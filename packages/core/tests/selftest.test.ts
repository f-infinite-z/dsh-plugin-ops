import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSelfTest, scanProfile } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile } from './helpers.js'

describe('engine selftest', () => {
  it('passes every built-in case with pinned release semantics (machine-independent)', async () => {
    const { results, ok } = await runSelfTest()
    expect(results.filter((r) => !r.ok).map((r) => r.caseName)).toEqual([])
    expect(results).toHaveLength(6)
    expect(ok).toBe(true)
  })

  it('the dshVersion override drives version-sensitive rule severity', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      writeLockfile(fixture.paths, {})
      writeFileSync(join(fixture.paths.profileDir, 'cordis.patch.yml'), '- insert:\n    - id: ghost-row\n      name: ghost-package\n', 'utf8')

      const strict = await scanProfile({ paths: fixture.paths, profileName: 'web', dshVersion: '0.1.6-alpha.2' })
      expect(strict.findings.find((f) => f.ruleId === 'patch-resolution')?.severity).toBe('fatal')

      const tolerant = await scanProfile({ paths: fixture.paths, profileName: 'web', dshVersion: '0.1.7-rc.2' })
      expect(tolerant.findings.find((f) => f.ruleId === 'patch-resolution')?.severity).toBe('warn')
    } finally {
      fixture.dispose()
    }
  })
})
