import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handlePanelApi } from '../src/index.js'
import { makeHome, writeProfile, writeLockfile, writeJson } from './helpers.js'

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

describe('panel api: scan version view', () => {
  it('scans under the all view by default and exposes versionNote', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const res = await handlePanelApi('GET', new URL('http://127.0.0.1:8912/api/scan?profile=web'), { paths: fixture.paths, config: {} })
      expect(res.status).toBe(200)
      const body = res.body as { findings: { ruleId: string; versionNote?: string }[] }
      const finding = body.findings.find((f) => f.ruleId === 'plugin-compatibility')
      expect(finding?.versionNote).toContain('rejected by')
      expect(finding?.versionNote).toContain('accepted by')
    } finally {
      fixture.dispose()
    }
  })

  it('honors a configured latest view (no gap finding for a newest-compatible range)', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', '^0.2.0')
      writeLockfile(fixture.paths, { 'pkg-a': '1.0.1' })
      const res = await handlePanelApi('GET', new URL('http://127.0.0.1:8912/api/scan?profile=web'), { paths: fixture.paths, config: { versionView: 'latest' } })
      expect(res.status).toBe(200)
      const body = res.body as { findings: { ruleId: string; versionNote?: string }[] }
      expect(body.findings.some((f) => f.ruleId === 'plugin-compatibility')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})
