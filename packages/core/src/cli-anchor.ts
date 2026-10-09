/**
 * Locate the dsh installation through the `dsh` command on PATH.
 *
 * Modern dsh (0.1.6+ runtime resolution) derives its own bundle anchor from
 * the running launcher's real path and never writes the legacy
 * `$DSH_HOME/profiles/node_modules` mirror, so a fresh home has no physical
 * file for a static scanner to read. The command the version probe would run
 * (`dsh --version`) is then the authoritative anchor source: same PATH order,
 * same installation the launcher would execute.
 *
 * The probe is pure filesystem reads (no process spawn) and caches its result
 * once per process.
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

let cached: string | null | undefined

/** Drop the cached CLI-derived anchor; tests that rewrite PATH call this. */
export function resetCliAnchorCache(): void {
  cached = undefined
}

/**
 * Locate the installation manifest through the first `dsh` shim on PATH.
 * @returns the absolute installation package.json path, or null when no shim
 * resolves to a readable installation.
 */
export function locateCliInstallAnchor(): string | null {
  if (cached !== undefined) return cached
  cached = probeCliAnchor()
  return cached
}

function probeCliAnchor(): string | null {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh'] : ['dsh']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    for (const name of names) {
      const shim = join(dir, name)
      if (!existsSync(shim)) continue
      const anchor = anchorThroughShim(shim)
      if (anchor !== null) return anchor
    }
  }
  return null
}

/**
 * Resolve the installation manifest behind one CLI shim. First the ancestor
 * `node_modules` chain around the shim, which covers npm prefixes (`dsh.cmd`
 * beside `<prefix>/node_modules`), npx (the ghost directory's `node_modules`
 * one level up from `.bin`), and Unix prefixes (`<prefix>/lib/node_modules`);
 * then the shim text itself, whose generated forms name the target relative
 * to the shim's own directory (`%dp0%` / `$basedir`) or absolutely.
 */
function anchorThroughShim(shim: string): string | null {
  const relative = join('@deepseek-ai', 'dsh', 'package.json')
  let dir = dirname(shim)
  for (let depth = 0; depth < 6; depth += 1) {
    for (const base of [join(dir, 'node_modules'), join(dir, 'lib', 'node_modules')]) {
      const candidate = join(base, relative)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return anchorFromShimText(shim)
}

/** A `node_modules/@deepseek-ai/dsh/` reference in a shim, rebased at the shim's directory when self-relative. */
function anchorFromShimText(shim: string): string | null {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return null
  }
  const references = text.match(/[^\s"']*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]/g) ?? []
  const shimDir = dirname(shim)
  for (const reference of references) {
    const rebased = reference
      .replace(/%~dp0|%dp0%/gi, shimDir)
      .replace(/\$(?:basedir|psscriptroot)/gi, shimDir)
    if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(rebased) || /[%$]/.test(rebased)) continue
    const candidate = join(rebased, 'package.json')
    if (existsSync(candidate)) return candidate
  }
  return null
}
