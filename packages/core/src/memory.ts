import { readFileSync, existsSync } from 'node:fs'
import { ensureDir, writeTextAtomic } from './fsutil.js'
import type { PackageSnapshot, SnapshotDiffEntry } from './types.js'
import type { DshPaths } from './paths.js'

export type MemoryEvent =
  | { type: 'attempt'; ts: string; profile: string }
  | { type: 'success'; ts: string; profile: string; snapshot: PackageSnapshot }
  | { type: 'failure'; ts: string; profile: string; detail: string }
  | { type: 'bypass'; ts: string; profile: string; detail: string }
  | { type: 'fix'; ts: string; profile: string; kind: string; detail: string }

const MAX_EVENTS_PER_PROFILE = 2000

export function appendMemory(paths: DshPaths, event: MemoryEvent): void {
  ensureDir(paths.memoryDir)
  const perProfile = new Map<string, string[]>()
  if (existsSync(paths.memoryFile)) {
    for (const line of readFileSync(paths.memoryFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as { profile?: string }
        const bucket = perProfile.get(parsed.profile ?? '')
        if (bucket === undefined) perProfile.set(parsed.profile ?? '', [line])
        else bucket.push(line)
      } catch {
        // corrupt legacy line: dropped on the next append
      }
    }
  }
  for (const bucket of perProfile.values()) {
    bucket.splice(0, Math.max(0, bucket.length - MAX_EVENTS_PER_PROFILE))
  }
  const bucket = perProfile.get(event.profile)
  if (bucket === undefined) perProfile.set(event.profile, [JSON.stringify(event)])
  else bucket.push(JSON.stringify(event))
  const all: string[] = []
  for (const lines of perProfile.values()) all.push(...lines)
  writeTextAtomic(paths.memoryFile, `${all.join('\n')}\n`)
}

function readEvents(paths: DshPaths, profile: string): MemoryEvent[] {
  if (!existsSync(paths.memoryFile)) return []
  const out: MemoryEvent[] = []
  for (const line of readFileSync(paths.memoryFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line) as MemoryEvent
      if (event.profile === profile) out.push(event)
    } catch {
      // corrupt line: ignore
    }
  }
  return out
}

export function lastSuccessSnapshot(paths: DshPaths, profile: string): { at: string; snapshot: PackageSnapshot } | null {
  const events = readEvents(paths, profile)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'success') return { at: event.ts, snapshot: event.snapshot }
  }
  return null
}

/** Most recent events for one profile, oldest first. */
export function recentEvents(paths: DshPaths, profile: string, limit = 20): MemoryEvent[] {
  const events = readEvents(paths, profile)
  return events.slice(-limit)
}

export function diffSnapshots(previous: PackageSnapshot, current: PackageSnapshot): SnapshotDiffEntry[] {
  const names = new Set([...Object.keys(previous.packages), ...Object.keys(current.packages)])
  const entries: SnapshotDiffEntry[] = []
  for (const name of [...names].sort()) {
    const before = previous.packages[name] ?? null
    const after = current.packages[name] ?? null
    if (before === after) continue
    entries.push({
      name,
      change: before === null ? 'added' : after === null ? 'removed' : 'changed',
      previous: before,
      current: after,
    })
  }
  return entries
}
