import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyOk, verifyPluginPackage, type VerifyReport } from 'dsh-plugin-ops-core'

export interface VerifyCommandOptions {
  dir: string
  json: boolean
  strict: boolean
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const

function renderHuman(report: VerifyReport): string {
  const lines: string[] = []
  const name = report.packageName ?? '(unnamed package)'
  const version = report.version === null ? '' : `@${report.version}`
  lines.push(`dsh-ops verify: ${report.packageDir} (${name}${version})`)
  if (report.findings.length === 0) {
    lines.push('OK: all checks passed')
    return lines.join('\n')
  }
  const sorted = [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  for (const finding of sorted) {
    lines.push(`  [${finding.ruleId}] ${finding.severity.toUpperCase()} ${finding.message}`)
    if (finding.detail !== undefined) lines.push(`      ${finding.detail}`)
  }
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of report.findings) counts[finding.severity]++
  lines.push('')
  lines.push(`${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info`)
  return lines.join('\n')
}

/** Publish-time check for one plugin package directory. */
export function runVerifyCommand(options: VerifyCommandOptions): number {
  const dir = resolve(options.dir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write(`verify: not a directory: ${dir}\n`)
    return 2
  }
  const report = verifyPluginPackage(dir)
  const ok = verifyOk(report, options.strict)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, ok })}\n`)
  } else {
    process.stdout.write(`${renderHuman(report)}\n`)
    if (!ok) {
      process.stderr.write(
        options.strict
          ? 'FAILED (--strict: warnings count as failures)\n'
          : 'FAILED: fix the errors before publishing\n',
      )
    }
  }
  return ok ? 0 : 1
}
