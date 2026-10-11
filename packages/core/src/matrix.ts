import semver from 'semver'
import { KNOWN_VERSION_BOUNDARIES } from './versions.js'
import type { VerifyFinding } from './verify.js'

/**
 * Compatibility-matrix reporting for `dsh-ops verify`: turns one verification
 * run into a marketplace-style matrix — static checks, dsh peer declaration
 * coverage, measured runtime targets, and an explicit lifecycle coverage
 * list. Transparency over completeness: phases this tool does not measure
 * yet are named as not covered instead of being omitted.
 */

/** One measured runtime target in the matrix. */
export interface MatrixRuntimeResult {
  ok: boolean
  detail: string
  /** The runtime version under test when known (host dsh version, desktop release version). */
  runtimeVersion: string | null
}

/** Everything one verify run knows, in matrix terms. */
export interface VerifyMatrixInput {
  packageName: string | null
  version: string | null
  findings: VerifyFinding[]
  /** The package's dsh-related peer declarations (name → range). */
  dshPeers: Record<string, string>
  web: MatrixRuntimeResult | null
  desktop: MatrixRuntimeResult | null
}

export interface VerifyMatrixLifecyclePhase {
  phase: 'install' | 'boot' | 'visibility' | 'uninstall' | 'rollback'
  covered: boolean
  note: string
}

export interface VerifyMatrix {
  packageName: string | null
  version: string | null
  staticChecks: { error: number; warn: number; info: number }
  dshPeers: {
    declared: Record<string, string>
    coveredVersions: string[]
    uncoveredVersions: string[]
  }
  web: MatrixRuntimeResult | null
  desktop: MatrixRuntimeResult | null
  lifecycle: VerifyMatrixLifecyclePhase[]
}

/**
 * Extract the dsh-related peer declarations from a manifest
 * (`@deepseek-ai/dsh` and its `@deepseek-ai/dsh-*` packages — the ranges the
 * launcher's compatibility check judges).
 */
export function dshPeersOf(manifest: { peerDependencies?: Record<string, string> }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) out[name] = range
  }
  return out
}

function severityCounts(findings: VerifyFinding[]): { error: number; warn: number; info: number } {
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity]++
  return counts
}

/**
 * Build the compatibility matrix of one verification run. A known release
 * counts as covered when at least one declared dsh peer range satisfies it;
 * the lifecycle list always names every phase, with the phases this tool does
 * not measure yet explicitly marked as not covered.
 */
export function buildVerifyMatrix(input: VerifyMatrixInput): VerifyMatrix {
  const ranges = Object.values(input.dshPeers)
  const coveredVersions: string[] = []
  const uncoveredVersions: string[] = []
  if (ranges.length > 0) {
    for (const release of KNOWN_VERSION_BOUNDARIES) {
      const covered = ranges.some((spec) => semver.validRange(spec) !== null && semver.satisfies(release, spec, { includePrerelease: true }))
      if (covered) coveredVersions.push(release)
      else uncoveredVersions.push(release)
    }
  }
  const runtimeRan = input.web !== null || input.desktop !== null
  const lifecycleNote = runtimeRan ? 'measured by the isolated runtime check' : 'not run (pass --runtime and/or --desktop)'
  return {
    packageName: input.packageName,
    version: input.version,
    staticChecks: severityCounts(input.findings),
    dshPeers: { declared: input.dshPeers, coveredVersions, uncoveredVersions },
    web: input.web,
    desktop: input.desktop,
    lifecycle: [
      { phase: 'install', covered: runtimeRan, note: lifecycleNote },
      { phase: 'boot', covered: runtimeRan, note: lifecycleNote },
      { phase: 'visibility', covered: false, note: 'planned' },
      { phase: 'uninstall', covered: false, note: 'planned' },
      { phase: 'rollback', covered: false, note: 'planned' },
    ],
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function runtimeRow(label: string, result: MatrixRuntimeResult | null, versionPrefix: string): string {
  if (result === null) return `| ${label} | not run | - | pass --runtime/--desktop to measure |`
  const runtime = result.runtimeVersion === null ? 'unknown' : `${versionPrefix} ${result.runtimeVersion}`
  return `| ${label} | ${cell(runtime)} | ${result.ok ? 'BOOTED' : 'FAILED'} | ${cell(result.detail)} |`
}

/**
 * Render the matrix as Markdown — the shape a marketplace compatibility
 * report wants. Deterministic: no timestamps or tool versions are embedded.
 */
export function renderVerifyMatrix(matrix: VerifyMatrix): string {
  const lines: string[] = []
  const name = matrix.packageName ?? '(unnamed package)'
  const version = matrix.version === null ? '' : `@${matrix.version}`
  lines.push(`# Compatibility matrix — ${name}${version}`)
  lines.push('')
  lines.push('## Static checks')
  lines.push('')
  lines.push(`${matrix.staticChecks.error} error(s), ${matrix.staticChecks.warn} warning(s), ${matrix.staticChecks.info} info`)
  lines.push('')
  lines.push('## dsh peer declaration coverage')
  lines.push('')
  const peerEntries = Object.entries(matrix.dshPeers.declared)
  if (peerEntries.length === 0) {
    lines.push('(no dsh peer ranges declared)')
  } else {
    lines.push('| peer | declared range |')
    lines.push('|---|---|')
    for (const [peer, range] of peerEntries) lines.push(`| ${cell(peer)} | ${cell(range)} |`)
    lines.push('')
    lines.push(`covered known releases: ${matrix.dshPeers.coveredVersions.length === 0 ? '(none)' : matrix.dshPeers.coveredVersions.join(', ')}`)
    lines.push(`not covered: ${matrix.dshPeers.uncoveredVersions.length === 0 ? '(none)' : matrix.dshPeers.uncoveredVersions.join(', ')}`)
  }
  lines.push('')
  lines.push('## Runtime results (measured)')
  lines.push('')
  lines.push('| target | runtime | result | detail |')
  lines.push('|---|---|---|---|')
  lines.push(runtimeRow('web', matrix.web, 'dsh'))
  lines.push(runtimeRow('desktop', matrix.desktop, 'release'))
  lines.push('')
  lines.push('## Lifecycle coverage')
  lines.push('')
  lines.push('| phase | covered | note |')
  lines.push('|---|---|---|')
  for (const phase of matrix.lifecycle) lines.push(`| ${phase.phase} | ${phase.covered ? 'yes' : 'no'} | ${cell(phase.note)} |`)
  lines.push('')
  return lines.join('\n')
}
