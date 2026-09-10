import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
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
 * Remove one package's installed entities so pnpm is forced to reinstall it.
 * pnpm trusts modules.yaml and directory names, so `--force` alone does not
 * repair files mutated inside an installed package (notably under POSIX
 * hardlink layouts). Deleting the link tree removes only links; the
 * content-addressable store stays intact.
 */
function removeInstalledPackage(profileDir: string, packageName: string): string[] {
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(packageName)) return []
  const removed: string[] = []
  const direct = join(profileDir, 'node_modules', packageName)
  if (existsSync(direct)) {
    rmSync(direct, { recursive: true, force: true })
    removed.push(direct)
  }
  const pnpmDir = join(profileDir, 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    const prefix = packageName.replace('/', '+')
    for (const entry of readdirSync(pnpmDir)) {
      if (entry === prefix || entry.startsWith(`${prefix}@`)) {
        const dir = join(pnpmDir, entry)
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      }
    }
  }
  return removed
}

/**
 * Realign the installed tree to the lockfile (`pnpm install --frozen-lockfile
 * --force`). Packages reported as drifted are deleted first, and pnpm's
 * `modules.yaml` state file is dropped: pnpm decides "already up to date"
 * from that file without checking that every package directory still exists,
 * so a forced install otherwise leaves the deleted packages missing. The
 * relink reads from the content-addressable store; nothing is re-downloaded.
 * Fails when the lockfile disagrees with the manifest — that case is reported
 * to the user instead of mutating the lock.
 */
export async function alignToLockfile(profileDir: string, driftPackages: string[] = []): Promise<AlignResult> {
  const removed: string[] = []
  for (const name of driftPackages) {
    removed.push(...removeInstalledPackage(profileDir, name))
  }
  if (driftPackages.length > 0) {
    // pnpm's fast path trusts its own state and skips installing deleted
    // packages; removing the virtual store and the modules state forces the
    // full relink from the content-addressable store (nothing is re-downloaded).
    const virtualStore = join(profileDir, 'node_modules', '.pnpm')
    if (existsSync(virtualStore)) {
      rmSync(virtualStore, { recursive: true, force: true })
      removed.push(virtualStore)
    }
    const modulesState = join(profileDir, 'node_modules', '.modules.yaml')
    if (existsSync(modulesState)) {
      rmSync(modulesState, { force: true })
      removed.push(modulesState)
    }
  }
  const result = await runPnpm(['install', '--frozen-lockfile', '--force'], profileDir)
  const reinstalled = driftPackages.length === 0
    ? ''
    : `; reinstalled ${driftPackages.join(', ')} (${removed.length} installed path(s) removed first)`
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
