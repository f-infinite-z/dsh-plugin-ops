import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfile, resetCliAnchorCache } from '../src/index.js'
import { makeHome, writeProfile, writeJson, type HomeFixture } from './helpers.js'

const originalPath = process.env.PATH

// The rule also scans the installation behind the first `dsh` on PATH; pin
// PATH to an empty string so tests never walk the host machine's real
// installation tree.
beforeEach(() => {
  process.env.PATH = ''
  resetCliAnchorCache()
})

afterEach(() => {
  process.env.PATH = originalPath
  resetCliAnchorCache()
})

/**
 * Write a minimal dsh installation tree and return its anchor package.json
 * path. `copies` are package manifests at paths relative to the tree root.
 */
function writeInstallTree(fixture: HomeFixture, copies: { rel: string[]; name: string; version: string }[]): string {
  const installDir = join(fixture.home, 'install')
  const anchor = join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  writeJson(anchor, { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' })
  for (const copy of copies) {
    writeJson(join(installDir, 'node_modules', ...copy.rel, 'package.json'), { name: copy.name, version: copy.version })
  }
  return anchor
}

async function scan(fixture: HomeFixture, anchor: string) {
  return scanProfile({
    paths: fixture.paths,
    profileName: 'web',
    updateCheck: false,
    dshVersion: null,
    config: { installAnchor: anchor },
  })
}

describe('rule 10: duplicate physical copies', () => {
  it('reports an official package with same-version copies in the install tree', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const anchor = writeInstallTree(fixture, [
        { rel: ['@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '1.0.0' },
        { rel: ['@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '1.0.0' },
      ])
      const report = await scan(fixture, anchor)
      const finding = report.findings.find((f) => f.ruleId === 'duplicate-copies')
      expect(finding).toBeDefined()
      expect(finding?.severity).toBe('warn')
      expect(finding?.message).toContain('2 physical copies of @deepseek-ai/dsh-win32-process@1.0.0 exist in one install tree')
      expect(finding?.nextAction).toBe('reinstall-tree')
    } finally {
      fixture.dispose()
    }
  })

  it('escalates framework core duplicates to fatal', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const anchor = writeInstallTree(fixture, [
        { rel: ['cordis'], name: 'cordis', version: '4.0.2' },
        { rel: ['@deepseek-ai', 'dsh-base', 'node_modules', 'cordis'], name: 'cordis', version: '4.0.2' },
      ])
      const report = await scan(fixture, anchor)
      const finding = report.findings.find((f) => f.ruleId === 'duplicate-copies')
      expect(finding?.severity).toBe('fatal')
    } finally {
      fixture.dispose()
    }
  })

  it('keeps different-version copies silent (normal nested resolution)', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const anchor = writeInstallTree(fixture, [
        { rel: ['@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '1.0.0' },
        { rel: ['@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '2.0.0' },
      ])
      const report = await scan(fixture, anchor)
      expect(report.findings.some((f) => f.ruleId === 'duplicate-copies')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('does not report ordinary third-party duplicates', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const anchor = writeInstallTree(fixture, [
        { rel: ['lodash'], name: 'lodash', version: '4.17.21' },
        { rel: ['some-pkg', 'node_modules', 'lodash'], name: 'lodash', version: '4.17.21' },
      ])
      const report = await scan(fixture, anchor)
      expect(report.findings.some((f) => f.ruleId === 'duplicate-copies')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('does not report copies in different trees (profile vs installation)', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const anchor = writeInstallTree(fixture, [
        { rel: ['@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '1.0.0' },
      ])
      // The profile's own tree carries a same-version copy of the same package.
      writeJson(join(fixture.paths.profileDir, 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'package.json'), {
        name: '@deepseek-ai/dsh-win32-process',
        version: '1.0.0',
      })
      const report = await scan(fixture, anchor)
      expect(report.findings.some((f) => f.ruleId === 'duplicate-copies')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })

  it('deduplicates a package reached through a symlink (one physical copy)', async () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const installDir = join(fixture.home, 'install')
      const anchor = writeInstallTree(fixture, [
        { rel: ['@deepseek-ai', 'dsh-win32-process'], name: '@deepseek-ai/dsh-win32-process', version: '1.0.0' },
      ])
      const realDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-win32-process')
      const linkDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-win32-process-alias')
      symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
      const report = await scan(fixture, anchor)
      expect(report.findings.some((f) => f.ruleId === 'duplicate-copies')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})
