import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Download one npm package artifact and extract it into a temporary
 * directory, so publish-time verification can run against the package as
 * published on the npm registry instead of a local source checkout.
 */

export interface FetchedPackage {
  ok: boolean
  /** Extracted `package/` directory; null when the fetch failed. */
  packageDir: string | null
  error?: string
  /** Remove the temporary directory. Safe to call multiple times. */
  cleanup: () => void
}

/**
 * Accepted specs: `name`, `@scope/name`, and either form with an exact
 * version or dist-tag suffix. Ranges are deliberately rejected: Windows runs
 * `npm pack` through `cmd.exe`, where range characters (`^`, `>`, `<`, `|`)
 * are shell metacharacters.
 */
const SPEC_PATTERN = /^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+(@[a-z0-9-._~]+)?$/i

function isWindows(): boolean {
  return process.platform === 'win32'
}

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = setTimeout(() => {
      if (child.pid === undefined) return
      if (isWindows()) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(child.pid, 'SIGTERM')
      }
    }, timeoutMs)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** Tail of a process output, trimmed for a one-line error message. */
function tail(output: string, max = 400): string {
  const lines = output.trim().split('\n').filter((line) => line.trim() !== '')
  return lines.slice(-3).join(' | ').slice(0, max)
}

/**
 * Fetch one npm package via `npm pack` and extract the tarball with the
 * platform `tar` extractor. The spec is validated before it reaches the
 * command line; the caller owns the returned temp directory via `cleanup`.
 */
export async function fetchNpmPackage(spec: string, timeoutMs = 180000): Promise<FetchedPackage> {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-ops-verify-'))
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best effort: temp dirs are safe to leave behind */
    }
  }

  if (!SPEC_PATTERN.test(spec)) {
    cleanup()
    return {
      ok: false,
      packageDir: null,
      error: `invalid npm package spec: ${JSON.stringify(spec)} (use name, @scope/name, or name@version)`,
      cleanup,
    }
  }

  const packArgs = ['pack', spec, '--pack-destination', tmp]
  const pack = isWindows()
    ? await runProcess('cmd.exe', ['/d', '/s', '/c', `npm ${packArgs.join(' ')}`], tmp, timeoutMs)
    : await runProcess('npm', packArgs, tmp, timeoutMs)
  if (pack.code !== 0) {
    cleanup()
    return { ok: false, packageDir: null, error: `npm pack ${spec} failed: ${tail(pack.output)}`, cleanup }
  }

  const tarball = readdirSync(tmp).find((name) => name.endsWith('.tgz'))
  if (tarball === undefined) {
    cleanup()
    return { ok: false, packageDir: null, error: 'npm pack produced no tarball', cleanup }
  }

  const extract = await runProcess('tar', ['-xzf', tarball, '-C', tmp], tmp, 60000)
  if (extract.code !== 0) {
    cleanup()
    return { ok: false, packageDir: null, error: `tar extraction failed: ${tail(extract.output, 300)}`, cleanup }
  }

  const packageDir = join(tmp, 'package')
  if (!existsSync(packageDir)) {
    cleanup()
    return { ok: false, packageDir: null, error: 'extracted tarball has no package/ directory', cleanup }
  }
  return { ok: true, packageDir, cleanup }
}
