import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, writeVersionExemption, removeVersionExemption, removeExemptionsForPackage, readProfileVersionExemptions } from '../src/index.js'
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
