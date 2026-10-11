import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PanelApiError,
  ScanError,
  buildChatContext,
  buildDepositPrompt,
  buildSystemPrompt,
  formatKnowledgeContext,
  handlePanelApi,
  parseDepositReply,
  resolveDshPaths,
  retrieveKnowledge,
  upsertKnowledge,
  type ChatMessage,
  type ModelChannel,
  type OpsConfig,
  type PanelApiOptions,
} from 'dsh-plugin-ops-core'
import {
  applyAdaptedInstall,
  installWithDiagnosis,
  listExemptions,
  removeAndCleanup,
  revokeExemptionsFor,
  type PluginManagerLike,
} from './adapt.js'
import type { SandboxManager } from './sandbox.js'

/** HTTP prefix the bundle owns on the harness Web server. */
export const ROUTE_PREFIX = '/dsh-ops'

/**
 * The harness connection's request admission — the Host/Origin trust fence
 * plus browser authentication (launch-token/cookie) — read through
 * `ctx.get('connection')`. Kept structural so the host half imports no
 * official runtime code; a host without that service falls back to the
 * same-origin check alone.
 */
export interface RequestGuard {
  /** 401/403 for a request that must not pass; undefined admits it. */
  requestRejection(request: { headers: IncomingMessage['headers'] }): number | undefined
}

export interface HostHandlerOptions {
  home: string
  profile: string
  config: OpsConfig
  /** Chat channel for this host; null when no provider is available. */
  channel: () => ModelChannel | null
  /** The official plugin-manager service, when this profile provides it. */
  manager?: () => PluginManagerLike | null
  /** The isolated sandbox manager (the "number 2 dsh"); absent when the host runs without one. */
  sandbox?: SandboxManager
  /**
   * Resolves the connection service's admission; called per request because
   * plugin rows activate concurrently — the service may register after this
   * host half does. Null when the host provides no connection service, in
   * which case the same-origin check is the only guard.
   */
  guard?: () => RequestGuard | null
}

/**
 * Derive the profile name from the Loader's base URL, which is the profile
 * directory (`file:///.../profiles/<name>/`). Returns null when the URL does
 * not sit under a `profiles` directory (nested include or unexpected boot).
 */
