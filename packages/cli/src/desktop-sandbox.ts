import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import {
  classifyDesktopReadiness,
  desktopNeedsPortPatch,
  desktopPortPatchYaml,
  desktopVerifyProfileFiles,
  detectDesktop,
  packLocalPackage,
  resolveDesktopAppExecutable,
  resolveDesktopCliLauncher,
  DESKTOP_CLI_MIN_VERSION,
  type DesktopReadinessOutcome,
  type DesktopReadinessProbe,
} from 'dsh-plugin-ops-core'
import { spawnCli } from './spawn-dsh.js'
import type { RuntimeInstallSource } from './verify-cmd.js'

/**
 * Reusable desktop sandbox: boot a package in an isolated desktop instance
 * and observe whether the application reaches a ready host port without
 * crashing. Shared by `verify --desktop`, `dev --desktop`, and the `adapt`
 * desktop canary (which prepares its exemption through `prepare`).
 *
 * Isolation follows the verified recipe: a temporary DSH home (its own desktop
 * profile) plus an Electron `--user-data-dir`, so the sandbox runs beside a
 * live desktop instance without touching it. The install goes through the
 * desktop's own bundled CLI (launcher by absolute path, `DSH_HOME` pointing at
 * the sandbox); the fixed-port 0.2.0-rc line gets a webserver port patch, and
 * 0.2.1+ binds a system-assigned port. Teardown kills only this run's process
 * tree.
 */

/** The prepared sandbox locations handed to a `prepare` hook. */
export interface DesktopSandboxContext {
  /** Temporary sandbox root (removed after the run). */
  sandboxDir: string
  /** The sandbox DSH home. */
  home: string
  /** The scaffolded sandbox desktop profile directory. */
  profileDir: string
  /** Absolute path of the desktop's bundled CLI launcher. */
  launcher: string
  /** Absolute path of the desktop application executable. */
  executable: string
  /** The installed desktop release version, or null when unknown. */
  desktopVersion: string | null
}

export interface DesktopSandboxOptions {
  installSource: RuntimeInstallSource
  /** Seconds the sandbox may take to reach readiness before it fails. */
  timeoutSec: number
  /**
   * Prepare the sandbox profile between scaffolding and the CLI install; the
   * `adapt` canary writes its exact-version exemption here so the official
   * gate admits the package inside the sandbox.
   */
  prepare?: (context: DesktopSandboxContext) => Promise<void> | void
}

/** Why the sandbox run ended the way it did. */
export type DesktopSandboxKind = 'ready' | 'exited' | 'crashed' | 'timeout' | 'install-failed' | 'unavailable'

export interface DesktopSandboxRun {
  ok: boolean
  kind: DesktopSandboxKind
  /** One-line human description of the outcome. */
  detail: string
  /** The process exit code for 'exited' and 'install-failed'; 0 once launched when not exited; null before anything ran. */
  exitCode: number | null
  elapsedMs: number
  /** The patched sandbox host port, or null when the release self-assigns one. */
  port: number | null
  outputTail: string
  /** The readiness classification when the sandbox launched; null otherwise. */
  outcome: DesktopReadinessOutcome | null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Kill one process tree; the tree is this run's sandbox, never the live desktop. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

/** Whether a local port accepts a connection right now. */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (value: boolean): void => { socket.destroy(); resolvePromise(value) }
    socket.setTimeout(800)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** Reserve one free local port; null when the probe fails. */
function freePort(): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const server = net.createServer()
    server.once('error', () => resolvePromise(null))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePromise(port === 0 ? null : port))
    })
  })
}

/** Crash-report files written since launch. */
function newCrashLogs(logsDir: string, sinceMs: number): string[] {
  let entries: string[]
  try { entries = readdirSync(logsDir) } catch { return [] }
  const out: string[] = []
  for (const entry of entries) {
    if (!/^crash-.*\.log$/i.test(entry)) continue
    const file = join(logsDir, entry)
    try {
      if (statSync(file).mtimeMs >= sinceMs - 2000) out.push(file)
    } catch { /* racing write */ }
  }
  return out
}

function readTail(file: string, max: number): string {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length <= max ? text : text.slice(text.length - max)
  } catch {
    return ''
  }
}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

interface CliRun {
  code: number | null
  output: string
}

