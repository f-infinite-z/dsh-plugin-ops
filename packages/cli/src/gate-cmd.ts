import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import {
  scanProfile, renderHuman, reportOk, alignToLockfile, appendMemory, ScanError,
  readProfileManifest, resolveBundles, allVisibleRows, rowIdsForPackage,
  lastSuccessSnapshot, diffSnapshots, disableRow,
  type Finding, type ScanReport, type DshPaths, type OpsConfig,
} from 'dsh-plugin-ops-core'

export interface GateCommandOptions {
  paths: DshPaths
  profileName: string
  bypass: boolean
  /** skip boot-failure attribution even for long-running profiles. */
  noAttribution: boolean
  bootThresholdMs: number
  config: OpsConfig
  dshCommand: string[]
}

/**
 * One-shot profiles exit fast on success; a fast non-zero exit means the task
 * failed, not that boot did. Attribution is only meaningful for long-running
 * profiles (web, sdk, acp, custom live profiles). `headless` is the shipped
 * one-shot template.
 */
export function attributionEnabled(options: GateCommandOptions): boolean {
  if (options.noAttribution) return false
  return options.profileName !== 'headless'
}

async function currentReport(options: GateCommandOptions): Promise<ScanReport> {
  return scanProfile({ paths: options.paths, profileName: options.profileName, config: options.config, updateCheck: false })
}

export async function runGateCommand(options: GateCommandOptions): Promise<number> {
  appendMemory(options.paths, { type: 'attempt', ts: new Date().toISOString(), profile: options.profileName })

  let report: ScanReport
  try {
    report = await currentReport(options)
  } catch (error) {
    if (error instanceof ScanError) {
      process.stderr.write(`gate: ${error.message}\n`)
      return 2
    }
    throw error
  }
  process.stdout.write(renderHuman(report))

  // --- block-first, graded disposition ------------------------------------
  const autoFixable = report.findings.filter((f): f is Finding & { fix: { kind: 'align-lockfile' } } =>
    f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
  const manual = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind !== 'align-lockfile')

  if (autoFixable.length > 0) {
    process.stdout.write(`\ngate: auto-fixing ${autoFixable.length} drift finding(s) with pnpm install --frozen-lockfile\n`)
    const fix = await alignToLockfile(options.paths.profileDir)
    if (fix.ok) {
      appendMemory(options.paths, { type: 'fix', ts: new Date().toISOString(), profile: options.profileName, kind: 'align-lockfile', detail: fix.detail })
      report = await currentReport(options)
      process.stdout.write(renderHuman(report))
    } else {
      process.stderr.write(`gate: auto-fix failed — ${fix.detail}\n`)
      report = { ...report, findings: report.findings } // keep original findings for the manual prompt
    }
  }

  if (!reportOk(report)) {
    const remaining = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind !== 'align-lockfile')
    const blockedPkgs = [...new Set(remaining.map((f) => f.packageName).filter((n): n is string => n !== undefined))]
    process.stderr.write('\n' + '='.repeat(60) + '\n')
    process.stderr.write('GATE BLOCKED: fatal findings require manual resolution\n')
    process.stderr.write('='.repeat(60) + '\n')
    if (blockedPkgs.length > 0) {
      process.stderr.write('Affected packages:\n')
      for (const pkg of blockedPkgs) process.stderr.write(`  - ${pkg}\n`)
      process.stderr.write('Suggested action: temporarily remove or reinstall these plugins, e.g.\n')
      process.stderr.write(`  dsh plugin --profile ${options.profileName} remove <pkg>\n`)
      process.stderr.write('  dsh plugin --profile <name> add <pkg>@<known-good-version>\n')
    }
    process.stderr.write('Re-run dsh-ops gate after resolving, or pass --bypass to start anyway (not recommended).\n')
    if (options.bypass) {
      appendMemory(options.paths, { type: 'bypass', ts: new Date().toISOString(), profile: options.profileName, detail: `bypassed ${remaining.length} fatal finding(s)` })
    } else {
      return 3
    }
  }

  // --- launch dsh ----------------------------------------------------------
  const start = Date.now()
  const dshCode = await runDsh(options.dshCommand)
  const elapsed = Date.now() - start

  if (dshCode === 0 || elapsed >= options.bootThresholdMs) {
    appendMemory(options.paths, { type: 'success', ts: new Date().toISOString(), profile: options.profileName, snapshot: report.snapshot })
    return dshCode
  }

  appendMemory(options.paths, { type: 'failure', ts: new Date().toISOString(), profile: options.profileName, detail: `exited ${dshCode} after ${elapsed}ms` })
  if (!attributionEnabled(options)) {
    process.stderr.write(`\ndsh exited ${dshCode} after ${elapsed}ms; profile ${options.profileName} is one-shot, so the exit code is the task result, not a boot signal (pass --no-attribution to silence this note)\n`)
    return dshCode
  }
  return attributeAndRecover(options, report, dshCode)
}

