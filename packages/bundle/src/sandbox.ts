import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import {
  appendDisabledRow,
  readLatestStartupReport,
  resolveDshPaths,
  scanProfile,
  type DshPaths,
  type ScanReport,
  type StartupReport,
} from 'dsh-plugin-ops-core'

/**
 * The isolated sandbox instance (the "number 2 dsh") that the panel starts,
 * watches, and repairs from outside. One temporary DSH_HOME per run, cleaned
 * up on stop: the sandbox carries the risky plugin work, while every reading
 * here comes from outside its process — files, diagnostics, and the child's
 * output — so nothing the sandbox loads can reach this host.
 */

export type SandboxState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface SandboxLogLine {
  seq: number
  ts: string
  line: string
}

export interface SandboxStatus {
  state: SandboxState
  /** The sandbox Web UI URL once running. */
  url: string | null
  /** The temporary DSH_HOME (readable while running). */
  home: string | null
  startedAt: string | null
  /** Why the last start failed, or the last run's outcome note; null when none. */
  problem: string | null
  /** The last process exit (any run). */
  lastExit: { code: number | null; at: string } | null
}

export interface SandboxDiagnosis {
  /** Official startup-diagnostics file inside the sandbox home, when present. */
  startup: StartupReport | null
  /** Error-looking lines from the sandbox output tail. */
  errorLines: string[]
}

export interface SandboxFixResult {
  applied: { row: string; ok: boolean; detail: string }[]
  status: SandboxStatus
}

const START_TIMEOUT_MS = 45_000
const MAX_LOG_LINES = 400

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Kill one process tree: `taskkill /T /F` on Windows, the process group on
 * POSIX (the sandbox child is spawned detached; SIGTERM, then a SIGKILL
 * sweep). Same behavior as the CLI sandbox teardown.
 */
export function killTree(pid: number | undefined, graceMs = 1000): void {
  if (pid === undefined || pid <= 0) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
    return
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal); return } catch { /* not a group leader */ }
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
  signalTree('SIGTERM')
  const timer = setTimeout(() => signalTree('SIGKILL'), graceMs)
  timer.unref()
}

/** Quote one argument for a `cmd.exe` command string. */
function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""').replace(/%/g, '%%')}"`
}

/** Spawn the dsh CLI portably; a bare `dsh` is an npm shim, which Node refuses to spawn without a shell on Windows. */
function spawnDsh(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const detached = process.platform !== 'win32'
  if (process.platform !== 'win32') {
    return spawn('dsh', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached })
  }
  const inner = ['dsh', ...args].map(quoteCmdArg).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${inner}"`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true })
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

const URL_LINE = /dsh web: (http[^\s]+)/

/**
 * One temporary sandbox instance with an outside observability surface:
 * status, incremental logs, startup diagnostics, profile scans, and
 * disable-row fixes that restart the instance to prove the repair.
 */
export class SandboxManager {
  private state: SandboxState = 'stopped'
  private child: ChildProcess | null = null
  private home: string | null = null
  private port: number | null = null
  private url: string | null = null
  private startedAt: string | null = null
  private problem: string | null = null
  private lastExit: { code: number | null; at: string } | null = null
  private readonly logs: SandboxLogLine[] = []
  private seq = 0

  constructor(private readonly dshCommand = 'dsh') {}

  /** The sandbox paths for the current run; null when no home exists. */
  private paths(): DshPaths | null {
    return this.home === null ? null : resolveDshPaths('web', this.home)
  }

  private appendLog(line: string): void {
    this.seq += 1
    this.logs.push({ seq: this.seq, ts: new Date().toISOString(), line })
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
  }

  status(): SandboxStatus {
    return {
      state: this.state,
      url: this.url,
      home: this.home,
      startedAt: this.startedAt,
      problem: this.problem,
      lastExit: this.lastExit,
    }
  }

  /** Log lines after `afterSeq` (0 = from the oldest retained line). */
  logsAfter(afterSeq: number): { lines: SandboxLogLine[]; nextSeq: number } {
    const lines = this.logs.filter((entry) => entry.seq > afterSeq)
    return { lines, nextSeq: this.seq }
  }

  /**
   * Start the isolated instance; respects an already starting/running sandbox.
   * A manual start begins from a fresh home; the fix flow restarts on the
   * retained home (`reuseHome`) so the written patch survives the restart.
   * A failed start keeps the home for diagnosis; `stop` clears it.
   */
  async start(reuseHome = false): Promise<SandboxStatus> {
    if (this.state === 'starting' || this.state === 'running') return this.status()
    if (!reuseHome) this.cleanup()
    this.state = 'starting'
    this.problem = null
    this.url = null
    this.startedAt = null
    try {
      if (this.home === null) this.home = mkdtempSync(join(tmpdir(), 'dsh-ops-sandbox-'))
      const home = this.home
      this.appendLog(`# starting isolated sandbox (DSH_HOME=${home})`)
      const port = await freePort()
      if (port === null) {
        this.problem = 'could not reserve a local port for the sandbox'
        this.cleanup()
        return this.status()
      }
      this.port = port
      const child = spawnDsh(['--profile', 'web', '--port', String(port), '--no-open'], { ...process.env, DSH_HOME: home })
      this.child = child
      this.appendLog(`$ dsh --profile web --port ${port} --no-open`)
      const collect = (chunk: Buffer): void => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (line.trim() === '') continue
          this.appendLog(line)
          if (this.url === null) {
            const match = URL_LINE.exec(line)
            if (match !== null) this.url = match[1]!
          }
        }
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)

