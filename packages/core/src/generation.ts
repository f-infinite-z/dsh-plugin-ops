/**
 * Static port of the official runtime resolution generation (dsh 0.1.6+).
 *
 * dsh 0.1.6-alpha.2 defaults to runtime resolution: the launcher builds one
 * immutable package table from the installation manifest plus the selected
 * bundles and installs it into Node's resolvers, without materializing the
 * `$DSH_HOME/profiles/node_modules` mirror. Static checks that trust that
 * frozen mirror drift from the real boot; this module rebuilds the same table
 * on disk so the scan judges what the launcher actually resolves.
 *
 * Ported from the official app-boot algorithm
 * (`packages/boot/app-boot/src/profile.ts`: `resolveModuleFallbackEntries`,
 * `healProfileModuleFallback`, `dependencyClosure`, `packageDirFromAnchor`)
 * and `profile-resolution/legacy-links.ts`. The port keeps the same selection
 * policy: breadth-first over `dependencies` then `peerDependencies` from the
 * declaring manifest, first resolution wins, declared-but-uninstalled
 * packages are skipped, installation names are reserved, and bundle roots do
 * not become fallback entries.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { packageDirFromAnchor, readPackageManifest, type PackageManifest } from './package-tree.js'
import type { DshPaths } from './paths.js'
import type { ResolvedBundle } from './profile.js'

/** Profile-private package links projected into its pnpm-managed node_modules. */
export const PROFILE_MODULE_FALLBACK_DIR = '.dsh-module-fallback'

/** One package selected by the generation, mirroring the official entry. */
export interface GenerationEntry {
  /** Bare package name. */
  name: string
  /** Absolute package directory selected by the traversal. */
  dir: string
  /** Manifest version when declared. */
  version: string | null
  /** Absolute package.json path of the manifest whose dependency edge selected this package. */
  declarer: string
  /** Whether the entry came from the installation closure or a profile bundle. */
  scope: 'installation' | 'profile'
}

/** Immutable package table for one profile launch, mirroring the official generation. */
export interface ResolutionGeneration {
  /** Absolute package.json path of the located dsh installation; null when it could not be found. */
  installAnchor: string | null
  /** First-wins package table in precedence order. */
  entries: Map<string, GenerationEntry>
  /**
   * Bundle roots resolved through the installation anchor, mirroring the
   * official `resolveBundleDir` contract ("installation anchor first, then the
   * profile directory"). Bundle roots are deliberately absent from
   * {@link entries}; the launcher resolves them through this path, so a patch
   * row referencing one must resolve here.
   */
  bundleRoots: Map<string, string>
}

/** One resolved package and the resolution layer that produced it. */
export interface ResolvedPackage {
  dir: string
  /**
   * `bundle` = a selected bundle root resolved through the installation anchor
   * (the official `resolveBundleDir` contract); `profile-local` = the profile's
   * own dependency tree; `generation` = the runtime fallback table.
   */
  source: 'bundle' | 'profile-local' | 'generation'
}

function versionOf(manifest: PackageManifest | null): string | null {
  return manifest?.version === undefined ? null : String(manifest.version)
}

