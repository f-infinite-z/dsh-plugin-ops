import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import {
  allVisibleRows,
  appendDisabledRow,
  desktopNeedsPortPatch,
  desktopPortPatchYaml,
  desktopVerifyProfileFiles,
  detectDesktop,
  locateInstallAnchor,
  MEMORY_DIR_NAME,
  profileBundles,
  readAllowBuildsState,
  readDesktopVersion,
  readLatestCrashReport,
  readLatestStartupReport,
  readPackageManifest,
  readProfileManifest,
  registryDependencies,
  resolveBundles,
  resolveDesktopAppExecutable,
  resolveDesktopCliLauncher,
  resolveDshPaths,
  scanProfile,
  setAllowBuilds,
  type CrashReport,
  type DshPaths,
  type ScanReport,
  type StartupReport,
} from 'dsh-plugin-ops-core'

/**
 * The isolated sandbox instance (the "number 2 dsh") that the panel starts,
 * watches, and repairs from outside. One temporary home per run, cleaned up
 * on stop.
 *
 * Two shapes share the manager: a `web` sandbox (a second CLI-hosted instance
 * in a temporary DSH home) and a `desktop` sandbox (a second desktop app
 * window driven through `--user-data-dir` plus its own DSH home, for the
 * desktop host). The shape follows the host that mounts the panel: the
 * desktop profile implies the desktop sandbox.
 *
 * The isolation is configuration-level, not a security boundary: the sandbox
 * is a fresh DSH profile, but it runs as this user with the inherited
 * environment and full file-system access — good for testing that a plugin
 * configuration boots, not for running untrusted plugin code.
 */

export type SandboxState = 'stopped' | 'starting' | 'running' | 'stopping'

/** Which instance shape the sandbox drives. */
export type SandboxKind = 'web' | 'desktop'

export interface SandboxLogLine {
  seq: number
  ts: string
  line: string
}

export interface SandboxStatus {
  /** The instance shape this manager drives. */
  kind: SandboxKind
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
  /** Desktop shape only: the newest crash report inside the sandbox user-data logs. */
  crash: CrashReport | null
  /** Error-looking lines from the sandbox output tail. */
  errorLines: string[]
}

export interface SandboxFixResult {
  applied: { row: string; ok: boolean; detail: string }[]
  /**
   * Whether the sandbox actually restarted with disabled rows in effect.
   * False when nothing was applied, the closure was unresolvable, or the old
   * process refused to exit — the outcome sentence must follow this, not the
   * status alone.
   */
  restarted: boolean
  status: SandboxStatus
}

/** One step of a sandbox change operation (install / uninstall). */
export interface SandboxChangeStep {
  step: string
  ok: boolean
  detail: string
}

/**
 * The outcome of one install or uninstall inside the sandbox. `ok` follows
 * the ground truth read back from the profile — the package manager's exit
 * code alone is not enough (a failed install can still leave the dependency
 * declared, and a successful `add` of an already-installed version does not
 * re-register the bundle).
 */
export interface SandboxChangeResult {
  action: 'install' | 'uninstall'
  /** The original request: the npm spec for install, the package name for uninstall. */
  target: string
  name: string
  ok: boolean
  /** Whether the automatic remove + add repair ran. */
  recovered: boolean
  steps: SandboxChangeStep[]
  status: SandboxStatus
}

/** One build-gate decision applied to the sandbox profile. */
export interface SandboxBuildGateEntry {
  name: string
  allow: boolean
  ok: boolean
}

/** The outcome of resolving the pnpm build-script gate inside the sandbox. */
export interface SandboxBuildGateResult {
  ok: boolean
  applied: SandboxBuildGateEntry[]
  backup: string | null
  problem: string | null
  status: SandboxStatus
}

/** One recorded sandbox action. */
export interface SandboxReportEvent {
  ts: string
  action: string
  detail: string
}

/**
 * The persisted conclusion of one sandbox session: what got installed (with
 * versions), every change action taken, and how the run ended. Written under
 * the host home so the result survives the sandbox home's cleanup — the
 * "what did I verify in there?" answer.
 */
export interface SandboxReport {
  kind: SandboxKind
  startedAt: string | null
  endedAt: string | null
  home: string | null
  url: string | null
  events: SandboxReportEvent[]
  packages: { name: string; version: string | null }[]
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

/** How the sandbox process is launched. */
type DshDriver =
  /** The running installation's own CLI entry (same version and closure as this host). */
  | { kind: 'node'; execPath: string; entry: string }
  /** A `dsh` command found on PATH (fallback when the host entry is not recognizable). */
  | { kind: 'command'; name: string }

/**
 * Prefer the running installation's own CLI entry so the sandbox matches this
 * host exactly (same version and package closure) instead of whatever `dsh`
 * resolves to on PATH.
 */
function resolveDshDriver(): DshDriver {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/]@deepseek-ai[\\/]dsh[\\/].*\.(js|mjs|cjs)$/.test(entry) && existsSync(entry)) {
    return { kind: 'node', execPath: process.execPath, entry }
  }
  return { kind: 'command', name: 'dsh' }
}

