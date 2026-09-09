import { spawn } from 'node:child_process'
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

export function runCommand(bin: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
}

/**
 * Run pnpm in the profile directory. Windows has no executable `pnpm` on
 * PATH, only `pnpm.cmd`, so the command goes through `cmd.exe /c` with a
 * constant argument list (never user input), which also avoids the
 * shell-option deprecation path.
 */
function runPnpm(args: string[], cwd: string): Promise<RunResult> {
  if (process.platform !== 'win32') {
    return runCommand('pnpm', args, cwd)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
}

export interface AlignResult {
  ok: boolean
  detail: string
}

/**
 * Realign the installed tree to the lockfile (`pnpm install --frozen-lockfile
 * --force`). The force flag is required because pnpm treats an unchanged
 * modules.yaml as up to date even when a package's own files drifted on disk;
 * force re-extracts every package from the locked tree. Fails when the
 * lockfile disagrees with the manifest — that case is reported to the user
 * instead of mutating the lock.
 */
export async function alignToLockfile(profileDir: string): Promise<AlignResult> {
  const result = await runPnpm(['install', '--frozen-lockfile', '--force'], profileDir)
  return result.code === 0
    ? { ok: true, detail: 'pnpm install --frozen-lockfile --force completed' }
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
