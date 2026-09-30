import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { StartupReportEntry } from './startup-log.js'

/**
 * Reader for the official desktop crash reports (dsh desktop 0.2.0+).
 *
 * Unlike the CLI, the desktop app does not write `$DSH_HOME/logs/startup-*.log`;
 * its fatal recovery writes one `crash-<UTC time>-<source>.log` into the
 * Electron logs directory before showing the recovery dialog. The report is a
 * plain-text layout of header fields plus an inspected error section, not JSON.
 * This reader extracts the header facts and the failed loader entries
 * (`id`/`module`/`required`) the way `startup-log.ts` does, so a desktop boot
 * failure can be attributed through the same recovered-entry path.
 *
 * Everything degrades to a metadata-only or null result when the layout is
 * unrecognized, so a format change never breaks the gate.
 */

/** One desktop crash report, parsed tolerantly. */
export interface CrashReport {
  /** Absolute path of the report file. */
  file: string
  /** Where the failure surfaced: `host`, `web-boot`, `renderer`, or `main`. */
  source: string | null
  /** Whether the backend had reached ready: `startup` or `running`. */
  phase: string | null
  /** Application/runtime version recorded in the report header. */
  appVersion: string | null
  /** Inactive loader entries; empty when none were parsed. */
  entries: StartupReportEntry[]
  /** Whether the report carries the Host's own diagnostic section. */
  hostDiagnostic: boolean
}

const FILE_PREFIX = 'crash-'
const FILE_SUFFIX = '.log'
const MAX_BYTES = 512 * 1024

function lineField(text: string, field: string): string | null {
  const match = new RegExp(`^${field}: (.*)$`, 'm').exec(text)
  return match === null ? null : match[1]!.trim()
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
 * Read the newest desktop crash report, optionally restricted to files written
 * at or after `sinceMs` (a launch start time, so a stale report from an
 * earlier failure is never attributed to this boot).
 * @param dir - The desktop logs directory (see `desktopLogsDir`).
 * @param sinceMs - epoch milliseconds lower bound for the report file's mtime.
 * @returns the parsed report, or null when no candidate exists.
 */
export function readLatestCrashReport(dir: string, sinceMs?: number): CrashReport | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const candidates = names
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .sort()
    .reverse()
  for (const name of candidates) {
    const file = join(dir, name)
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
    const app = lineField(text, 'app')
    return {
      file,
      source: lineField(text, 'source'),
      phase: lineField(text, 'phase'),
      appVersion: app === null ? null : app.split(/\s+/).pop() ?? null,
      entries: parseEntries(text),
      hostDiagnostic: text.includes('--- host diagnostic'),
    }
  }
  return null
}
