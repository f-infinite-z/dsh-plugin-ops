import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import type { ResolvedBundle } from './profile.js'
import { readPatchFile, PROFILE_PATCH_FILENAME, type PatchRow } from './patch-layer.js'

export interface RowRef {
  source: string
  row: PatchRow
}

function rowsOfFile(file: string, label: string): RowRef[] {
  if (!existsSync(file)) return []
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'))
    const value: unknown = doc.toJS()
    if (!Array.isArray(value)) return []
    const refs: RowRef[] = []
    for (const row of value) {
      if (typeof row === 'object' && row !== null) {
        refs.push({ source: label, row: row as PatchRow })
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
    const patchFile = join(bundle.dir, bundle.patch)
    refs.push(...rowsOfFile(patchFile, `${bundle.name}@${bundle.patch}`))
  }
  refs.push(...rowsOfFile(join(profileDir, PROFILE_PATCH_FILENAME), `${PROFILE_PATCH_FILENAME} (user layer)`))
  return refs
}

/**
 * Row ids that compose the given package. A row composes a package when its
 * `name` is the package (bare specifiers import through Node resolution) or
 * when its `id` names the package directly.
 */
export function rowIdsForPackage(refs: RowRef[], packageName: string): string[] {
  const ids = new Set<string>()
  for (const ref of refs) {
    const row = ref.row
    if (row.name === packageName || row.id === packageName) {
      const id = row.id ?? packageName
      ids.add(id)
    }
  }
  return [...ids]
}
