import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, type YAMLSeq } from 'yaml'
import { readTextFile, writeTextAtomic, backupFile } from './fsutil.js'

export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

export interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
}

export interface PatchFileState {
  ok: boolean
  rows: PatchRow[]
  raw: string
  problem?: string
}

/**
 * Parse the profile user patch layer (a YAML list of rows). `!!js` tags are
 * never evaluated here — the value is structural only. An empty or absent file
 * is a valid empty list.
 */
export function readPatchFile(profileDir: string): PatchFileState {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  const raw = readTextFile(file)
  if (raw === null || raw.trim() === '') return { ok: true, rows: [], raw: raw ?? '' }
  try {
    const doc = parseDocument(raw)
    const rows = rowsOf(doc)
    if (rows === null) return { ok: false, rows: [], raw, problem: 'patch file is not a YAML list' }
    return { ok: true, rows, raw }
  } catch (error) {
    return { ok: false, rows: [], raw, problem: `patch file is not valid YAML: ${String(error)}` }
  }
}

function rowsOf(doc: ReturnType<typeof parseDocument>): PatchRow[] | null {
  let value: unknown
  try {
    value = doc.toJS()
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null
  return value.map((row) => (typeof row === 'object' && row !== null ? (row as PatchRow) : {}))
}

export interface PatchWriteResult {
  ok: boolean
  problem?: string
  backup: string | null
}

function newDisabledText(rowId: string): string {
  return `- id: ${JSON.stringify(rowId)}\n  disabled: true\n`
}

/**
 * Append `- id: <rowId>` + `disabled: true` to the user patch layer. A later
 * row with the same id overrides earlier rows, so this disables the entry
 * without touching the user's own rows. Never writes through an unparsable
 * file and always leaves a backup.
 */
export function appendDisabledRow(profileDir: string, rowId: string): PatchWriteResult {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  const state = readPatchFile(profileDir)
  if (!state.ok) {
    return { ok: false, problem: state.problem ?? 'patch layer is unparsable; refusing to write', backup: null }
  }
  const backup = backupFile(file)
  const body = state.raw.trim() === '' ? '' : state.raw.endsWith('\n') ? state.raw : `${state.raw}\n`
  writeTextAtomic(file, `${body}${newDisabledText(rowId)}`)
  return { ok: true, backup }
}

/**
 * Remove the trailing row that this tool appended for `rowId` (the last row
 * carrying that id with `disabled: true`), restoring the previous state.
 */
export function removeDisabledRow(profileDir: string, rowId: string): PatchWriteResult {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  const state = readPatchFile(profileDir)
  if (!state.ok) {
    return { ok: false, problem: state.problem ?? 'patch layer is unparsable; refusing to write', backup: null }
  }
  let target = -1
  for (let i = state.rows.length - 1; i >= 0; i--) {
    if (state.rows[i]?.id === rowId && state.rows[i]?.disabled === true) {
      target = i
      break
    }
  }
  if (target === -1) {
    return { ok: false, problem: `no disabled row found for ${JSON.stringify(rowId)}`, backup: null }
  }
  const backup = backupFile(file)
  const doc = parseDocument(state.raw)
  const seq = doc.contents as unknown as YAMLSeq | null
  if (seq === null || seq.items.length <= target) {
    return { ok: false, problem: 'patch tree changed while planning; retry', backup }
  }
  seq.items.splice(target, 1)
  writeTextAtomic(file, doc.toString())
  return { ok: true, backup }
}

export function patchFileExists(profileDir: string): boolean {
  return existsSync(join(profileDir, PROFILE_PATCH_FILENAME))
}