/** The desktop installation facts a desktop sandbox needs. */
export interface DesktopDriver {
  /** Absolute path of the installed application executable. */
  executable: string
  /** The installed desktop release version, or null when unknown. */
  version: string | null
  /** The desktop installation directory (management commands go through its bundled CLI). */
  installDir: string
}

/**
 * Derive the desktop installation directory from a host process entry path.
 * The desktop host runs inside the application, so its `argv[1]` is the
 * Electron executable (`<install>\DeepSeek Harness.exe` on Windows,
 * `<install>.app/Contents/MacOS/...` on macOS) — the running installation,
 * which pins the sandbox to the same release the host itself runs. Returns
 * null for any other shape (web hosts, tests).
 */
export function desktopInstallFromEntry(entry: string | undefined): string | null {
  if (entry === undefined || entry === '') return null
  if (process.platform === 'win32' && /[\\/]DeepSeek Harness\.exe$/i.test(entry)) return dirname(entry)
  if (process.platform === 'darwin') {
    const marker = entry.indexOf('.app/Contents/MacOS/')
    if (marker > 0) return entry.slice(0, marker + '.app'.length)
  }
  return null
}

/**
 * Resolve the desktop installation to drive: the running installation first
 * (from the host entry), then the conventional install locations. The
 * executable lookup doubles as the installation validation — it only exists
 * in a complete desktop installation.
 */
function resolveDesktopDriver(): { driver: DesktopDriver } | { error: string } {
  const fromHost = desktopInstallFromEntry(process.argv[1])
  if (fromHost !== null) {
    const executable = resolveDesktopAppExecutable(fromHost)
    if (executable !== null) return { driver: { executable, version: readDesktopVersion(fromHost), installDir: fromHost } }
  }
  const detected = detectDesktop()
  if (detected.installDir === null) {
    return { error: 'no DeepSeek Harness desktop installation found; install the desktop app first' }
  }
  const executable = resolveDesktopAppExecutable(detected.installDir)
  if (executable === null) {
    return { error: 'the desktop installation is missing its application executable' }
  }
  return { driver: { executable, version: detected.version, installDir: detected.installDir } }
}

/** Quote one argument for a `cmd.exe` command string. */
function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""').replace(/%/g, '%%')}"`
}