function runDsh(command: string[]): Promise<number> {
  const bin0 = command[0]
  if (bin0 === undefined) {
    process.stderr.write('gate: empty dsh command\n')
    return Promise.resolve(2)
  }
  const bin = bin0 === 'dsh' && process.platform === 'win32' ? 'dsh.cmd' : bin0
  const args = command.slice(1)
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', shell: false })
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && !child.killed) child.kill(signal)
    }
    process.on('SIGINT', () => forward('SIGINT'))
    process.on('SIGTERM', () => forward('SIGTERM'))
    child.on('error', (error) => {
      process.stderr.write(`gate: failed to launch ${bin}: ${error.message}\n`)
      resolve(127)
    })
    child.on('close', (code) => {
      process.removeAllListeners('SIGINT')
      process.removeAllListeners('SIGTERM')
      resolve(code ?? 1)
    })
  })
}

async function attributeAndRecover(options: GateCommandOptions, report: ScanReport, dshCode: number): Promise<number> {
  const last = lastSuccessSnapshot(options.paths, options.profileName)
  if (last === null) {
    process.stderr.write(`\ndsh exited ${dshCode} shortly after launch and no successful baseline exists.\n`)
    process.stderr.write('Inspect the boot log above; the failure may come from dsh itself or a config change.\n')
    return dshCode
  }
  const diff = diffSnapshots(last.snapshot, report.snapshot)
  if (diff.length === 0) {
    process.stderr.write(`\ndsh exited ${dshCode} shortly after launch; package state matches the last successful boot (${last.at}).\n`)
    process.stderr.write('The failure likely comes from configuration or a broken update inside a bundle; run dsh directly to see the full error.\n')
    return dshCode
  }

  const manifest = readProfileManifest(options.paths.profileManifest)
  const bundles = manifest === null ? [] : resolveBundles(options.paths, manifest).resolved
  const refs = allVisibleRows(options.paths.profileDir, bundles)
  const suspects = diff.map((entry) => ({ ...entry, rows: rowIdsForPackage(refs, entry.name) }))

  process.stderr.write('\n' + '='.repeat(60) + '\n')
  process.stderr.write(`BOOT FAILURE ATTRIBUTION: dsh exited ${dshCode} after launch; these packages changed since the last successful boot (${last.at}):\n`)
  suspects.forEach((s, index) => {
    process.stderr.write(`  [${index + 1}] ${s.name} (${s.change}: ${s.previous ?? 'absent'} -> ${s.current ?? 'absent'})`)
    process.stderr.write(s.rows.length > 0 ? ` — rows: ${s.rows.join(', ')}\n` : ' — no loadable row found\n')
  })

  const disableable = suspects.filter((s) => s.rows.length > 0)
  if (disableable.length === 0 || !process.stdin.isTTY) {
    process.stderr.write('Suggested action: disable or remove the changed plugins, then re-run the gate.\n')
    process.stderr.write('(interactive disable requires a TTY; row ids above match dsh-ops fix targets)\n')
    return 5
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('\naction: [a] disable all suspect rows and retry, [s] skip (start dsh anyway), or indices like 1,2 to pick: ')
    const trimmed = answer.trim().toLowerCase()
    if (trimmed === 's' || trimmed === 'skip') {
      process.stderr.write('skipped; starting dsh without changes\n')
      return runDsh(options.dshCommand)
    }
    let chosen = disableable
    if (trimmed !== 'a' && trimmed !== 'all') {
      const picked = new Set(trimmed.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n)))
      chosen = disableable.filter((_, index) => picked.has(index + 1))
      if (chosen.length === 0) {
        process.stderr.write('no valid choice; aborting\n')
        return 4
      }
    }
    const rows = [...new Set(chosen.flatMap((s) => s.rows))]
    for (const row of rows) {
      const result = await disableRow(options.paths, options.profileName, row)
      if (!result.ok) process.stderr.write(`disable ${row}: ${result.detail}\n`)
      else process.stderr.write(`disabled row ${row} (backup: ${result.backup ?? 'none'})\n`)
    }
    process.stderr.write('\ndisabled rows recorded; retrying dsh...\n')
    const retryCode = await runDsh(options.dshCommand)
    if (retryCode === 0) {
      const fresh = await currentReport(options)
      appendMemory(options.paths, { type: 'success', ts: new Date().toISOString(), profile: options.profileName, snapshot: fresh.snapshot })
    }
    return retryCode
  } finally {
    rl.close()
  }
}
