import semver from 'semver'

/**
 * Desktop runtime-verification support (the `verify --desktop` mode).
 *
 * The CLI owns process orchestration (sandbox directory, desktop CLI install,
 * instance launch, teardown); this module owns the pure planning half: the
 * sandbox desktop profile's files, the host-port patch that lets the sandbox
 * run beside a live desktop instance, and how one readiness probe is
 * classified.
 */

/** Profile name the desktop application reserves for itself. */
export const DESKTOP_VERIFY_PROFILE_NAME = 'desktop'

/**
 * First desktop-host release that binds a system-assigned port (`--port 0`)
 * instead of the fixed 19387, so a port patch is unnecessary from there on.
 * Pinned to the source-verified release; recheck against the first 0.2.1+
 * desktop build.
 */
export const DESKTOP_PORT_ZERO_MIN_VERSION = '0.2.1-alpha.1'

/** Files initializing an isolated DSH home's desktop profile (the shipped web template). */
export function desktopVerifyProfileFiles(): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`,
    'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'cordis.yml': '[]\n',
  }
}

/**
 * Whether the sandbox needs the webserver port patch: true for the fixed-port
 * 0.2.0-rc line (and for an unknown version, which stays on the known path).
 * @param version - desktop release version, or null when unknown.
 */
export function desktopNeedsPortPatch(version: string | null): boolean {
  return version === null || semver.valid(version) === null || semver.lt(version, DESKTOP_PORT_ZERO_MIN_VERSION)
}

/**
 * The user-layer patch pinning the sandbox host to an isolated port. The
 * include replaces a row's whole `config`, so every key of the webserver row
 * is restated (the base bundle's `host`, `port`, and compression settings);
 * dropping any key would fail the host with a missing required value.
 * @param port - the free port the sandbox host should bind.
 */
export function desktopPortPatchYaml(port: number): string {
  return [
    '# dsh-ops verify --desktop: pin the sandbox host to an isolated port',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '',
  ].join('\n')
}

/** One readiness probe of the sandboxed desktop instance. */
export interface DesktopReadinessProbe {
  /** The launched process is still running. */
  alive: boolean
  /** Its exit code once it exited, else null. */
  exitCode: number | null
  /** The sandbox host port accepts connections (false when port-probing is unavailable). */
  listening: boolean
  /** Crash-report files written since launch. */
  crashLogs: string[]
}

/** Outcome of waiting for desktop readiness. */
export type DesktopReadinessOutcome =
  | { kind: 'ready'; elapsedMs: number }
  | { kind: 'exited'; exitCode: number | null; elapsedMs: number }
  | { kind: 'crashed'; crashLogs: string[]; elapsedMs: number }
  | { kind: 'timeout'; elapsedMs: number }

/**
 * Classify one readiness probe. A crash report decides first, then an exited
 * process; at the deadline a still-running instance is ready only when its
 * host port is listening (the boot signal the live instance exposes).
 * @returns the outcome, or null while the caller should keep polling.
 */
export function classifyDesktopReadiness(
  probe: DesktopReadinessProbe,
  elapsedMs: number,
  deadlineMs: number,
): DesktopReadinessOutcome | null {
  if (probe.crashLogs.length > 0) return { kind: 'crashed', crashLogs: probe.crashLogs, elapsedMs }
  if (!probe.alive) return { kind: 'exited', exitCode: probe.exitCode, elapsedMs }
  if (elapsedMs >= deadlineMs) {
    return probe.listening ? { kind: 'ready', elapsedMs } : { kind: 'timeout', elapsedMs }
  }
  return null
}
