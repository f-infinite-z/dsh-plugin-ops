import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile } from '../src/index.js'
import { makeHome, writeProfile, writeJson } from './helpers.js'

// The desktop install lives in an Electron app directory that a plain Node
// process can neither depend on nor reach reliably in CI, so the scan-path
// tests pin the detection result instead of constructing a packaged app.
vi.mock('../src/desktop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/desktop.js')>()
  return {
    ...actual,
    detectDesktop: () => ({ installDir: '/fake/deepseek', version: '0.2.0-rc.2' }),
  }
})

function writeUserPatch(profileDir: string, rows: string): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), rows, 'utf8')
}

describe('desktop profile scan', () => {
  it('trusts official bundles and official patch rows on the desktop profile', async () => {
    const fixture = makeHome('desktop')
    try {
      writeProfile(fixture.paths, {
        dependencies: {},
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      })
      writeUserPatch(fixture.paths.profileDir, [
        '- insert:',
        '    - id: ui-settings',
        '      name: "@deepseek-ai/dsh-client-ui-settings"',
        '      config:',
        '        enabled: true',
        '',
      ].join('\n'))
      const report = await scanProfile({ paths: fixture.paths, profileName: 'desktop' })
      expect(report.findings.filter((f) => f.severity === 'fatal')).toHaveLength(0)
      expect(report.findings.filter((f) => f.severity === 'warn')).toHaveLength(0)
      expect(report.findings.some((f) => f.ruleId === 'patch-resolution')).toBe(false)
      expect(report.findings.some((f) => f.ruleId === 'bundle-declaration')).toBe(false)
      expect(report.findings.some((f) => f.ruleId === 'dependency-drift')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('trusts official peers of third-party bundles on the desktop profile', async () => {
    const fixture = makeHome('desktop')
    try {
      writeProfile(fixture.paths, { dependencies: { 'third-party-plug': '1.0.0' }, bundles: ['third-party-plug'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'third-party-plug')
      writeJson(join(dir, 'package.json'), {
        name: 'third-party-plug',
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '0.2.0-rc.2', '@deepseek-ai/dsh-atomic-write': '0.2.0-rc.2' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "third-party-plug"\n', 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'desktop' })
      expect(report.findings.filter((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')).toHaveLength(0)
    } finally {
      fixture.dispose()
    }
  })

  it('does not evaluate pre-desktop boundaries on the desktop profile', async () => {
    // The desktop host only ever runs 0.2.0-rc.1+ releases: a peer range that
    // rejects 0.1.7-rc.2 but accepts every desktop release is not observable.
    const fixture = makeHome('desktop')
    try {
      writeProfile(fixture.paths, { dependencies: { 'desktop-plug': '1.0.0' }, bundles: ['desktop-plug'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'desktop-plug')
      writeJson(join(dir, 'package.json'), {
        name: 'desktop-plug',
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-client-runtime': '>=0.2.0-rc.1 <0.3.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "desktop-plug"\n', 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'desktop', versionView: 'all' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('still reports an unresolvable third-party patch row on the desktop profile', async () => {
    const fixture = makeHome('desktop')
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeUserPatch(fixture.paths.profileDir, '- insert:\n    - id: third-party\n      name: "some-missing-plugin"\n')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'desktop' })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding).toBeDefined()
      expect(finding?.severity).toBe('warn')
    } finally {
      fixture.dispose()
    }
  })

  it('does not exempt official rows on a non-desktop profile', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeUserPatch(fixture.paths.profileDir, '- insert:\n    - id: ui-settings\n      name: "@deepseek-ai/dsh-client-ui-settings"\n')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding).toBeDefined()
      expect(finding?.severity).toBe('fatal')
    } finally {
      fixture.dispose()
    }
  })

  it('does not report a user-layer flat row on the desktop profile: the official layers sit in the asar', async () => {
    const fixture = makeHome('desktop')
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeUserPatch(fixture.paths.profileDir, '- id: ui-settings\n  config:\n    enabled: true\n')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'desktop' })
      expect(report.findings.some((f) => f.ruleId === 'patch-resolution')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})
