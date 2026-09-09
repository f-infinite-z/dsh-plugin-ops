import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './fsutil.js'
import {
  packageDirFromAnchors,
  readPackageManifest,
  type PackageManifest,
} from './package-tree.js'
import type { DshPaths } from './paths.js'

export interface ProfileManifest {
  name?: unknown
  version?: unknown
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown; patchReload?: unknown }; bundle?: { patch?: unknown } }
}

export function readProfileManifest(manifestFile: string): ProfileManifest | null {
  return readJsonFile<ProfileManifest>(manifestFile)
}

export function profileBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((b): b is string => typeof b === 'string')
}

/** Direct dependencies with plain registry specifiers (no file:/link:/git:/workspace:). */
export function registryDependencies(manifest: ProfileManifest): Record<string, string> {
  const deps = manifest.dependencies ?? {}
  const out: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (!spec.includes(':')) out[name] = spec
  }
  return out
}

/**
 * Find a real package.json inside the shared installation closure directory
 * (`$DSH_HOME/profiles/node_modules`), which mirrors the dsh installation's
 * dependency closure. The Loader resolves from that anchor first, so bundles
 * installed only there must be found from it. Returns null when the closure is
 * absent (fresh machine, nothing installed yet).
 */
function anchorInsideSharedClosure(sharedDir: string): string | null {
  if (!existsSync(sharedDir)) return null
  const scoped = readdirSync(sharedDir, { withFileTypes: true })
  for (const entry of scoped) {
    const base = join(sharedDir, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const sub of readdirSync(base, { withFileTypes: true })) {
        const manifest = join(base, sub.name, 'package.json')
        if (sub.isDirectory() && existsSync(manifest)) return manifest
      }
    }
    const manifest = join(base, 'package.json')
    if (entry.isDirectory() && existsSync(manifest)) return manifest
  }
  return null
}

/**
 * Resolution anchors in Loader order: the profile's own dependency tree first,
 * then the shared installation closure. Mirrors the official two-anchor
 * contract (profile-local copy vs installation copy).
 */
export function anchorFiles(paths: DshPaths): string[] {
  const anchors = [paths.profileManifest]
  const shared = anchorInsideSharedClosure(paths.sharedProfilesDir)
  if (shared !== null) anchors.push(shared)
  return anchors
}

export interface ResolvedBundle {
  name: string
  dir: string
  manifest: PackageManifest
  patch: string
  patchFileExists: boolean
}

export interface BundleResolution {
  resolved: ResolvedBundle[]
  problems: { name: string; message: string }[]
}

export function resolveBundles(paths: DshPaths, manifest: ProfileManifest): BundleResolution {
  const anchors = anchorFiles(paths)
  const resolved: ResolvedBundle[] = []
  const problems: { name: string; message: string }[] = []
  for (const name of profileBundles(manifest)) {
    const dir = packageDirFromAnchors(anchors, name)
    if (dir === null) {
      problems.push({ name, message: 'cannot resolve bundle package from the profile dependency tree' })
      continue
    }
    const bundleManifest = readPackageManifest(dir)
    if (bundleManifest === null) {
      problems.push({ name, message: 'package directory exists but its package.json is unreadable' })
      continue
    }
    const patch = bundleManifest.dsh?.bundle?.patch
    if (typeof patch !== 'string' || patch.length === 0) {
      problems.push({ name, message: 'package declares no dsh.bundle.patch (bundle-less package listed as a layer)' })
      continue
    }
    resolved.push({ name, dir, manifest: bundleManifest, patch, patchFileExists: existsSync(join(dir, patch)) })
  }
  return { resolved, problems }
}
