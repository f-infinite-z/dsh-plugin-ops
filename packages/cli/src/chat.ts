import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveDshPaths, scanProfile, type DshPaths, type OpsConfig } from 'dsh-plugin-ops-core'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatContext {
  profile: string
  findingsJson: string
}

/**
 * Resolve the DeepSeek API key in the same order the harness itself uses:
 * ambient environment, the gitignored `$DSH_HOME/.env`, then the harness
 * credentials file (`$DSH_HOME/.credentials.yaml`, refs table). Returns null
 * when none of them carries a key.
 */
export function resolveApiKey(home: string): string | null {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const envFile = join(home, '.env')
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const match = /^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
        if (match !== null && match[1] !== undefined && match[1] !== '') return match[1]!
      }
    } catch {
      // fall through to the credentials file
    }
  }
  const credentialsFile = join(home, '.credentials.yaml')
  if (existsSync(credentialsFile)) {
    try {
      const doc = parseYaml(readFileSync(credentialsFile, 'utf8')) as { refs?: Record<string, unknown> } | null
      const value = doc?.refs?.['DEEPSEEK_API_KEY']
      if (typeof value === 'string' && value !== '') return value
    } catch {
      return null
    }
  }
  return null
}

function baseUrl(): string {
  return process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
}

function modelName(): string {
  return process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
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

export interface ChatReply {
  reply: string
  ok: boolean
  error?: string
}

/**
 * One explicit chat turn against the DeepSeek chat-completions API. The
 * caller decides when this runs; it never participates in scan/gate paths.
 */
export async function chatTurn(
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatReply> {
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName(),
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: 800,
        stream: false,
      }),
    }
    if (signal !== undefined) init.signal = signal
    const response = await fetch(`${baseUrl()}/chat/completions`, init)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { reply: '', ok: false, error: `DeepSeek API ${response.status}: ${body.slice(0, 300)}` }
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const reply = data.choices?.[0]?.message?.content
    if (reply === undefined) return { reply: '', ok: false, error: 'DeepSeek API returned no content' }
    return { reply, ok: true }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { reply: '', ok: false, error: 'request timed out' }
    }
    return { reply: '', ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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
