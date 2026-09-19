import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readJsonFile } from './fsutil.js'

/**
 * Node's own node_modules lookup order, same algorithm the dsh Loader uses
 * (behavioral port of `packageDirFromAnchor` in the official
 * packages/boot/app-boot/src/profile.ts; ~20 lines, kept in-process so we
 * never import the harness runtime). The optional `exclude` hook mirrors the
 * official signature: candidates it rejects are skipped, so a managed
 * fallback projection never claims local precedence.
 */
export function packageDirFromAnchor(
  anchorFile: string,
  packageName: string,
  exclude?: (candidate: string, packageName: string) => boolean,
): string | null {
  const require_ = createRequire(anchorFile)
  for (const searchPath of require_.resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json')) && !(exclude?.(candidate, packageName) ?? false)) return candidate
  }
  return null
}

export function packageDirFromAnchors(anchorFiles: readonly string[], packageName: string): string | null {
  for (const anchor of anchorFiles) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== null) return dir
  }
  return null
}

export interface PackageManifest {
  name?: unknown
  version?: unknown
  type?: unknown
  main?: unknown
  types?: unknown
  exports?: unknown
  files?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: unknown }; profile?: unknown; client?: unknown }
}

export function readPackageManifest(dir: string): PackageManifest | null {
  return readJsonFile<PackageManifest>(join(dir, 'package.json'))
}
