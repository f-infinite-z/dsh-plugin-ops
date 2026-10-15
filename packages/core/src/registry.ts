import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The `registry=` line of the first npmrc that names one. */
function npmrcRegistry(files: string[]): string | null {
  for (const file of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line)
        if (match !== null && match[1] !== undefined && match[1] !== '') return match[1]
      }
    } catch {
      // this npmrc does not exist
    }
  }
  return null
}

/**
 * The registry a package-manager run for this profile should use: the dsh-ops
 * config value wins, the host environment is the fallback, then the npmrc
 * files the package manager itself would read (the profile's own, then the
 * invoking user's). Null means the package-manager default (the public npm
 * registry). A GUI-launched host carries no `npm_config_registry`, so the
 * config file and the npmrc files are the reliable paths.
 * @param profileDir - profile directory whose npmrc participates.
 * @param configured - the dsh-ops config value, when set.
 */
export function discoverRegistry(profileDir: string, configured?: string | null): string | null {
  const fromConfig = (configured ?? '').trim()
  if (fromConfig !== '') return fromConfig
  const env = (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? '').trim()
  if (env !== '') return env
  return npmrcRegistry([join(profileDir, '.npmrc'), join(homedir(), '.npmrc')])
}
