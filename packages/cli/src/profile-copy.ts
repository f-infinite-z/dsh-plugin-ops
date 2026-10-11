import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Profile copy support for the gate's sandbox fix verification: copy a
 * profile's manifest and boot files (never node_modules — the sandbox
 * installs its own tree from the copied lockfile through the official
 * channel, which is store-hit fast), and mirror the local `file:`
 * dependencies so the copy installs in its new location.
 */

/** The files a profile copy carries into a sandbox. */
export const PROFILE_COPY_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'cordis.yml',
  '.npmrc',
]

/**
 * Mirror the relative `file:` dependencies a lockfile references so the copy
 * installs in a different location. pnpm records a `file:` dependency's
 * resolution relative to the profile directory (even an absolute
 * `file:C:/...` specifier lands as a relative `file:../../../...` entry in
 * the lockfile), and a copy elsewhere resolves those references to nowhere —
 * the install fails with ENOENT. Relative targets are re-created at the same
 * relative location inside the copy: files are copied, directories become
 * symlinks (junctions on Windows) so nothing large is duplicated. Absolute
 * references need no mirroring — they resolve to the same file in place.
 */
function mirrorFileDependencies(sourceProfileDir: string, targetProfileDir: string): void {
  const lockfilePath = join(sourceProfileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockfilePath)) return
  let lockfile: string
  try {
    lockfile = readFileSync(lockfilePath, 'utf8')
  } catch {
    return
  }
  const seen = new Set<string>()
  for (const match of lockfile.matchAll(/file:([^\s'",)}]+)/g)) {
    const ref = match[1]!.replace(/\\/g, '/')
    if (/^[A-Za-z]:/.test(ref) || ref.startsWith('/')) continue
    if (seen.has(ref)) continue
    seen.add(ref)
    const source = resolve(sourceProfileDir, ref)
    const target = resolve(targetProfileDir, ref)
    if (!existsSync(source) || existsSync(target)) continue
    try {
      mkdirSync(dirname(target), { recursive: true })
      if (statSync(source).isDirectory()) {
        symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      } else if (process.platform === 'win32') {
        copyFileSync(source, target)
      } else {
        symlinkSync(source, target)
      }
    } catch {
      /* best effort; the install reports the real problem */
    }
  }
}

/** Copy the profile's manifest and boot files into the target directory, mirroring relative `file:` dependencies. */
export function copyProfileFiles(sourceProfileDir: string, targetProfileDir: string): void {
  for (const name of PROFILE_COPY_FILES) {
    const from = join(sourceProfileDir, name)
    if (existsSync(from)) cpSync(from, join(targetProfileDir, name))
  }
  mirrorFileDependencies(sourceProfileDir, targetProfileDir)
}
