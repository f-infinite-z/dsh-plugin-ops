import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isRetiredBundle, scanProfile } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile, writeJson, type HomeFixture } from './helpers.js'

const RETIRED = '@deepseek-ai/dsh-experimental-schedule-bundle'

/** Write the dsh installation anchor (the shared closure's @deepseek-ai/dsh link). */
function writeDshInstall(fixture: HomeFixture, version: string): void {
  writeJson(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
  })
}

/** A profile that still lists the retired bundle (the pre-upgrade shape). */
async function scanWithRetired(fixture: HomeFixture) {
  writeProfile(fixture.paths, { dependencies: {}, bundles: [RETIRED] })
  writeLockfile(fixture.paths, {})
  return scanProfile({ paths: fixture.paths, profileName: 'web' })
}

describe('retired bundles (0.2.1-alpha.1+)', () => {
  it('gates the retirement on the launcher version', () => {
    expect(isRetiredBundle(RETIRED, '0.2.1-alpha.1')).toBe(true)
    expect(isRetiredBundle(RETIRED, '0.2.1')).toBe(true)
    expect(isRetiredBundle(RETIRED, '0.2.0-rc.2')).toBe(false)
    expect(isRetiredBundle(RETIRED, null)).toBe(false)
    expect(isRetiredBundle(RETIRED, 'not-a-version')).toBe(false)
    expect(isRetiredBundle('@deepseek-ai/dsh-base', '0.2.1-alpha.1')).toBe(false)
  })

  it('downgrades the unresolvable retired bundle to info (the launcher self-heals)', async () => {
    const fixture = makeHome()
    try {
      writeDshInstall(fixture, '0.2.1-alpha.1')
      const report = await scanWithRetired(fixture)
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration')
      expect(finding?.severity).toBe('info')
      expect(finding?.packageName).toBe(RETIRED)
      expect(finding?.message).toContain('retired upstream')
      expect(finding?.detail).toContain('dsh.profile.bundles')
      expect(report.findings.some((f) => f.severity === 'fatal')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('keeps the fatal before the retiring release', async () => {
    const fixture = makeHome()
    try {
      writeDshInstall(fixture, '0.2.0-rc.2')
      const report = await scanWithRetired(fixture)
      const finding = report.findings.find((f) => f.ruleId === 'bundle-declaration')
      expect(finding?.severity).toBe('fatal')
    } finally {
      fixture.dispose()
    }
  })
})
