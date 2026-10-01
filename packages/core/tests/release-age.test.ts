import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile, type HomeFixture } from './helpers.js'

/** Write `pnpm-workspace.yaml` after the profile fixture established the directory. */
function writeWorkspace(fixture: HomeFixture, content: string): void {
  writeFileSync(join(fixture.paths.profileDir, 'pnpm-workspace.yaml'), content, 'utf8')
}

async function findingsWithWorkspace(fixture: HomeFixture, content: string) {
  writeProfile(fixture.paths, { dependencies: {} })
  writeLockfile(fixture.paths, {})
  writeWorkspace(fixture, content)
  const report = await scanProfile({ paths: fixture.paths, profileName: 'web' })
  return report.findings.filter((f) => f.ruleId === 'release-age-exclude')
}

describe('rule 9: minimumReleaseAgeExclude hygiene', () => {
  it('warns when one package has multiple versioned entries (the reproduced pnpm 11.7 deadlock)', async () => {
    const fixture = makeHome()
    try {
      const findings = await findingsWithWorkspace(fixture, [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        'minimumReleaseAgeExclude:',
        '  - dsh-plugin-ops-bundle@0.12.0',
        '  - dsh-plugin-ops-bundle@0.14.0',
        '',
      ].join('\n'))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.severity).toBe('warn')
      expect(findings[0]!.packageName).toBe('dsh-plugin-ops-bundle')
      expect(findings[0]!.message).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
      expect(findings[0]!.detail).toContain('"dsh-plugin-ops-bundle"')
      expect(findings[0]!.detail).toContain('minimumReleaseAge: 0')
      expect(findings[0]!.fix).toEqual({ kind: 'none' })
    } finally {
      fixture.dispose()
    }
  })

  it('resolves a scoped package name from its versioned entries', async () => {
    const fixture = makeHome()
    try {
      const findings = await findingsWithWorkspace(fixture, [
        'minimumReleaseAgeExclude:',
        '  - "@scope/plugin@1.0.0"',
        '  - "@scope/plugin@2.0.0"',
        '',
      ].join('\n'))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.packageName).toBe('@scope/plugin')
    } finally {
      fixture.dispose()
    }
  })

  it('is silent for bare package names, the durable fix (current real profiles)', async () => {
    const fixture = makeHome()
    try {
      const findings = await findingsWithWorkspace(fixture, [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        'minimumReleaseAgeExclude:',
        '  - dsh-plugin-ops-bundle',
        '  - dsh-plugin-ops-core',
        '',
      ].join('\n'))
      expect(findings).toHaveLength(0)
    } finally {
      fixture.dispose()
    }
  })

  it('is silent for a single versioned entry and for distinct packages with one entry each (reproduced as passing)', async () => {
    const single = makeHome()
    const distinct = makeHome()
    try {
      const singleFindings = await findingsWithWorkspace(single, [
        'minimumReleaseAgeExclude:',
        '  - fresh-plugin@1.0.0',
        '',
      ].join('\n'))
      expect(singleFindings).toHaveLength(0)

      const distinctFindings = await findingsWithWorkspace(distinct, [
        'minimumReleaseAgeExclude:',
        '  - plugin-a@1.0.0',
        '  - plugin-b@2.0.0',
        '',
      ].join('\n'))
      expect(distinctFindings).toHaveLength(0)
    } finally {
      single.dispose()
      distinct.dispose()
    }
  })

  it('skips the mixed bare plus versioned form (presumably safe, unverified)', async () => {
    const fixture = makeHome()
    try {
      const findings = await findingsWithWorkspace(fixture, [
        'minimumReleaseAgeExclude:',
        '  - plugin-a',
        '  - plugin-a@1.0.0',
        '',
      ].join('\n'))
      expect(findings).toHaveLength(0)
    } finally {
      fixture.dispose()
    }
  })

  it('skips when the policy is disabled with minimumReleaseAge: 0 (number or string)', async () => {
    const numeric = makeHome()
    const stringy = makeHome()
    try {
      const numericFindings = await findingsWithWorkspace(numeric, [
        'minimumReleaseAge: 0',
        'minimumReleaseAgeExclude:',
        '  - plugin-a@1.0.0',
        '  - plugin-a@2.0.0',
        '',
      ].join('\n'))
      expect(numericFindings).toHaveLength(0)

      const stringyFindings = await findingsWithWorkspace(stringy, [
        "minimumReleaseAge: '0'",
        'minimumReleaseAgeExclude:',
        '  - plugin-a@1.0.0',
        '  - plugin-a@2.0.0',
        '',
      ].join('\n'))
      expect(stringyFindings).toHaveLength(0)
    } finally {
      numeric.dispose()
      stringy.dispose()
    }
  })

  it('degrades silently on unreadable shapes: missing file, invalid YAML, non-array field', async () => {
    const missing = makeHome()
    const broken = makeHome()
    const weird = makeHome()
    try {
      writeProfile(missing.paths, { dependencies: {} })
      writeLockfile(missing.paths, {})
      const missingReport = await scanProfile({ paths: missing.paths, profileName: 'web' })
      expect(missingReport.findings.some((f) => f.ruleId === 'release-age-exclude')).toBe(false)

      const brokenFindings = await findingsWithWorkspace(broken, 'minimumReleaseAgeExclude: [unclosed\n')
      expect(brokenFindings).toHaveLength(0)

      const weirdFindings = await findingsWithWorkspace(weird, 'minimumReleaseAgeExclude: not-a-list\n')
      expect(weirdFindings).toHaveLength(0)
    } finally {
      missing.dispose()
      broken.dispose()
      weird.dispose()
    }
  })
})
