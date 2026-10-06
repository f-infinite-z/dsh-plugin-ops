import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import type { ResolvedBundle } from './profile.js'
import { PROFILE_PATCH_FILENAME, type PatchRow } from './patch-layer.js'

export interface RowRef {
  source: string
  row: PatchRow
  /**
   * True when the row was introduced by an `insert` directive — the only form
   * that creates an entry. False for a flat configuration patch, which merges
   * its fields into an entry an earlier insert created.
   */
  inserted: boolean
  /**
   * Directory a relative module path in this row resolves against: the patch
   * file's own directory for bundle rows, the profile directory for the user
   * layer (app boot anchors inserted paths beside their patch file).
   */
  baseDir: string
}

function rowsOfFile(file: string, label: string, baseDir: string): RowRef[] {
  if (!existsSync(file)) return []
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'))
    const value: unknown = doc.toJS()
    if (!Array.isArray(value)) return []
    const refs: RowRef[] = []
    const pushRow = (row: unknown, inserted: boolean) => {
      if (typeof row === 'object' && row !== null) {
        refs.push({ source: label, row: row as PatchRow, inserted, baseDir })
      }
    }
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>
        // `insert` directives nest the real rows (applyEntryPatches semantics).
        if (Array.isArray(record.insert)) {
          for (const sub of record.insert) pushRow(sub, true)
        } else {
          pushRow(item, false)
        }
      }
    }
    return refs
  } catch {
    return []
  }
}

/**
 * Every visible Loader row from the user patch layer plus each bundle's patch
 * file — the static equivalent of what the include root composes at boot.
 */
export function allVisibleRows(profileDir: string, bundles: ResolvedBundle[]): RowRef[] {
  const refs: RowRef[] = []
  for (const bundle of bundles) {
    for (const patch of bundle.patches) {
      const patchFile = join(bundle.dir, patch)
      refs.push(...rowsOfFile(patchFile, `${bundle.name}@${patch}`, bundle.dir))
    }
  }
  refs.push(...rowsOfFile(join(profileDir, PROFILE_PATCH_FILENAME), `${PROFILE_PATCH_FILENAME} (user layer)`, profileDir))
  return refs
}

/**
 * Row ids that compose the given package. A row composes a package when its
 * `name` is the package or a subpath of it (bare specifiers import through
 * Node resolution) or when its `id` names the package directly.
 */
export function rowIdsForPackage(refs: RowRef[], packageName: string): string[] {
  const ids = new Set<string>()
  for (const ref of refs) {
    const row = ref.row
    const name = row.name
    const matches = name === packageName || name?.startsWith(`${packageName}/`) === true || row.id === packageName
    if (matches) {
      const id = row.id ?? packageName
      ids.add(id)
    }
  }
  return [...ids]
}
