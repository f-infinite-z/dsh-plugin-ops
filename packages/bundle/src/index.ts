/**
 * dsh-plugin-ops host half: mounts the panel API under the `/dsh-ops` HTTP
 * prefix of the running harness Web server. The browser half ships through
 * `exports["./client"]` (a settings-page section). This half is deliberately
 * thin and defensive: it imports no official runtime code, waits for the
 * optional `webServer` service through `ctx.inject` (so profiles without a
 * Web server still boot), and contains every error so a broken panel can
 * never fail the plugin tree (the harness aborts the whole tree when one
 * plugin fails).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  OpenAiCompatibleChannel,
  isDesktopProfile,
  readOpsConfig,
  resolveDshPaths,
  resolveModelConfig,
  type ModelChannel,
} from 'dsh-plugin-ops-core'
import { ROUTE_PREFIX, createHostHandler, profileFromBaseUrl, type RequestGuard } from './host.js'
import type { PluginManagerLike } from './adapt.js'
import { LlmChannel, type LlmRuntimeLike, type ModelSelectionLike } from './llm-channel.js'
import { SandboxManager } from './sandbox.js'
import { registerSandboxTools, type ToolRuntimeLike } from './tools.js'

export const name = 'dsh-ops-bundle'

/** Minimal view of the cordis context the host half relies on. */
export interface HostContext {
  baseUrl?: string
  webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  get(name: string): unknown
  inject(deps: string[], callback: (ctx: HostContext) => void): unknown
  effect(callback: () => (() => void) | void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        registerPanel(webCtx)
      } catch (error) {
        console.error('[dsh-ops] host half disabled:', error)
      }
    })
  } catch (error) {
    console.error('[dsh-ops] host half disabled:', error)
  }
}

function registerPanel(ctx: HostContext): void {
  const profile = profileFromBaseUrl(ctx.baseUrl) ?? 'web'
  const paths = resolveDshPaths(profile)
  const read = readOpsConfig(paths.configFile)
  if (!read.ok) {
    console.error(`[dsh-ops] ignoring unreadable config: ${read.problem ?? 'unknown problem'}`)
  }
  // The sandbox shape follows the host: the desktop profile implies a second
  // desktop window (driven through --user-data-dir), every other profile a
  // second CLI-hosted instance.
  const sandbox = new SandboxManager({ kind: isDesktopProfile(profile) ? 'desktop' : 'web' })
  ctx.effect(() => () => { sandbox.dispose() }, 'dsh-ops-bundle: sandbox teardown')
  const handler = createHostHandler({
    home: paths.home,
    profile,
    config: read.ok ? read.config : {},
    channel: () => resolveChannel(ctx, paths.home),
    manager: () => resolveManager(ctx),
    sandbox,
    guard: () => resolveGuard(ctx),
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-ops-bundle: /dsh-ops prefix',
  )
  // The agent tools are optional like every service read here: a tree
  // without the tools service keeps booting, the sandbox just stays
  // panel-only.
  ctx.inject(['tools'], (toolCtx) => {
    try {
      const tools = toolCtx.get('tools') as ToolRuntimeLike | null | undefined
      if (tools === null || tools === undefined || typeof tools.register !== 'function') return
      toolCtx.effect(() => {
        const disposers = registerSandboxTools(tools, sandbox)
        return () => { for (const dispose of disposers) dispose() }
      }, 'dsh-ops-bundle: sandbox tools')
    } catch (error) {
      console.error('[dsh-ops] sandbox tools disabled:', error)
    }
  })
}

/** The official plugin-manager service, when this profile provides one. */
function resolveManager(ctx: HostContext): PluginManagerLike | null {
  try {
    const manager = ctx.get('pluginManager')
    return manager === null || manager === undefined || typeof manager !== 'object'
      ? null
      : manager as PluginManagerLike
  } catch {
    return null
  }
}

/**
 * The connection service's request admission (Host/Origin fence plus browser
 * authentication), when this tree provides it — the same gate the harness API
 * routes use, so /dsh-ops is not an unauthenticated side door.
 */
function resolveGuard(ctx: HostContext): RequestGuard | null {
  try {
    const connection = ctx.get('connection') as { requestRejection?: (request: { headers: unknown }) => number | undefined } | null | undefined
    if (connection === null || connection === undefined || typeof connection.requestRejection !== 'function') return null
    return {
      requestRejection: (request) => connection.requestRejection!(request),
    }
  } catch {
    return null
  }
}

/**
 * Prefer the harness llm seam with the configured default model; fall back to
 * the direct OpenAI-compatible channel when the tree exposes no llm service or
 * no default selection.
 */
function resolveChannel(ctx: HostContext, home: string): ModelChannel | null {
  const llm = ctx.get('llm') as LlmRuntimeLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): ModelSelectionLike } | undefined
  if (llm !== undefined && defaultModel !== undefined) {
    try {
      return new LlmChannel(llm, defaultModel.currentSelection())
    } catch (error) {
      console.error('[dsh-ops] llm channel unavailable, falling back to direct:', error)
    }
  }
  const config = resolveModelConfig(home)
  return config === null ? null : new OpenAiCompatibleChannel(config)
}
