import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeHome } from './helpers.js'

const { runPnpmMock } = vi.hoisted(() => ({ runPnpmMock: vi.fn() }))
vi.mock('../src/fix.js', () => ({ runPnpm: runPnpmMock }))

import { checkOutdated } from '../src/outdated.js'

afterEach(() => {
  runPnpmMock.mockReset()
})

describe('checkOutdated', () => {
  it('parses the multi-line answer of a run that exits 1 because updates exist', async () => {
    runPnpmMock.mockResolvedValueOnce({
      code: 1,
      signal: null,
      output: '{\n  "pkg-a": {\n    "current": "1.0.0",\n    "latest": "1.1.0"\n  }\n}\n',
    })
    const fixture = makeHome()
    try {
      const state = await checkOutdated(fixture.paths.profileDir, fixture.paths.memoryDir, 'web')
      expect(state.checkedAt).not.toBeNull()
      expect(state.entries).toEqual([{ name: 'pkg-a', current: '1.0.0', latest: '1.1.0' }])
    } finally {
      fixture.dispose()
    }
  })

  it('degrades to unavailable when the run printed no JSON', async () => {
    runPnpmMock.mockResolvedValueOnce({
      code: 127,
      signal: null,
      output: 'pnpm was not found; install pnpm and make it available on PATH.\n',
    })
    const fixture = makeHome()
    try {
      const state = await checkOutdated(fixture.paths.profileDir, fixture.paths.memoryDir, 'web')
      expect(state.checkedAt).toBeNull()
      expect(state.entries).toEqual([])
    } finally {
      fixture.dispose()
    }
  })
})
