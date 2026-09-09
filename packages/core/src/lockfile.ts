import { readWantedLockfile } from '@pnpm/lockfile-file'
import { readTextFile } from './fsutil.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LockedDirectDeps {
  /** package name → locked version string, for the project importer ('.'). */
  versions: Record<string, string>
  /** lockfileVersion as parsed from the file (e.g. '9.0'). */
  lockfileVersion: string | null
  missing: boolean
  incompatible: boolean
}

interface ImporterLike {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface LockfileLike {
  importers?: Record<string, ImporterLike>
  lockfileVersion?: unknown
}

/**
 * Read the profile's pnpm-lock.yaml and extract direct dependency lock
 * versions. An unsupported lockfile format is reported as `incompatible`
 * (caller degrades conservatively) rather than thrown, per the self-reliance
 * contract: unknown schema must never crash the scanner.
 */
export async function readLockedDirectDeps(profileDir: string): Promise<LockedDirectDeps> {
  const raw = readTextFile(join(profileDir, 'pnpm-lock.yaml'))
  if (raw === null) {
    return { versions: {}, lockfileVersion: null, missing: true, incompatible: false }
  }
  try {
    const lockfile = (await readWantedLockfile(profileDir, { ignoreIncompatible: true })) as LockfileLike | null
    if (lockfile === null) {
      return { versions: {}, lockfileVersion: null, missing: false, incompatible: true }
    }
    const importer = lockfile.importers?.['.']
    const versions: Record<string, string> = {}
    if (importer) {
      for (const group of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
        if (!group) continue
        for (const [name, version] of Object.entries(group)) {
          if (!version.startsWith('link:') && !version.startsWith('file:')) {
            versions[name] = version
          }
        }
      }
    }
    return { versions, lockfileVersion: String(lockfile.lockfileVersion), missing: false, incompatible: false }
  } catch {
    return { versions: {}, lockfileVersion: null, missing: false, incompatible: true }
  }
}

export function hasLockfile(profileDir: string): boolean {
  return existsSync(join(profileDir, 'pnpm-lock.yaml'))
}
