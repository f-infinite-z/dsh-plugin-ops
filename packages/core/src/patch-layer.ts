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
  const rows: PatchRow[] = []
  const pushRow = (row: unknown) => {
    if (typeof row === 'object' && row !== null) rows.push(row as PatchRow)
  }
  for (const item of value) {
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>
      if (Array.isArray(record.insert)) {
        for (const sub of record.insert) pushRow(sub)
      } else {
        pushRow(item)
      }
    }
  }
  return rows
}

export interface PatchWriteResult {
  ok: boolean
  problem?: string
  backup: string | null
}

/**
 * Append a flat `id + disabled: true` row to the user patch layer by pushing a
 * node into the root sequence. A later row with the same id overrides earlier
 * rows, so this disables the entry without touching the user's own rows.
 * Structural append is required because the official profile template ships a
 * comment header plus an empty `[]` placeholder — text-concatenating after it
 * would corrupt the document. Never writes through an unparsable file and
 * always leaves a backup.
 */
export function appendDisabledRow(profileDir: string, rowId: string): PatchWriteResult {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  const raw = readTextFile(file)
  const backup = backupFile(file)
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(raw ?? '')
    if (doc.contents === null) {
      doc.contents = doc.createNode([])
    }
    const seq = doc.contents as unknown as YAMLSeq
    if (!Array.isArray(doc.toJS())) {
      return { ok: false, problem: 'patch file root is not a YAML list; refusing to write', backup }
    }
    seq.items.push(doc.createNode({ id: rowId, disabled: true }))
    writeTextAtomic(file, doc.toString())
    return { ok: true, backup }
  } catch (error) {
    return { ok: false, problem: `patch layer is not valid YAML: ${String(error)}`, backup }
  }
}

/**
 * Remove the trailing flat row that this tool appended for `rowId` (the last
 * root-level row carrying that id with `disabled: true`), restoring the
 * previous state. Root-level flat rows are what appendDisabledRow writes, so
 * removal scans the document's root items directly, never the insert-expanded
 * view.
 */
export function removeDisabledRow(profileDir: string, rowId: string): PatchWriteResult {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  const state = readPatchFile(profileDir)
  if (!state.ok) {
    return { ok: false, problem: state.problem ?? 'patch layer is unparsable; refusing to write', backup: null }
  }
  const backup = backupFile(file)
  const doc = parseDocument(state.raw)
  const seq = doc.contents as unknown as YAMLSeq | null
  if (seq === null) {
    return { ok: false, problem: 'patch file is not a YAML list', backup }
  }
  const rootValue: unknown = doc.toJS()
  if (!Array.isArray(rootValue)) {
    return { ok: false, problem: 'patch file is not a YAML list', backup }
  }
  let target = -1
  for (let i = rootValue.length - 1; i >= 0; i--) {
    const value = rootValue[i]
    if (typeof value === 'object' && value !== null && !Array.isArray((value as Record<string, unknown>).insert)) {
      const record = value as PatchRow
      if (record.id === rowId && record.disabled === true) {
        target = i
        break
      }
    }
  }
  if (target === -1) {
    return { ok: false, problem: `no disabled row found for ${JSON.stringify(rowId)}`, backup }
  }
  seq.items.splice(target, 1)
  writeTextAtomic(file, doc.toString())
  return { ok: true, backup }
}

export function patchFileExists(profileDir: string): boolean {
  return existsSync(join(profileDir, PROFILE_PATCH_FILENAME))
}
