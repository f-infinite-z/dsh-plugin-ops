import { spawn } from 'node:child_process'

/**
 * Read the global dsh CLI version once per process.
 *
 * The shared closure mirror (`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`)
 * goes stale under runtime resolution (dsh 0.1.6+ never heals it), so the
 * authoritative version is the global `dsh --version` that the launcher would
 * actually run. The probe runs at most once and caches the result; a missing
 * dsh command or a timeout degrades to null so the caller falls back to the
 * mirror anchor.
 */

let cached: string | null | undefined

/** Probe the global dsh version; null when unavailable or unparsable. */
function probe(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', 'dsh --version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('dsh', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve(null)
    }, 5000)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', () => {
      clearTimeout(timer)
      const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)
      resolve(match === null ? null : match[1]!)
    })
  })
}

/** Cached global dsh version, probed once. */
export async function readGlobalDshVersion(): Promise<string | null> {
  if (cached !== undefined) return cached
  cached = await probe()
  return cached
}
