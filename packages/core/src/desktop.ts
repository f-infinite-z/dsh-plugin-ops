import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import { readJsonFile } from './fsutil.js'

/**
 * Desktop profile support (official dsh desktop, 0.2.0-rc.2+).
 *
 * The desktop app ships dsh inside its own Electron resources
 * (`resources/app.asar/dsh`), not in the shared `$DSH_HOME/profiles/node_modules`
 * closure. A plain Node process cannot read the packaged runtime: the official
 * bundles (`dsh-base`, `dsh-web-app`) and every `@deepseek-ai/dsh-client-*`
 * package live inside the compressed asar. The launcher guarantees that
 * packaged runtime is complete (it verifies `desktop-runtime.json` integrity
 * before boot), so a desktop profile scan treats official packages as
 * resolvable instead of failing the patch-resolution and bundle-declaration
 * rules over packages it can never observe on disk.
 *
 * The one physically readable fact is the release version, recorded in
 * `resources/runtime/primary-runtime/runtime.json` under `desktopVersion`
 * (release identity keeps Electron and dsh on the same exact version).
 */

/** Fixed profile name the official desktop app owns. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Primary-runtime manifest that records the desktop release version. */
export const DESKTOP_RUNTIME_VERSION_FILE = 'runtime.json'

/** Desktop installation facts a scan can use. */
export interface DesktopInfo {
  /** Absolute installation directory (Windows) or `.app` bundle (macOS); null when not installed. */
  installDir: string | null
  /** Release version from the primary-runtime manifest; null when unreadable. */
  version: string | null
}

/** Whether a profile name is the official desktop profile. */
export function isDesktopProfile(profileName: string): boolean {
  return profileName === DESKTOP_PROFILE_NAME
}

/** The `resources` directory inside one desktop installation, by platform. */
function resourcesDir(installDir: string): string {
  return process.platform === 'darwin' ? join(installDir, 'Contents', 'Resources') : join(installDir, 'resources')
}

/** Structural fingerprint of a desktop installation directory. */
function isDesktopInstall(installDir: string): boolean {
  const resources = resourcesDir(installDir)
  return existsSync(join(resources, 'app.asar'))
    && existsSync(join(resources, 'runtime', 'primary-runtime', DESKTOP_RUNTIME_VERSION_FILE))
}

/** Candidate parent directories to scan for a desktop installation. */
function candidateDirs(): string[] {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const programFiles = process.env.PROGRAMFILES
    return [
      ...(local === undefined ? [] : [join(local, 'Programs')]),
      ...(programFiles === undefined ? [] : [programFiles]),
    ]
  }
  if (process.platform === 'darwin') {
    return ['/Applications', join(homedir(), 'Applications')]
  }
  return []
}

/** Locate the desktop installation directory by fingerprint; null when absent. */
export function detectDesktopInstall(): string | null {
  for (const root of candidateDirs()) {
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      if (isDesktopInstall(dir)) return dir
    }
  }
  return null
}

/** Read the desktop release version from its primary-runtime manifest. */
export function readDesktopVersion(installDir: string): string | null {
  const runtime = readJsonFile<{ desktopVersion?: unknown }>(
    join(resourcesDir(installDir), 'runtime', 'primary-runtime', DESKTOP_RUNTIME_VERSION_FILE),
  )
  return typeof runtime?.desktopVersion === 'string' ? runtime.desktopVersion : null
}

/** Detect the desktop installation and its release version in one pass. */
export function detectDesktop(): DesktopInfo {
  const installDir = detectDesktopInstall()
  if (installDir === null) return { installDir: null, version: null }
  return { installDir, version: readDesktopVersion(installDir) }
}

/**
 * Desktop releases at or after this version ship a bundled CLI command (the
 * "Manage dsh Command" menu) whose `dsh plugin --profile desktop` can manage
 * the reserved desktop profile while the application is quit (verified against
 * the 0.2.0-rc.2 sources; npm-installed dsh still refuses that profile).
 */
export const DESKTOP_CLI_MIN_VERSION = '0.2.0-rc.1'

/**
 * The bundled CLI launcher inside a desktop installation, when that release
 * ships one. The launcher runs the private desktop CLI entry through the
 * installed Electron executable in Node mode, so calling it by absolute path
 * does not depend on the user's PATH registration.
 */
export function resolveDesktopCliLauncher(installDir: string): string | null {
  const launcher = process.platform === 'darwin'
    ? join(resourcesDir(installDir), 'runtime', 'cli', 'bin', 'dsh')
    : join(resourcesDir(installDir), 'runtime', 'cli', 'bin', 'dsh.cmd')
  return existsSync(launcher) ? launcher : null
}

/**
 * Whether a desktop release's bundled CLI may manage the reserved desktop
 * profile. Older releases (and npm-installed dsh) refuse profile "desktop".
 */
export function desktopCliSupportsPluginManagement(version: string | null): boolean {
  return version !== null && semver.valid(version) !== null && semver.gte(version, DESKTOP_CLI_MIN_VERSION)
}

/**
 * Platform-conventional directory where the desktop app writes its crash
 * reports (`app.setAppLogsPath()`): Windows/Linux put logs under Electron
 * userData (`%APPDATA%\@deepseek-ai\dsh-desktop\logs`), macOS under
 * `~/Library/Logs/DeepSeek Harness`. Returns null where no convention applies.
 */
export function desktopLogsDir(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData === undefined) return null
    return join(appData, '@deepseek-ai', 'dsh-desktop', 'logs')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Logs', 'DeepSeek Harness')
  }
  return null
}
