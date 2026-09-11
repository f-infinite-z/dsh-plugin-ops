import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendMemory } from './memory.js'
import { appendDisabledRow } from './patch-layer.js'
import type { DshPaths } from './paths.js'

export interface SpawnResult {
  code: number | null
  signal: string | null
}

export function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export interface RunResult extends SpawnResult {
  output: string
}

export function runCommand(bin: string, args: string[], cwd: string, timeoutMs?: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      killProcessTree(child.pid ?? 0)
    }, timeoutMs)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, signal, output })
    })
  })
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(pid, 'SIGTERM')
  }
}

/**
 * Run pnpm in the profile directory. Windows has no executable `pnpm` on
 * PATH, only `pnpm.cmd`, so the command goes through `cmd.exe /c` with a
 * constant argument list (never user input), which also avoids the
 * shell-option deprecation path. `timeoutMs` kills the whole process tree and
 * resolves with `code: null` instead of hanging forever.
 */
export function runPnpm(args: string[], cwd: string, timeoutMs?: number): Promise<RunResult> {
  if (process.platform !== 'win32') {
    return runCommand('pnpm', args, cwd, timeoutMs)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      killProcessTree(child.pid ?? 0)
    }, timeoutMs)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, signal, output })
    })
  })
}

export interface AlignResult {
  ok: boolean
  detail: string
}

/**
 * Realign the installed tree to the lockfile (`pnpm install --frozen-lockfile
 * --force`). When drifted packages are reported, the whole node_modules tree
 * is deleted first: pnpm trusts its workspace/module state files
 * (`.pnpm-workspace-state-v1.json`, `.modules.yaml`, `.pnpm/lock.yaml`) and
 * skips reinstalling deleted packages even under `--force`, so removing the
 * state alone is not enough. The rebuild links from the content-addressable
 * store; nothing is re-downloaded. Fails when the lockfile disagrees with the
 * manifest — that case is reported to the user instead of mutating the lock.
 */
export async function alignToLockfile(profileDir: string, driftPackages: string[] = []): Promise<AlignResult> {
  const removed: string[] = []
  if (driftPackages.length > 0) {
    const nodeModules = join(profileDir, 'node_modules')
    if (existsSync(nodeModules)) {
      try {
        // Windows keeps locks on files opened by running processes and its
        // filesystem is slow with many small files; retries absorb transient
        // locks (antivirus, editors) instead of failing the whole fix.
        rmSync(nodeModules, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch (error) {
        return {
          ok: false,
          detail: `could not remove ${nodeModules}: ${error instanceof Error ? error.message : String(error)}`
            + '\nClose any running dsh process (and pause antivirus scanning) and retry `dsh-ops fix`.',
        }
      }
      removed.push(nodeModules)
    }
  }
  const result = await runPnpm(['install', '--frozen-lockfile', '--force'], profileDir)
  const reinstalled = driftPackages.length === 0
    ? ''
    : `; reinstalled ${driftPackages.join(', ')} (node_modules rebuilt, ${removed.length} path(s) removed)`
  return result.code === 0
    ? { ok: true, detail: `pnpm install --frozen-lockfile --force completed${reinstalled}` }
    : { ok: false, detail: `pnpm install --frozen-lockfile --force failed (${result.code ?? result.signal}):\n${result.output.slice(0, 2000)}` }
}

export interface DisableResult {
  ok: boolean
  detail: string
  backup: string | null
}

/** Disable one Loader row id through the profile user patch layer. */
export async function disableRow(paths: DshPaths, profileName: string, rowId: string): Promise<DisableResult> {
  const result = appendDisabledRow(paths.profileDir, rowId)
  if (result.ok) {
    appendMemory(paths, {
      type: 'fix', ts: new Date().toISOString(), profile: profileName, kind: 'write-disabled', detail: `disabled row ${rowId}`,
    })
  }
  return { ok: result.ok, detail: result.problem ?? `wrote disabled row for ${rowId}`, backup: result.backup }
}