      const deadline = Date.now() + START_TIMEOUT_MS
      for (;;) {
        await delay(500)
        if (child.exitCode !== null) {
          this.state = 'stopped'
          this.lastExit = { code: child.exitCode, at: new Date().toISOString() }
          this.problem = `the sandbox dsh exited ${child.exitCode} during startup; see the log and diagnostics`
          return this.status()
        }
        if (this.url !== null) break
        if (Date.now() >= deadline) {
          this.problem = `the sandbox did not report its Web UI within ${START_TIMEOUT_MS / 1000}s`
          killTree(child.pid)
          this.state = 'stopped'
          this.lastExit = { code: child.exitCode, at: new Date().toISOString() }
          return this.status()
        }
      }
      this.state = 'running'
      this.startedAt = new Date().toISOString()
      this.appendLog('# sandbox is up')
      return this.status()
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error)
      this.state = 'stopped'
      return this.status()
    }
  }

  /** Stop the sandbox process but keep its home (the fix restart path). */
  private async killOnly(): Promise<void> {
    this.state = 'stopping'
    const child = this.child
    if (child !== null && child.exitCode === null) {
      killTree(child.pid)
      const deadline = Date.now() + 8000
      while (child.exitCode === null && Date.now() < deadline) await delay(200)
      this.lastExit = { code: child.exitCode, at: new Date().toISOString() }
    }
    this.child = null
    this.url = null
    this.startedAt = null
    this.state = 'stopped'
  }

  /** Stop the sandbox and clean its temporary home (关掉即清理). */
  async stop(): Promise<SandboxStatus> {
    await this.killOnly()
    this.appendLog('# sandbox stopped; temporary home removed')
    this.cleanup()
    return this.status()
  }

  /**
   * Restart the sandbox on its retained home: installed or disabled plugins
   * take effect and the boot can be observed again, without losing the
   * sandbox state the way `stop` would.
   */
  async restart(): Promise<SandboxStatus> {
    await this.killOnly()
    this.appendLog('# restarting the sandbox (home kept)')
    return this.start(true)
  }

  /** Stop without awaiting (plugin teardown). */
  dispose(): void {
    const child = this.child
    if (child !== null && child.exitCode === null) killTree(child.pid)
    this.cleanup()
  }

  private cleanup(): void {
    this.child = null
    this.url = null
    this.port = null
    this.startedAt = null
    const home = this.home
    this.home = null
    if (home !== null) {
      const remove = (): void => {
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          setTimeout(remove, 500)
        }
      }
      remove()
    }
  }

  /** Read the outside-visible diagnosis: official startup diagnostics + error-looking output lines. */
  diagnose(sinceMs?: number): SandboxDiagnosis {
    const paths = this.paths()
    const startup = paths === null ? null : readLatestStartupReport(paths, sinceMs ?? 0)
    const errorLines = this.logs
      .map((entry) => entry.line)
      .filter((line) => /did not activate|failed to import|Error:|error|fatal|ERR_/i.test(line))
      .slice(-40)
    return { startup, errorLines }
  }

  /** Scan the sandbox profile with the shared engine (outside its process). */
  async scan(): Promise<ScanReport | null> {
    const paths = this.paths()
    if (paths === null) return null
    return scanProfile({ paths, profileName: 'web', config: {}, updateCheck: false })
  }

  /**
   * Apply a disable-row fix inside the sandbox and restart it to prove the
   * repair. Each row is written structurally into the sandbox profile's patch
   * layer; the restart's outcome decides whether the fix worked.
   */
  async fix(rows: string[]): Promise<SandboxFixResult> {
    const paths = this.paths()
    const applied: SandboxFixResult['applied'] = []
    if (paths === null) {
      return { applied: rows.map((row) => ({ row, ok: false, detail: 'no sandbox home; start the sandbox first' })), status: this.status() }
    }
    for (const row of rows) {
      const write = appendDisabledRow(paths.profileDir, row)
      applied.push({ row, ok: write.ok, detail: write.ok ? `disabled row "${row}"` : write.problem ?? 'unknown error' })
    }
    await this.killOnly()
    this.appendLog(`# restarting to verify the fix (rows: ${rows.join(', ')})`)
    const restart = await this.start(true)
    return { applied, status: restart }
  }
}
