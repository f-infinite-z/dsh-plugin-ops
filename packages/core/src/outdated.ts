import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPnpm } from './fix.js'
import { writeTextAtomic, ensureDir } from './fsutil.js'

export interface OutdatedEntry {
  name: string
  current: string | null
  latest: string
}

export interface OutdatedState {
  entries: OutdatedEntry[]
  /** null when the check itself failed (offline, timeout, no pnpm). */
  checkedAt: string | null
}

interface OutdatedRaw {
  [name: string]: { current?: unknown; latest?: unknown }
}

const CACHE_TTL_MS = 5 * 60 * 1000
const CHECK_TIMEOUT_MS = 45000

function cacheFile(cacheDir: string, profileName: string): string {
  return join(cacheDir, `outdated-${profileName}.json`)
}

/**
 * Check registry versions through `pnpm outdated --format json`. Results are
 * cached for the TTL so repeated scans (gate, fix rescans) stay fast; a failed
 * check degrades to an empty state with `checkedAt: null` instead of throwing.
 * Never blocks longer than CHECK_TIMEOUT_MS.
 */
export async function checkOutdated(profileDir: string, cacheDir: string, profileName: string): Promise<OutdatedState> {
  const file = cacheFile(cacheDir, profileName)
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { ts: string; entries: OutdatedEntry[] }
      if (Date.now() - Date.parse(cached.ts) < CACHE_TTL_MS) {
        return { entries: cached.entries, checkedAt: cached.ts }
      }
    } catch {
      // corrupt cache: re-check
    }
  }
  try {
    const result = await runPnpm(['outdated', '--format', 'json'], profileDir, CHECK_TIMEOUT_MS)
    if (result.code !== 0) {
      return { entries: [], checkedAt: null }
    }
    let raw: OutdatedRaw
    try {
      raw = JSON.parse(result.output.trim().split('\n').pop() ?? '{}') as OutdatedRaw
    } catch {
      return { entries: [], checkedAt: null }
    }
    const entries: OutdatedEntry[] = []
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value.latest !== 'string') continue
      entries.push({ name, current: typeof value.current === 'string' ? value.current : null, latest: value.latest })
    }
    const now = new Date().toISOString()
    ensureDir(cacheDir)
    writeTextAtomic(file, JSON.stringify({ ts: now, entries }))
    return { entries, checkedAt: now }
  } catch {
    return { entries: [], checkedAt: null }
  }
}
