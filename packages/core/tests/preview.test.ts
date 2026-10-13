import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPreviewReport,
  renderPreviewMatrix,
  renderPreviewReport,
  LATEST_KNOWN_VERSION,
  PreviewError,
} from '../src/index.js'
import { makeHome, writeProfile, writeJson, type HomeFixture } from './helpers.js'

/** Write one profile-local bundle with dsh peer ranges. */
function writeBundle(fixture: HomeFixture, name: string, version: string, peers: Record<string, string>): void {
  const dir = join(fixture.paths.profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), {
    name,
    version,
    peerDependencies: peers,
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: probe\n      name: ${name}\n`, 'utf8')
}

/** Stub global fetch with a URL-substring dispatch over registry documents. */
function stubRegistryFetch(routes: [string, unknown][]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    for (const [key, document] of routes) {
      if (url.includes(key)) return { ok: true, json: async () => document }
    }
    return { ok: false, json: async () => ({}) }
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preview: verdicts', () => {
  it('reports a skipped bundle with an exemption command and no network', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: '0.1.7-rc.2' })
      expect(report.target).toEqual({ version: LATEST_KNOWN_VERSION, source: 'table-latest' })
      expect(report.runningVersion).toBe('0.1.7-rc.2')
      expect(report.counts.skipped).toBe(1)
      expect(report.counts.exempt).toBe(1)
      const entry = report.entries[0]!
      expect(entry.verdict).toBe('skipped')
      expect(entry.fix).toBe('exempt')
      expect(entry.risk).toBe('cross-major')
      expect(entry.commands).toEqual([
        `dsh plugin --profile web allow-version pkg-a@1.0.1 --dsh-version ${LATEST_KNOWN_VERSION} --accept-risk`,
      ])
      expect(renderPreviewReport(report)).toContain('1 plugin(s) would be skipped')
    } finally {
      fixture.dispose()
    }
  })

  it('accepts a peer range covering the newest release', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '>=0.1.5-rc.2' })
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: null })
      expect(report.counts.compatible).toBe(1)
      expect(report.entries[0]!.verdict).toBe('compatible')
      expect(report.entries[0]!.fix).toBe('none')
    } finally {
      fixture.dispose()
    }
  })

  it('never evaluates official bundles but reports retired ones', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, {
        dependencies: { '@deepseek-ai/dsh-fake': '^1.0.0', '@deepseek-ai/dsh-experimental-schedule-bundle': '^1.0.0' },
        bundles: ['@deepseek-ai/dsh-fake', '@deepseek-ai/dsh-experimental-schedule-bundle'],
      })
      writeBundle(fixture, '@deepseek-ai/dsh-fake', '1.0.1', { '@deepseek-ai/dsh-client-runtime': '^0.1.0' })
      writeBundle(fixture, '@deepseek-ai/dsh-experimental-schedule-bundle', '1.0.0', {})
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: null })
      expect(report.entries.map((entry) => entry.name)).toEqual(['@deepseek-ai/dsh-experimental-schedule-bundle'])
      expect(report.entries[0]!.verdict).toBe('retired')
      expect(report.counts.compatible).toBe(0)
    } finally {
      fixture.dispose()
    }
  })

  it('treats an active exemption covering the target as exempted', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      writeJson(join(fixture.paths.profileDir, 'compatibility.json'), { 'pkg-a@1.0.1': [LATEST_KNOWN_VERSION] })
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: null })
      expect(report.counts.exempted).toBe(1)
      expect(report.entries[0]!.verdict).toBe('exempted')
    } finally {
      fixture.dispose()
    }
  })

  it('reports an unresolvable bundle as unresolved', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'ghost-pkg': '^1.0.0' }, bundles: ['ghost-pkg'] })
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: null })
      expect(report.counts.unresolved).toBe(1)
      expect(report.entries[0]!.verdict).toBe('unresolved')
    } finally {
      fixture.dispose()
    }
  })
})

describe('preview: target resolution', () => {
  it('judges against an explicit target release', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '>=0.2.1-alpha.1' })
      const old = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', target: '0.2.0-rc.2', dshVersion: null })
      expect(old.target).toEqual({ version: '0.2.0-rc.2', source: 'explicit' })
      expect(old.counts.skipped).toBe(1)
      const next = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', target: '0.2.1-alpha.2', dshVersion: null })
      expect(next.counts.compatible).toBe(1)
    } finally {
      fixture.dispose()
    }
  })

  it('rejects an invalid target', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      await expect(buildPreviewReport({ paths: fixture.paths, profileName: 'web', target: 'not-a-version' }))
        .rejects.toBeInstanceOf(PreviewError)
    } finally {
      fixture.dispose()
    }
  })
})

describe('preview: update check', () => {
  it('resolves the target from the registry and recommends a compatible update', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      stubRegistryFetch([
        ['@deepseek-ai%2Fdsh', { 'dist-tags': { latest: '0.2.1-alpha.2' } }],
        ['/pkg-a', { 'dist-tags': { latest: '1.1.0' }, versions: { '1.1.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.1.5-rc.2' } } } }],
      ])
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', updateCheck: true, dshVersion: null })
      expect(report.target).toEqual({ version: '0.2.1-alpha.2', source: 'registry' })
      const entry = report.entries[0]!
      expect(entry.fix).toBe('update')
      expect(entry.latest).toBe('1.1.0')
      expect(entry.commands).toEqual(['dsh plugin --profile web add pkg-a@1.1.0'])
    } finally {
      fixture.dispose()
    }
  })

  it('falls back to an exemption when the newest release is still incompatible', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      stubRegistryFetch([
        ['@deepseek-ai%2Fdsh', { 'dist-tags': { latest: '0.2.1-alpha.2' } }],
        ['/pkg-a', { 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.1.5' } } } }],
      ])
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', updateCheck: true, dshVersion: null })
      const entry = report.entries[0]!
      expect(entry.fix).toBe('exempt')
      expect(entry.latestCompatible).toBe(false)
      expect(entry.detail).toContain('even the newest release 2.0.0 rejects')
      expect(entry.commands[0]).toContain('allow-version pkg-a@1.0.1')
    } finally {
      fixture.dispose()
    }
  })

  it('keeps the exemption advice when the registry cannot answer', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      stubRegistryFetch([])
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', updateCheck: true, dshVersion: null })
      expect(report.target.source).toBe('table-latest')
      expect(report.registry?.problem).toBeDefined()
      const entry = report.entries[0]!
      expect(entry.fix).toBe('exempt')
      expect(entry.detail).toContain('registry did not answer')
    } finally {
      fixture.dispose()
    }
  })
})

describe('preview: rendering', () => {
  it('renders a deterministic markdown matrix', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: { 'pkg-a': '^1.0.0' }, bundles: ['pkg-a'] })
      writeBundle(fixture, 'pkg-a', '1.0.1', { '@deepseek-ai/dsh': '^0.1.5' })
      const report = await buildPreviewReport({ paths: fixture.paths, profileName: 'web', dshVersion: null })
      const matrix = renderPreviewMatrix(report)
      expect(matrix).toContain('# Upgrade preview — profile `web`')
      expect(matrix).toContain(`- target: ${LATEST_KNOWN_VERSION} (newest known release)`)
      expect(matrix).toContain('| pkg-a | 1.0.1 | skipped |')
      expect(matrix).toContain('allow-version pkg-a@1.0.1')
    } finally {
      fixture.dispose()
    }
  })
})
