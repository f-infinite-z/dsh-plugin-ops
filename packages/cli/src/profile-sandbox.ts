import { type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { appendDisabledRow } from 'dsh-plugin-ops-core'
import { spawnCli } from './spawn-dsh.js'
import { killTree } from './kill-tree.js'
import { runDesktopSandbox } from './desktop-sandbox.js'
import { copyProfileFiles } from './profile-copy.js'

/**
 * Sandbox fix verification for the gate's attribution-recovery loop: before a
 * disable-fix touches the real profile, it is applied to an isolated copy of
 * that profile and booted. Web profiles boot the copy in a temporary DSH home
 * (official `plugin install --frozen-lockfile` from the copied lockfile, then
 * the copied patch and the proposed rows); the desktop profile reuses the
 * reusable desktop sandbox's copied-profile mode. A sandbox that cannot be
 * set up or observed is reported as such — the gate falls back to applying
 * the fix directly, so the verifier never blocks recovery.
 */

export interface FixVerifyResult {
  ok: boolean
  kind: 'booted' | 'exited' | 'crashed' | 'timeout' | 'unavailable' | 'setup-failed'
  detail: string
  outputTail: string
}

export interface FixVerifyOptions {
  /** The real profile directory whose copy is booted. */
  sourceProfileDir: string
  profileName: string
  /** Row ids the proposed fix would disable. */
  disableRows: string[]
  /** The gate's dsh command; its first element drives the sandbox. */
  dshCommand: string[]
  /** Seconds the sandbox boot may take before it is judged a timeout. */
  timeoutSec: number
}

/** How long the sandbox port must stay open before the boot counts as stable. */
const STABLE_MS = 5000

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
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
    const child = spawnCli(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' })
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
 * Verify one proposed disable-fix on an isolated copy of the profile.
 * @param options - the profile to copy, the rows to disable, and the driver
 *   command.
 * @returns the sandbox outcome; `booted` means the fix produces a healthy
 *   boot (and only then should the gate write the real profile).
 */
export async function runFixVerify(options: FixVerifyOptions): Promise<FixVerifyResult> {
  if (options.profileName === 'desktop') return runDesktopFixVerify(options)
  if (options.profileName !== 'web') {
    return {
      ok: false,
      kind: 'unavailable',
      detail: `sandbox fix verification currently covers the web and desktop profiles (got "${options.profileName}")`,
      outputTail: '',
    }
  }
  return runWebFixVerify(options)
}

async function runWebFixVerify(options: FixVerifyOptions): Promise<FixVerifyResult> {
  const driver = options.dshCommand[0]
  if (driver === undefined) {
    return { ok: false, kind: 'unavailable', detail: 'the gate has no dsh command to drive the sandbox', outputTail: '' }
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-ops-fix-verify-'))
  const home = join(sandbox, 'home')
  const profileDir = join(home, 'profiles', 'web')
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
  let child: ChildProcess | null = null
  try {
    mkdirSync(profileDir, { recursive: true })
    copyProfileFiles(options.sourceProfileDir, profileDir)
    for (const row of options.disableRows) {
      const write = appendDisabledRow(profileDir, row)
      if (!write.ok) {
        return { ok: false, kind: 'setup-failed', detail: `cannot write the sandbox patch row "${row}": ${write.problem ?? 'unknown error'}`, outputTail: '' }
      }
    }
    const install = await runCli(driver, ['plugin', '--profile', 'web', 'install', '--frozen-lockfile'], env, 300_000)
    if (install.code !== 0) {
      return { ok: false, kind: 'setup-failed', detail: `the sandbox copy could not be installed (exit ${install.code ?? 'timeout'})`, outputTail: tail(install.output) }
    }
    const port = 39400 + Math.floor(Math.random() * 500)
    const start = Date.now()
    child = spawnCli(driver, ['--profile', 'web', '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    let listeningSince: number | null = null
    const deadline = options.timeoutSec * 1000
    for (;;) {
      await delay(1000)
      if (child.exitCode !== null || child.killed) {
        return { ok: false, kind: 'exited', detail: `the sandbox dsh exited ${child.exitCode ?? 'by signal'} after ${Date.now() - start}ms with the fix applied`, outputTail: tail(output) }
      }
      if (await isPortListening(port)) {
        if (listeningSince === null) listeningSince = Date.now()
        else if (Date.now() - listeningSince >= STABLE_MS) {
          return { ok: true, kind: 'booted', detail: `the sandbox boot reached its host port in ${((listeningSince - start) / 1000).toFixed(1)}s and stayed up`, outputTail: tail(output) }
        }
      } else {
        listeningSince = null
      }
      if (Date.now() - start >= deadline) {
        return { ok: false, kind: 'timeout', detail: `the sandbox dsh did not open its host port within ${options.timeoutSec}s`, outputTail: tail(output) }
      }
    }
  } finally {
    if (child !== null && child.exitCode === null) {
      killTree(child.pid)
      // Let the killed tree release its file handles before removing the sandbox.
      await delay(1200)
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

async function runDesktopFixVerify(options: FixVerifyOptions): Promise<FixVerifyResult> {
  try {
    const run = await runDesktopSandbox({
      profileCopyFrom: options.sourceProfileDir,
      timeoutSec: options.timeoutSec,
      prepare: (context) => {
        for (const row of options.disableRows) {
          const write = appendDisabledRow(context.profileDir, row)
          if (!write.ok) throw new Error(`cannot write the sandbox patch row "${row}": ${write.problem ?? 'unknown error'}`)
        }
      },
    })
    const kind: FixVerifyResult['kind'] =
      run.kind === 'ready' ? 'booted'
        : run.kind === 'exited' ? 'exited'
          : run.kind === 'crashed' ? 'crashed'
            : run.kind === 'timeout' ? 'timeout'
              : run.kind === 'install-failed' ? 'setup-failed'
                : 'unavailable'
    return { ok: run.ok, kind, detail: run.detail, outputTail: run.outputTail }
  } catch (error) {
    return {
      ok: false,
      kind: 'setup-failed',
      detail: error instanceof Error ? error.message : String(error),
      outputTail: '',
    }
  }
}