/** Official `profileDependencyNames`: dependencies first, then peers. */
function dependencyNames(manifest: PackageManifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/** Official `realModuleDirectory` without the pkg carrier branch (plain Node tool). */
function realModuleDirectory(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Official `canonicalLinkPath`: canonicalize the parent, keep the final component. */
function canonicalLinkPath(path: string): string | null {
  try {
    return join(realModuleDirectory(dirname(path)), basename(path))
  } catch {
    return null
  }
}

/** Official `symlinkPointsTo`. */
function symlinkPointsTo(link: string, target: string): boolean {
  let actual: string
  try {
    actual = resolve(dirname(link), readlinkSync(link))
  } catch {
    return false
  }
  const canonicalActual = canonicalLinkPath(actual)
  const canonicalTarget = canonicalLinkPath(resolve(target))
  return canonicalActual !== null && canonicalActual === canonicalTarget
}

/**
 * Official `isProfileModuleFallbackLink`: whether the observed profile entry is
 * a managed fallback projection rather than a profile-local package. Runtime
 * launches never read these projections, so they must not claim local
 * precedence during a static scan.
 */
export function isProfileFallbackProjection(profileDir: string, name: string): boolean {
  const link = join(profileDir, 'node_modules', name)
  const target = join(profileDir, PROFILE_MODULE_FALLBACK_DIR, 'node_modules', name)
  try {
    return lstatSync(link).isSymbolicLink() && symlinkPointsTo(link, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

/**
 * Locate the dsh installation manifest the launcher would use as its anchor.
 * The shared mirror's `@deepseek-ai/dsh` link is the primary source (it points
 * at the running installation even after an upgrade); an explicit config value
 * overrides it for non-standard layouts.
 * @param paths - resolved DSH paths.
 * @param configured - explicit install anchor directory or package.json path from config.
 * @returns the absolute package.json path, or null when no installation is locatable.
 */
export function locateInstallAnchor(paths: DshPaths, configured?: string | null): string | null {
  if (configured !== undefined && configured !== null && configured !== '') {
    const direct = configured.endsWith('package.json') ? configured : join(configured, 'package.json')
    if (existsSync(direct)) return direct
  }
  const mirror = join(paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json')
  return existsSync(mirror) ? mirror : null
}

/** Official `packageDirFromAnchor` with the projection-exclude hook for the profile plane. */
function resolveFromAnchor(
  anchor: string,
  name: string,
  exclude?: (candidate: string, packageName: string) => boolean,
): string | null {
  return packageDirFromAnchor(anchor, name, exclude)
}

/**
 * Walk one root manifest breadth-first, mirroring official `dependencyClosure`:
 * `dependencies` followed by `peerDependencies`, first resolution wins, missing
 * packages are skipped rather than failing the walk.
 */
function walkClosure(
  entries: Map<string, GenerationEntry>,
  startAnchor: string,
  startManifest: PackageManifest,
  scope: 'installation' | 'profile',
  exclude?: (candidate: string, packageName: string) => boolean,
): void {
  const queue: { anchor: string; manifest: PackageManifest }[] = [{ anchor: startAnchor, manifest: startManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dep of dependencyNames(next.manifest)) {
      if (entries.has(dep)) continue
      const dir = resolveFromAnchor(next.anchor, dep, exclude)
      if (dir === null) continue
      const manifest = readPackageManifest(dir)
      entries.set(dep, { name: dep, dir, version: versionOf(manifest), declarer: next.anchor, scope })
      if (manifest !== null) queue.push({ anchor: join(dir, 'package.json'), manifest })
    }
  }
}

/**
 * Rebuild the launcher's package table on disk: the installation closure from
 * the install anchor, then each selected bundle's closure, with installation
 * names reserved and bundle roots excluded from the fallback entries. Mirrors
 * official `resolveModuleFallbackEntries` plus the bundle half of
 * `healProfileModuleFallback`.
 * @param installAnchor - absolute installation package.json path, or null when unlocatable.
 * @param bundles - bundles resolved from the profile's `dsh.profile.bundles`.
 * @param profileDir - profile directory whose fallback projections are excluded.
 * @returns the immutable generation for one scan.
 */
export function buildResolutionGeneration(
  installAnchor: string | null,
  bundles: readonly ResolvedBundle[],
  profileDir: string,
): ResolutionGeneration {
  const entries = new Map<string, GenerationEntry>()
  const bundleRoots = new Map<string, string>()
  if (installAnchor !== null) {
    const appManifest = readPackageManifest(dirname(installAnchor))
    if (appManifest !== null) {
      if (typeof appManifest.name === 'string' && !entries.has(appManifest.name)) {
        entries.set(appManifest.name, {
          name: appManifest.name,
          dir: dirname(installAnchor),
          version: versionOf(appManifest),
          declarer: installAnchor,
          scope: 'installation',
        })
      }
      walkClosure(entries, installAnchor, appManifest, 'installation')
    }
  }
  const installationNames = new Set(entries.keys())
  const excludeProjection = (candidate: string, name: string): boolean => {
    const profileLink = join(profileDir, 'node_modules', name)
    if (canonicalLinkPath(candidate) !== canonicalLinkPath(profileLink)) return false
    return isProfileFallbackProjection(profileDir, name)
  }
  for (const bundle of bundles) {
    const canonicalDir = realModuleDirectory(bundle.dir)
    // Every selected bundle root resolves through the installation anchor
    // first (official resolveBundleDir), so the root is recorded regardless of
    // whether the installation closure already carries the name.
    bundleRoots.set(bundle.name, canonicalDir)
    if (installationNames.has(bundle.name)) continue
    const anchor = join(canonicalDir, 'package.json')
    const manifest = readPackageManifest(canonicalDir) ?? bundle.manifest
    if (typeof manifest.name !== 'string') continue
    if (!entries.has(manifest.name)) {
      entries.set(manifest.name, {
        name: manifest.name,
        dir: canonicalDir,
        version: versionOf(manifest),
        declarer: anchor,
        scope: 'profile',
      })
    }
    walkClosure(entries, anchor, manifest, 'profile', excludeProjection)
  }
  // Official semantics remove bundle roots only from the profile-bundle half;
  // an installation-closure bundle root (an in-box bundle that is also a dsh
  // dependency) keeps its installation entry.
  for (const bundle of bundles) {
    if (!installationNames.has(bundle.name)) entries.delete(bundle.name)
  }
  return { installAnchor, entries, bundleRoots }
}

function isWithin(child: string, parent: string): boolean {
  const relative = child.slice(parent.length).replace(/\\/g, '/')
  return (child === parent || relative.startsWith('/')) && !relative.startsWith('../')
}

/**
 * Resolve a package with runtime semantics. A selected bundle root resolves
 * through the installation anchor first — the official contract keeps in-box
 * bundles on the running installation and never on a profile-local copy.
 * Everything else follows the launcher's virtual fallback position: the
 * profile's own tree wins natively (fallback projections excluded), then the
 * generation table. Legacy disk links no longer participate.
 * @param generation - generation built by {@link buildResolutionGeneration}.
 * @param paths - resolved DSH paths.
 * @param name - bare package name to resolve.
 * @returns the resolved directory and its layer, or null when no layer owns the name.
 */
export function resolvePackageDir(
  generation: ResolutionGeneration,
  paths: DshPaths,
  name: string,
): ResolvedPackage | null {
  const bundleDir = generation.bundleRoots.get(name)
  if (bundleDir !== undefined) return { dir: bundleDir, source: 'bundle' }
  const profileNodeModules = join(paths.profileDir, 'node_modules')
  const local = packageDirFromAnchor(paths.profileManifest, name, (candidate) => {
    if (!isWithin(candidate, profileNodeModules)) return true
    return isProfileFallbackProjection(paths.profileDir, name)
  })
  if (local !== null && isWithin(local, profileNodeModules)) {
    return { dir: local, source: 'profile-local' }
  }
  const entry = generation.entries.get(name)
  if (entry !== undefined) return { dir: entry.dir, source: 'generation' }
  return null
}
