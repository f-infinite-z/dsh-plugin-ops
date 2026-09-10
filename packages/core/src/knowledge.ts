import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { lookupSecret, type ChatMessage } from './chat.js'
import type { DshPaths } from './paths.js'
import type { Finding } from './types.js'

/**
 * Knowledge base for plugin-troubleshooting experience: each entry is one
 * Markdown file under `$DSH_HOME/cache/dsh-ops/knowledge/`, readable and
 * hand-editable. Retrieval is BM25 (self-contained, offline) with an optional
 * embedding re-rank when an embedding key is configured.
 */

export type KnowledgeSource = 'chat' | 'fix' | 'gate' | 'manual'

export interface KnowledgeEntry {
  id: string
  title: string
  source: KnowledgeSource
  createdAt: string
  /** How many times this problem was observed (merged entries). */
  occurrences: number
  /** Last time this problem was observed. */
  lastSeenAt: string
  tags: string[]
  symptom: string
  cause: string
  fix: string
  notes: string
}

export interface KnowledgeHit {
  entry: KnowledgeEntry
  /** Combined score in [0, 1]-ish space (BM25 normalized, optionally blended with cosine). */
  score: number
  bm25: number
  vector: number | null
}

export interface KnowledgeInput {
  title: string
  source: KnowledgeSource
  tags: string[]
  symptom: string
  cause: string
  fix: string
  notes?: string
}

export interface KnowledgeWriteResult {
  ok: boolean
  id?: string
  problem?: string
}

const SECTION_KEYS = ['symptom', 'cause', 'fix', 'notes'] as const
const SECTION_TITLES: Record<(typeof SECTION_KEYS)[number], string> = {
  symptom: '症状',
  cause: '根因',
  fix: '修复',
  notes: '备注',
}

/** Only ids this module generates may reach the filesystem. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,120}$/

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/[\u4e00-\u9fff]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug === '' ? 'entry' : slug
}

function serializeEntry(entry: KnowledgeEntry): string {
  const front = stringifyYaml({
    id: entry.id,
    title: entry.title,
    source: entry.source,
    createdAt: entry.createdAt,
    occurrences: entry.occurrences,
    lastSeenAt: entry.lastSeenAt,
    tags: entry.tags,
  }).trimEnd()
  const body = SECTION_KEYS.map((key) => `## ${SECTION_TITLES[key]}\n${entry[key] === '' ? '（无）' : entry[key]}`).join('\n\n')
  return `---\n${front}\n---\n\n${body}\n`
}

function parseEntry(raw: string, fallbackId: string): KnowledgeEntry | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (match === null) return null
  let meta: Record<string, unknown>
  try {
    const parsed = parseYaml(match[1] ?? '')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    meta = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const sections = new Map<string, string>()
  for (const part of (match[2] ?? '').split(/^## /m).slice(1)) {
    const newline = part.indexOf('\n')
    const name = (newline === -1 ? part : part.slice(0, newline)).trim()
    const text = (newline === -1 ? '' : part.slice(newline + 1)).trim()
    sections.set(name, text === '（无）' ? '' : text)
  }
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((t): t is string => typeof t === 'string')
    : []
  const source = meta.source
  const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : ''
  const occurrences = typeof meta.occurrences === 'number' && Number.isFinite(meta.occurrences) && meta.occurrences >= 1
    ? Math.trunc(meta.occurrences)
    : 1
  return {
    id: typeof meta.id === 'string' && ID_PATTERN.test(meta.id) ? meta.id : fallbackId,
    title: typeof meta.title === 'string' ? meta.title : fallbackId,
    source: source === 'chat' || source === 'fix' || source === 'gate' || source === 'manual' ? source : 'manual',
    createdAt,
    occurrences,
    lastSeenAt: typeof meta.lastSeenAt === 'string' && meta.lastSeenAt !== '' ? meta.lastSeenAt : createdAt,
    tags,
    symptom: sections.get(SECTION_TITLES.symptom) ?? '',
    cause: sections.get(SECTION_TITLES.cause) ?? '',
    fix: sections.get(SECTION_TITLES.fix) ?? '',
    notes: sections.get(SECTION_TITLES.notes) ?? '',
  }
}

export function listKnowledge(paths: DshPaths): KnowledgeEntry[] {
  const dir = paths.knowledgeDir
  if (!existsSync(dir)) return []
  const out: KnowledgeEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    try {
      const entry = parseEntry(readFileSync(join(dir, name), 'utf8'), name.replace(/\.md$/, ''))
      if (entry !== null) out.push(entry)
    } catch {
      // Unreadable entry: skip it, keep the rest of the base usable.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readKnowledge(paths: DshPaths, id: string): KnowledgeEntry | null {
  if (!ID_PATTERN.test(id)) return null
  const file = join(paths.knowledgeDir, `${id}.md`)
  if (!existsSync(file)) return null
  try {
    return parseEntry(readFileSync(file, 'utf8'), id)
  } catch {
    return null
  }
}

export function writeKnowledge(paths: DshPaths, input: KnowledgeInput): KnowledgeWriteResult {
  if (input.title.trim() === '') return { ok: false, problem: 'title is required' }
  if (input.symptom.trim() === '' && input.fix.trim() === '') {
    return { ok: false, problem: 'symptom or fix is required' }
  }
  const createdAt = new Date().toISOString()
  const id = `${input.source}-${slugify(input.title)}-${Date.now().toString(36)}`
  const entry: KnowledgeEntry = {
    id,
    title: input.title.trim(),
    source: input.source,
    createdAt,
    occurrences: 1,
    lastSeenAt: createdAt,
    tags: [...new Set(input.tags.map((t) => t.trim()).filter((t) => t !== ''))],
    symptom: input.symptom.trim(),
    cause: input.cause.trim(),
    fix: input.fix.trim(),
    notes: (input.notes ?? '').trim(),
  }
  try {
    mkdirSync(paths.knowledgeDir, { recursive: true })
    writeFileSync(join(paths.knowledgeDir, `${id}.md`), serializeEntry(entry), 'utf8')
    return { ok: true, id }
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
}

export function deleteKnowledge(paths: DshPaths, id: string): boolean {
  if (!ID_PATTERN.test(id)) return false
  const file = join(paths.knowledgeDir, `${id}.md`)
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

// ---- merge-on-repeat ------------------------------------------------------------

function tagsKey(tags: string[]): string {
  return [...tags].map((t) => t.trim().toLowerCase()).filter((t) => t !== '').sort().join('|')
}

function findByTags(paths: DshPaths, tags: string[]): KnowledgeEntry | null {
  const key = tagsKey(tags)
  if (key === '') return null
  return listKnowledge(paths).find((entry) => tagsKey(entry.tags) === key) ?? null
}

function findByTitle(paths: DshPaths, title: string): KnowledgeEntry | null {
  const normalized = title.trim().toLowerCase()
  if (normalized === '') return null
  return listKnowledge(paths).find((entry) => entry.title.trim().toLowerCase() === normalized) ?? null
}

/** Merge line lists preserving order, dropping blank and duplicate lines. */
function mergeLines(existing: string, next: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of [...existing.split('\n'), ...next.split('\n')]) {
    const key = line.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.join('\n')
}

