import { join } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { backupFile, readTextFile, writeTextAtomic } from './fsutil.js'

/**
 * pnpm dependency-build options (`pnpm-workspace.yaml`).
 *
 * dsh's bundled pnpm (11.7) gates dependency build scripts on the
 * `allowBuilds` map: an install that hits a gated script fails with
 * `ERR_PNPM_IGNORED_BUILDS` until each package is set to `true` (or `false`).
 * In the field, a failed install leaves the map carrying placeholder values
 * (non-boolean strings) that block every retry — the official hint points at
 * `pnpm approve-builds`, which the sandbox workflow cannot run interactively.
 * This reader lets the tools see that state without shelling out to pnpm.
 */

/** The `allowBuilds` state inside one profile. */
export interface AllowBuildsState {
  /** The raw `allowBuilds` value, or null when the key is absent (or the file is unreadable). */
  value: unknown | null
  /** Entry names whose value is not a boolean: placeholders that still need true/false. */
  placeholders: string[]
}

/**
 * Read `allowBuilds` from the profile's `pnpm-workspace.yaml`.
 * @param profileDir - profile directory to read from.
 * @returns the raw value and any placeholder entries; a missing key or file reads as absent.
 */
export function readAllowBuildsState(profileDir: string): AllowBuildsState {
  const raw = readTextFile(join(profileDir, 'pnpm-workspace.yaml'))
  if (raw === null) return { value: null, placeholders: [] }
  let parsed: unknown
  try {
    parsed = parseDocument(raw).toJS()
  } catch {
    return { value: null, placeholders: [] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, placeholders: [] }
  }
  const value = (parsed as Record<string, unknown>).allowBuilds
  if (value === undefined) return { value: null, placeholders: [] }
  const placeholders: string[] = []
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== 'boolean') placeholders.push(name)
    }
  } else if (typeof value !== 'boolean') {
    // A scalar stand-in for the whole map is a placeholder too.
    placeholders.push('(the whole allowBuilds map)')
  }
  return { value, placeholders }
}

/** The outcome of one `allowBuilds` write. */
export interface AllowBuildsWrite {
  ok: boolean
  /** Backup path written before the change, when one was made. */
  backup: string | null
  problem?: string
}

/**
 * Set `allowBuilds` entries in the profile's `pnpm-workspace.yaml`, keeping
 * the rest of the document (comments included) intact. An absent key is
 * created as a mapping; an existing non-mapping key is refused rather than
 * overwritten, so a malformed file keeps its shape for the user to inspect.
 * @param profileDir - profile directory holding `pnpm-workspace.yaml`.
 * @param updates - package name → allow (true) or deny (false).
 * @returns the write outcome with the backup path when one was made.
 */
export function setAllowBuilds(profileDir: string, updates: Record<string, boolean>): AllowBuildsWrite {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  const raw = readTextFile(file)
  if (raw === null) return { ok: false, backup: null, problem: 'pnpm-workspace.yaml does not exist in the profile' }
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) {
    return { ok: false, backup: null, problem: `pnpm-workspace.yaml is not valid YAML: ${doc.errors[0]?.message ?? 'unknown error'}` }
  }
  const current = doc.get('allowBuilds')
  if (current !== undefined && current !== null && !isMap(current)) {
    return { ok: false, backup: null, problem: 'allowBuilds is not a mapping; resolve it by hand first' }
  }
  for (const [name, allow] of Object.entries(updates)) {
    doc.setIn(['allowBuilds', name], allow)
  }
  const backup = backupFile(file)
  try {
    writeTextAtomic(file, doc.toString())
  } catch (error) {
    return { ok: false, backup, problem: `writing pnpm-workspace.yaml failed: ${String(error)}` }
  }
  return { ok: true, backup }
}
