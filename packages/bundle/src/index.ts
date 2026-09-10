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
  readOpsConfig,
  resolveDshPaths,
  resolveModelConfig,
  type ModelChannel,
} from 'dsh-plugin-ops-core'
import { ROUTE_PREFIX, createHostHandler, profileFromBaseUrl } from './host.js'
import { LlmChannel, type LlmRuntimeLike, type ModelSelectionLike } from './llm-channel.js'

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
  const handler = createHostHandler({
    home: paths.home,
    profile,
    config: read.ok ? read.config : {},
    channel: () => resolveChannel(ctx, paths.home),
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-ops-bundle: /dsh-ops prefix',
  )
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