function persistEntry(paths: DshPaths, entry: KnowledgeEntry): KnowledgeWriteResult {
  try {
    mkdirSync(paths.knowledgeDir, { recursive: true })
    writeFileSync(join(paths.knowledgeDir, `${entry.id}.md`), serializeEntry(entry), 'utf8')
    return { ok: true, id: entry.id }
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Merge a repeated observation into an existing entry: occurrences +1, last
 * seen refreshed, symptoms unioned (history is diagnostic value). Cause, fix,
 * and notes keep their first recorded value unless they were empty.
 */
function mergeEntry(paths: DshPaths, existing: KnowledgeEntry, input: KnowledgeInput): KnowledgeWriteResult {
  const merged: KnowledgeEntry = {
    ...existing,
    occurrences: existing.occurrences + 1,
    lastSeenAt: new Date().toISOString(),
    symptom: mergeLines(existing.symptom, input.symptom),
    cause: existing.cause === '' ? input.cause.trim() : existing.cause,
    fix: existing.fix === '' ? input.fix.trim() : existing.fix,
    notes: existing.notes === '' ? (input.notes ?? '').trim() : existing.notes,
  }
  return persistEntry(paths, merged)
}

/**
 * Write or merge one knowledge entry. Repeated observations of the same
 * problem (identical tag set, or identical title for manual/deposited
 * entries) update the existing entry instead of appending a duplicate.
 */
export function upsertKnowledge(paths: DshPaths, input: KnowledgeInput): KnowledgeWriteResult {
  if (input.title.trim() === '') return { ok: false, problem: 'title is required' }
  const existing = findByTags(paths, input.tags) ?? findByTitle(paths, input.title)
  if (existing !== null) return mergeEntry(paths, existing, input)
  return writeKnowledge(paths, input)
}

/** Lowercased ASCII words plus CJK bigrams; no dictionary dependency. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  for (const word of lower.match(/[a-z0-9][a-z0-9._@/-]*/g) ?? []) tokens.push(word)
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

function entryText(entry: KnowledgeEntry): string {
  return [entry.title, entry.tags.join(' '), entry.symptom, entry.cause, entry.fix, entry.notes].join('\n')
}

