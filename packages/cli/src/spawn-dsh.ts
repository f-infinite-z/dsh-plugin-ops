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
 * Spawn the dsh CLI portably. On Windows the npm shim is `dsh.cmd`, and Node
 * refuses to spawn `.cmd` without a shell (CVE-2024-27980), so the command
 * goes through `cmd.exe /d /s /c` with a fixed, fully quoted argv; caller
 * values are never interpreted as shell syntax. `windowsVerbatimArguments`
 * keeps Node from adding its own quoting layer around the prepared string.
 * @param args - dsh arguments (never includes the binary itself).
 * @param options - stdio, environment, and cwd for the child.
 * @returns the child process.
 */
export function spawnDsh(args: readonly string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== 'win32') return spawn('dsh', [...args], options)
  const inner = ['"dsh.cmd"', ...args.map(quoteCmdArg)].join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${inner}"`], { ...options, windowsVerbatimArguments: true })
}
