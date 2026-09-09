import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { readPatchFile, appendDisabledRow, removeDisabledRow } from '../src/index.js'
import { makeHome } from './helpers.js'

describe('patch layer', () => {
  it('treats an absent file as an empty list', () => {
    const fixture = makeHome()
    try {
      const state = readPatchFile(fixture.paths.profileDir)
      expect(state.ok).toBe(true)
      expect(state.rows).toEqual([])
    } finally {
      fixture.dispose()
    }
  })

  it('appends a disabled row and preserves the original rows', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      mkdirSync(paths.profileDir, { recursive: true })
      writeFileSync(`${paths.profileDir}/cordis.patch.yml`, '- id: user-row\n  config:\n    a: 1\n', 'utf8')

      const result = appendDisabledRow(paths.profileDir, 'plugin-x')
      expect(result.ok).toBe(true)
      const state = readPatchFile(paths.profileDir)
      expect(state.ok).toBe(true)
      expect(state.rows).toContainEqual({ id: 'user-row', config: { a: 1 } })
      expect(state.rows).toContainEqual({ id: 'plugin-x', disabled: true })
      expect(state.rows.length).toBe(2)
    } finally {
      fixture.dispose()
    }
  })

  it('refuses to write through an unparsable patch file', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      mkdirSync(paths.profileDir, { recursive: true })
      writeFileSync(`${paths.profileDir}/cordis.patch.yml`, 'not: [valid', 'utf8')

      const result = appendDisabledRow(paths.profileDir, 'plugin-x')
      expect(result.ok).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('removes the trailing disabled row it appended', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      appendDisabledRow(paths.profileDir, 'plugin-x')
      appendDisabledRow(paths.profileDir, 'plugin-x')
      const removal = removeDisabledRow(paths.profileDir, 'plugin-x')
      expect(removal.ok).toBe(true)
      const state = readPatchFile(paths.profileDir)
      const disabled = state.rows.filter((r) => r.id === 'plugin-x' && r.disabled === true)
      expect(disabled.length).toBe(1)
    } finally {
      fixture.dispose()
    }
  })

  it('appends into the official empty-[] placeholder without corrupting the file', () => {
    const fixture = makeHome()
    try {
      const { paths } = fixture
      mkdirSync(paths.profileDir, { recursive: true })
      writeFileSync(`${paths.profileDir}/cordis.patch.yml`, '# official template header\n[]\n', 'utf8')

      const result = appendDisabledRow(paths.profileDir, 'plugin-y')
      expect(result.ok).toBe(true)
      const state = readPatchFile(paths.profileDir)
      expect(state.ok).toBe(true)
      expect(state.rows).toContainEqual({ id: 'plugin-y', disabled: true })
      const removal = removeDisabledRow(paths.profileDir, 'plugin-y')
      expect(removal.ok).toBe(true)
      const after = readPatchFile(paths.profileDir)
      expect(after.ok).toBe(true)
      expect(after.rows).toEqual([])
    } finally {
      fixture.dispose()
    }
  })
})
