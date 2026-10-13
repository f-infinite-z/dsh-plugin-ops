import { readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { readPackageManifest } from './package-tree.js'
import { CORE_PACKAGES } from './peers.js'
import { locateCliInstallAnchor } from './cli-anchor.js'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'

/**
 * Rule 10: duplicate physical copies of one package inside the resolved
 * install tree. Native/binding packages and the cordis family register
 * process-global names at module evaluation; two same-version copies loaded
 * into one process collide. The observed field case (2026-10-13, reported by
 * the session-audit author): an install tree had accumulated four identical
 * copies of `@deepseek-ai/dsh-win32-process`; the second copy's koffi struct
 * registration threw `Duplicate type name 'DSH_STARTUPINFOW'` at load, and
 * the plugin loader swallowed the message — the boot failed with only
 * "could not be resolved" and official static checks (`--dump-config`)
 * passed. A fresh install of the same version carried exactly one copy, so
 * this is a tree-state defect, and it is invisible to every static gate that
 * does not count physical copies.
 *
 * Scope: only `@deepseek-ai/*` and framework-core names are reported.
 * Same-version duplicates of ordinary third-party packages are common and
 * harmless, while the official install tree is expected to carry exactly one
 * physical copy of each official package. pnpm layouts are deduplicated by
 * real path: one store entity behind many symlinks is one copy.
 */

/** Upper bound on package directories one scan walks, guarding huge global prefixes. */
const MAX_PACKAGE_DIRS = 10_000

/**
 * The package name a canonical package directory implies (`…/node_modules/name`
 * or `…/node_modules/@scope/name`), or null when the directory does not sit in
 * that layout. Used to filter during the walk so no manifest is read until a
 * name actually has several copies.
 */
function nameFromCanonical(dir: string): string | null {
  const parts = dir.split(sep)
  if (parts.length < 2) return null
  const last = parts[parts.length - 1]
  if (last === undefined || last === '') return null
  const parent = parts[parts.length - 2]
  if (parent === 'node_modules') return last
  if (parent !== undefined && parent.startsWith('@') && parts[parts.length - 3] === 'node_modules') {
    return `${parent}/${last}`
  }
  return null
}

/** List package directories directly inside one `node_modules` directory. */
function listPackageDirs(nodeModulesDir: string): string[] {
  let entries
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const full = join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      let subs
      try {
        subs = readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of subs) {
        if (sub.isDirectory() || sub.isSymbolicLink()) out.push(join(full, sub.name))
      }
    } else {
      out.push(full)
    }
  }
  return out
}

/** Resolve a directory to its physical path; null when unreadable. */
function physicalPath(dir: string): string | null {
  try {
    return realpathSync.native(dir)
  } catch {
    return null
  }
}

/**
 * The physical install tree a canonical package path belongs to: everything
 * above the first `node_modules` segment. Copies in different trees (the
 * shared-closure mirror an old home retains vs the global installation) do
 * not share a module-resolution chain and are not the collision this rule
 * looks for; only copies inside one tree are.
 */
function treeAnchor(canonicalDir: string): string {
  const parts = canonicalDir.split(sep)
  const index = parts.indexOf('node_modules')
  if (index <= 0) return canonicalDir
  return parts.slice(0, index).join(sep) || sep
}

/**
 * The directory whose `node_modules` holds the installation: walk up from the
 * anchor package directory to its nearest `node_modules` ancestor and return
 * that ancestor's parent. Null when the anchor sits outside any node_modules
 * (a non-standard layout the walk cannot scope).
 */
