import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanProfile, verifyPluginPackage } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile, writeJson } from './helpers.js'

/** Write the dsh installation anchor (the shared closure's @deepseek-ai/dsh link). */
function writeDshInstall(fixture: ReturnType<typeof makeHome>, version: string): void {
  writeJson(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
  })
}

/** Write the user-layer patch with one inserted ghost row. */
function writeGhostInsert(fixture: ReturnType<typeof makeHome>): void {
  mkdirSync(fixture.paths.profileDir, { recursive: true })
  writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'), '- insert:\n    - id: row-a\n      name: ghost-package\n', 'utf8')
}

/** Write one profile-local bundle with a dsh peer range. */
function writeBundle(fixture: ReturnType<typeof makeHome>, name: string, version: string, peerRange: string): void {
  const dir = join(fixture.paths.profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), {
    name,
    version,
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': peerRange },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: probe\n      name: ${name}\n`, 'utf8')
}

describe('version view: rule severities', () => {
  it('reports an optional patch row fatal under all, with a version note', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeGhostInsert(fixture)
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all' })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.versionNote).toContain('0.1.7-alpha.1')
    } finally {
      fixture.dispose()
    }
  })

  it('reports the same row warn under latest, without a version note', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeGhostInsert(fixture)
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'latest' })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding?.severity).toBe('warn')
      expect(finding?.versionNote).toBeUndefined()
    } finally {
      fixture.dispose()
    }
  })

  it('keeps the actual install as the default view', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeDshInstall(fixture, '0.1.7-rc.2')
      writeGhostInsert(fixture)
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding?.severity).toBe('warn')
    } finally {
      fixture.dispose()
    }
  })

  it('honors versionView from the config when the input does not set one', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeGhostInsert(fixture)
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, config: { versionView: 'latest' } })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding?.severity).toBe('warn')
    } finally {
      fixture.dispose()
    }
  })
})

describe('version view: rule 8 compatibility', () => {
  it('reports a peer gap under all as a warning when only some releases reject it', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all', dshVersion: null })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('warn')
      expect(finding?.versionNote).toContain('rejected by 0.1.7-rc.2, 0.2.0-rc.2')
      expect(finding?.versionNote).toContain('accepted by 0.2.1-alpha.1')
    } finally {
      fixture.dispose()
    }
  })

  it('escalates to fatal when the unknown install rejects every evaluated release', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '0.1.0-rc.8')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all', dshVersion: null })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.versionNote).toContain('rejected by every known release')
    } finally {
      fixture.dispose()
    }
  })

  it('accepts a peer range covering every known boundary under all', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '>=0.1.5-rc.2')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('downgrades a future-only rejection to warn when the actual install still loads it', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '>=0.1.5-rc.2 <0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all', dshVersion: '0.1.7-rc.2' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('warn')
      expect(finding?.versionNote).toContain('rejected by 0.2.1-alpha.1')
      expect(finding?.versionNote).toContain('accepted by 0.1.7-rc.2, 0.2.0-rc.2')
    } finally {
      fixture.dispose()
    }
  })

  it('does not evaluate official bundles under a cross-release view', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { '@deepseek-ai/dsh-fake': '^1.0.0' }, bundles: ['@deepseek-ai/dsh-fake'] })
      writeBundle(fixture, '@deepseek-ai/dsh-fake', '1.0.1', '^0.1.0')
      writeLockfile(fixture.paths, { '@deepseek-ai/dsh-fake': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('evaluates only the newest boundary under latest', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      // Exact newest release: accepted by latest, rejected by older boundaries.
      writeBundle(fixture, 'pkg-a', '1.0.1', '0.2.1-alpha.1')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'latest', dshVersion: null })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
      const all = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false, versionView: 'all', dshVersion: null })
      const finding = all.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('warn')
      expect(finding?.versionNote).toContain('accepted by 0.2.1-alpha.1')
    } finally {
      fixture.dispose()
    }
  })
})

describe('version view: verify peer coverage', () => {
  function makePkg(files: Record<string, string>): string {
    const dir = join(tmpdir(), `dsh-ops-vv-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const file = join(dir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return dir
  }

  it('warns when a dsh peer range does not cover every known boundary', () => {
    const dir = makePkg({
      'package.json': JSON.stringify({
        name: 'vv-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh': '^0.1.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'cordis.patch.yml': '- insert:\n    - id: vv\n      name: vv-plugin\n',
      'lib/index.js': 'export function apply() {}\n',
    })
    try {
      const report = verifyPluginPackage(dir)
      const finding = report.findings.find((f) => f.ruleId === 'peer-contract' && f.severity === 'warn' && f.message.includes('does not cover'))
      expect(finding).toBeDefined()
      expect(finding?.message).toContain('0.2.1-alpha.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a dsh peer range covering every known boundary', () => {
    const dir = makePkg({
      'package.json': JSON.stringify({
        name: 'vv-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh': '>=0.1.5-rc.2' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'cordis.patch.yml': '- insert:\n    - id: vv\n      name: vv-plugin\n',
      'lib/index.js': 'export function apply() {}\n',
    })
    try {
      const report = verifyPluginPackage(dir)
      expect(report.findings.some((f) => f.ruleId === 'peer-contract' && f.message.includes('does not cover'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
