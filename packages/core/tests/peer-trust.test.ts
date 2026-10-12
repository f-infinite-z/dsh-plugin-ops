import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scanProfile } from '../src/index.js'
import { makeHome, writeProfile, writeJson } from './helpers.js'

// Pin the fallback anchor lookup to "nothing found" so the closure-unknown
// path is exercised deterministically (CI runners carry no global dsh).
vi.mock('../src/cli-anchor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli-anchor.js')>()
  return { ...actual, locateCliInstallAnchor: () => null }
})

/** Install one bundle whose manifest carries the given peers and optional dsh extras. */
function writeBundle(
  paths: ReturnType<typeof makeHome>['paths'],
  name: string,
  peers: Record<string, string>,
  dshExtra: Record<string, unknown> = {},
  peerMeta?: Record<string, unknown>,
): void {
  const dir = join(paths.profileDir, 'node_modules', name)
  writeJson(join(dir, 'package.json'), {
    name,
    version: '1.0.0',
    type: 'module',
    main: 'lib/index.js',
    peerDependencies: peers,
    ...(peerMeta === undefined ? {} : { peerDependenciesMeta: peerMeta }),
    dsh: { bundle: { patch: 'cordis.patch.yml' }, ...dshExtra },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe\n', 'utf8')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), `export const name = ${JSON.stringify(name)}\n`, 'utf8')
}

describe('peer-gap trust and exemptions', () => {
  it('degrades to an info instead of judging official peers when the installation is not located', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'plug-a': '1.0.0' }, bundles: ['plug-a'] })
      writeBundle(fixture.paths, 'plug-a', { '@deepseek-ai/dsh-settings': '0.2.0-rc.2' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const gapFindings = report.findings.filter((f) => f.ruleId === 'peer-gap')
      expect(gapFindings.filter((f) => f.severity === 'warn')).toHaveLength(0)
      expect(gapFindings.some((f) => f.severity === 'info' && f.message.includes('could not be located'))).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('still reports a non-official unreachable peer when the installation is not located', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'plug-b': '1.0.0' }, bundles: ['plug-b'] })
      writeBundle(fixture.paths, 'plug-b', { 'some-missing-peer': '^1.0.0' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')
      expect(finding?.message).toContain('some-missing-peer')
    } finally {
      fixture.dispose()
    }
  })

  it('exempts shell-seeded react for a bundle with a client half', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'client-plug': '1.0.0' }, bundles: ['client-plug'] })
      writeBundle(fixture.paths, 'client-plug', { react: '^18.2.0', 'react-dom': '^18.2.0' }, { client: { platform: 'web' } })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(report.findings.some((f) => f.ruleId === 'peer-gap' && (f.severity === 'warn' || f.severity === 'fatal'))).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('exempts a peer the bundle itself injects into its client half, without exempting the rest', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'inject-plug': '1.0.0' }, bundles: ['inject-plug'] })
      writeBundle(
        fixture.paths,
        'inject-plug',
        { '@deepseek-ai/dsh-client-runtime': '^0.1.0-rc.6', 'some-host-peer': '^1.0.0' },
        { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] } },
      )
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const gaps = report.findings.filter((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')
      expect(gaps.some((f) => f.message.includes('dsh-client-runtime'))).toBe(false)
      expect(gaps.some((f) => f.message.includes('some-host-peer'))).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('exempts an absent peer marked optional in peerDependenciesMeta', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'opt-plug': '1.0.0' }, bundles: ['opt-plug'] })
      writeBundle(fixture.paths, 'opt-plug', { 'some-optional-peer': '^1.0.0' }, {}, { 'some-optional-peer': { optional: true } })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      expect(report.findings.some((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('still reports an absent peer without the optional marking', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'req-plug': '1.0.0' }, bundles: ['req-plug'] })
      writeBundle(fixture.paths, 'req-plug', { 'some-optional-peer': '^1.0.0' }, {}, { 'some-optional-peer': {} })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')
      expect(finding?.message).toContain('some-optional-peer')
    } finally {
      fixture.dispose()
    }
  })

  it('still reports react for a host-only bundle without a client half', async () => {
    const fixture = makeHome('web')
    try {
      writeProfile(fixture.paths, { dependencies: { 'host-plug': '1.0.0' }, bundles: ['host-plug'] })
      writeBundle(fixture.paths, 'host-plug', { react: '^18.2.0' })
      const report = await scanProfile({ paths: fixture.paths, profileName: 'web', updateCheck: false })
      const finding = report.findings.find((f) => f.ruleId === 'peer-gap' && f.severity === 'warn')
      expect(finding?.message).toContain('react')
    } finally {
      fixture.dispose()
    }
  })
})
