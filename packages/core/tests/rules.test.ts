import { describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, reportOk, anchorFiles } from '../src/index.js'
import { makeHome, writeProfile, writeInstalledPackages, writeLockfile, writeJson } from './helpers.js'

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

  it('resolves official rows from the installation closure before the mirror heals', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-web-app'] })
      // The shared mirror still reflects the previous dsh generation: the dsh
      // link points at the upgraded installation, whose nested node_modules
      // carries the new official package, but the mirror has no top-level link
      // for it yet (healed at the next dsh boot).
      const installRoot = join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh')
      writeJson(join(installRoot, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' })
      const nested = join(installRoot, 'node_modules', '@deepseek-ai')
      const webAppDir = join(nested, 'dsh-web-app')
      writeJson(join(webAppDir, 'package.json'), {
        name: '@deepseek-ai/dsh-web-app',
        version: '0.1.5-rc.2',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(webAppDir, 'cordis.patch.yml'), [
        '- id: ui-sidebar-documentpreview',
        "  name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'",
        '',
      ].join('\n'), 'utf8')
      writeJson(join(nested, 'dsh-client-ui-sidebar-documentpreview', 'package.json'), {
        name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
        version: '0.1.5-rc.2',
      })
      writeLockfile(fixture.paths, {})
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.ruleId === 'patch-resolution')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('anchors resolution at the dsh installation manifest when the closure links it', () => {
    const fixture = makeHome()
    try {
      const installRoot = join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh')
      writeJson(join(installRoot, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' })
      expect(anchorFiles(fixture.paths)).toContain(join(installRoot, 'package.json'))
    } finally {
      fixture.dispose()
    }
  })

  it('resolves the flat installation layout through the physical link target', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-web-app'] })
      // npx-style flat installation: official packages are hoisted next to the
      // dsh package instead of nested under it.
      const installModules = join(fixture.home, 'npx-cache', 'node_modules')
      writeJson(join(installModules, '@deepseek-ai', 'dsh', 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '0.1.6-alpha.1',
      })
      const webAppDir = join(installModules, '@deepseek-ai', 'dsh-web-app')
      writeJson(join(webAppDir, 'package.json'), {
        name: '@deepseek-ai/dsh-web-app',
        version: '0.1.6-alpha.1',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(webAppDir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      // The shared mirror links dsh into the profile home; the link path alone
      // walks the mirror's parents, so only the resolved target exposes the
      // hoisted package.
      const linkParent = join(fixture.paths.sharedProfilesDir, '@deepseek-ai')
      mkdirSync(linkParent, { recursive: true })
      symlinkSync(join(installModules, '@deepseek-ai', 'dsh'), join(linkParent, 'dsh'), 'junction')
      writeLockfile(fixture.paths, {})
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(reportOk(report)).toBe(true)
      expect(report.findings.some((f) => f.ruleId === 'bundle-declaration')).toBe(false)
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
