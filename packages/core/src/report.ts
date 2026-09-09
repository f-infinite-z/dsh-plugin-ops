import type { ScanReport, Finding } from './types.js'

export function renderHuman(report: ScanReport): string {
  const lines: string[] = []
  lines.push(`profile ${report.profile} @ ${report.profileDir}`)
  const grouped = new Map<string, Finding[]>()
  for (const finding of report.findings) {
    const key = finding.ruleId
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [finding])
    else bucket.push(finding)
  }
  for (const [ruleId, findings] of grouped) {
    lines.push(`\n[${ruleId}]`)
    for (const finding of findings) {
      const pkg = finding.packageName === undefined ? '' : ` (${finding.packageName})`
      lines.push(`  ${finding.severity.toUpperCase().padEnd(5)} ${finding.message}${pkg}`)
      if (finding.detail !== undefined) lines.push(`         ${finding.detail}`)
    }
  }
  const counts = countSeverities(report)
  lines.push(`\n${counts.fatal} fatal, ${counts.warn} warn, ${counts.info} info`)
  lines.push(reportOk(report) ? 'OK: no fatal findings' : 'BLOCKED: fatal findings present')
  return lines.join('\n')
}

export function renderJson(report: ScanReport): string {
  return JSON.stringify({ ...report, counts: countSeverities(report) }, null, 2)
}

export function countSeverities(report: ScanReport): { fatal: number; warn: number; info: number } {
  const counts = { fatal: 0, warn: 0, info: 0 }
  for (const finding of report.findings) counts[finding.severity]++
  return counts
}

export function reportOk(report: ScanReport): boolean {
  return !report.findings.some((finding) => finding.severity === 'fatal')
}
