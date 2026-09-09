import semver from 'semver'
import type { Finding, PackageSnapshot } from './types.js'
import type { DshPaths } from './paths.js'
import {
  resolveBundles,
  type ProfileManifest,
  type ResolvedBundle,
  registryDependencies,
} from './profile.js'
import { packageDirFromAnchors, readPackageManifest } from './package-tree.js'
import type { LockedDirectDeps } from './lockfile.js'
import { lastSuccessSnapshot, diffSnapshots } from './memory.js'

export interface RuleContext {
  profileName: string
  paths: DshPaths
  manifest: ProfileManifest
  anchors: string[]
  locked: LockedDirectDeps
}

export function trackedPackageNames(ctx: RuleContext, resolved: ResolvedBundle[]): string[] {
  const names = new Set(Object.keys(registryDependencies(ctx.manifest)))
  for (const bundle of resolved) names.add(bundle.name)
  return [...names].sort()
}

/**
 * Bundles resolved from the shared installation closure (the official box
 * bundles) are not expected in the profile's own dependencies; only
 * profile-local packages must be declared there.
 */
export function bundleSources(resolved: ResolvedBundle[]): Map<string, 'profile' | 'closure'> {
  return new Map(resolved.map((bundle) => [bundle.name, bundle.from]))
}

function installedVersion(ctx: RuleContext, name: string): { version: string | null; declaredInDeps: boolean } {
  const dir = packageDirFromAnchors(ctx.anchors, name)
  const manifest = dir === null ? null : readPackageManifest(dir)
  const declaredInDeps = ctx.manifest.dependencies !== undefined && name in ctx.manifest.dependencies
  return { version: manifest?.version === undefined ? null : String(manifest.version), declaredInDeps }
}

export function ruleBundleDeclaration(ctx: RuleContext): Finding[] {
  const findings: Finding[] = []
  const { problems, resolved } = resolveBundles(ctx.paths, ctx.manifest)
  for (const problem of problems) {
    findings.push({
      ruleId: 'bundle-declaration',
      severity: 'fatal',
      packageName: problem.name,
      message: problem.message,
      fix: { kind: 'none' },
    })
  }
  for (const bundle of resolved) {
    if (!bundle.patchFileExists) {
      findings.push({
        ruleId: 'bundle-declaration',
        severity: 'fatal',
        packageName: bundle.name,
        message: `bundle patch file ${bundle.patch} is missing from the package`,
        detail: 'the package is broken or partially installed; reinstall it (dsh plugin --profile <name> add <pkg>@<version>) before booting',
        fix: { kind: 'none' },
      })
    }
  }
  return findings
}

export function ruleDependencyDrift(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const { missing: lockMissing, incompatible: lockIncompatible, versions: locked } = ctx.locked
  const sources = bundleSources(resolved)

  if (lockMissing) {
    findings.push({
      ruleId: 'dependency-drift',
      severity: 'warn',
      message: 'profile has no pnpm-lock.yaml; versions are not locked against drift',
      detail: 'run pnpm install in the profile directory (or dsh plugin --profile <name> install) to establish a lockfile',
      fix: { kind: 'none' },
    })
  } else if (lockIncompatible) {
    findings.push({
      ruleId: 'dependency-drift',
      severity: 'warn',
      message: 'pnpm-lock.yaml uses an unsupported format version; lockfile comparison degraded',
      detail: 're-run pnpm install with the profile package manager to regenerate the lockfile, then retry',
      fix: { kind: 'none' },
    })
  }

  for (const name of trackedPackageNames(ctx, resolved)) {
    const declared = registryDependencies(ctx.manifest)[name] ?? null
    const lockedVersion = locked[name] ?? null
    const { version: installed, declaredInDeps } = installedVersion(ctx, name)

    if (!declaredInDeps && sources.get(name) !== 'closure') {
      findings.push({
        ruleId: 'dependency-drift',
        severity: 'warn',
        packageName: name,
        message: 'bundle is not declared in profile dependencies; the profile manager may drop it',
        detail: 'run: dsh plugin --profile <name> add <pkg>@<installed-or-locked-version> to declare it',
        fix: { kind: 'none' },
      })
      continue
    }

    const rangeDegraded = lockMissing || lockIncompatible
    if (rangeDegraded) {
      if (installed === null) {
        findings.push({
          ruleId: 'dependency-drift',
          severity: 'warn',
          packageName: name,
          message: 'declared package is not installed (no lockfile to restore from)',
          detail: 'run pnpm install in the profile directory to establish the tree, then re-scan',
          fix: { kind: 'none' },
        })
      } else if (declared !== null && !semver.satisfies(installed, declared)) {
        findings.push({
          ruleId: 'dependency-drift',
          severity: 'warn',
          packageName: name,
          message: `installed ${installed} falls outside the declared range ${declared}`,
          fix: { kind: 'none' },
        })
      }
      continue
    }

    if (installed === null) {
      findings.push({
        ruleId: 'dependency-drift',
        severity: 'fatal',
        packageName: name,
        message: lockedVersion !== null
          ? `package is locked at ${lockedVersion} but not installed on disk`
          : 'declared package is not installed and not locked',
        fix: lockedVersion !== null ? { kind: 'align-lockfile' } : { kind: 'none' },
      })
      continue
    }

    if (lockedVersion !== null && installed !== lockedVersion) {
      findings.push({
        ruleId: 'dependency-drift',
        severity: 'fatal',
        packageName: name,
        message: `installed ${installed} deviates from locked ${lockedVersion}`,
        fix: { kind: 'align-lockfile' },
      })
      continue
    }

    if (lockedVersion !== null && declared !== null && !semver.satisfies(lockedVersion, declared)) {
      findings.push({
        ruleId: 'dependency-drift',
        severity: 'warn',
        packageName: name,
        message: `locked ${lockedVersion} does not satisfy the declared range ${declared}`,
        detail: 'the manifest changed after the last install; re-run the profile install to re-lock',
        fix: { kind: 'none' },
      })
      continue
    }

    if (declared !== null && !semver.satisfies(installed, declared)) {
      findings.push({
        ruleId: 'dependency-drift',
        severity: 'fatal',
        packageName: name,
        message: `installed ${installed} does not satisfy the declared range ${declared}`,
        fix: { kind: 'align-lockfile' },
      })
    }
  }
  return findings
}

export function ruleSessionMemory(ctx: RuleContext, snapshot: PackageSnapshot): Finding[] {
  const last = lastSuccessSnapshot(ctx.paths, ctx.profileName)
  if (last === null) {
    return [{
      ruleId: 'session-memory',
      severity: 'info',
      message: 'no recorded successful boot yet; the first gate pass establishes the baseline',
      fix: { kind: 'none' },
    }]
  }
  const diff = diffSnapshots(last.snapshot, snapshot)
  if (diff.length === 0) {
    return [{
      ruleId: 'session-memory',
      severity: 'info',
      message: `package state matches the last successful boot (${last.at})`,
      fix: { kind: 'none' },
    }]
  }
  return diff.map((entry) => ({
    ruleId: 'session-memory',
    severity: 'warn' as const,
    packageName: entry.name,
    message: `package ${entry.change} since last successful boot (${last.at}): ${entry.previous ?? 'absent'} -> ${entry.current ?? 'absent'}`,
    detail: 'if this boot fails, this package is the prime suspect',
    fix: { kind: 'none' },
  }))
}