export function profileFromBaseUrl(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || baseUrl === '') return null
  try {
    const dir = fileURLToPath(baseUrl)
    if (basename(dirname(dir)) !== 'profiles') return null
    const name = basename(dir)
    return /^[\w.-]+$/.test(name) ? name : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
      throw new PanelApiError('request body too large', 413)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Browsers on the same machine must not drive writes cross-site; bare CLI/curl requests are allowed. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Build the HTTP handler served under {@link ROUTE_PREFIX}. Panel API routes
 * are delegated to the shared engine; the chat route is answered here because
 * it needs the host's model channel. Errors are contained and answered as
 * JSON — a failing panel must never reach the plugin tree.
 */
export function createHostHandler(options: HostHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const paths = resolveDshPaths(options.profile, options.home)
  const apiOptions: PanelApiOptions = { paths, config: options.config, defaultProfile: options.profile }
  return async (req, res) => {
    try {
      // Every /dsh-ops route passes the harness connection's admission when
      // that service exists (trust fence + browser authentication, the same
      // gate the harness API uses); older hosts without it keep the
      // same-origin check as the only guard.
      const guard = options.guard?.() ?? null
      const rejection = guard?.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      if (guard === null && !sameOrigin(req)) {
        json(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
        json(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
        return
      }
      const apiPath = url.pathname.slice(ROUTE_PREFIX.length)
      const body = req.method === 'POST' ? await collectBody(req) : undefined
      if (req.method === 'POST' && apiPath === '/api/chat') {
        await handleChat(res, options, paths, body)
        return
      }
      if (req.method === 'POST' && apiPath === '/api/knowledge/deposit') {
        await handleDeposit(res, options, paths, body)
        return
      }
      if (apiPath.startsWith('/api/adapt/')) {
        await handleAdapt(res, options, apiPath, req.method ?? 'GET', body)
        return
      }
      if (apiPath.startsWith('/api/sandbox/')) {
        await handleSandbox(res, options.sandbox ?? null, apiPath, req.method ?? 'GET', url.searchParams, body)
        return
      }
      const apiUrl = new URL(url)
      apiUrl.pathname = apiPath
      const result = await handlePanelApi(req.method ?? 'GET', apiUrl, apiOptions, body)
      json(res, result.status, result.body)
    } catch (error) {
      if (error instanceof PanelApiError) json(res, error.status, { error: error.message })
      else if (error instanceof ScanError) json(res, 400, { error: error.message })
      else json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Adapt routes: installation adaptation driven by the official plugin-manager
 * service, so the panel can grant and clean exact-version exemptions where the
 * official UI only reports the incompatibility. Every outcome is a JSON
 * `AdaptOutcome`; a missing manager answers 501.
 */
async function handleAdapt(
  res: ServerResponse,
  options: HostHandlerOptions,
  apiPath: string,
  method: string,
  body: string | undefined,
): Promise<void> {
  const manager = options.manager?.() ?? null
  if (manager === null) {
    json(res, 501, { ok: false, code: 'no-plugin-manager', message: 'this profile provides no plugin-manager service' })
    return
  }
  let parsed: Record<string, unknown> = {}
  if (body !== undefined && body !== '') {
    try {
      const value: unknown = JSON.parse(body)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch {
      json(res, 400, { ok: false, code: 'invalid-json', message: 'request body is not JSON' })
      return
    }
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  switch (apiPath) {
    case '/api/adapt/install': {
      const spec = str(parsed.spec)
      if (method !== 'POST' || spec === '') {
        json(res, 400, { ok: false, code: 'invalid-spec', message: 'POST with a package spec is required' })
        return
      }
      json(res, 200, await installWithDiagnosis(manager, spec))
      return
    }
    case '/api/adapt/apply': {
      const spec = str(parsed.spec)
      const name = str(parsed.name)
      const version = str(parsed.version)
      const runtimeVersion = str(parsed.runtimeVersion)
      if (method !== 'POST' || spec === '' || name === '' || version === '' || runtimeVersion === '') {
        json(res, 400, { ok: false, code: 'invalid-request', message: 'POST with spec, name, version and runtimeVersion is required' })
        return
      }
      json(res, 200, await applyAdaptedInstall(manager, { spec, name, version, runtimeVersion }))
      return
    }
    case '/api/adapt/exemptions': {
      if (method !== 'GET') {
        json(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET required' })
        return
      }
      json(res, 200, { ok: true, exemptions: listExemptions(manager) })
      return
    }
    case '/api/adapt/revoke': {
      const name = str(parsed.name)
      if (method !== 'POST' || name === '') {
        json(res, 400, { ok: false, code: 'invalid-request', message: 'POST with a package name is required' })
        return
      }
      const result = await revokeExemptionsFor(manager, name)
      json(res, result.ok ? 200 : 500, result)
      return
    }
    case '/api/adapt/remove': {
      const name = str(parsed.name)
      if (method !== 'POST' || name === '') {
        json(res, 400, { ok: false, code: 'invalid-request', message: 'POST with a package name is required' })
        return
      }
      json(res, 200, await removeAndCleanup(manager, name))
      return
    }
    default:
      json(res, 404, { ok: false, code: 'not-found', message: `no adapt route for ${apiPath}` })
  }
}

/**
 * Sandbox routes: the isolated "number 2 dsh" driven from outside — status
 * with incremental logs, start/stop, profile scan, startup diagnostics, and
 * disable-row fixes (which restart the sandbox to prove the repair).
 */
async function handleSandbox(
  res: ServerResponse,
  sandbox: SandboxManager | null,
  apiPath: string,
  method: string,
  query: URLSearchParams,
  body: string | undefined,
): Promise<void> {
  if (sandbox === null) {
    json(res, 501, { ok: false, code: 'no-sandbox', message: 'this host runs without a sandbox manager' })
    return
  }
  const allowGet = (): boolean => {
    if (method === 'GET') return true
    json(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET required' })
    return false
  }
  const allowPost = (): boolean => {
    if (method === 'POST') return true
    json(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' })
    return false
  }
  switch (apiPath) {
    case '/api/sandbox/status': {
      if (!allowGet()) return
      const after = Number(query.get('after') ?? '0')
      const logs = sandbox.logsAfter(Number.isFinite(after) && after >= 0 ? after : 0)
      json(res, 200, { ok: true, status: sandbox.status(), logs: logs.lines, nextSeq: logs.nextSeq })
      return
    }
    case '/api/sandbox/start': {
      if (!allowPost()) return
      json(res, 200, { ok: true, status: await sandbox.start() })
      return
    }
    case '/api/sandbox/stop': {
      if (!allowPost()) return
      json(res, 200, { ok: true, status: await sandbox.stop() })
      return
    }
    case '/api/sandbox/restart': {
      if (!allowPost()) return
      json(res, 200, { ok: true, status: await sandbox.restart() })
      return
    }
    case '/api/sandbox/diagnose': {
      if (!allowGet()) return
      json(res, 200, { ok: true, diagnosis: sandbox.diagnose() })
      return
    }
    case '/api/sandbox/scan': {
      if (!allowGet()) return
      const report = await sandbox.scan()
      json(res, 200, report === null
        ? { ok: false, code: 'no-home', message: 'no sandbox home exists; start the sandbox first' }
        : { ok: true, findings: report.findings })
      return
    }
    case '/api/sandbox/fix': {
      if (!allowPost()) return
      let rows: string[] = []
      if (body !== undefined && body !== '') {
        try {
          const parsed: unknown = JSON.parse(body)
          if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows)) {
            rows = ((parsed as { rows: unknown[] }).rows)
              .filter((row): row is string => typeof row === 'string' && row.trim() !== '')
              .map((row) => row.trim())
          }
        } catch {
          json(res, 400, { ok: false, code: 'invalid-json', message: 'request body is not JSON' })
          return
        }
      }
      if (rows.length === 0) {
        json(res, 400, { ok: false, code: 'invalid-rows', message: 'POST with a non-empty rows array is required' })
        return
      }
      json(res, 200, { ok: true, ...(await sandbox.fix(rows)) })
      return
    }
    default:
      json(res, 404, { ok: false, code: 'not-found', message: `no sandbox route for ${apiPath}` })
  }
}

async function handleChat(
  res: ServerResponse,
  options: HostHandlerOptions,
  paths: ReturnType<typeof resolveDshPaths>,
  body: string | undefined,
): Promise<void> {
  const parsed = JSON.parse(body ?? '{}') as { profile?: unknown; lang?: unknown; messages?: unknown; rag?: unknown }
  const profile = typeof parsed.profile === 'string' && parsed.profile !== '' ? parsed.profile : options.profile
  const lang = typeof parsed.lang === 'string' ? parsed.lang : 'zh'
  const rag = parsed.rag === true
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
        .filter((m): m is ChatMessage => typeof m === 'object' && m !== null
          && ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant')
          && typeof (m as ChatMessage).content === 'string')
        .slice(-10)
    : []
  if (messages.length === 0) {
    json(res, 400, { error: 'no user messages' })
    return
  }
  const channel = options.channel()
  if (channel === null) {
    json(res, 200, {
      ok: false,
      reply: '',
      error: 'no model channel available (no harness llm service and no provider key found); set DSH_OPS_LLM_API_KEY to override',
    })
    return
  }
  const context = await buildChatContext(paths, profile, options.config)
  if (rag) {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const query = `${lastUser?.content ?? ''}\n${context.findingsJson}`
    const hits = await retrieveKnowledge(paths, query, 3)
    if (hits.length > 0) context.knowledge = formatKnowledgeContext(hits)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const result = await channel.complete(buildSystemPrompt(context, lang), messages, controller.signal)
    json(res, result.ok ? 200 : 502, { ok: result.ok, reply: result.reply, error: result.error })
  } finally {
    clearTimeout(timer)
  }
}

/** Summarize the current troubleshooting chat into one knowledge entry. */
async function handleDeposit(
  res: ServerResponse,
  options: HostHandlerOptions,
  paths: ReturnType<typeof resolveDshPaths>,
  body: string | undefined,
): Promise<void> {
  const parsed = JSON.parse(body ?? '{}') as { lang?: unknown; messages?: unknown }
  const lang = typeof parsed.lang === 'string' ? parsed.lang : 'zh'
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
        .filter((m): m is ChatMessage => typeof m === 'object' && m !== null
          && ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant')
          && typeof (m as ChatMessage).content === 'string')
        .slice(-12)
    : []
  if (messages.length === 0) {
    json(res, 400, { error: 'no messages to deposit' })
    return
  }
  const channel = options.channel()
  if (channel === null) {
    json(res, 200, { ok: false, error: 'no model channel available; configure a model to summarize the conversation' })
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const result = await channel.complete(buildDepositPrompt(messages, lang), [], controller.signal)
    if (!result.ok) {
      json(res, 502, { ok: false, error: result.error })
      return
    }
    const draft = parseDepositReply(result.reply)
    if (draft === null) {
      json(res, 502, { ok: false, error: 'model reply was not a parsable knowledge entry' })
      return
    }
    const written = upsertKnowledge(paths, { ...draft, source: 'chat' })
    json(res, written.ok ? 200 : 500, { ok: written.ok, id: written.id, problem: written.problem })
  } finally {
    clearTimeout(timer)
  }
}