function installScanRoot(anchor: string): string | null {
  let current = dirname(anchor)
  for (let guard = 0; guard < 32; guard++) {
    const parent = dirname(current)
    if (basename(current) === 'node_modules') return parent
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Walk one tree recording the physical directories of `@deepseek-ai/*` and
 * framework-core package names. Symlinked package directories resolve to
 * their target, so a pnpm store entity behind many links records once; nested
 * `node_modules` inside packages are walked, which is where accumulated
 * duplicate copies live. Visited physical directories are not re-walked, and
 * no manifest is read — only the directory layout decides what to look at.
 */
function collectCopies(
  rootDir: string,
  records: Map<string, Set<string>>,
  visited: Set<string>,
  budget: { remaining: number },
): void {
  const walk = (dir: string): void => {
    if (budget.remaining <= 0) return
    for (const pkgDir of listPackageDirs(join(dir, 'node_modules'))) {
      if (budget.remaining <= 0) return
      budget.remaining--
      const canonical = physicalPath(pkgDir)
      if (canonical === null || visited.has(canonical)) continue
      visited.add(canonical)
      const name = nameFromCanonical(canonical)
      if (name !== null && (name.startsWith('@deepseek-ai/') || CORE_PACKAGES.has(name))) {
        const key = `${treeAnchor(canonical)}\u0000${name}`
        let dirs = records.get(key)
        if (dirs === undefined) {
          dirs = new Set()
          records.set(key, dirs)
        }
        dirs.add(canonical)
      }
      walk(canonical)
    }
  }
  walk(rootDir)
}

/** Whether `child` sits inside `parent` (both absolute, same platform). */
function isWithin(child: string, parent: string): boolean {
  const relative = child.slice(parent.length).replace(/\\/g, '/')
  return (child === parent || relative.startsWith('/')) && !relative.startsWith('../')
}

/**
 * Rule 10: report `@deepseek-ai/*` and framework-core packages that exist as
 * more than one physical copy at the same version inside one installation
 * tree. A same-version duplicate is a load-time hazard for packages with
 * module-evaluation side effects and is always an install-tree hygiene defect
 * (cumulative installs/upgrades leave residues; a fresh install carries one
 * copy).
 * @param ctx - the scan rule context (profile paths, generation anchor).
 * @returns one finding per duplicated official/core package, fatal for
 *   framework core, warn otherwise.
 */
export function ruleDuplicateCopies(ctx: RuleContext): Finding[] {
  const roots: string[] = [ctx.paths.profileDir]
  const addRoot = (anchor: string | null): void => {
    if (anchor === null) return
    // The legacy shared-closure mirror ($DSH_HOME/profiles/node_modules) holds
    // a full old installation that no launcher since 0.1.6 reads; its internal
    // duplicates can never load into one process, so scanning it only
    // manufactures dead-tree findings.
    if (isWithin(anchor, ctx.paths.sharedProfilesDir)) return
    const installRoot = installScanRoot(anchor)
    if (installRoot === null || roots.includes(installRoot)) return
    roots.push(installRoot)
  }
  // The real runtime tree: the installation behind the `dsh` command on PATH,
  // then a configured/explicit anchor (desktop runtime, custom installs).
  addRoot(locateCliInstallAnchor())
  addRoot(ctx.generation.installAnchor)
  const records = new Map<string, Set<string>>()
  const visited = new Set<string>()
  const budget = { remaining: MAX_PACKAGE_DIRS }
  for (const root of roots) collectCopies(root, records, visited, budget)

  const findings: Finding[] = []
  for (const [key, dirs] of records) {
    if (dirs.size < 2) continue
    const name = key.slice(key.indexOf('\u0000') + 1)
    // Only now read manifests: group the candidate copies by version and
    // report same-version sets (different-version nesting is ordinary npm
    // resolution, not accumulated residue).
    const byVersion = new Map<string, string[]>()
    for (const dir of dirs) {
      const manifest = readPackageManifest(dir)
      const version = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
      if (version === null) continue
      const bucket = byVersion.get(version)
      if (bucket === undefined) byVersion.set(version, [dir])
      else bucket.push(dir)
    }
    for (const [version, paths] of byVersion) {
      if (paths.length < 2) continue
      const core = CORE_PACKAGES.has(name)
      const copies = [...paths].sort()
      const shown = copies.slice(0, 3).join('\n  ')
      findings.push({
        ruleId: 'duplicate-copies',
        severity: core ? 'fatal' : 'warn',
        packageName: name,
        message: `${copies.length} physical copies of ${name}@${version} exist in one install tree`,
        detail: `copies:\n  ${shown}${copies.length > 3 ? `\n  … ${copies.length - 3} more` : ''}\n`
          + 'same-version residues accumulate across installs/upgrades; at module evaluation such packages register '
          + 'process-global names (native bindings, koffi types) and the second copy fails at load, with the reason swallowed '
          + 'by the plugin loader; reinstall the tree (or the profile) to collapse the copies',
        nextAction: 'reinstall-tree',
        fix: { kind: 'none' },
      })
    }
  }
  findings.sort((a, b) => (a.severity === b.severity
    ? (a.packageName ?? '').localeCompare(b.packageName ?? '')
    : a.severity === 'fatal' ? -1 : 1))
  return findings
}