/** Run one CLI command with the sandbox environment and a hard timeout. */
function runCli(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolvePromise) => {
    const child = spawnCli(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
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

/**
 * Boot the package inside an isolated desktop sandbox and observe readiness.
 * @param options - install source, readiness window, and an optional profile
 *   preparation hook that runs before the CLI install.
 * @returns the structured sandbox outcome (each consumer shapes its own
 *   presentation; nothing throws for expected failures).
 */
export async function runDesktopSandbox(options: DesktopSandboxOptions): Promise<DesktopSandboxRun> {
  const unavailable = (detail: string): DesktopSandboxRun => ({
    ok: false, kind: 'unavailable', detail, exitCode: null, elapsedMs: 0, port: null, outputTail: '', outcome: null,
  })
  const desktop = detectDesktop()
  if (desktop.installDir === null) {
    return unavailable('no DeepSeek Harness desktop installation found; install the desktop app first')
  }
  const launcher = resolveDesktopCliLauncher(desktop.installDir)
  if (launcher === null) {
    return unavailable(`the desktop installation carries no bundled CLI (needs ${DESKTOP_CLI_MIN_VERSION}+); update the desktop app`)
  }
  const executable = resolveDesktopAppExecutable(desktop.installDir)
  if (executable === null) {
    return unavailable('the desktop application executable was not found in the installation')
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-ops-desktop-sandbox-'))
  const home = join(sandbox, 'home')
  const userdata = join(sandbox, 'userdata')
  const profileDir = join(home, 'profiles', 'desktop')
  const logsDir = join(userdata, 'logs')
  let instance: ChildProcess | null = null
  let packCleanup: (() => void) | null = null
  try {
    mkdirSync(profileDir, { recursive: true })
    for (const [rel, content] of Object.entries(desktopVerifyProfileFiles())) {
      writeFileSync(join(profileDir, rel), content, 'utf8')
    }
    // The sandbox's bundled pnpm reads the profile's project-level npm config;
    // propagate the registry the caller's environment selected (a mirror on
    // networks that cannot reach the default one). A caller without an
    // explicit registry keeps the bundled default.
    const registry = (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? '').trim()
    if (registry !== '') {
      writeFileSync(join(profileDir, '.npmrc'), `registry=${registry}\n`, 'utf8')
    }
    if (options.prepare !== undefined) {
      await options.prepare({ sandboxDir: sandbox, home, profileDir, launcher, executable, desktopVersion: desktop.version })
    }

    let installTarget: string
    if (options.installSource.kind === 'spec') {
      installTarget = options.installSource.value
    } else {
      const packed = await packLocalPackage(options.installSource.value)
      if (!packed.ok || packed.tarball === null) {
        return unavailable(`cannot pack the directory for a tarball install: ${packed.error ?? 'unknown error'}`)
      }
      installTarget = packed.tarball
      packCleanup = packed.cleanup
    }

    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
    const install = await runCli(launcher, ['plugin', '--profile', 'desktop', 'add', installTarget], env, 300_000)
    if (install.code !== 0) {
      return {
        ok: false, kind: 'install-failed',
        detail: `the desktop CLI install failed (exit ${install.code ?? 'timeout'})`,
        exitCode: install.code, elapsedMs: 0, port: null, outputTail: tail(install.output), outcome: null,
      }
    }

    let port: number | null = null
    if (desktopNeedsPortPatch(desktop.version)) {
      port = await freePort()
      if (port === null) return unavailable('could not reserve a local port for the sandbox host')
      writeFileSync(join(profileDir, 'cordis.patch.yml'), desktopPortPatchYaml(port), 'utf8')
    }

    const start = Date.now()
    const deadline = options.timeoutSec * 1000
    const child = spawn(executable, [`--user-data-dir=${userdata}`], { stdio: ['ignore', 'pipe', 'pipe'], env })
    instance = child
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    let outcome: DesktopReadinessOutcome | null = null
    while (outcome === null) {
      await delay(1000)
      const probe: DesktopReadinessProbe = {
        alive: child.exitCode === null && !child.killed,
        exitCode: child.exitCode,
        // The 0.2.1+ host binds a system-assigned port this run cannot know;
        // readiness there degrades to process liveness and crash reports.
        listening: port === null ? true : await isPortListening(port),
        crashLogs: newCrashLogs(logsDir, start),
      }
      outcome = classifyDesktopReadiness(probe, Date.now() - start, deadline)
    }

    const crashTail = outcome.kind === 'crashed' && outcome.crashLogs.length > 0
      ? readTail(outcome.crashLogs[outcome.crashLogs.length - 1]!, 1000)
      : ''
    const detail = outcome.kind === 'ready'
      ? `desktop boot: the isolated sandbox reached its host port in ${(outcome.elapsedMs / 1000).toFixed(1)}s${port === null ? '' : ` (port ${port})`}`
      : outcome.kind === 'exited'
        ? `desktop exited ${outcome.exitCode ?? 'by signal'} after ${outcome.elapsedMs}ms, before the host port opened`
        : outcome.kind === 'crashed'
          ? `desktop wrote a crash report before the host port opened: ${outcome.crashLogs[0] ?? ''}`
          : `desktop did not open its host port within ${options.timeoutSec}s`
    return {
      ok: outcome.kind === 'ready',
      kind: outcome.kind,
      detail,
      exitCode: outcome.kind === 'exited' ? outcome.exitCode : 0,
      elapsedMs: outcome.elapsedMs,
      port,
      outputTail: tail(`${output}${crashTail === '' ? '' : `\n--- crash report tail ---\n${crashTail}`}`),
      outcome,
    }
  } finally {
    packCleanup?.()
    if (instance !== null && instance.exitCode === null) {
      killTree(instance.pid)
      // Let the killed tree release its file handles before removing the sandbox.
      await delay(1500)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(sandbox, { recursive: true, force: true })
        break
      } catch {
        await delay(700)
      }
    }
  }
}
