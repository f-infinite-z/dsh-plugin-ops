import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, reportOk } from '../src/index.js'
import { makeHome, writeProfile, writeInstalledPackages, writeLockfile } from './helpers.js'

function cleanProfileSetup() {
  const fixture = makeHome()
  writeProfile(fixture.paths, {
    dependencies: { 'pkg-a': '^1.0.0' },
    bundles: ['pkg-a'],
  })
  writeInstalledPackages(fixture.paths, [
    { name: 'pkg-a', version: '1.0.1', dshBundlePatch: 'cordis.patch.yml' },
  ])
  writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
  return fixture
}

describe('scan on a clean profile', () => {
  it('reports no fatal findings', async () => {
    const fixture = cleanProfileSetup()
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.severity === 'fatal')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('records the installed snapshot', async () => {
    const fixture = cleanProfileSetup()
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.snapshot.packages['pkg-a']).toBe('1.0.1')
    } finally {
      fixture.dispose()
    }
  })
})

describe('rule 1: bundle declaration integrity', () => {
  it('flags a bundle that is not installed', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['missing-bundle'] })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(false)
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration' && f.packageName === 'missing-bundle')
      expect(finding?.severity).toBe('fatal')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a bundle whose package.json is unreadable', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['broken-bundle'] })
      // A non-JSON package.json forces a parse failure.
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(fixture.paths.profileDir, 'node_modules', 'broken-bundle'), { recursive: true })
      writeFileSync(join(fixture.paths.profileDir, 'node_modules', 'broken-bundle', 'package.json'), '{not json', 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration' && f.packageName === 'broken-bundle')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('unreadable')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a bundle-less package listed as a layer', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['plain-pkg'] })
      writeInstalledPackages(fixture.paths, [{ name: 'plain-pkg', version: '1.0.0' }])
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration' && f.packageName === 'plain-pkg')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('dsh.bundle.patch')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a bundle whose declared patch file is missing', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['lost-patch'] })
      // Declares a patch file that is never created on disk.
      writeInstalledPackages(fixture.paths, [{ name: 'lost-patch', version: '1.0.0', dshBundlePatch: 'nonexistent.yml', patchExists: false }])
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration' && f.packageName === 'lost-patch')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('missing')
    } finally {
      fixture.dispose()
    }
  })
})

describe('rule 2: dependency drift', () => {
  it('flags installed version deviating from the lockfile', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' } })
      writeInstalledPackages(fixture.paths, [{ name: 'pkg-a', version: '1.0.2' }])
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'dependency-drift' && f.packageName === 'pkg-a')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.fix.kind).toBe('align-lockfile')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a declared but uninstalled package when a lock exists', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' } })
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'dependency-drift' && f.packageName === 'pkg-a')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.fix.kind).toBe('align-lockfile')
    } finally {
      fixture.dispose()
    }
  })

  it('warns when the manifest was not re-locked after a range change', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^2.0.0' } })
      writeInstalledPackages(fixture.paths, [{ name: 'pkg-a', version: '1.0.1' }])
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'dependency-drift' && f.packageName === 'pkg-a')
      expect(finding?.severity).toBe('warn')
      expect(finding?.message).toContain('does not satisfy')
    } finally {
      fixture.dispose()
    }
  })

  it('warns (not crashes) when the lockfile is missing', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' } })
      writeInstalledPackages(fixture.paths, [{ name: 'pkg-a', version: '1.0.1' }])
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.message.includes('no pnpm-lock.yaml'))).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('warns on a declared-but-missing package when no lockfile exists', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' } })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      const finding = report.findings.find((f) => f.ruleId === 'dependency-drift' && f.packageName === 'pkg-a')
      expect(finding?.severity).toBe('warn')
      expect(finding?.message).toContain('not installed')
    } finally {
      fixture.dispose()
    }
  })

  it('treats a peer-context lockfile version as equal to the bare installed version', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' } })
      writeInstalledPackages(fixture.paths, [{ name: 'pkg-a', version: '1.0.1' }])
      // pnpm encodes the resolved peer context in the importer version.
      writeFileSync(
        join(fixture.paths.profileDir, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\nimporters:\n  .:\n    dependencies:\n      'pkg-a':\n        specifier: ^1.0.0\n        version: 1.0.1(react@18.3.1)\n",
        'utf8',
      )
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.severity === 'fatal')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('does not warn about closure-resolved box bundles missing from dependencies', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-base'] })
      // The official box bundle lives only in the shared installation closure.
      const boxDir = join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh-base')
      mkdirSync(boxDir, { recursive: true })
      writeFileSync(join(boxDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-base', version: '0.1.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }), 'utf8')
      writeFileSync(join(boxDir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      writeLockfile(fixture.paths, {})
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.message.includes('not declared in profile dependencies'))).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})

describe('scan failure', () => {
  it('throws ScanError when the profile has no manifest', async () => {
    const fixture = makeHome()
    try {
      await expect(scanProfile({ paths: fixture.paths, profileName: 'web' })).rejects.toThrow(/no readable manifest/)
    } finally {
      fixture.dispose()
    }
  })
})
