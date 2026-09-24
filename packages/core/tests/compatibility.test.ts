import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile } from '../src/index.js'
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
