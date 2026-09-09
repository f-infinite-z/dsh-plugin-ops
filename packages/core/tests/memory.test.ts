import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { appendMemory, lastSuccessSnapshot, diffSnapshots } from '../src/index.js'
import { makeHome } from './helpers.js'

describe('session memory', () => {
  it('keeps events per profile and returns the last success snapshot', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      appendMemory(paths, { type: 'attempt', ts: '2026-01-01T00:00:00.000Z', profile: 'web' })
      appendMemory(paths, {
        type: 'success', ts: '2026-01-01T00:00:01.000Z', profile: 'web',
        snapshot: { packages: { 'pkg-a': '1.0.0' } },
      })
      appendMemory(paths, { type: 'attempt', ts: '2026-01-01T00:00:02.000Z', profile: 'other' })

      const last = lastSuccessSnapshot(paths, 'web')
      expect(last?.at).toBe('2026-01-01T00:00:01.000Z')
      expect(last?.snapshot.packages['pkg-a']).toBe('1.0.0')
      expect(lastSuccessSnapshot(paths, 'other')).toBeNull()
    } finally {
      fixture.dispose()
    }
  })

  it('survives corrupt lines', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      appendMemory(paths, { type: 'attempt', ts: '2026-01-01T00:00:00.000Z', profile: 'web' })
      writeFileSync(paths.memoryFile, '{"type":"attempt","ts":"x","profile":"web"}\n{corrupt\n', 'utf8')
      expect(lastSuccessSnapshot(paths, 'web')).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})

describe('snapshot diffing', () => {
  it('classifies added, changed, and removed packages', () => {
    const before = { packages: { a: '1.0.0', b: '2.0.0', c: null } }
    const after = { packages: { a: '1.0.1', b: null, d: '3.0.0', c: null } }
    const diff = diffSnapshots(before, after)
    expect(diff).toEqual([
      { name: 'a', change: 'changed', previous: '1.0.0', current: '1.0.1' },
      { name: 'b', change: 'removed', previous: '2.0.0', current: null },
      { name: 'd', change: 'added', previous: null, current: '3.0.0' },
    ])
  })
})
