import { join } from 'node:path'
import {
  quarantineSessions,
  repairSessionPaths,
  scanSessions,
  type DshPaths,
  type SessionRepairResult,
  type SessionScanResult,
} from 'dsh-plugin-ops-core'

export interface SessionsCommandOptions {
  paths: DshPaths
  json: boolean
  /** Move path-mismatched session directories back to their header id. */
  repairPaths: boolean
  /** Move unreadable session directories into the quarantine root (never deleted). */
  quarantine: boolean
}

function renderScan(scan: SessionScanResult): string {
  const lines: string[] = []
  lines.push(`dsh-ops sessions @ ${new Date().toISOString()}`)
  lines.push(`root: ${scan.root}`)
  lines.push(`scanned: ${scan.scanned} artifact(s), ${scan.findings.length} need attention`)
  for (const finding of scan.findings) {
    lines.push('')
    if (finding.kind === 'unreadable') {
      lines.push(`[unreadable] ${finding.directoryName}`)
    } else {
      lines.push(`[path-mismatch] "${finding.directoryName}" (header id ${finding.headerId ?? 'unknown'})`)
    }
    lines.push(`  file: ${finding.file} (${finding.sizeBytes} bytes)`)
    lines.push(`  detail: ${finding.detail}`)
  }
  if (scan.findings.length > 0) {
    lines.push('')
    lines.push('suggestions:')
    if (scan.findings.some((finding) => finding.kind === 'unreadable')) {
      lines.push('  dsh-ops sessions --quarantine     move unreadable sessions out (never deleted)')
    }
    if (scan.findings.some((finding) => finding.kind === 'path-mismatch')) {
      lines.push('  dsh-ops sessions --repair-paths   move path-mismatched directories back to their header id')
    }
    lines.push('  deep corruption classes (seq gaps, event types, empty text blocks) are covered by')
    lines.push('  @argszero/cordis-plugin-session-audit')
  }
  return lines.join('\n')
}

function renderRepair(label: string, result: SessionRepairResult): string {
  const lines: string[] = []
  for (const move of result.moved) lines.push(`${label}: ${move.from} -> ${move.to}`)
  for (const refusal of result.refused) lines.push(`${label} refused: ${refusal.target} (${refusal.reason})`)
  if (result.moved.length === 0 && result.refused.length === 0) lines.push(`${label}: nothing to do`)
  return lines.join('\n')
}

/**
 * Session-container repair command. Read-only by default (a plan with exit 1
 * when anything needs attention); `--repair-paths` and `--quarantine` execute
 * the two reversible fixes. Nothing is ever deleted.
 * @param options - resolved paths and the requested actions.
 * @returns 0 clean or fully repaired, 1 findings remain.
 */
export async function runSessionsCommand(options: SessionsCommandOptions): Promise<number> {
  const scan = scanSessions(join(options.paths.home, 'sessions'))
  let repairResult: SessionRepairResult | null = null
  let quarantineResult: SessionRepairResult | null = null
  if (options.repairPaths) repairResult = repairSessionPaths(scan.findings)
  if (options.quarantine) {
    const quarantineRoot = join(options.paths.home, 'cache', 'dsh-ops', 'quarantine', new Date().toISOString().replaceAll(':', '-'))
    quarantineResult = quarantineSessions(scan.findings, quarantineRoot)
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      root: scan.root,
      scanned: scan.scanned,
      findings: scan.findings,
      ...(repairResult === null ? {} : { repairPaths: repairResult }),
      ...(quarantineResult === null ? {} : { quarantine: quarantineResult }),
    })}\n`)
  } else {
    process.stdout.write(`${renderScan(scan)}\n`)
    if (repairResult !== null) {
      process.stdout.write(`\n${renderRepair('repaired', repairResult)}\n`)
    }
    if (quarantineResult !== null) {
      process.stdout.write(`\n${renderRepair('quarantined', quarantineResult)}\n`)
    }
  }

  const acted = repairResult !== null || quarantineResult !== null
  const remaining = acted
    ? (repairResult?.refused.length ?? 0) + (quarantineResult?.refused.length ?? 0)
    : scan.findings.length
  return remaining > 0 ? 1 : 0
}