/** Okapi BM25 over the whole knowledge base. */
export function bm25Search(
  entries: KnowledgeEntry[],
  query: string,
  limit = 20,
): Array<{ entry: KnowledgeEntry; score: number }> {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0 || entries.length === 0) return []
  const docs = entries.map((entry) => {
    const tokens = tokenize(entryText(entry))
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return { entry, tf, length: tokens.length }
  })
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / docs.length
  const k1 = 1.2
  const b = 0.75
  const scored = docs.map((doc) => {
    let score = 0
    for (const token of queryTokens) {
      const frequency = doc.tf.get(token) ?? 0
      if (frequency === 0) continue
      let documentFrequency = 0
      for (const other of docs) if (other.tf.has(token)) documentFrequency++
      const idf = Math.log(1 + (docs.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      score += (idf * (frequency * (k1 + 1))) / (frequency + k1 * (1 - b + b * (doc.length / (avgLength || 1))))
    }
    return { entry: doc.entry, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
}

// ---- optional embedding re-rank -------------------------------------------------

export interface EmbeddingConfig {
  key: string
  baseUrl: string
  model: string
}

const EMBEDDING_CANDIDATES: ReadonlyArray<{ env: string; baseUrl: string; model: string }> = [
  { env: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  { env: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' },
]

/**
 * Resolve the embedding endpoint: explicit `DSH_OPS_EMBEDDING_API_KEY` /
 * `_BASE_URL` / `_MODEL` overrides first, then the first provider key found
 * through {@link lookupSecret}. Returns null when no key is available; the
 * caller then stays on BM25 only.
 */
export function resolveEmbeddingConfig(home: string): EmbeddingConfig | null {
  const explicit = lookupSecret('DSH_OPS_EMBEDDING_API_KEY', home)
  if (explicit !== null) {
    return {
      key: explicit,
      baseUrl: lookupSecret('DSH_OPS_EMBEDDING_BASE_URL', home) ?? 'https://api.openai.com/v1',
      model: lookupSecret('DSH_OPS_EMBEDDING_MODEL', home) ?? 'text-embedding-3-small',
    }
  }
  for (const candidate of EMBEDDING_CANDIDATES) {
    const key = lookupSecret(candidate.env, home)
    if (key !== null) return { key, baseUrl: candidate.baseUrl, model: candidate.model }
  }
  return null
}

async function embedTexts(texts: string[], config: EmbeddingConfig): Promise<number[][] | null> {
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ model: config.model, input: texts }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
    if (!Array.isArray(data.data) || data.data.length !== texts.length) return null
    const vectors: number[][] = []
    for (const item of data.data) {
      if (!Array.isArray(item.embedding)) return null
      vectors.push(item.embedding)
    }
    return vectors
  } catch {
    return null
  }
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

interface EmbeddingCache {
  model: string
  vectors: Record<string, number[]>
}

function embeddingsFile(paths: DshPaths): string {
  return join(paths.knowledgeDir, '.embeddings.json')
}

function readEmbeddingCache(paths: DshPaths, model: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  try {
    const file = embeddingsFile(paths)
    if (!existsSync(file)) return out
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EmbeddingCache
    if (parsed.model !== model || typeof parsed.vectors !== 'object' || parsed.vectors === null) return out
    for (const [id, vector] of Object.entries(parsed.vectors)) {
      if (Array.isArray(vector)) out.set(id, vector)
    }
  } catch {
    // Corrupt cache: rebuild below.
  }
  return out
}

function writeEmbeddingCache(paths: DshPaths, model: string, vectors: Map<string, number[]>): void {
  try {
    mkdirSync(paths.knowledgeDir, { recursive: true })
    const payload: EmbeddingCache = { model, vectors: Object.fromEntries(vectors) }
    writeFileSync(embeddingsFile(paths), JSON.stringify(payload), 'utf8')
  } catch {
    // Cache is an optimization; failure is not fatal.
  }
}

/** Embed the given entries, reusing cached vectors and refreshing the cache. */
async function ensureVectors(
  paths: DshPaths,
  entries: KnowledgeEntry[],
  config: EmbeddingConfig,
): Promise<Map<string, number[]> | null> {
  const cache = readEmbeddingCache(paths, config.model)
  const missing = entries.filter((entry) => !cache.has(entry.id))
  if (missing.length > 0) {
    const vectors = await embedTexts(missing.map((entry) => entryText(entry)), config)
    if (vectors === null) return cache.size > 0 ? cache : null
    missing.forEach((entry, index) => {
      const vector = vectors[index]
      if (vector !== undefined) cache.set(entry.id, vector)
    })
    writeEmbeddingCache(paths, config.model, cache)
  }
  return cache
}

/**
 * Retrieve the most relevant knowledge entries. BM25 runs first (offline,
 * dependency-free); when an embedding key is configured the lexical top
 * candidates are re-ranked by blending normalized BM25 with cosine
 * similarity. Any embedding failure silently degrades to BM25.
 */
export async function retrieveKnowledge(paths: DshPaths, query: string, limit = 3): Promise<KnowledgeHit[]> {
  const entries = listKnowledge(paths)
  if (entries.length === 0 || query.trim() === '') return []
  const lexical = bm25Search(entries, query, Math.max(limit * 4, 12))
  if (lexical.length === 0) return []
  const maxBm25 = lexical[0]?.score ?? 0

  const vectorById = new Map<string, number>()
  const config = resolveEmbeddingConfig(paths.home)
  if (config !== null) {
    const vectors = await ensureVectors(paths, lexical.map((hit) => hit.entry), config)
    if (vectors !== null) {
      const queryVector = (await embedTexts([query], config))?.[0]
      if (queryVector !== undefined) {
        for (const { entry } of lexical) {
          const vector = vectors.get(entry.id)
          if (vector !== undefined) vectorById.set(entry.id, cosine(queryVector, vector))
        }
      }
    }
  }

  const hits: KnowledgeHit[] = lexical.map(({ entry, score }) => {
    const vector = vectorById.get(entry.id) ?? null
    const lexicalNorm = maxBm25 > 0 ? score / maxBm25 : 0
    const base = vector === null ? lexicalNorm : 0.5 * lexicalNorm + 0.5 * Math.max(vector, 0)
    // Frequent problems rank slightly higher (1 → ×1, 2 → ×1.1, 4 → ×1.2, 8 → ×1.3).
    const frequencyBoost = 1 + 0.1 * Math.log2(Math.max(entry.occurrences, 1))
    return { entry, score: base * frequencyBoost, bm25: score, vector }
  })
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ---- automatic capture and prompt helpers ---------------------------------------

/**
 * Record one knowledge entry after a successful automatic repair. Repeated
 * observations of the same problem merge into the existing entry (occurrences
 * +1, symptoms unioned) through {@link upsertKnowledge}.
 */
export function recordFixKnowledge(
  paths: DshPaths,
  input: { profile: string; source: 'fix' | 'gate'; findings: Finding[]; action: string; detail: string },
): void {
  const fatal = input.findings.filter((finding) => finding.severity === 'fatal')
  if (fatal.length === 0) return
  const tags = [
    ...new Set(
      fatal.flatMap((finding) => [finding.ruleId, finding.packageName].filter((value): value is string => value !== undefined)),
    ),
  ].sort()
  const first = fatal[0]
  const suffix = first?.packageName === undefined ? '' : ` (${first.packageName})`
  upsertKnowledge(paths, {
    title: `自动记录：${first?.ruleId ?? 'unknown'}${suffix}`,
    source: input.source,
    tags,
    symptom: fatal.map((finding) => finding.message).join('\n'),
    cause: 'scan 规则判定为 fatal（详见 finding 详情与规则说明）',
    fix: input.detail !== '' ? input.detail : input.action,
    notes: `profile: ${input.profile}`,
  })
}

/** Render retrieved entries for injection into the chat system prompt. */
export function formatKnowledgeContext(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return ''
  return hits
    .map((hit, index) => {
      const entry = hit.entry
      const lines = [`### ${index + 1}. ${entry.title}`, `- 症状: ${entry.symptom}`, `- 根因: ${entry.cause}`, `- 修复: ${entry.fix}`]
      if (entry.notes !== '') lines.push(`- 备注: ${entry.notes}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/** Prompt used by the panels to summarize a troubleshooting chat into one entry. */
export function buildDepositPrompt(messages: ChatMessage[], lang: string): string {
  const language = lang === 'zh' ? '用简体中文' : 'Answer in English'
  const transcript = messages.map((message) => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`).join('\n\n')
  return `你是 dsh-ops 的知识沉淀助手。把下面这段排障对话总结为一条可复用的知识条目。
${language}，只输出严格的 JSON（不要 Markdown 代码块），字段：
- title: 一句话标题
- symptom: 症状 / 错误信息（保留原文关键部分）
- cause: 根因
- fix: 修复步骤
- tags: 字符串数组（规则 id、包名、关键词）
- notes: 可选备注

对话：
${transcript}`
}

export interface DepositDraft {
  title: string
  symptom: string
  cause: string
  fix: string
  tags: string[]
  notes: string
}

/** Parse the model reply from {@link buildDepositPrompt}; tolerant of code fences. */
export function parseDepositReply(reply: string): DepositDraft | null {
  const match = /\{[\s\S]*\}/.exec(reply)
  if (match === null) return null
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : []
    const draft: DepositDraft = {
      title: text(parsed.title),
      symptom: text(parsed.symptom),
      cause: text(parsed.cause),
      fix: text(parsed.fix),
      tags,
      notes: text(parsed.notes),
    }
    if (draft.title === '') return null
    return draft
  } catch {
    return null
  }
}
