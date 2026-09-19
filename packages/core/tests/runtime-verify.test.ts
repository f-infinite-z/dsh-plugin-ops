import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendActivationRow,
  classifyBootOutcome,
  readPatchFile,
  readRuntimeVerifyPlan,
  runtimeRowId,
} from '../src/index.js'
import { makeHome, writeJson } from './helpers.js'

describe('runtime verify plan', () => {
  it('marks a package declaring dsh.bundle.patch as a bundle', () => {
    const fixture = makeHome()
    try {
      writeJson(join(fixture.home, 'pkg', 'package.json'), {
        name: '@scope/dsh-thing',
        version: '1.0.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      expect(readRuntimeVerifyPlan(join(fixture.home, 'pkg'))).toEqual({
        packageName: '@scope/dsh-thing',
        isBundle: true,
        rowId: null,
      })
    } finally {
      fixture.dispose()
    }
  })

  it('plans a loader row for a plain plugin', () => {
    const fixture = makeHome()
    try {
      writeJson(join(fixture.home, 'pkg', 'package.json'), { name: 'plain-plugin', version: '1.0.0' })
      expect(readRuntimeVerifyPlan(join(fixture.home, 'pkg'))).toEqual({
        packageName: 'plain-plugin',
        isBundle: false,
        rowId: 'verify-plain-plugin',
      })
    } finally {
      fixture.dispose()
    }
  })

  it('returns null for an unreadable or unnamed manifest', () => {
    const fixture = makeHome()
    try {
      expect(readRuntimeVerifyPlan(join(fixture.home, 'missing'))).toBeNull()
      writeJson(join(fixture.home, 'pkg', 'package.json'), { version: '1.0.0' })
      expect(readRuntimeVerifyPlan(join(fixture.home, 'pkg'))).toBeNull()
    } finally {
      fixture.dispose()
    }
  })

  it('derives a filesystem-safe row id from the package name', () => {
    expect(runtimeRowId('@scope/pkg')).toBe('verify-scope-pkg')
    expect(runtimeRowId('plain')).toBe('verify-plain')
  })
})

describe('boot outcome classification', () => {
  it('classifies a process alive at the threshold as booted', () => {
    expect(classifyBootOutcome(null, 45_000, 45_000)).toEqual({ kind: 'booted', elapsedMs: 45_000 })
  })

  it('classifies an early exit as a failure', () => {
    expect(classifyBootOutcome(1, 8_000, 45_000)).toEqual({ kind: 'exited', exitCode: 1, elapsedMs: 8_000 })
  })
})

describe('activation row write', () => {
  it('appends a row into the official template patch file', () => {
    const fixture = makeHome()
    try {
      mkdirSync(fixture.paths.profileDir, { recursive: true })
      writeFileSync(
        join(fixture.paths.profileDir, 'cordis.patch.yml'),
        '# Your patch layer for this dsh profile\n[]\n',
        'utf8',
      )
      const result = appendActivationRow(fixture.paths.profileDir, 'verify-x', 'x-pkg')
      expect(result.ok).toBe(true)
      const state = readPatchFile(fixture.paths.profileDir)
      expect(state.ok).toBe(true)
      expect(state.rows).toContainEqual({ id: 'verify-x', name: 'x-pkg' })
    } finally {
      fixture.dispose()
    }
  })

  it('refuses to write through a non-list patch file', () => {
    const fixture = makeHome()
    try {
      mkdirSync(fixture.paths.profileDir, { recursive: true })
      writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'), 'not: a list\n', 'utf8')
      const result = appendActivationRow(fixture.paths.profileDir, 'verify-x', 'x-pkg')
      expect(result.ok).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})
