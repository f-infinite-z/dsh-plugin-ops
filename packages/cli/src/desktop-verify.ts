import { runDesktopSandbox } from './desktop-sandbox.js'
import type { RuntimeInstallSource, RuntimeVerifyResult } from './verify-cmd.js'

/**
 * Desktop runtime verification (`verify --desktop`): a thin shape adapter over
 * the reusable desktop sandbox, so the verify command reads the same result
 * type as the web runtime check.
 */

export interface DesktopVerifyOptions {
  installSource: RuntimeInstallSource
  timeoutSec: number
}

/**
 * Verify one package against the desktop runtime in an isolated sandbox.
 * @param options - install source (npm spec or local directory) and the
 *   readiness window a healthy boot must fill.
 * @returns the same result shape as the web runtime check.
 */
export async function runDesktopVerify(options: DesktopVerifyOptions): Promise<RuntimeVerifyResult> {
  const run = await runDesktopSandbox(options)
  return {
    ok: run.ok,
    detail: run.detail,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    startupReport: null,
    outputTail: run.outputTail,
    failedEntries: [],
  }
}
