import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, writeVersionExemption, removeVersionExemption, removeExemptionsForPackage, readProfileVersionExemptions, unmetDshRequirements } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile, writeJson } from './helpers.js'

/** Write the dsh installation anchor (the shared closure's @deepseek-ai/dsh link). */
function writeDshInstall(fixture: ReturnType<typeof makeHome>, version: string): void {
  writeJson(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
  })
}

/** Write one profile-local bundle with an optional dsh peer range. */
function writeBundle(
  fixture: ReturnType<typeof makeHome>,
  name: string,
  version: string,
  peerRange?: string,
): void {
  const dir = join(fixture.paths.profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), {
    name,
    version,
    ...(peerRange === undefined ? {} : { peerDependencies: { '@deepseek-ai/dsh-client-runtime': peerRange } }),
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
}

function setup(version: string): ReturnType<typeof makeHome> {
  const fixture = makeHome()
  writeDshInstall(fixture, version)
  return fixture
}

describe('rule 8: plugin version compatibility', () => {
  it('is silent on dsh releases before 0.1.7-rc.1', async () => {
    const fixture = setup('0.1.6-alpha.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('flags a bundle whose dsh peer rejects the running dsh version', async () => {
    const fixture = setup('0.1.7-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.packageName).toBe('pkg-a')
      expect(finding?.message).toContain('skips this bundle')
    } finally {
      fixture.dispose()
    }
  })

  it('flags a prerelease mismatch against a ^0.1.7 peer', async () => {
    const fixture = setup('0.1.7-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.1.7')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('fatal')
    } finally {
      fixture.dispose()
    }
  })

  it('keeps pre-desktop boundaries on a web profile and carries the version context', async () => {
    const fixture = setup('0.2.0-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '>=0.2.0-rc.1 <0.3.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', versionView: 'all' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('warn')
      expect(finding?.versionContext).toContain('running: 0.2.0-rc.2')
      expect(finding?.nextAction).toBe('update-plugin-or-grant-exemption')
    } finally {
      fixture.dispose()
    }
  })

  it('is silent for a compatible prerelease range (includePrerelease semantics)', async () => {
    const fixture = setup('0.1.7-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.1.0-rc.6')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('treats a workspace:* peer as always compatible', async () => {
    const fixture = setup('0.1.7-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', 'workspace:*')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('reports an active exact-version exemption at info instead of fatal', async () => {
    const fixture = setup('0.1.7-rc.2')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      writeJson(join(fixture.paths.profileDir, 'compatibility.json'), { 'pkg-a@1.0.1': ['0.1.7-rc.2'] })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('info')
      expect(finding?.message).toContain('exemption')
    } finally {
      fixture.dispose()
    }
  })

  it('never evaluates official bundles, even under the actual view', async () => {
    for (const view of [undefined, 'all'] as const) {
      const fixture = setup('0.1.7-rc.2')
      try {
        // A stale shared-mirror copy of an official bundle whose peers reject
        // the running release: the launcher owns it, so no view may judge it.
        writeProfile(fixture.paths, { dependencies: { '@deepseek-ai/dsh-web-app': '0.1.6-alpha.2' }, bundles: ['@deepseek-ai/dsh-web-app'] })
        writeBundle(fixture, '@deepseek-ai/dsh-web-app', '0.1.6-alpha.2', '^0.5.0')
        writeLockfile(fixture.paths, {})
        const report = await scanProfile({ paths: fixture.paths, profileName: 'web', ...(view === undefined ? {} : { versionView: view }) })
        expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
      } finally {
        fixture.dispose()
      }
    }
  })
})

describe('exemption write/revoke', () => {
  it('grants, merges, and revokes an exact-version exemption', () => {
    const fixture = makeHome('web')
    try {
      writeJson(join(fixture.paths.profileDir, 'compatibility.json'), { 'other@1.0.0': ['0.1.7-rc.2'] })

      const grant = writeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      expect(grant.ok).toBe(true)
      expect(readProfileVersionExemptions(fixture.paths.profileDir)).toEqual({
        'other@1.0.0': ['0.1.7-rc.2'],
        'pkg-a@1.0.1': ['0.2.0-rc.2'],
      })

      const again = writeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      expect(again.ok).toBe(true)
      expect(readProfileVersionExemptions(fixture.paths.profileDir)['pkg-a@1.0.1']).toEqual(['0.2.0-rc.2'])

      const revoke = removeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      expect(revoke.ok).toBe(true)
      expect(readProfileVersionExemptions(fixture.paths.profileDir)).toEqual({ 'other@1.0.0': ['0.1.7-rc.2'] })
    } finally {
      fixture.dispose()
    }
  })

  it('revoking an unknown exemption is a no-op', () => {
    const fixture = makeHome('web')
    try {
      const result = removeVersionExemption(fixture.paths.profileDir, 'missing', '1.0.0', '0.2.0')
      expect(result.ok).toBe(true)
      expect(result.backup).toBeNull()
    } finally {
      fixture.dispose()
    }
  })

  it('drops the key when its last runtime is revoked', () => {
    const fixture = makeHome('web')
    try {
      writeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      removeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      expect(readProfileVersionExemptions(fixture.paths.profileDir)).toEqual({})
    } finally {
      fixture.dispose()
    }
  })

  it('removes every exemption for a package name regardless of version', () => {
    const fixture = makeHome('web')
    try {
      writeVersionExemption(fixture.paths.profileDir, 'pkg-a', '1.0.1', '0.2.0-rc.2')
      writeVersionExemption(fixture.paths.profileDir, 'pkg-a', '2.0.0', '0.2.0-rc.2')
      writeVersionExemption(fixture.paths.profileDir, 'other', '1.0.0', '0.2.0-rc.2')
      const result = removeExemptionsForPackage(fixture.paths.profileDir, 'pkg-a')
      expect(result.ok).toBe(true)
      expect(readProfileVersionExemptions(fixture.paths.profileDir)).toEqual({ 'other@1.0.0': ['0.2.0-rc.2'] })
    } finally {
      fixture.dispose()
    }
  })

  it('removing exemptions for an absent package is a no-op', () => {
    const fixture = makeHome('web')
    try {
      const result = removeExemptionsForPackage(fixture.paths.profileDir, 'missing')
      expect(result.ok).toBe(true)
      expect(result.backup).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})

describe('unmetDshRequirements', () => {
  it('prefers engines.dsh over dsh peers from 0.2.1-alpha.4 on', () => {
    expect(unmetDshRequirements({
      engines: { dsh: '>=0.2.1-alpha.4 <0.3.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.7' },
    }, '0.2.1-rc.1')).toBeNull()
    expect(unmetDshRequirements({
      engines: { dsh: '0.2.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.5' },
    }, '0.2.1-rc.1')).toEqual({ 'engines.dsh': '0.2.0' })
  })

  it('applies the same requirement rules on dsh 0.2.1-rc.2', () => {
    expect(unmetDshRequirements({
      engines: { dsh: '>=0.2.1-alpha.4 <0.3.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.7' },
    }, '0.2.1-rc.2')).toBeNull()
    expect(unmetDshRequirements({
      engines: { dsh: '0.2.1-rc.1' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.5' },
    }, '0.2.1-rc.2')).toEqual({ 'engines.dsh': '0.2.1-rc.1' })
  })

  it('applies the same requirement rules on dsh 0.2.1-rc.3', () => {
    expect(unmetDshRequirements({
      engines: { dsh: '>=0.2.1-alpha.4 <0.3.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.7' },
    }, '0.2.1-rc.3')).toBeNull()
    expect(unmetDshRequirements({
      engines: { dsh: '0.2.1-rc.2' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.5' },
    }, '0.2.1-rc.3')).toEqual({ 'engines.dsh': '0.2.1-rc.2' })
  })

  it('ignores engines.dsh before 0.2.1-alpha.4', () => {
    expect(unmetDshRequirements({
      engines: { dsh: '>=9.0.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.5' },
    }, '0.1.7-rc.2')).toBeNull()
    expect(unmetDshRequirements({
      engines: { dsh: '>=9.0.0' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' },
    }, '0.1.7-rc.2')).toEqual({ '@deepseek-ai/dsh': '^0.2.0' })
  })

  it('treats workspace:, empty, and non-string engines.dsh as unmet', () => {
    expect(unmetDshRequirements({ engines: { dsh: 'workspace:^' } }, '0.2.1-rc.1')).toEqual({ 'engines.dsh': 'workspace:^' })
    expect(unmetDshRequirements({ engines: { dsh: '' } }, '0.2.1-rc.1')).toEqual({ 'engines.dsh': '' })
    expect(unmetDshRequirements({ engines: { dsh: 1 } }, '0.2.1-rc.1')).toEqual({ 'engines.dsh': '(not a string)' })
  })

  it('refuses a malformed engines object', () => {
    expect(unmetDshRequirements({ engines: 'x' as unknown as Record<string, unknown> }, '0.2.1-rc.1')).toEqual({ engines: '(not an object)' })
    expect(unmetDshRequirements({ engines: [] as unknown as Record<string, unknown> }, '0.2.1-rc.1')).toEqual({ engines: '(not an object)' })
  })

  it('keeps workspace peers matching the runtime and non-string peers unmet', () => {
    expect(unmetDshRequirements({ peerDependencies: { '@deepseek-ai/dsh': 'workspace:^' } }, '0.2.0-rc.2')).toBeNull()
    expect(unmetDshRequirements({ peerDependencies: { '@deepseek-ai/dsh': 1 as unknown as string } }, '0.2.0-rc.2')).toEqual({ '@deepseek-ai/dsh': '(not a string)' })
  })
})

describe('rule 8: engines.dsh requirements', () => {
  it('flags an engines.dsh rejection on dsh 0.2.1-rc.1', async () => {
    const fixture = setup('0.2.1-rc.1')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'pkg-a')
      mkdirSync(dir, { recursive: true })
      writeJson(join(dir, 'package.json'), {
        name: 'pkg-a',
        version: '1.0.1',
        engines: { dsh: '0.2.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', dshVersion: '0.2.1-rc.1' })
      const finding = report.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.severity).toBe('fatal')
      expect(finding?.message).toContain('engines.dsh')
      expect(finding?.message).toContain('requirements')
    } finally {
      fixture.dispose()
    }
  })

  it('ignores engines.dsh on dsh 0.2.1-alpha.3', async () => {
    const fixture = setup('0.2.1-alpha.3')
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      const dir = join(fixture.paths.profileDir, 'node_modules', 'pkg-a')
      mkdirSync(dir, { recursive: true })
      writeJson(join(dir, 'package.json'), {
        name: 'pkg-a',
        version: '1.0.1',
        engines: { dsh: '>=9.0.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', dshVersion: '0.2.1-alpha.3' })
      expect(report.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})