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

/** HTTP prefix the bundle owns on the harness Web server. */
export const ROUTE_PREFIX = '/dsh-ops'

export interface HostHandlerOptions {
  home: string
  profile: string
  config: OpsConfig
  /** Chat channel for this host; null when no provider is available. */
  channel: () => ModelChannel | null
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
      if (!sameOrigin(req)) {
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
        await handleChat(res, options, paths, url, body)
        return
      }
      if (req.method === 'POST' && apiPath === '/api/knowledge/deposit') {
        await handleDeposit(res, options, paths, body)
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

async function handleChat(
  res: ServerResponse,
  options: HostHandlerOptions,
  paths: ReturnType<typeof resolveDshPaths>,
  url: URL,
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
