/**
 * Runtime verification support (the `verify --runtime` mode).
 *
 * Static checks judge a package's shape; runtime verification boots it inside
 * an isolated DSH home and observes what the launcher actually does. This
 * module owns the pure planning half: what the package declares, how the
 * isolated profile should activate it, and how one boot outcome is classified.
 * The CLI owns process orchestration (isolated home, official `dsh plugin`
 * install, `dsh` launch, teardown).
 */

import { readPackageManifest, type PackageManifest } from './package-tree.js'

/** How the isolated profile must activate one verified package. */
export interface RuntimeVerifyPlan {
  /** Bare package name from its manifest. */
  packageName: string
  /** Whether the package declares `dsh.bundle.patch` (the profile manager activates it as a layer). */
  isBundle: boolean
  /** Loader row id used when the package is a plain plugin; null for bundles. */
  rowId: string | null
}

/** Derive a filesystem-safe row id from a package name (`@scope/pkg` → `verify-scope-pkg`). */
export function runtimeRowId(packageName: string): string {
  return `verify-${packageName.replace(/^@/, '').replace(/[\\/]/g, '-')}`
}

/**
 * Read the runtime verification plan from a package directory.
 * @param pluginDir - absolute package directory.
 * @returns the plan, or null when the manifest is unreadable or unnamed.
 */
export function readRuntimeVerifyPlan(pluginDir: string): RuntimeVerifyPlan | null {
  const manifest: PackageManifest | null = readPackageManifest(pluginDir)
  if (manifest === null || typeof manifest.name !== 'string' || manifest.name.length === 0) return null
  const bundlePatch = manifest.dsh?.bundle?.patch
  const isBundle = typeof bundlePatch === 'string' && bundlePatch.length > 0
  return {
    packageName: manifest.name,
    isBundle,
    rowId: isBundle ? null : runtimeRowId(manifest.name),
  }
}

/** Outcome of one isolated boot observation. */
export type RuntimeBootOutcome =
  | { kind: 'booted'; elapsedMs: number }
  | { kind: 'exited'; exitCode: number | null; elapsedMs: number }

/**
 * Classify one observation: a process still alive after the threshold booted;
 * an earlier exit is a boot failure (or, for one-shot profiles, the task
 * result — runtime verification always uses a long-running profile).
 * @param exitCode - the child's exit code, or null while it is still running.
 * @param elapsedMs - milliseconds since launch.
 * @param thresholdMs - how long a healthy boot must survive.
 */
export function classifyBootOutcome(exitCode: number | null, elapsedMs: number, thresholdMs: number): RuntimeBootOutcome {
  if (exitCode === null && elapsedMs >= thresholdMs) return { kind: 'booted', elapsedMs }
  return { kind: 'exited', exitCode, elapsedMs }
}
