import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { verifyPluginPackage, type VerifyReport } from 'dsh-plugin-ops-core'
import { runRuntimeVerify } from './verify-cmd.js'

export interface DevCommandOptions {
  dir: string
  /** Also run the isolated boot check after a clean static pass. */
  runtime: boolean
  runtimeTimeoutSec: number
}

/** Build output and dependency trees change constantly and are not the author's source. */
const IGNORED = /(^|[\\/])(node_modules|\.git|\.dsh-module-fallback)([\\/]|$)/

function now(): string {
  return new Date().toTimeString().slice(0, 8)
}

/** Render one static-check result as indented lines (exported for tests). */
export function renderDevStatic(report: VerifyReport): string[] {
  if (report.findings.length === 0) return ['  static: OK (all checks passed)']
  const errors = report.findings.filter((finding) => finding.severity === 'error').length
  const warns = report.findings.filter((finding) => finding.severity === 'warn').length
  const lines = [`  static: ${errors} error(s), ${warns} warning(s)`]
  for (const finding of report.findings) {
    lines.push(`    [${finding.ruleId}] ${finding.severity.toUpperCase()} ${finding.message}`)
    if (finding.detail !== undefined) lines.push(`      ${finding.detail}`)
  }
  return lines
}

async function checkOnce(dir: string, options: DevCommandOptions, reason: string): Promise<void> {
  process.stdout.write(`\n[${now()}] ${reason}\n`)
  let report: VerifyReport
  try {
    report = verifyPluginPackage(dir)
  } catch (error) {
    process.stdout.write(`  static: cannot read the package: ${String(error)}\n`)
    return
  }
  for (const line of renderDevStatic(report)) process.stdout.write(`${line}\n`)
  const clean = report.findings.every((finding) => finding.severity !== 'error')
  if (options.runtime && clean) {
    process.stdout.write(`  runtime: booting in an isolated DSH home (up to ${options.runtimeTimeoutSec}s)...\n`)
    const result = await runRuntimeVerify(dir, { kind: 'dir', value: dir }, options.runtimeTimeoutSec)
    process.stdout.write(`  runtime: ${result.ok ? 'BOOTED' : 'FAILED'} — ${result.detail}\n`)
    for (const entry of result.failedEntries) process.stdout.write(`    failed entry: ${entry}\n`)
    if (!result.ok && result.outputTail !== '') {
      for (const line of result.outputTail.split('\n').slice(-8)) process.stdout.write(`    ${line}\n`)
    }
  }
}

/**
 * Development watcher for one plugin directory: static checks after every
 * change (debounced), optionally followed by an isolated boot check. Nothing
 * touches a running dsh — the runtime check uses its own DSH home. The command
 * runs until interrupted (SIGINT/SIGTERM).
 * @param options - plugin directory, runtime flag, and boot window.
 * @returns 2 when the input is not a directory, otherwise 0 after shutdown.
 */
export async function runDevCommand(options: DevCommandOptions): Promise<number> {
  const dir = resolve(options.dir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write(`dev: not a directory: ${dir}\n`)
    return 2
  }
  process.stdout.write(`dsh-ops dev: watching ${dir}\n`)
  process.stdout.write(options.runtime
    ? `  static checks + isolated boot (${options.runtimeTimeoutSec}s window) after each change\n`
    : '  static checks after each change (pass --runtime for the isolated boot)\n')
  await checkOnce(dir, options, 'initial check')

  return await new Promise<number>((resolvePromise) => {
    let timer: NodeJS.Timeout | null = null
    let busy = false
    let pending = false
    const run = async (reason: string): Promise<void> => {
      if (busy) {
        pending = true
        return
      }
      busy = true
      try {
        await checkOnce(dir, options, reason)
      } finally {
        busy = false
        if (pending) {
          pending = false
          void run('change detected (coalesced)')
        }
      }
    }
    const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename !== null && IGNORED.test(filename)) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void run(filename === null || filename === undefined ? 'change detected' : `change: ${String(filename)}`)
      }, 600)
    })
    watcher.on('error', (error) => {
      process.stderr.write(`dev: watcher error: ${String(error)}\n`)
    })
    const shutdown = (): void => {
      watcher.close()
      process.stdout.write('\ndsh-ops dev: stopped\n')
      resolvePromise(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
