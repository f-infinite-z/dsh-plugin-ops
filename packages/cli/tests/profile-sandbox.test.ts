import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { copyProfileFiles, PROFILE_COPY_FILES } from '../src/profile-copy.js'
import { runFixVerify } from '../src/profile-sandbox.js'

describe('copyProfileFiles', () => {
  it('copies manifest and boot files, never node_modules, skipping what is absent', () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-ops-copy-src-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-ops-copy-dst-'))
    try {
      writeFileSync(join(source, 'package.json'), '{"name":"x"}\n', 'utf8')
      writeFileSync(join(source, 'cordis.patch.yml'), '[]\n', 'utf8')
      mkdirSync(join(source, 'node_modules', 'some-pkg'), { recursive: true })
      copyProfileFiles(source, target)
      expect(existsSync(join(target, 'package.json'))).toBe(true)
      expect(existsSync(join(target, 'cordis.patch.yml'))).toBe(true)
      expect(existsSync(join(target, 'pnpm-lock.yaml'))).toBe(false)
      expect(existsSync(join(target, 'node_modules'))).toBe(false)
      expect(PROFILE_COPY_FILES).not.toContain('node_modules')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('mirrors relative file: dependencies at the same relative location', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ops-copy-mirror-'))
    const sourceProfile = join(root, 'a', 'profiles', 'web')
    const targetProfile = join(root, 'b', 'profiles', 'web')
    const depDir = join(root, 'shared', 'e2e-dep')
    mkdirSync(sourceProfile, { recursive: true })
    mkdirSync(targetProfile, { recursive: true })
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'package.json'), '{"name":"e2e-dep"}\n', 'utf8')
    writeFileSync(join(sourceProfile, 'pnpm-lock.yaml'), [
      'lockfileVersion: 9.0',
      'dependencies:',
      '  e2e-dep:',
      '    specifier: file:../../../shared/e2e-dep',
      '    version: file:../../../shared/e2e-dep',
      '',
    ].join('\n'), 'utf8')
    try {
      copyProfileFiles(sourceProfile, targetProfile)
      const mirrored = resolve(targetProfile, '../../../shared/e2e-dep')
      expect(existsSync(mirrored)).toBe(true)
      expect(readFileSync(join(mirrored, 'package.json'), 'utf8')).toContain('e2e-dep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runFixVerify', () => {
  it('reports unavailable for profiles outside web and desktop', async () => {
    const result = await runFixVerify({
      sourceProfileDir: 'unused', profileName: 'headless', disableRows: [], dshCommand: ['dsh'], timeoutSec: 5,
    })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('unavailable')
    expect(result.detail).toContain('web and desktop')
  })

  it('reports unavailable without a dsh command to drive the sandbox', async () => {
    const result = await runFixVerify({
      sourceProfileDir: 'unused', profileName: 'web', disableRows: [], dshCommand: [], timeoutSec: 5,
    })
    expect(result.kind).toBe('unavailable')
  })

  it('reports setup-failed when the sandbox install fails, leaving the source untouched', async () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-ops-fix-verify-src-'))
    try {
      writeFileSync(join(source, 'package.json'), '{"name":"prof"}\n', 'utf8')
      const fakeDriver = join(source, 'exit1.mjs')
      writeFileSync(fakeDriver, 'process.exit(1)\n', 'utf8')
      const result = await runFixVerify({
        sourceProfileDir: source, profileName: 'web', disableRows: ['some-row'],
        dshCommand: [process.execPath, fakeDriver], timeoutSec: 5,
      })
      expect(result.kind).toBe('setup-failed')
      expect(result.detail).toContain('could not be installed')
      expect(existsSync(join(source, 'cordis.patch.yml'))).toBe(false)
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  }, 20000)
})
