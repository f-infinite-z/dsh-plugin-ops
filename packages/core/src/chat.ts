import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveDshPaths, type DshPaths } from './paths.js'
import { scanProfile } from './scan.js'
import type { OpsConfig } from './config.js'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatContext {
  profile: string
  findingsJson: string
}

export interface ChatReply {
  reply: string
  ok: boolean
  error?: string
}

/** Provider key candidates, in probe order. The provider that owns the first
 * found key also selects the default base URL (all OpenAI-compatible). */
const PROVIDER_CANDIDATES: ReadonlyArray<{ env: string; baseUrl: string; defaultModel: string }> = [
  { env: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { env: 'ARK_API_KEY', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'deepseek-v3' },
  { env: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { env: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
]

export interface ResolvedModelConfig {
  key: string
  baseUrl: string
  model: string
}

function secretFromEnvOrDotEnv(name: string, home: string): string | null {
  const fromEnv = process.env[name]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const envFile = join(home, '.env')
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line)
        if (match !== null && match[1] !== undefined && match[1] !== '') return match[1]!
      }
    } catch {
      // fall through
    }
  }
  return null
}

function credentialsRefs(home: string): Record<string, unknown> | null {
  const credentialsFile = join(home, '.credentials.yaml')
  if (!existsSync(credentialsFile)) return null
  try {
    const doc = parseYaml(readFileSync(credentialsFile, 'utf8')) as { refs?: Record<string, unknown> } | null
    return doc?.refs ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the model configuration for the direct (non-harness) channel. Probe
 * order: an explicit override (`DSH_OPS_LLM_API_KEY` / `_BASE_URL` /
 * `_MODEL`), then the first provider key found in the environment, the
 * gitignored `$DSH_HOME/.env`, or the harness credentials file
 * (`.credentials.yaml` refs — the same store the harness itself reads).
 * Base URL and model default to that provider's OpenAI-compatible endpoint.
 */
export function resolveModelConfig(home: string): ResolvedModelConfig | null {
  const refs = credentialsRefs(home)
  const look = (name: string): string | null => {
    const env = process.env[name]
    if (env !== undefined && env !== '') return env
    const dot = secretFromEnvOrDotEnv(name, home)
    if (dot !== null) return dot
    const ref = refs?.[name]
    return typeof ref === 'string' && ref !== '' ? ref : null
  }
  const explicitKey = process.env.DSH_OPS_LLM_API_KEY
  if (explicitKey !== undefined && explicitKey !== '') {
    return {
      key: explicitKey,
      baseUrl: process.env.DSH_OPS_LLM_BASE_URL ?? 'https://api.deepseek.com',
      model: process.env.DSH_OPS_LLM_MODEL ?? 'deepseek-chat',
    }
  }
  for (const candidate of PROVIDER_CANDIDATES) {
    const key = look(candidate.env)
    if (key === null) continue
    return {
      key,
      baseUrl: process.env.DSH_OPS_LLM_BASE_URL ?? candidate.baseUrl,
      model: process.env.DSH_OPS_LLM_MODEL ?? candidate.defaultModel,
    }
  }
  return null
}

/**
 * Model channel seam. The standalone panel uses the OpenAI-compatible direct
 * channel; the embedded bundle host provides the same seam over the official
 * ctx.llm service (or falls back to the direct channel), so the panel UI and
 * the `/api/chat` protocol do not change.
 */
export interface ModelChannel {
  complete(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ChatReply>
}

/** OpenAI-compatible chat-completions channel (DeepSeek, ARK, DashScope, ...). */
export class OpenAiCompatibleChannel implements ModelChannel {
  constructor(private readonly config: ResolvedModelConfig) {}

  async complete(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ChatReply> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.key}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: 800,
        stream: false,
      }),
    }
    if (signal !== undefined) init.signal = signal
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, init)
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return { reply: '', ok: false, error: `model API ${response.status}: ${body.slice(0, 300)}` }
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const reply = data.choices?.[0]?.message?.content
      if (reply === undefined) return { reply: '', ok: false, error: 'model API returned no content' }
      return { reply, ok: true }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { reply: '', ok: false, error: 'request timed out' }
      }
      return { reply: '', ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function buildSystemPrompt(context: ChatContext, lang: string): string {
  const language = lang === 'zh'
    ? '用简体中文回答。'
    : 'Answer in English.'
  return `You are the diagnosis assistant inside dsh-ops, a DeepSeek Harness plugin
health tool. The user is looking at a scan report for profile
"${context.profile}" and wants to understand and fix problems.

Rules:
${language}
- Explain the findings in plain terms: what is wrong, why it matters, what the
  risk is.
- Only suggest fixes that dsh-ops itself can perform or that use the standard
  dsh commands: pnpm install --frozen-lockfile --force (lockfile realign),
  disabling a plugin row (panel 禁用 button), dsh plugin add/remove, or
  editing $DSH_HOME/dsh-ops.yml.
- Never ask the user to delete data directories or edit dsh installation
  files by hand.
- If the report is clean, say so briefly.
- Keep the answer under 250 words unless asked for detail.

Current scan report (JSON):
${context.findingsJson}`
}

/** Scan context snapshot for the chat system prompt. */
export async function buildChatContext(paths: DshPaths, profile: string, config: OpsConfig): Promise<ChatContext> {
  const report = await scanProfile({ paths: resolveDshPaths(profile, paths.home), profileName: profile, config, updateCheck: false })
  const findingsJson = JSON.stringify(
    report.findings.map((f) => ({ rule: f.ruleId, severity: f.severity, package: f.packageName, message: f.message, fix: f.fix })),
    null,
    1,
  )
  return { profile, findingsJson }
}
