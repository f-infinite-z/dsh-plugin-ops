import { readWantedLockfile } from '@pnpm/lockfile-file'
import { readTextFile } from './fsutil.js'
import { join } from 'node:path'

export interface LockedDirectDeps {
  /** package name → locked version string, for the project importer ('.'). */
  versions: Record<string, string>
  /** lockfileVersion as parsed from the file (e.g. '9.0'). */
  lockfileVersion: string | null
  missing: boolean
  incompatible: boolean
  /**
   * Why the lockfile is unusable: `unsupported` when the file parses but
   * carries a format version this reader rejects, `damaged` when it cannot be
   * parsed at all (truncation, NUL bytes, a partial write). Null when the
   * lockfile is usable or simply absent.
   */
  incompatibleReason: 'unsupported' | 'damaged' | null
  /** The version declared in the file head, when readable (best effort, set only for an unusable file). */
  incompatibleVersion: string | null
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
 * The importer's locked version may carry a peer-context suffix
 * (`0.2.37(react@18.3.1)`); the disk manifest only records the bare version,
 * so the comparison key strips anything from the first `(`.
 */
function bareVersion(version: string): string {
  const cut = version.indexOf('(')
  return cut === -1 ? version : version.slice(0, cut)
}

/** The lockfileVersion declared in the file head, readable even when the rest of the file is damaged. */
function headLockfileVersion(raw: string): string | null {
  const match = /^lockfileVersion:\s*'?([0-9][0-9.]*)'?\s*$/m.exec(raw.slice(0, 1024))
  return match === null ? null : match[1]!
}

/** The result for a file that exists but cannot be used. */
function unusable(reason: 'unsupported' | 'damaged', raw: string): LockedDirectDeps {
  return {
    versions: {},
    lockfileVersion: null,
    missing: false,
    incompatible: true,
    incompatibleReason: reason,
    incompatibleVersion: headLockfileVersion(raw),
  }
}

/**
 * Read the profile's pnpm-lock.yaml and extract direct dependency lock
 * versions. An unusable lockfile is reported through `incompatible` (caller
 * degrades conservatively) rather than thrown, per the self-reliance
 * contract: unknown schema must never crash the scanner. The reason is kept
 * apart — a rejected format version versus a file that cannot be parsed at
 * all — so the caller can say which one happened instead of guessing.
 */
export async function readLockedDirectDeps(profileDir: string): Promise<LockedDirectDeps> {
  const raw = readTextFile(join(profileDir, 'pnpm-lock.yaml'))
  if (raw === null) {
    return { versions: {}, lockfileVersion: null, missing: true, incompatible: false, incompatibleReason: null, incompatibleVersion: null }
  }
  try {
    const lockfile = (await readWantedLockfile(profileDir, { ignoreIncompatible: true })) as LockfileLike | null
    if (lockfile === null) {
      // The reader found nothing to parse in a file that exists (a race with
      // a writer, or a stricter reader than the one probed here); a non-empty
      // file reads as a rejected format, an empty one as damage.
      return unusable(raw.trim() === '' ? 'damaged' : 'unsupported', raw)
    }
    const importer = lockfile.importers?.['.']
    const versions: Record<string, string> = {}
    if (importer) {
      for (const group of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
        if (!group) continue
        for (const [name, version] of Object.entries(group)) {
          if (!version.startsWith('link:') && !version.startsWith('file:')) {
            versions[name] = bareVersion(version)
          }
        }
      }
    }
    return { versions, lockfileVersion: String(lockfile.lockfileVersion), missing: false, incompatible: false, incompatibleReason: null, incompatibleVersion: null }
  } catch {
    // YAML parse failures land here (truncated or otherwise damaged files).
    return unusable('damaged', raw)
  }
}
