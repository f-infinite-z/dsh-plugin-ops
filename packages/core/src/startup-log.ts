/**
 * Reader for the official startup diagnostics (dsh 0.1.6+).
 *
 * On a failed boot the dsh CLI saves one private report under `$DSH_HOME/logs`
 * (`startup-<timestamp>-<uuid>.log`) with the dsh/node/platform/profile
 * metadata and the `StartupError`, including its inactive-entry list
 * (`id`, `module`, `required`). dsh-ops reads that report to attribute a boot
 * failure to the plugins the launcher already identified, instead of inferring
 * suspects from package changes alone.
 *
 * The file is `util.inspect` output, not JSON. The reader extracts metadata
 * and the failed-entry list with tolerant patterns and degrades to a
 * metadata-only or null result when the layout is unrecognized, so a format
 * change never breaks the gate.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DshPaths } from './paths.js'

/** One inactive entry as recorded by the official startup audit. */
export interface StartupReportEntry {
  /** Loader entry id (matches the required startup id list when `required`). */
  id: string
  /** Package name the entry loads. */
  module: string
  /** Whether this entry belongs to the global required startup list. */
  required: boolean
}

/** Parsed official startup diagnostic report. */
export interface StartupReport {
  /** Absolute path of the report file. */
  file: string
  /** ISO timestamp recorded by the CLI. */
  timestamp: string | null
  /** dsh version that produced the report. */
  dshVersion: string | null
  /** Profile whose boot failed. */
  profile: string | null
  /** Inactive entries; empty when the report could not be parsed that far. */
  entries: StartupReportEntry[]
}

const FILE_PREFIX = 'startup-'
const FILE_SUFFIX = '.log'
const MAX_BYTES = 256 * 1024

function stringField(text: string, field: string): string | null {
  const match = new RegExp(`\\b${field}: '([^']*)'`).exec(text)
  return match === null ? null : match[1]!
}

function parseEntries(text: string): StartupReportEntry[] {
  const entries: StartupReportEntry[] = []
  const pattern = /id: '([^']+)',\s*module: '([^']+)',\s*required: (true|false)/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    entries.push({ id: match[1]!, module: match[2]!, required: match[3] === 'true' })
  }
  return entries
}

/**
 * Read the newest official startup report, optionally restricted to files
 * written at or after `sinceMs` (use the launch start time so a stale report
 * from an earlier failure is never attributed to this boot).
 * @param paths - resolved DSH paths.
 * @param sinceMs - epoch milliseconds lower bound for the report file's mtime.
 * @returns the parsed report, or null when no candidate exists.
 */
export function readLatestStartupReport(paths: DshPaths, sinceMs?: number): StartupReport | null {
  let names: string[]
  try {
    names = readdirSync(paths.logsDir)
  } catch {
    return null
  }
  const candidates = names
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .sort()
    .reverse()
  for (const name of candidates) {
    const file = join(paths.logsDir, name)
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (sinceMs !== undefined && mtimeMs < sinceMs) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES)
    return {
      file,
      timestamp: stringField(text, 'timestamp'),
      dshVersion: stringField(text, 'dshVersion'),
      profile: stringField(text, 'profile'),
      entries: parseEntries(text),
    }
  }
  return null
}
