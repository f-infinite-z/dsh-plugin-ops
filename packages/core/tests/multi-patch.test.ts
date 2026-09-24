import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { scanProfile, verifyPluginPackage, reportOk } from '../src/index.js'
import { makeHome, writeProfile, writeInstalledPackages, writeLockfile, writeJson } from './helpers.js'

function makePkg(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-verify-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return dir
}

describe('multi-patch-file bundles (dsh 0.1.7+)', () => {
  it('resolves a bundle that declares an ordered patch-file list', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeInstalledPackages(fixture.paths, [
        { name: 'pkg-a', version: '1.0.1', dshBundlePatch: ['a.yml', 'b.yml'] },
      ])
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.findings.some((f) => f.ruleId === 'bundle-declaration')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('flags a missing file in a patch-file list', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'pkg-a')
      mkdirSync(dir, { recursive: true })
      writeJson(join(dir, 'package.json'), {
        name: 'pkg-a', version: '1.0.1',
        dsh: { bundle: { patch: ['a.yml', 'missing.yml'] } },
      })
      writeFileSync(join(dir, 'a.yml'), '- id: probe\n', 'utf8')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('missing.yml')
    } finally {
      fixture.dispose()
    }
  })

  it('sees patch rows from every file in the list', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'pkg-a')
      mkdirSync(dir, { recursive: true })
      writeJson(join(dir, 'package.json'), {
        name: 'pkg-a', version: '1.0.1',
        dsh: { bundle: { patch: ['a.yml', 'b.yml'] } },
      })
      writeFileSync(join(dir, 'a.yml'), '- id: probe\n', 'utf8')
      writeFileSync(join(dir, 'b.yml'), '- id: ghost\n  name: ghost-pkg\n', 'utf8')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.findings.some((f) => f.ruleId === 'patch-resolution' && f.message.includes('ghost-pkg'))).toBe(true)
    } finally {
      fixture.dispose()
    }
  })
})

describe('verifyPluginPackage multi-patch', () => {
  it('accepts an ordered patch-file list', () => {
    const dir = makePkg({
      'package.json': JSON.stringify({
        name: 'multi-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js',
        dsh: { bundle: { patch: ['./a.yml', './b.yml'] } },
      }),
      'a.yml': '- id: one\n  name: multi-plugin\n',
      'b.yml': '- id: two\n  name: multi-plugin\n',
      'lib/index.js': 'export function apply() {}\n',
    })
    try {
      const report = verifyPluginPackage(dir)
      expect(report.findings).toEqual([])
      expect(report.packageName).toBe('multi-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('errors when a listed patch file is missing', () => {
    const dir = makePkg({
      'package.json': JSON.stringify({
        name: 'multi-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js',
        dsh: { bundle: { patch: ['./a.yml', './missing.yml'] } },
      }),
      'a.yml': '- id: one\n',
      'lib/index.js': 'export function apply() {}\n',
    })
    try {
      const report = verifyPluginPackage(dir)
      const finding = report.findings.find((f) => f.ruleId === 'bundle-patch' && f.severity === 'error')
      expect(finding?.message).toContain('missing.yml')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
