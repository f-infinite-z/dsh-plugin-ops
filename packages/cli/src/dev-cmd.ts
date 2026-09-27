import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { readPackageManifest, verifyPluginPackage, type VerifyReport } from 'dsh-plugin-ops-core'
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

/** `name@version` for the package at `dir`, or the directory path when unnamed. */
export function packageIdentity(dir: string): string {
  const manifest = readPackageManifest(dir)
  const name = manifest !== null && typeof manifest.name === 'string' ? manifest.name : null
  const version = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
  if (name === null) return dir
  return version === null ? name : `${name}@${version}`
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

interface DevStats {
  seq: number
  checks: number
  failed: number
}

async function checkOnce(
  dir: string,
  identity: string,
  options: DevCommandOptions,
  reason: string,
  stats: DevStats,
): Promise<void> {
  stats.seq += 1
  stats.checks += 1
  process.stdout.write(`\n[${now()}] #${stats.seq} ${reason} — ${identity}\n`)
  let report: VerifyReport
  try {
    report = verifyPluginPackage(dir)
  } catch (error) {
    process.stdout.write(`  static: cannot read the package at ${dir}: ${String(error)}\n`)
    stats.failed += 1
    return
  }
  for (const line of renderDevStatic(report)) process.stdout.write(`${line}\n`)
  const clean = report.findings.every((finding) => finding.severity !== 'error')
  if (!clean) stats.failed += 1
  if (options.runtime) {
    if (clean) {
      process.stdout.write(`  runtime: booting in an isolated DSH home (up to ${options.runtimeTimeoutSec}s)...\n`)
      const result = await runRuntimeVerify(dir, { kind: 'dir', value: dir }, options.runtimeTimeoutSec)
      process.stdout.write(`  runtime: ${result.ok ? 'BOOTED' : 'FAILED'} — ${result.detail}\n`)
      for (const entry of result.failedEntries) process.stdout.write(`    failed entry: ${entry}\n`)
      if (!result.ok && result.outputTail !== '') {
        for (const line of result.outputTail.split('\n').slice(-8)) process.stdout.write(`    ${line}\n`)
      }
    } else {
      process.stdout.write('  runtime: skipped (static checks still report errors)\n')
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
  const identity = packageIdentity(dir)
  const startedAt = Date.now()
  process.stdout.write(`dsh-ops dev: watching ${identity}\n`)
  process.stdout.write(`  directory: ${dir}\n`)
  process.stdout.write(options.runtime
    ? `  static checks + isolated boot (${options.runtimeTimeoutSec}s window) after each change\n`
    : '  static checks after each change (pass --runtime for the isolated boot)\n')

  const stats: DevStats = { seq: 0, checks: 0, failed: 0 }
  await checkOnce(dir, identity, options, 'initial check', stats)

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
        await checkOnce(dir, identity, options, reason, stats)
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
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      process.stdout.write(`\ndsh-ops dev: stopped — ${stats.checks} check(s), ${stats.failed} failed, ${elapsed}s\n`)
      resolvePromise(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
