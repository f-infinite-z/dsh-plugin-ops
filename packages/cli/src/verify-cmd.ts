import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  appendActivationRow,
  classifyBootOutcome,
  fetchNpmPackage,
  packLocalPackage,
  readLatestStartupReport,
  readRuntimeVerifyPlan,
  resolveDshPaths,
  verifyOk,
  verifyPluginPackage,
  type StartupReport,
  type VerifyReport,
} from 'dsh-plugin-ops-core'
import { spawnDsh } from './spawn-dsh.js'

export interface VerifyCommandOptions {
  dir: string
  json: boolean
  strict: boolean
  /** boot the package in an isolated DSH home and observe the launcher */
  runtime: boolean
  /** seconds a healthy boot must survive before the package passes */
  runtimeTimeoutSec: number
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

export interface RuntimeVerifyResult {
  ok: boolean
  detail: string
  exitCode: number | null
  elapsedMs: number
  startupReport: StartupReport | null
  outputTail: string
  /** Failed loader entries extracted from the full boot output. */
  failedEntries: string[]
}

/** Extract failed loader-entry names from the boot output (`failed to import loader entry <id> (<pkg>)`). */
function extractFailedEntries(output: string): string[] {
  const pattern = /failed to import loader entry ([^ ()]+) \(([^)]+)\)/g
  const seen = new Set<string>()
  for (let match = pattern.exec(output); match !== null; match = pattern.exec(output)) {
    seen.add(`${match[1]} (${match[2]})`)
  }
  return [...seen]
}

interface CommandResult {
  code: number | null
  output: string
}

function killTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

