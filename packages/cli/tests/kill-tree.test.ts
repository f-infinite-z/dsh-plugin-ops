import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'

import { killTree } from '../src/kill-tree.js'

/** Wait until `check()` holds, or the deadline passes. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return check()
}

/** Whether a PID still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A node process that idles until it is killed. */
function idleChild(detached: boolean): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached,
  })
}

describe('killTree', () => {
  it('is a no-op for missing or invalid PIDs', () => {
    expect(() => killTree(undefined)).not.toThrow()
    expect(() => killTree(0)).not.toThrow()
  })

  it('kills a plain child process on every platform', async () => {
    const child = idleChild(false)
    try {
      expect(alive(child.pid!)).toBe(true)
      killTree(child.pid)
      expect(await until(() => !alive(child.pid!))).toBe(true)
    } finally {
      if (child.pid !== undefined) killTree(child.pid)
    }
  })

  it.skipIf(process.platform === 'win32')('kills a detached process group including its children', async () => {
    // A parent in its own process group spawns a grandchild that a
    // single-process SIGTERM would leave running (the Electron-helper shape).
    const parent = spawn(
      process.execPath,
      [
        '-e',
        'const { spawn } = require("node:child_process");' +
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
          'console.log(grandchild.pid);' +
          'setInterval(() => {}, 1000)',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    )
    try {
      const grandchildPid = await new Promise<number>((resolvePromise, rejectPromise) => {
        let buffered = ''
        parent.stdout?.on('data', (chunk: Buffer) => {
          buffered += chunk.toString()
          const match = buffered.match(/(\d+)/)
          if (match !== null) resolvePromise(Number(match[1]))
        })
        parent.once('error', rejectPromise)
      })
      expect(alive(grandchildPid)).toBe(true)
      killTree(parent.pid)
      expect(await until(() => !alive(parent.pid!) && !alive(grandchildPid))).toBe(true)
    } finally {
      if (parent.pid !== undefined) killTree(parent.pid)
    }
  })
})
