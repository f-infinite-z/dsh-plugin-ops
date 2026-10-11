import { spawn } from 'node:child_process'

/**
 * Kill one process tree: the instance a verify/dev/adapt run launched, or a
 * child command that run is driving — never anything else.
 *
 * Long-lived children are spawned `detached` on POSIX so their PID is a
 * process-group leader; the whole group is then signalled at once, which is
 * what removes the Electron helpers and pnpm grandchildren a single-process
 * SIGTERM leaves behind. Windows uses `taskkill /T /F` (walking the tree is
 * its job).
 *
 * POSIX sends SIGTERM to the group (falling back to the single process when
 * the child was not made a group leader), then SIGKILL after a short grace
 * period. A process that is already gone is not an error: the call is
 * idempotent and safe to repeat.
 * @param pid - the child PID to kill; undefined or non-positive is a no-op.
 * @param graceMs - how long SIGTERM gets before the SIGKILL sweep.
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
  // The sweep is best-effort: never keep the CLI alive just to send SIGKILL.
  timer.unref()
}