function runDshWithEnv(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawnDsh(args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    const timer = setTimeout(() => killTree(child.pid), timeoutMs)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 127, output: `${output}${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** How the isolated profile should obtain the package under verification. */
export interface RuntimeInstallSource {
  kind: 'spec' | 'dir'
  value: string
}

/**
 * Boot the package inside an isolated DSH home: install through the official
 * `dsh plugin` command, activate plain plugins with a loader row, launch a
 * long-running profile, and observe whether the boot survives. A local
 * directory is packed into a tarball first because a directory install only
 * links the package (pnpm `link:`) and leaves its dependencies unresolved;
 * the tarball install matches what a registry user gets. A failed boot reads
 * the official startup diagnostics from the isolated home.
 */
export async function runRuntimeVerify(pluginDir: string, installSource: RuntimeInstallSource, timeoutSec: number): Promise<RuntimeVerifyResult> {  const plan = readRuntimeVerifyPlan(pluginDir)
  if (plan === null) {
    return { ok: false, detail: 'package manifest is unreadable or unnamed', exitCode: null, elapsedMs: 0, startupReport: null, outputTail: '', failedEntries: [] }
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-ops-runtime-'))
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
  const paths = resolveDshPaths('web', home)
  let child: ChildProcess | null = null
  let packCleanup: (() => void) | null = null
  try {
    let installTarget: string
    if (installSource.kind === 'spec') {
      installTarget = installSource.value
    } else {
      const packed = await packLocalPackage(installSource.value)
      if (!packed.ok || packed.tarball === null) {
        return {
          ok: false,
          detail: `cannot pack the directory for a tarball install: ${packed.error ?? 'unknown error'}`,
          exitCode: null,
          elapsedMs: 0,
          startupReport: null,
          outputTail: '',
          failedEntries: [],
        }
      }
      installTarget = packed.tarball
      packCleanup = packed.cleanup
    }
    const install = await runDshWithEnv(['plugin', '--profile', 'web', 'add', installTarget], env, 300_000)
    if (install.code !== 0) {
      return {
        ok: false,
        detail: `official install failed (exit ${install.code ?? 'timeout'})`,
        exitCode: install.code,
        elapsedMs: 0,
        startupReport: null,
        outputTail: tail(install.output),
        failedEntries: extractFailedEntries(install.output),
      }
    }
    if (!plan.isBundle && plan.rowId !== null) {
      const write = appendActivationRow(paths.profileDir, plan.rowId, plan.packageName)
      if (!write.ok) {
        return {
          ok: false,
          detail: `cannot write the activation row: ${write.problem ?? 'unknown error'}`,
          exitCode: null,
          elapsedMs: 0,
          startupReport: null,
          outputTail: '',
          failedEntries: [],
        }
      }
    }

    const port = 39000 + Math.floor(Math.random() * 1000)
    const start = Date.now()
    const thresholdMs = timeoutSec * 1000
    child = spawnDsh(['--profile', 'web', '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    const outcome = await new Promise<ReturnType<typeof classifyBootOutcome>>((resolvePromise) => {
      const timer = setTimeout(() => {
        resolvePromise(classifyBootOutcome(null, Date.now() - start, thresholdMs))
      }, thresholdMs)
      child?.on('close', (code) => {
        clearTimeout(timer)
        resolvePromise(classifyBootOutcome(code, Date.now() - start, thresholdMs))
      })
      child?.on('error', (error) => {
        output += String(error)
        clearTimeout(timer)
        resolvePromise(classifyBootOutcome(127, Date.now() - start, thresholdMs))
      })
    })
    if (outcome.kind === 'booted') killTree(child.pid)

    const startupReport = outcome.kind === 'exited' ? readLatestStartupReport(paths, start - 2000) : null
    return {
      ok: outcome.kind === 'booted',
      detail: outcome.kind === 'booted'
        ? `boot survived ${timeoutSec}s in an isolated profile${plan.isBundle ? ' (bundle layer activated)' : ' (loader row activated)'}`
        : `dsh exited ${outcome.exitCode ?? 'by signal'} after ${outcome.elapsedMs}ms`,
      exitCode: outcome.kind === 'exited' ? outcome.exitCode : 0,
      elapsedMs: outcome.elapsedMs,
      startupReport,
      outputTail: tail(output),
      failedEntries: extractFailedEntries(output),
    }
  } finally {
    packCleanup?.()
    if (child !== null && child.exitCode === null) killTree(child.pid)
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function renderRuntime(result: RuntimeVerifyResult): string {
  const lines: string[] = ['', 'runtime: isolated boot check']
  lines.push(`  result: ${result.ok ? 'BOOTED' : 'FAILED'} —?${result.detail}`)
  if (!result.ok) {
    for (const entry of result.failedEntries) lines.push(`  failed entry: ${entry}`)
  }
  if (result.startupReport !== null) {
    lines.push(`  official startup diagnostics: ${result.startupReport.file}`)
    for (const entry of result.startupReport.entries) {
      lines.push(`    [${entry.required ? 'required' : 'optional'}] ${entry.id} —?${entry.module}`)
    }
  }
  if (!result.ok && result.outputTail !== '') {
    lines.push('  last output:')
    for (const line of result.outputTail.split('\n').slice(-12)) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

/**
 * Publish-time check for one plugin package: a local directory, or an npm
 * package spec that is downloaded from the registry into a temp directory.
 * With `--runtime` the package is additionally booted in an isolated DSH home.
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
    const staticOk = verifyOk(report, options.strict)
    let runtime: RuntimeVerifyResult | null = null
    if (options.runtime) {
      if (!options.json) process.stdout.write('\nrunning the isolated boot check...\n')
      const installSource: RuntimeInstallSource = kind === 'npm' ? { kind: 'spec', value: input } : { kind: 'dir', value: dir }
      runtime = await runRuntimeVerify(dir, installSource, options.runtimeTimeoutSec)
    }
    const ok = staticOk && (runtime === null || runtime.ok)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...report, ok, ...(runtime === null ? {} : { runtime }) })}\n`)
    } else {
      process.stdout.write(`${renderHuman(report)}\n`)
      if (runtime !== null) process.stdout.write(`${renderRuntime(runtime)}\n`)
      if (!ok) {
        process.stderr.write(
          options.strict
            ? 'FAILED (--strict: warnings count as failures)\n'
            : runtime !== null && !runtime.ok
              ? 'FAILED: the isolated boot did not survive; fix the package before publishing\n'
              : 'FAILED: fix the errors before publishing\n',
        )
      }
    }
    return ok ? 0 : 1
  } finally {
    cleanup?.()
  }
}
