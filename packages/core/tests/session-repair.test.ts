import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { quarantineSessions, repairSessionPaths, scanSessions } from '../src/index.js'
import { makeHome } from './helpers.js'

function writeSession(
  root: string,
  project: string,
  dirName: string,
  options: { headerId?: string; corrupt?: boolean; empty?: boolean } = {},
): string {
  const dir = join(root, project, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v3.jsonl.zstd')
  if (options.empty === true) {
    writeFileSync(file, Buffer.alloc(0))
  } else if (options.corrupt === true) {
    writeFileSync(file, Buffer.alloc(64))
  } else {
    const line = JSON.stringify({ id: options.headerId ?? dirName, cwd: 'C:/work' })
    writeFileSync(file, zstdCompressSync(Buffer.from(`${line}\n`)))
  }
  return dir
}

describe('session scan', () => {
  it('finds nothing in a healthy sessions tree', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      writeSession(root, '--C-work--', 'session-aaaa')
      writeSession(root, '--C-work--', 'session-bbbb')
      const scan = scanSessions(root)
      expect(scan.scanned).toBe(2)
      expect(scan.findings).toEqual([])
    } finally {
      fixture.dispose()
    }
  })

  it('flags an artifact whose first frame cannot be decoded', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      writeSession(root, '--C-work--', 'session-aaaa', { corrupt: true })
      const scan = scanSessions(root)
      expect(scan.findings).toHaveLength(1)
      expect(scan.findings[0]?.kind).toBe('unreadable')
      expect(scan.findings[0]?.detail).toContain('corrupt Zstandard session log')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a directory that does not match its header id', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      writeSession(root, '--C-work--', 'renamed-by-hand', { headerId: 'session-aaaa' })
      const scan = scanSessions(root)
      expect(scan.findings).toHaveLength(1)
      expect(scan.findings[0]?.kind).toBe('path-mismatch')
      expect(scan.findings[0]?.headerId).toBe('session-aaaa')
      expect(scan.findings[0]?.directoryName).toBe('renamed-by-hand')
    } finally {
      fixture.dispose()
    }
  })

  it('tolerates empty artifacts and missing roots', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      writeSession(root, '--C-work--', 'session-aaaa', { empty: true })
      expect(scanSessions(root).findings).toEqual([])
      expect(scanSessions(join(fixture.home, 'nope')).scanned).toBe(0)
    } finally {
      fixture.dispose()
    }
  })
})

describe('session repair', () => {
  it('moves a path-mismatched directory to its header id', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      const dir = writeSession(root, '--C-work--', 'renamed-by-hand', { headerId: 'session-aaaa' })
      const scan = scanSessions(root)
      const result = repairSessionPaths(scan.findings)
      expect(result.refused).toEqual([])
      expect(result.moved).toEqual([{ from: dir, to: join(root, '--C-work--', 'session-aaaa') }])
      expect(scanSessions(root).findings).toEqual([])
    } finally {
      fixture.dispose()
    }
  })

  it('refuses a repair when the target directory already exists', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      writeSession(root, '--C-work--', 'session-aaaa')
      writeSession(root, '--C-work--', 'renamed-by-hand', { headerId: 'session-aaaa' })
      const result = repairSessionPaths(scanSessions(root).findings)
      expect(result.moved).toEqual([])
      expect(result.refused).toHaveLength(1)
      expect(result.refused[0]?.reason).toContain('already exists')
    } finally {
      fixture.dispose()
    }
  })

  it('quarantines unreadable sessions without deleting them', () => {
    const fixture = makeHome()
    try {
      const root = join(fixture.home, 'sessions')
      const dir = writeSession(root, '--C-work--', 'session-broken', { corrupt: true })
      const quarantineRoot = join(fixture.home, 'cache', 'dsh-ops', 'quarantine', 'stamp')
      const result = quarantineSessions(scanSessions(root).findings, quarantineRoot)
      expect(result.refused).toEqual([])
      expect(result.moved).toHaveLength(1)
      expect(result.moved[0]?.from).toBe(dir)
      // The artifact still exists inside the quarantine root.
      expect(existsSync(join(result.moved[0]!.to, 'session.v3.jsonl.zstd'))).toBe(true)
      expect(scanSessions(root).findings).toEqual([])
    } finally {
      fixture.dispose()
    }
  })
})
