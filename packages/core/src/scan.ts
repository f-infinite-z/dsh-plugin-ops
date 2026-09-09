import { readProfileManifest, resolveBundles, anchorFiles, registryDependencies, type ProfileManifest } from './profile.js'
import { readLockedDirectDeps } from './lockfile.js'
import { ruleBundleDeclaration, ruleDependencyDrift, ruleSessionMemory, ruleRegistryVersion, type RuleContext, trackedPackageNames } from './rules.js'
import { rulePeerGap, rulePeerDrift } from './peers.js'
import { rulePatchResolution } from './patchres.js'
import { ruleStructure } from './structure.js'
import { packageDirFromAnchors, readPackageManifest } from './package-tree.js'
import { checkOutdated } from './outdated.js'
import { applyConfig, type OpsConfig } from './config.js'
import type { ScanReport, PackageSnapshot, Finding } from './types.js'
import type { DshPaths } from './paths.js'
import type { ResolvedBundle } from './profile.js'

export interface ScanInput {
  paths: DshPaths
  profileName: string
  /** user rule config; findings are filtered through it after collection. */
  config?: OpsConfig | null
  /** run the advisory registry version check (pnpm outdated); opt-in so library callers never hit the network. */
  updateCheck?: boolean
}

export class ScanError extends Error {}

export async function scanProfile(input: ScanInput): Promise<ScanReport> {
  const manifest = readProfileManifest(input.paths.profileManifest)
  if (manifest === null) {
    throw new ScanError(
      `profile ${JSON.stringify(input.profileName)} has no readable manifest at ${input.paths.profileManifest}; `
      + "start the profile once with dsh to initialize it, or check DSH_HOME",
    )
  }
  const anchors = anchorFiles(input.paths)
  const { resolved } = resolveBundles(input.paths, manifest)
  const locked = await readLockedDirectDeps(input.paths.profileDir)

  const ctx: RuleContext = {
    profileName: input.profileName,
    paths: input.paths,
    manifest,
    anchors,
    locked,
  }

  const snapshot = collectSnapshot(ctx, resolved)
  let findings: Finding[] = [
    ...ruleBundleDeclaration(ctx),
    ...ruleDependencyDrift(ctx, resolved),
    ...rulePeerGap(ctx, resolved),
    ...rulePeerDrift(ctx, resolved),
    ...rulePatchResolution(ctx, resolved),
    ...ruleStructure(resolved),
    ...ruleSessionMemory(ctx, snapshot),
  ]

  const updateEnabled = input.config?.rules?.['registry-version']?.enabled !== false
  if (input.updateCheck === true && updateEnabled) {
    const outdated = await checkOutdated(input.paths.profileDir, input.paths.memoryDir, input.profileName)
    findings = [...findings, ...ruleRegistryVersion(outdated)]
  }

  if (input.config !== undefined && input.config !== null) {
    findings = applyConfig(findings, input.config)
  }

  return {
    profile: input.profileName,
    profileDir: input.paths.profileDir,
    findings,
    snapshot,
  }
}

function collectSnapshot(ctx: RuleContext, resolved: ResolvedBundle[]): PackageSnapshot {
  const tracked = trackedPackageNames(ctx, resolved)
  const packages: Record<string, string | null> = {}
  for (const name of tracked) {
    const dir = packageDirFromAnchors(ctx.anchors, name)
    const manifest = dir === null ? null : readPackageManifest(dir)
    packages[name] = manifest?.version === undefined ? null : String(manifest.version)
  }
  return { packages }
}

export function declaredRegistryNames(manifest: ProfileManifest): string[] {
  return Object.keys(registryDependencies(manifest))
}
