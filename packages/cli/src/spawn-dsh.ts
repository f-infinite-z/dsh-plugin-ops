import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/**
 * Quote one argument for a `cmd.exe` command string. Values are always quoted
 * (cmd treats `& | < > ^` literally inside quotes) and `%` is doubled so the
 * value is never expanded as a variable.
 */
function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""').replace(/%/g, '%%')}"`
}

/**
 * Spawn one CLI tool portably. On Windows an npm shim is a `.cmd` file and
 * Node refuses to spawn `.cmd` without a shell (CVE-2024-27980), so a bare
 * shim name or a `.cmd`/`.bat` path goes through `cmd.exe /d /s /c` with a
 * fixed, fully quoted argv; caller values are never interpreted as shell
 * syntax. An `.exe` (or any non-shim path) spawns directly.
 * `windowsVerbatimArguments` keeps Node from adding its own quoting layer
 * around the prepared string.
 * @param bin - executable name (`dsh`, `session-audit`) or path.
 * @param args - arguments (never includes the binary itself).
 * @param options - stdio, environment, and cwd for the child.
 * @returns the child process.
 */
export function spawnCli(bin: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== 'win32') return spawn(bin, [...args], options)
  if (/\.exe$/i.test(bin)) return spawn(bin, [...args], options)
  const shim = /\.(cmd|bat)$/i.test(bin) ? bin : `${bin}.cmd`
  const inner = [quoteCmdArg(shim), ...args.map(quoteCmdArg)].join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${inner}"`], { ...options, windowsVerbatimArguments: true })
}

/**
 * Spawn the dsh CLI portably (see {@link spawnCli}).
 * @param args - dsh arguments (never includes the binary itself).
 * @param options - stdio, environment, and cwd for the child.
 * @returns the child process.
 */
export function spawnDsh(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawnCli('dsh', args, options)
}
