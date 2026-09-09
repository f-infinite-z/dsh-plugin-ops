import { createInterface } from 'node:readline/promises'
import { scanProfile, alignToLockfile, renderHuman, reportOk, countSeverities, appendMemory, ScanError, type Finding } from 'dsh-plugin-ops-core'
import type { DshPaths } from 'dsh-plugin-ops-core'

export interface FixCommandOptions {
  paths: DshPaths
  profileName: string
  dryRun: boolean
  yes: boolean
}

function hasAlignable(report: { findings: Finding[] }): boolean {
  return report.findings.some((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
}

export async function runFixCommand(options: FixCommandOptions): Promise<number> {
  let report
  try {
    report = await scanProfile({ paths: options.paths, profileName: options.profileName })
  } catch (error) {
    if (error instanceof ScanError) {
      process.stderr.write(`fix: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const blockers = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind !== 'align-lockfile')
  if (blockers.length > 0) {
    process.stdout.write(renderHuman(report))
    process.stderr.write('\nfix: fatal findings without an automatic fix exist; resolve them first (see suggestions above)\n')
    return 1
  }

  if (!hasAlignable(report)) {
    process.stdout.write(`profile ${options.profileName} is clean; nothing to fix\n`)
    return 0
  }

  process.stdout.write(`plan: realign installed tree to pnpm-lock.yaml in ${options.paths.profileDir}\n  -> pnpm install --frozen-lockfile\n`)
  const counts = countSeverities(report)
  process.stdout.write(`  (fixes ${counts.fatal} fatal drift finding(s))\n`)
  if (options.dryRun) {
    process.stdout.write('dry-run: no change made\n')
    return 0
  }

  const confirmed = options.yes || await confirm()
  if (!confirmed) {
    process.stdout.write('aborted by user\n')
    return 2
  }

  const result = await alignToLockfile(options.paths.profileDir)
  if (!result.ok) {
    process.stderr.write(`fix: ${result.detail}\n`)
    return 1
  }
  appendMemory(options.paths, {
    type: 'fix', ts: new Date().toISOString(), profile: options.profileName, kind: 'align-lockfile', detail: result.detail,
  })

  const rescan = await scanProfile({ paths: options.paths, profileName: options.profileName })
  process.stdout.write(`\nfix applied; re-scan:\n${renderHuman(rescan)}`)
  return reportOk(rescan) ? 0 : 1
}

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('apply this plan? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}