/** Spawn the sandbox CLI portably, with the sandbox home as the working directory. */
function spawnSandbox(driver: DshDriver, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const detached = process.platform !== 'win32'
  const stdio: ('ignore' | 'pipe')[] = ['ignore', 'pipe', 'pipe']
  if (driver.kind === 'node') {
    return spawn(driver.execPath, [driver.entry, ...args], { env, cwd, stdio, detached })
  }
  if (process.platform !== 'win32') {
    return spawn(driver.name, args, { env, cwd, stdio, detached })
  }
  const inner = [driver.name, ...args].map(quoteCmdArg).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${inner}"`], { env, cwd, stdio, windowsVerbatimArguments: true })
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
 * The launch URL carries its browser token; every line this module stores
 * (the log ring) or renders (tool output) must mask it — the token is a
 * local capability and must not leak into agent context, session logs, or
 * shared screenshots. The status URL itself stays intact: the panel needs it
 * to open the sandbox.
 */
export function redactToken(text: string): string {
  return text.replace(/([?&]token=)[^&\s]*/gi, '$1***')
}

/**
 * The bare package name inside an npm spec (`name`, `name@range`,
 * `@scope/name`, `@scope/name@range`). Path-like and protocol targets return
 * null: the sandbox change tools accept registry specs only, and guessing a
 * name for a tarball or a file: reference cannot be verified against the
 * profile afterwards.
 */
export function packageNameFromSpec(spec: string): string | null {
  const s = spec.trim()
  if (s === '') return null
  if (/^(file:|link:|git\+|https?:|\.{0,2}[\\/])/i.test(s) || /\.(tgz|tar\.gz|tar)$/i.test(s)) return null
  if (s.includes('\\')) return null
  if (s.startsWith('@')) {
    const slash = s.indexOf('/')
    if (slash <= 1) return null
    const at = s.indexOf('@', slash)
    const name = at === -1 ? s : s.slice(0, at)
    return name.length > slash + 1 ? name : null
  }
  const at = s.indexOf('@')
  const name = at === -1 ? s : s.slice(0, at)
  return name.length > 0 ? name : null
}

/** Collapse one command output into a bounded single-line tail for step details. */
function outputTail(text: string, max = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : collapsed.slice(collapsed.length - max)
}

/**
 * One temporary sandbox instance with an outside observability surface:
 * status, incremental logs, startup diagnostics, profile scans, and
 * disable-row fixes that restart the instance to prove the repair.
 */
export class SandboxManager {
  /** The instance shape this manager drives (set once at construction). */
  readonly kind: SandboxKind
  private state: SandboxState = 'stopped'
  private child: ChildProcess | null = null
  /** The desktop shape's sandbox root holding `home` and `userdata`; null for the web shape. */
  private root: string | null = null
  private home: string | null = null
  /** The desktop shape's Electron user-data directory (`--user-data-dir` isolation). */
  private userdata: string | null = null
  private port: number | null = null
  private url: string | null = null
  private startedAt: string | null = null
  /** Launch epoch for crash-report filtering (desktop shape). */
  private startedMs: number | null = null
  private problem: string | null = null
  private lastExit: { code: number | null; at: string } | null = null
  private readonly logs: SandboxLogLine[] = []
  private seq = 0
  private readonly driver: DshDriver = resolveDshDriver()
  /**
   * The running installation's package.json. Sandbox-side analysis resolves
   * official bundles through this closure — the same installation the
   * sandbox boots from — because the fresh sandbox home has no install
   * anchor of its own.
   */
  private readonly installAnchor: string | null = (() => {
    if (this.driver.kind !== 'node') return null
    const candidate = resolve(dirname(this.driver.entry), '..', 'package.json')
    return existsSync(candidate) ? candidate : null
  })()
  /** A kill that outlived SIGTERM and the SIGKILL sweep keeps the home for diagnosis. */
  private killTimedOut = false
  /** The configured npm registry for sandbox installs; null when unset. */
  private readonly configuredRegistry: string | null
  /** Where session reports are persisted (the host home's cache); null when the host provided no home. */
  private readonly reportDir: string | null
  private readonly reportEvents: SandboxReportEvent[] = []
  private reportStartedAt: string | null = null
  private readonly reportPackages: { name: string; version: string | null }[] = []

  constructor(options: { kind?: SandboxKind; registry?: string | undefined; home?: string | undefined } = {}) {
    this.kind = options.kind ?? 'web'
    const registry = (options.registry ?? '').trim()
    this.configuredRegistry = registry === '' ? null : registry
    this.reportDir = options.home === undefined || options.home === ''
      ? null
      : join(options.home, 'cache', MEMORY_DIR_NAME, 'sandbox-reports')
  }

  /** Reset the in-memory report for a fresh session (the persisted archive keeps the past). */
  private resetReport(): void {
    this.reportEvents.length = 0
    this.reportPackages.length = 0
    this.reportStartedAt = null
  }

  /**
   * Record one session action and persist the report. Persistence is best
   * effort: reporting must never disturb the sandbox.
   */
  private recordEvent(action: string, detail: string): void {
    this.reportEvents.push({ ts: new Date().toISOString(), action, detail })
    this.persistReport()
  }

  /** Track one installed package with the version read back from the sandbox profile. */
  private recordPackage(name: string): void {
    const paths = this.paths()
    const manifest = paths === null ? null : readPackageManifest(join(paths.profileDir, 'node_modules', ...name.split('/')))
    const version = manifest === null ? null : manifest.version === undefined ? null : String(manifest.version)
    const index = this.reportPackages.findIndex((pkg) => pkg.name === name)
    if (index === -1) this.reportPackages.push({ name, version })
    else this.reportPackages[index] = { name, version }
  }

  private forgetPackage(name: string): void {
    const index = this.reportPackages.findIndex((pkg) => pkg.name === name)
    if (index !== -1) this.reportPackages.splice(index, 1)
  }

  /**
   * Persist the session report under the host home (so the conclusion
   * survives the sandbox home's cleanup) and keep the newest 20 archives.
   */
  private persistReport(endedAt: string | null = null): void {
    const dir = this.reportDir
    if (dir === null) return
    try {
      mkdirSync(dir, { recursive: true })
      const report: SandboxReport = {
        kind: this.kind,
        startedAt: this.reportStartedAt,
        endedAt,
        home: this.home,
        url: this.url === null ? null : redactToken(this.url),
        events: this.reportEvents.slice(-200),
        packages: this.reportPackages,
      }
      const body = `${JSON.stringify(report, null, 2)}\n`
      writeFileSync(join(dir, 'latest.json'), body, 'utf8')
      writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), body, 'utf8')
      try {
        const archives = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'latest.json').sort()
        for (const name of archives.slice(0, Math.max(0, archives.length - 20))) {
          try { unlinkSync(join(dir, name)) } catch { /* raced */ }
        }
      } catch { /* the newest writes stand */ }
    } catch { /* best effort */ }
  }

  /** The latest persisted session report, read back from disk. */
  lastReport(): SandboxReport | null {
    const dir = this.reportDir
    if (dir === null) return null
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))
      return typeof value === 'object' && value !== null ? value as SandboxReport : null
    } catch {
      return null
    }
  }

  /**
   * The registry override for sandbox management commands and the desktop
   * profile scaffold: the dsh-ops config value wins, the environment is the
   * fallback, and neither means the package manager default.
   */
  private registryValue(): string | null {
    if (this.configuredRegistry !== null) return this.configuredRegistry
    const env = (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? '').trim()
    return env === '' ? null : env
  }

  /** The sandbox profile name (the shape's official profile). */
  private profileName(): string {
    return this.kind === 'desktop' ? 'desktop' : 'web'
  }

  /** The sandbox paths for the current run; null when no home exists. */
  private paths(): DshPaths | null {
    return this.home === null ? null : resolveDshPaths(this.profileName(), this.home)
  }

  private appendLog(line: string): void {
    this.seq += 1
    this.logs.push({ seq: this.seq, ts: new Date().toISOString(), line: redactToken(line) })
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
  }

  status(): SandboxStatus {
    return {
      kind: this.kind,
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
    if (!reuseHome) {
      this.cleanup()
      this.resetReport()
    }
    this.state = 'starting'
    this.problem = null
    this.url = null
    this.startedAt = null
    try {
      return this.kind === 'desktop' ? await this.startDesktop(reuseHome) : await this.startWeb()
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error)
      this.state = 'stopped'
      return this.status()
    }
  }

  /**
   * Collect one child's output into the ring buffer (picking up the Web UI
   * URL) and track an unexpected exit so the panel state cannot keep claiming
   * a running sandbox after its process is gone. killOnly owns expected exits
   * (it sets 'stopping' first) and the startup wait loop handles the startup
   * window.
   */
  private trackChild(child: ChildProcess): void {
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
    child.on('exit', (code) => {
      if (this.child !== child) return
      if (this.state !== 'running') return
      this.lastExit = { code, at: new Date().toISOString() }
      this.problem = `the sandbox process exited ${code ?? 'by signal'}`
      this.state = 'stopped'
      this.child = null
      this.url = null
      this.startedAt = null
      this.appendLog(`# sandbox process exited ${code ?? 'by signal'}`)
    })
  }

  /**
   * The desktop shape's newest crash report inside the sandbox user-data
   * logs. macOS keeps `app.setAppLogsPath()` pointing at the shared user log
   * directory regardless of `--user-data-dir`, so a report there cannot be
   * attributed to this sandbox: the desktop shape degrades to the Web UI
   * signal and the process state on macOS.
   */
  private currentCrashReport(sinceMs: number): CrashReport | null {
    if (this.kind !== 'desktop' || this.userdata === null) return null
    if (process.platform === 'darwin') return null
    return readLatestCrashReport(join(this.userdata, 'logs'), sinceMs)
  }

  /**
   * Wait for the startup signal (the `dsh web:` line either shape prints —
   * the desktop host forwards its child's output), an early exit, a desktop
   * crash report, or the timeout.
   */
  private async awaitReady(child: ChildProcess, startMs: number): Promise<SandboxStatus> {
    const deadline = startMs + START_TIMEOUT_MS
    for (;;) {
      await delay(500)
      if (child.exitCode !== null) {
        this.state = 'stopped'
        this.lastExit = { code: child.exitCode, at: new Date().toISOString() }
        this.problem = `the sandbox dsh exited ${child.exitCode} during startup; see the log and diagnostics`
        return this.status()
      }
      if (this.url !== null) break
      const crash = this.currentCrashReport(startMs)
      if (crash !== null) {
        this.problem = `the desktop sandbox wrote a crash report before opening its Web UI: ${crash.file}`
        this.appendLog(`# crash report written: ${crash.file}`)
        killTree(child.pid)
        this.state = 'stopped'
        this.lastExit = { code: child.exitCode, at: new Date().toISOString() }
        return this.status()
      }
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
    this.startedMs = startMs
    this.appendLog('# sandbox is up')
    this.reportStartedAt = this.reportStartedAt ?? this.startedAt
    this.recordEvent('start', `${this.kind} sandbox is up`)
    return this.status()
  }

  /** The web shape: a second CLI-hosted dsh in a temporary DSH home. */
  private async startWeb(): Promise<SandboxStatus> {
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
    const child = spawnSandbox(this.driver, ['--profile', 'web', '--port', String(port), '--no-open'], { ...process.env, DSH_HOME: home }, home)
    this.child = child
    this.appendLog(`$ dsh --profile web --port ${port} --no-open`)
    this.trackChild(child)
    return this.awaitReady(child, Date.now())
  }

  /**
   * The desktop shape: a second desktop window of the running installation
   * (its own `--user-data-dir` plus a scaffolded desktop profile under a
   * temporary DSH home). The scaffold boots as verified by the desktop
   * sandbox recipe — no install step is needed for an empty profile; the
   * fixed-port releases get an isolated webserver port pin.
   */
  private async startDesktop(reuseHome: boolean): Promise<SandboxStatus> {
    const resolved = resolveDesktopDriver()
    if ('error' in resolved) {
      this.problem = resolved.error
      this.state = 'stopped'
      return this.status()
    }
    if (!reuseHome || this.root === null || this.home === null || this.userdata === null) {
      this.root = mkdtempSync(join(tmpdir(), 'dsh-ops-desktop-sandbox-'))
      this.home = join(this.root, 'home')
      this.userdata = join(this.root, 'userdata')
      const profileDir = join(this.home, 'profiles', 'desktop')
      mkdirSync(profileDir, { recursive: true })
      for (const [rel, content] of Object.entries(desktopVerifyProfileFiles())) {
        writeFileSync(join(profileDir, rel), content, 'utf8')
      }
      // The sandbox's bundled pnpm reads the profile-level npm config; carry
      // over the registry the host selected (config first, environment
      // second) so networks that cannot reach the default registry work.
      const registry = this.registryValue()
      if (registry !== null) writeFileSync(join(profileDir, '.npmrc'), `registry=${registry}\n`, 'utf8')
      if (desktopNeedsPortPatch(resolved.driver.version)) {
        const port = await freePort()
        if (port === null) {
          this.problem = 'could not reserve a local port for the desktop sandbox host'
          this.cleanup()
          return this.status()
        }
        this.port = port
        writeFileSync(join(profileDir, 'cordis.patch.yml'), desktopPortPatchYaml(port), 'utf8')
      }
    }
    const home = this.home
    const userdata = this.userdata
    this.appendLog(`# starting isolated desktop sandbox (DSH_HOME=${home}, user-data-dir=${userdata})`)
    const startMs = Date.now()
    // The host half itself runs inside an Electron child process, whose
    // environment carries Electron-injected variables (`ELECTRON_RUN_AS_NODE`
    // would make the second window start as a Node script and die on
    // `--user-data-dir`). The sandbox must boot as a GUI app: strip them.
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    const child = spawn(resolved.driver.executable, [`--user-data-dir=${userdata}`], {
      env,
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.appendLog(`$ "${resolved.driver.executable}" --user-data-dir=${userdata}`)
    this.trackChild(child)
    return this.awaitReady(child, startMs)
  }

  /** Stop the sandbox process but keep its home (the fix/restart path). */
  private async killOnly(): Promise<void> {
    this.state = 'stopping'
    this.killTimedOut = false
    const child = this.child
    if (child !== null && child.exitCode === null) {
      killTree(child.pid)
      const deadline = Date.now() + 8000
      while (child.exitCode === null && Date.now() < deadline) await delay(200)
      if (child.exitCode === null) {
        // SIGTERM and the SIGKILL sweep both failed to settle this tree; keep
        // the home for diagnosis instead of pretending the teardown was clean.
        this.killTimedOut = true
        this.problem = 'the sandbox process did not exit; its home is kept for diagnosis'
      }
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
    if (this.killTimedOut) {
      this.appendLog('# sandbox process did not exit; home kept for diagnosis')
      this.persistReport(new Date().toISOString())
      return this.status()
    }
    this.appendLog('# sandbox stopped; temporary home removed')
    this.recordEvent('stop', 'sandbox stopped; temporary home removed')
    this.persistReport(new Date().toISOString())
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
    if (this.killTimedOut) {
      this.appendLog('# restart skipped: the old process did not exit')
      return this.status()
    }
    this.appendLog('# restarting the sandbox (home kept)')
    return this.start(true)
  }

  /** Stop without awaiting (plugin teardown). */
  dispose(): void {
    const child = this.child
    if (child !== null && child.exitCode === null) killTree(child.pid)
    this.recordEvent('dispose', 'plugin teardown')
    this.persistReport(new Date().toISOString())
    this.cleanup()
  }

  private cleanup(): void {
    this.child = null
    this.url = null
    this.port = null
    this.startedAt = null
    this.startedMs = null
    // The web shape's home is its own temporary directory; the desktop
    // shape's root holds both the home and the Electron user-data directory.
    const target = this.kind === 'desktop' ? this.root : this.home
    this.root = null
    this.home = null
    this.userdata = null
    if (target !== null) {
      let attempts = 0
      const remove = (): void => {
        try {
          rmSync(target, { recursive: true, force: true })
        } catch {
          attempts += 1
          if (attempts < 5) {
            const timer = setTimeout(remove, 500)
            timer.unref()
          }
        }
      }
      remove()
    }
  }

  /**
   * Read the outside-visible diagnosis: official startup diagnostics (the web
   * shape), the desktop shape's crash reports, plus error-looking output lines.
   */
  diagnose(sinceMs?: number): SandboxDiagnosis {
    const paths = this.paths()
    const startup = paths === null ? null : readLatestStartupReport(paths, sinceMs ?? 0)
    const crash = this.currentCrashReport(sinceMs ?? this.startedMs ?? 0)
    const errorLines = this.logs
      .map((entry) => entry.line)
      .filter((line) => /did not activate|failed to import|Error:|error|fatal|ERR_/i.test(line))
      .slice(-40)
    return { startup, crash, errorLines }
  }

  /** Scan the sandbox profile with the shared engine (outside its process). */
  async scan(): Promise<ScanReport | null> {
    const paths = this.paths()
    if (paths === null) return null
    return scanProfile({ paths, profileName: this.profileName(), config: {}, updateCheck: false })
  }

  /**
   * Row ids visible in the sandbox profile's loader layers (bundle patches
   * plus the user patch). The web shape resolves official bundles through the
   * running installation's closure; the desktop shape excludes official
   * bundles (they live inside the packaged asar, unreadable to this process),
   * so only third-party bundles and the user layer contribute rows there.
   * Returns null when the profile manifest is unreadable — an unresolvable
   * closure must read as "cannot tell", never as "no rows".
   */
  private visibleRows(paths: DshPaths): Set<string> | null {
    try {
      const manifest = readProfileManifest(paths.profileManifest)
      if (manifest === null) return null
      const desktop = this.kind === 'desktop'
      const anchor = desktop ? null : this.installAnchor ?? locateInstallAnchor(paths, null)
      const bundles = resolveBundles(paths, manifest, anchor, desktop).resolved
      return new Set(
        allVisibleRows(paths.profileDir, bundles)
          .map((ref) => ref.row.id)
          .filter((id): id is string => typeof id === 'string'),
      )
    } catch {
      return null
    }
  }

  /**
   * Apply a disable-row fix inside the sandbox and restart it with those rows
   * disabled. A row id with no visible loader row in the sandbox profile is
   * rejected instead of writing a meaningless patch entry; the restart's
   * outcome reports whether the boot succeeds with the disabled rows (which
   * shows they are not the sole blocker — it cannot prove they were the cause).
   */
  async fix(rows: string[]): Promise<SandboxFixResult> {
    const paths = this.paths()
    const applied: SandboxFixResult['applied'] = []
    if (paths === null) {
      return { applied: rows.map((row) => ({ row, ok: false, detail: 'no sandbox home; start the sandbox first' })), restarted: false, status: this.status() }
    }
    const known = this.visibleRows(paths)
    if (known === null) {
      return {
        applied: rows.map((row) => ({ row, ok: false, detail: 'cannot resolve the sandbox profile dependency closure; restart the sandbox and retry' })),
        restarted: false,
        status: this.status(),
      }
    }
    for (const row of rows) {
      if (!known.has(row)) {
        applied.push({ row, ok: false, detail: 'no visible loader row with this id exists in the sandbox profile' })
        continue
      }
      const write = appendDisabledRow(paths.profileDir, row)
      applied.push({ row, ok: write.ok, detail: write.ok ? `disabled row "${row}"` : write.problem ?? 'unknown error' })
    }
    if (!applied.some((entry) => entry.ok)) {
      return { applied, restarted: false, status: this.status() }
    }
    const disabled = applied.filter((entry) => entry.ok).map((entry) => entry.row)
    await this.killOnly()
    if (this.killTimedOut) {
      return { applied, restarted: false, status: this.status() }
    }
    this.appendLog(`# restarting with these rows disabled: ${disabled.join(', ')}`)
    const restart = await this.start(true)
    this.recordEvent('fix', `disabled rows: ${disabled.join(', ')}; restarted: ${restart.state === 'running'}`)
    return { applied, restarted: true, status: restart }
  }

  /**
   * The driver for plugin-management commands against the sandbox home: the
   * running CLI for the web shape; the desktop installation's own bundled CLI
   * for the desktop shape (an npm-installed dsh refuses the desktop profile).
   */
  private managementDriver(): DshDriver | string {
    if (this.kind !== 'desktop') return this.driver
    const resolved = resolveDesktopDriver()
    if ('error' in resolved) return resolved.error
    const launcher = resolveDesktopCliLauncher(resolved.driver.installDir)
    if (launcher === null) return 'the desktop installation carries no bundled CLI; update the desktop app'
    return { kind: 'command', name: launcher }
  }

  /** One plugin-management invocation for the sandbox profile, registry carried over when set. */
  private pluginArgs(action: 'add' | 'remove', target: string): string[] {
    const args = ['plugin', '--profile', this.profileName(), action, target]
    // `remove` is a local operation and rejects --registry ("Unknown option:
    // 'registry'" in the field); only `add` takes the registry.
    if (action === 'add') {
      const registry = this.registryValue()
      if (registry !== null) args.push(`--registry=${registry}`)
    }
    return args
  }

  /**
   * Run one sandbox management command to completion (bounded) and return its
   * exit code plus output. The command runs with the sandbox home as DSH_HOME;
   * a timeout kills its tree.
   */
  private runSandboxCommand(args: string[], timeoutMs = 300_000): Promise<{ code: number | null; output: string }> {
    const home = this.home
    if (home === null) return Promise.resolve({ code: null, output: 'no sandbox home' })
    const driver = this.managementDriver()
    if (typeof driver === 'string') return Promise.resolve({ code: null, output: driver })
    return new Promise((resolvePromise) => {
      this.appendLog(`$ ${args.join(' ')}`)
      const child = spawnSandbox(driver, args, { ...process.env, DSH_HOME: home }, home)
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
        for (const line of output.split(/\r?\n/).slice(-8)) {
          if (line.trim() !== '') this.appendLog(line)
        }
        resolvePromise({ code, output })
      })
    })
  }

  /** The profile's current registration state for one package, read back from disk. */
  private registrationState(paths: DshPaths, name: string): { registered: boolean; inDeps: boolean; detail: string } {
    const manifest = readProfileManifest(paths.profileManifest)
    if (manifest === null) {
      return { registered: false, inDeps: false, detail: 'the sandbox profile manifest is unreadable' }
    }
    const registered = profileBundles(manifest).includes(name)
    const inDeps = Object.prototype.hasOwnProperty.call(registryDependencies(manifest), name)
    const detail = registered
      ? 'registered in dsh.profile.bundles'
      : inDeps
        ? 'declared in dependencies but missing from dsh.profile.bundles (half-registered)'
        : 'not declared in the profile'
    return { registered, inDeps, detail }
  }

  /**
   * The allowBuilds placeholder detail for the sandbox profile, or null when
   * nothing blocks a build. dsh's bundled pnpm gates dependency build scripts
   * on this map and a failed install leaves placeholder values behind; the
   * interactive `pnpm approve-builds` recovery is not available here.
   */
  private allowBuildsBlockers(paths: DshPaths): string | null {
    const state = readAllowBuildsState(paths.profileDir)
    if (state.placeholders.length === 0) return null
    return `pnpm-workspace.yaml allowBuilds still carries placeholder entries (${state.placeholders.join(', ')}); they need true or false before an install can succeed`
  }

  /**
   * Install one registry package into the sandbox and verify the bundle got
   * registered, repairing a half-registered residue (remove + add) when the
   * dependency is present but activation is not. The desktop shape hot-loads
   * a new bundle in a few seconds; no restart is needed.
   */
  async install(spec: string): Promise<SandboxChangeResult> {
    const steps: SandboxChangeStep[] = []
    const name = packageNameFromSpec(spec)
    const finish = (ok: boolean, recovered: boolean): SandboxChangeResult => {
      this.recordEvent('install', `${spec} → ${ok ? 'installed and registered' : 'failed'}${recovered ? ' (recovered with remove + add)' : ''}`)
      if (ok && name !== null) this.recordPackage(name)
      return { action: 'install', target: spec, name: name ?? spec, ok, recovered, steps, status: this.status() }
    }
    if (name === null) {
      steps.push({ step: 'spec', ok: false, detail: 'only registry specs can be installed and verified (name, name@version, or a scoped name); tarball and file: targets are not supported here' })
      return finish(false, false)
    }
    const paths = this.paths()
    if (this.state !== 'running' || paths === null) {
      steps.push({ step: 'state', ok: false, detail: 'the sandbox is not running; start it first' })
      return finish(false, false)
    }
    const add = await this.runSandboxCommand(this.pluginArgs('add', spec))
    steps.push({
      step: 'add', ok: add.code === 0,
      detail: add.code === 0 ? 'the package manager finished' : `exited ${add.code ?? 'timeout or spawn failure'} — ${outputTail(add.output)}`,
    })
    if (/IGNORED_BUILDS/i.test(add.output)) {
      steps.push({ step: 'build-scripts', ok: false, detail: 'the install reported ignored build scripts (ERR_PNPM_IGNORED_BUILDS): the dependency build gate needs a decision before the install can complete' })
    }
    let state = this.registrationState(paths, name)
    steps.push({ step: 'verify', ok: state.registered, detail: state.detail })
    if (state.registered) return finish(true, false)
    const blockers = this.allowBuildsBlockers(paths)
    if (blockers !== null) {
      steps.push({ step: 'allowBuilds', ok: false, detail: blockers })
      return finish(false, false)
    }
    if (add.code !== 0 && !state.inDeps) {
      steps.push({ step: 'repair', ok: false, detail: 'the install failed before touching the profile; nothing to repair — resolve the cause and retry' })
      return finish(false, false)
    }
    const remove = await this.runSandboxCommand(this.pluginArgs('remove', name))
    steps.push({ step: 'repair-remove', ok: remove.code === 0, detail: remove.code === 0 ? 'residue cleared' : `exited ${remove.code ?? 'timeout'} — ${outputTail(remove.output)}` })
    const readd = await this.runSandboxCommand(this.pluginArgs('add', spec))
    steps.push({ step: 'repair-add', ok: readd.code === 0, detail: readd.code === 0 ? 're-installed' : `exited ${readd.code ?? 'timeout'} — ${outputTail(readd.output)}` })
    state = this.registrationState(paths, name)
    steps.push({ step: 'verify-after-repair', ok: state.registered, detail: state.detail })
    return finish(state.registered, true)
  }

  /** Remove one package from the sandbox and verify the profile no longer declares or activates it. */
  async uninstall(name: string): Promise<SandboxChangeResult> {
    const steps: SandboxChangeStep[] = []
    const finish = (ok: boolean): SandboxChangeResult => {
      this.recordEvent('uninstall', `${name} → ${ok ? 'removed and cleaned' : 'not fully removed'}`)
      if (ok) this.forgetPackage(name)
      return { action: 'uninstall', target: name, name, ok, recovered: false, steps, status: this.status() }
    }
    const paths = this.paths()
    if (this.state !== 'running' || paths === null) {
      steps.push({ step: 'state', ok: false, detail: 'the sandbox is not running; start it first' })
      return finish(false)
    }
    const remove = await this.runSandboxCommand(this.pluginArgs('remove', name))
    steps.push({
      step: 'remove', ok: remove.code === 0,
      detail: remove.code === 0 ? 'the package manager finished' : `exited ${remove.code ?? 'timeout'} — ${outputTail(remove.output)}`,
    })
    const state = this.registrationState(paths, name)
    const clean = !state.registered && !state.inDeps
    steps.push({ step: 'verify', ok: clean, detail: clean ? 'no longer declared or activated' : state.detail })
    if (clean && existsSync(join(paths.profileDir, 'node_modules', ...name.split('/')))) {
      steps.push({ step: 'residue', ok: false, detail: 'a node_modules directory remains on disk (the launcher does not load it; a future reinstall may reuse it)' })
    }
    return finish(clean)
  }

  /**
   * Resolve the pnpm build-script gate inside the sandbox: set the named
   * placeholder entries (default: every placeholder) of the profile's
   * `pnpm-workspace.yaml allowBuilds` to true (allow) or false (deny). The
   * write is backed up and keeps the rest of the document intact; retrying
   * the install stays an explicit caller action.
   */
  approveBuilds(options: { packages?: string[] | undefined; allow?: boolean | undefined } = {}): SandboxBuildGateResult {
    const paths = this.paths()
    const finish = (ok: boolean, applied: SandboxBuildGateEntry[], backup: string | null, problem: string | null): SandboxBuildGateResult => (
      { ok, applied, backup, problem, status: this.status() }
    )
    if (paths === null) return finish(false, [], null, 'no sandbox home; start the sandbox first')
    const state = readAllowBuildsState(paths.profileDir)
    if (state.placeholders.includes('(the whole allowBuilds map)')) {
      return finish(false, [], null, 'allowBuilds is a scalar placeholder; edit pnpm-workspace.yaml by hand first')
    }
    const allow = options.allow !== false
    const targets = options.packages !== undefined && options.packages.length > 0
      ? options.packages
      : state.placeholders
    if (targets.length === 0) {
      return finish(false, [], null, 'no allowBuilds placeholders to resolve')
    }
    const updates: Record<string, boolean> = {}
    for (const name of targets) updates[name] = allow
    const write = setAllowBuilds(paths.profileDir, updates)
    const applied = targets.map((name) => ({ name, allow, ok: write.ok }))
    if (!write.ok) return finish(false, applied, write.backup, write.problem ?? 'unknown write error')
    this.appendLog(`# build gate: allowBuilds ${targets.join(', ')} -> ${allow ? 'true' : 'false'}`)
    this.recordEvent('approve-builds', `${targets.join(', ')} → ${allow ? 'allow' : 'deny'}`)
    return finish(true, applied, write.backup, null)
  }
}
