import semver from 'semver'
import type { PackageManifest } from './package-tree.js'
import { incompatibleDshPeers } from './compatibility.js'

/**
 * Installation-adaptation diagnosis: why one plugin is rejected by the
 * official compatibility gate, and how risky granting the exemption would be.
 *
 * This is the analysis half of the `dsh-ops adapt` loop. It never writes
 * anything; the CLI owns the plan → confirm → write → verify → rollback
 * orchestration.
 */

/** Risk class for an incompatible peer set. */
export type AdaptRisk = 'narrow' | 'cross-major'

/** One plugin's incompatibility against the running dsh. */
export interface AdaptDiagnosis {
  /** Bare package name from its manifest; null when the manifest is unreadable/unnamed. */
  packageName: string | null
  /** Manifest version, or null when undeclared. */
  version: string | null
  /** The running dsh version used for the comparison; null when unknown. */
  dshVersion: string | null
  /** Incompatible `@deepseek-ai/dsh*` peers (name → declared range). */
  incompatiblePeers: Record<string, string>
  /** Narrow ranges (same major) versus cross-major or unparsable ranges. */
  risk: AdaptRisk
}

/**
 * Classify one package against the running dsh version. A range whose minimum
 * satisfying version shares the runtime's major is `narrow` (likely only a
 * stale lower bound); anything crossing a major — or that does not parse at
 * all — is `cross-major`. The caller decides whether the package needs
 * adaptation at all (empty `incompatiblePeers` means it is compatible).
 */
export function diagnoseIncompatibility(
  manifest: PackageManifest | null,
  dshVersion: string | null,
): AdaptDiagnosis | null {
  if (manifest === null || typeof manifest.name !== 'string' || manifest.name.length === 0) return null
  const version = typeof manifest.version === 'string' ? manifest.version : null
  if (dshVersion === null || !semver.valid(dshVersion)) {
    return { packageName: manifest.name, version, dshVersion, incompatiblePeers: {}, risk: 'cross-major' }
  }
  const peers = incompatibleDshPeers(manifest, dshVersion) ?? {}
  const runtime = semver.parse(dshVersion)!
  const crossMajor = Object.entries(peers).some(([, range]) => {
    const min = semver.minVersion(range)
    if (min === null) return true
    if (min.major !== runtime.major) return true
    // On a 0.x release line the minor is the breaking boundary.
    return runtime.major === 0 && min.minor !== runtime.minor
  })
  return {
    packageName: manifest.name,
    version,
    dshVersion,
    incompatiblePeers: peers,
    risk: crossMajor ? 'cross-major' : 'narrow',
  }
}

/** Human summary of one incompatibility for the CLI confirm prompt. */
export function renderAdaptDiagnosis(diagnosis: AdaptDiagnosis): string {
  const peers = Object.entries(diagnosis.incompatiblePeers)
  const lines: string[] = [
    `${diagnosis.packageName ?? '(unnamed)'}${diagnosis.version === null ? '' : `@${diagnosis.version}`} is incompatible with dsh ${diagnosis.dshVersion ?? 'unknown'}`,
  ]
  for (const [name, range] of peers) lines.push(`  ${name}: requires ${range}`)
  lines.push(diagnosis.risk === 'narrow'
    ? 'risk: NARROW — the peer ranges stay within the same breaking boundary; likely only a stale lower bound, so an exemption has a good chance of working'
    : 'risk: CROSS-MAJOR — a peer range crosses a breaking boundary (a major, or a minor on the 0.x line) or is unparsable; an exemption may still crash the plugin')
  return lines.join('\n')
}
