import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetchNpmPackage, verifyOk, verifyPluginPackage, type VerifyReport } from 'dsh-plugin-ops-core'

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

/**
 * Decide whether the input names a local directory or an npm package.
 * Scoped package specs start with `@`; everything else that looks like a
 * filesystem path must exist as a directory or the command fails loud.
 */
function classifyInput(input: string): 'dir' | 'npm' | 'invalid' {
  if (existsSync(input) && statSync(input).isDirectory()) return 'dir'
  if (input.startsWith('@')) return 'npm'
  if (input.startsWith('.') || input.includes('/') || input.includes('\\') || /^[a-zA-Z]:/.test(input)) return 'invalid'
  return 'npm'
}

/**
 * Publish-time check for one plugin package: a local directory, or an npm
 * package spec that is downloaded from the registry into a temp directory.
 */
export async function runVerifyCommand(options: VerifyCommandOptions): Promise<number> {
  const input = options.dir
  const kind = classifyInput(input)

  let dir: string
  let cleanup: (() => void) | null = null
  if (kind === 'dir') {
    dir = resolve(input)
  } else if (kind === 'invalid') {
    process.stderr.write(`verify: not a directory: ${resolve(input)}\n`)
    return 2
  } else {
    process.stdout.write(`fetching ${input} from the npm registry...\n`)
    const fetched = await fetchNpmPackage(input)
    if (!fetched.ok || fetched.packageDir === null) {
      process.stderr.write(`verify: ${fetched.error ?? 'download failed'}\n`)
      fetched.cleanup()
      return 2
    }
    dir = fetched.packageDir
    cleanup = fetched.cleanup
  }

  try {
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
  } finally {
    cleanup?.()
  }
}
