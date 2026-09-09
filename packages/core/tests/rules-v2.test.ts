import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, reportOk, applyConfig, ruleRegistryVersion, type Finding, type OutdatedState } from '../src/index.js'
import { makeHome, writeProfile, writeInstalledPackages, writeJson } from './helpers.js'

function emptyOutdated(partial: Partial<OutdatedState>): OutdatedState {
  return { entries: [], checkedAt: null, ...partial }
}

describe('rule 3: registry version (advisory)', () => {
  it('reports updates as warnings', () => {
    const findings = ruleRegistryVersion(emptyOutdated({ checkedAt: '2026-01-01T00:00:00.000Z', entries: [{ name: 'pkg-a', current: '1.0.0', latest: '1.1.0' }] }))
    expect(findings[0]?.severity).toBe('warn')
    expect(findings[0]?.message).toContain('latest is 1.1.0')
  })
  it('degrades a failed check to info', () => {
    const findings = ruleRegistryVersion(emptyOutdated({}))
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.message).toContain('unavailable')
  })
  it('reports up-to-date as info', () => {
    const findings = ruleRegistryVersion(emptyOutdated({ checkedAt: '2026-01-01T00:00:00.000Z' }))
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.message).toContain('up to date')
  })
})

describe('rule 4: peer gaps and double instances', () => {
  function peerFixture(peerManifest: Record<string, string>, embedded: { name: string; scope?: string } | null, hostInClosure: boolean) {
    const fixture = makeHome()
    const { paths } = fixture
    writeProfile(paths, { dependencies: { 'pkg-b': '1.0.0' }, bundles: ['pkg-b'] })
    const dir = join(paths.profileDir, 'node_modules', 'pkg-b')
    writeJson(join(dir, 'package.json'), { name: 'pkg-b', version: '1.0.0', type: 'module', main: 'lib/index.js', peerDependencies: peerManifest, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "pkg-b"\n', 'utf8')
    if (embedded !== null) {
      const target = embedded.scope === undefined
        ? join(dir, 'node_modules', embedded.name)
        : join(dir, 'node_modules', embedded.scope, embedded.name)
      writeJson(join(target, 'package.json'), { name: embedded.scope === undefined ? embedded.name : `${embedded.scope}/${embedded.name}`, version: '4.0.0' })
    }
    if (hostInClosure) {
      const host = join(paths.sharedProfilesDir, '@deepseek-ai', 'cordis')
      writeJson(join(host, 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.0' })
    }
    return fixture
  }

  it('flags a double instance of framework core as fatal', async () => {
    const fixture = peerFixture({ '@deepseek-ai/cordis': '^4.0.0' }, { name: 'cordis', scope: '@deepseek-ai' }, true)
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'peer-gap')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('double instance')
    } finally {
      fixture.dispose()
    }
  })

  it('flags an unreachable peer as a warning', async () => {
    const fixture = peerFixture({ 'some-missing-peer': '^1.0.0' }, null, false)
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(reportOk(report)).toBe(true)
      const finding = report.findings.find((f) => f.ruleId === 'peer-gap')
      expect(finding?.severity).toBe('warn')
      expect(finding?.message).toContain('does not resolve')
    } finally {
      fixture.dispose()
    }
  })

  it('stays silent when peers resolve from the closure host', async () => {
    const fixture = peerFixture({ '@deepseek-ai/cordis': '^4.0.0' }, null, true)
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(report.findings.some((f) => f.ruleId === 'peer-gap')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})

describe('rule 5: patch resolution', () => {
  it('flags a row whose package does not resolve', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      mkdirSync(fixture.paths.profileDir, { recursive: true })
      writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'), '- id: row-a\n  name: ghost-package\n', 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'patch-resolution')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('ghost-package')
    } finally {
      fixture.dispose()
    }
  })

  it('accepts package subpath references when the package resolves', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeInstalledPackages(fixture.paths, [{ name: '@deepseek-ai/dsh-web-app', version: '1.0.0', dirName: '@deepseek-ai/dsh-web-app' }])
      mkdirSync(fixture.paths.profileDir, { recursive: true })
      writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'),
        "- id: startup\n  name: '@deepseek-ai/dsh-web-app/startup'\n", 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(report.findings.some((f) => f.ruleId === 'patch-resolution' && f.severity === 'fatal')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('skips disabled rows and cordis builtins', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      mkdirSync(fixture.paths.profileDir, { recursive: true })
      writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'),
        '- id: off\n  name: ghost-package\n  disabled: true\n- id: inc\n  name: cordis:include\n', 'utf8')
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(reportOk(report)).toBe(true)
    } finally {
      fixture.dispose()
    }
  })
})

describe('rule 7: structure integrity', () => {
  function structureFixture(manifest: Record<string, unknown>, entryFiles: string[]) {
    const fixture = makeHome()
    const { paths } = fixture
    writeProfile(paths, { dependencies: {}, bundles: ['pkg-c'] })
    const dir = join(paths.profileDir, 'node_modules', 'pkg-c')
    writeJson(join(dir, 'package.json'), { name: 'pkg-c', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }, ...manifest })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
    for (const file of entryFiles) {
      const dirPath = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
      if (dirPath.length > 0) mkdirSync(join(dir, dirPath), { recursive: true })
      writeFileSync(join(dir, file), 'export const name = "pkg-c"\n', 'utf8')
    }
    return fixture
  }

  it('flags a missing default entry as fatal', async () => {
    const fixture = structureFixture({ type: 'module', main: 'lib/index.js' }, [])
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'structure')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('does not exist')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a CommonJS default entry as fatal', async () => {
    const fixture = structureFixture({ main: 'lib/index.js' }, ['lib/index.js'])
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'structure')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('CommonJS')
    } finally {
      fixture.dispose()
    }
  })

  it('accepts an ESM default entry', async () => {
    const fixture = structureFixture({ type: 'module', main: 'lib/index.js' }, ['lib/index.js'])
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(report.findings.some((f) => f.ruleId === 'structure' && f.severity === 'fatal')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('warns on a missing types entry', async () => {
    const fixture = structureFixture({ type: 'module', main: 'lib/index.js', types: 'lib/index.d.ts' }, ['lib/index.js'])
    try {
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'structure' && f.packageName === 'pkg-c')
      expect(finding?.severity).toBe('warn')
    } finally {
      fixture.dispose()
    }
  })
})

describe('config application', () => {
  const fatal: Finding = { ruleId: 'dependency-drift', severity: 'fatal', packageName: 'pkg-a', message: 'x', fix: { kind: 'align-lockfile' } }
  const warn: Finding = { ruleId: 'registry-version', severity: 'warn', packageName: 'pkg-a', message: 'y', fix: { kind: 'none' } }

  it('disables a rule', () => {
    const out = applyConfig([fatal], { rules: { 'dependency-drift': { enabled: false } } })
    expect(out).toEqual([])
  })

  it('drops ignored packages', () => {
    const out = applyConfig([fatal], { ignorePackages: ['pkg-a'] })
    expect(out).toEqual([])
  })

  it('demotes but never promotes severity', () => {
    const demoted = applyConfig([fatal, warn], { rules: { 'dependency-drift': { severity: 'warn' }, 'registry-version': { severity: 'fatal' } } })
    expect(demoted[0]?.severity).toBe('warn')
    expect(demoted[1]?.severity).toBe('warn')
  })
})
