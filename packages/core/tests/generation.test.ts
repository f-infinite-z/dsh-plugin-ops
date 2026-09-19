import { describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildResolutionGeneration,
  locateInstallAnchor,
  resolvePackageDir,
  resolveBundles,
  readProfileManifest,
} from '../src/index.js'
import { makeHome, writeProfile, writeJson } from './helpers.js'

function installFixture() {
  const fixture = makeHome()
  const installRoot = join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh')
  writeJson(join(installRoot, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.1.6-alpha.2',
    dependencies: { '@deepseek-ai/dsh-web-app': '0.1.6-alpha.2' },
    peerDependencies: { '@deepseek-ai/dsh-subprocess': '0.1.6-alpha.2' },
  })
  const nested = join(installRoot, 'node_modules', '@deepseek-ai')
  writeJson(join(nested, 'dsh-web-app', 'package.json'), {
    name: '@deepseek-ai/dsh-web-app',
    version: '0.1.6-alpha.2',
    dependencies: { '@deepseek-ai/dsh-client-ui': '0.1.6-alpha.2' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  })
  writeFileSync(join(nested, 'dsh-web-app', 'cordis.patch.yml'), '- id: probe\n', 'utf8')
  writeJson(join(nested, 'dsh-client-ui', 'package.json'), {
    name: '@deepseek-ai/dsh-client-ui',
    version: '0.1.6-alpha.2',
  })
  writeJson(join(nested, 'dsh-subprocess', 'package.json'), {
    name: '@deepseek-ai/dsh-subprocess',
    version: '0.1.6-alpha.2',
  })
  return { fixture, nested }
}

describe('generation: install anchor location', () => {
  it('locates the installation manifest through the shared mirror link', () => {
    const { fixture } = installFixture()
    try {
      const anchor = locateInstallAnchor(fixture.paths, null)
      expect(anchor).toBe(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'))
    } finally {
      fixture.dispose()
    }
  })

  it('prefers an explicit configured anchor', () => {
    const { fixture } = installFixture()
    try {
      const explicit = join(fixture.home, 'custom-install')
      writeJson(join(explicit, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2' })
      expect(locateInstallAnchor(fixture.paths, explicit)).toBe(join(explicit, 'package.json'))
    } finally {
      fixture.dispose()
    }
  })

  it('returns null when no installation is locatable', () => {
    const fixture = makeHome()
    try {
      expect(locateInstallAnchor(fixture.paths, null)).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})

describe('generation: closure construction', () => {
  it('walks dependencies and peers breadth-first from the installation manifest', () => {
    const { fixture } = installFixture()
    try {
      const anchor = locateInstallAnchor(fixture.paths, null)
      const generation = buildResolutionGeneration(anchor, [], fixture.paths.profileDir)
      expect([...generation.entries.keys()].sort()).toEqual([
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-client-ui',
        '@deepseek-ai/dsh-subprocess',
        '@deepseek-ai/dsh-web-app',
      ])
      expect(generation.entries.get('@deepseek-ai/dsh-client-ui')?.scope).toBe('installation')
    } finally {
      fixture.dispose()
    }
  })

  it('skips declared-but-uninstalled packages instead of failing', () => {
    const { fixture } = installFixture()
    try {
      const installRoot = join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh')
      writeJson(join(installRoot, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '0.1.6-alpha.2',
        dependencies: { '@deepseek-ai/ghost': '0.1.6-alpha.2' },
      })
      const generation = buildResolutionGeneration(join(installRoot, 'package.json'), [], fixture.paths.profileDir)
      expect(generation.entries.has('@deepseek-ai/ghost')).toBe(false)
      expect(generation.entries.has('@deepseek-ai/dsh')).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('keeps an installation-closure bundle root in the table and records every bundle root', () => {
    const { fixture } = installFixture()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-web-app'] })
      const manifest = readProfileManifest(fixture.paths.profileManifest)!
      const anchor = locateInstallAnchor(fixture.paths, null)
      const { resolved } = resolveBundles(fixture.paths, manifest, anchor)
      const generation = buildResolutionGeneration(anchor, resolved, fixture.paths.profileDir)
      // dsh-web-app is also a dsh dependency, so the installation closure owns
      // it; the profile-bundle half must not delete that entry.
      expect(generation.entries.has('@deepseek-ai/dsh-web-app')).toBe(true)
      expect(generation.entries.has('@deepseek-ai/dsh-client-ui')).toBe(true)
      expect(generation.bundleRoots.get('@deepseek-ai/dsh-web-app')).toBe(resolved[0]!.dir)
    } finally {
      fixture.dispose()
    }
  })

  it('removes a profile-only bundle root from fallback entries but keeps it resolvable as a bundle', () => {
    const { fixture } = installFixture()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-web-app', 'third-party-bundle'] })
      writeJson(join(fixture.paths.profileDir, 'node_modules', 'third-party-bundle', 'package.json'), {
        name: 'third-party-bundle',
        version: '1.0.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      })
      const manifest = readProfileManifest(fixture.paths.profileManifest)!
      const anchor = locateInstallAnchor(fixture.paths, null)
      const { resolved } = resolveBundles(fixture.paths, manifest, anchor)
      const generation = buildResolutionGeneration(anchor, resolved, fixture.paths.profileDir)
      expect(generation.entries.has('third-party-bundle')).toBe(false)
      expect(generation.bundleRoots.get('third-party-bundle')).toBeDefined()
      const resolvedPackage = resolvePackageDir(generation, fixture.paths, 'third-party-bundle')
      expect(resolvedPackage?.source).toBe('bundle')
    } finally {
      fixture.dispose()
    }
  })

  it('resolves a bundle root through the installation anchor, not the generation table', () => {
    const { fixture } = installFixture()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: ['@deepseek-ai/dsh-web-app'] })
      const manifest = readProfileManifest(fixture.paths.profileManifest)!
      const anchor = locateInstallAnchor(fixture.paths, null)
      const { resolved } = resolveBundles(fixture.paths, manifest, anchor)
      const generation = buildResolutionGeneration(anchor, resolved, fixture.paths.profileDir)
      const resolvedPackage = resolvePackageDir(generation, fixture.paths, '@deepseek-ai/dsh-web-app')
      expect(resolvedPackage?.source).toBe('bundle')
      expect(resolvedPackage?.dir).toBe(resolved[0]!.dir)
    } finally {
      fixture.dispose()
    }
  })
})

describe('generation: runtime resolution order', () => {
  it('lets a profile-local package win over the generation table', () => {
    const { fixture } = installFixture()
    try {
      const localDir = join(fixture.paths.profileDir, 'node_modules', '@deepseek-ai', 'dsh-subprocess')
      writeJson(join(localDir, 'package.json'), { name: '@deepseek-ai/dsh-subprocess', version: '9.9.9' })
      const anchor = locateInstallAnchor(fixture.paths, null)
      const generation = buildResolutionGeneration(anchor, [], fixture.paths.profileDir)
      const resolved = resolvePackageDir(generation, fixture.paths, '@deepseek-ai/dsh-subprocess')
      expect(resolved?.source).toBe('profile-local')
      expect(resolved?.dir).toBe(localDir)
    } finally {
      fixture.dispose()
    }
  })

  it('falls back to the generation table when the profile tree does not own the name', () => {
    const { fixture } = installFixture()
    try {
      const anchor = locateInstallAnchor(fixture.paths, null)
      const generation = buildResolutionGeneration(anchor, [], fixture.paths.profileDir)
      const resolved = resolvePackageDir(generation, fixture.paths, '@deepseek-ai/dsh-subprocess')
      expect(resolved?.source).toBe('generation')
    } finally {
      fixture.dispose()
    }
  })

  it('does not let a fallback projection claim local precedence', () => {
    const fixture = makeHome()
    try {
      writeProfile(fixture.paths, { dependencies: {}, bundles: [] })
      const owned = join(fixture.paths.profileDir, '.dsh-module-fallback', 'node_modules', 'ghost-local')
      writeJson(join(owned, 'package.json'), { name: 'ghost-local', version: '9.9.9' })
      mkdirSync(join(fixture.paths.profileDir, 'node_modules'), { recursive: true })
      symlinkSync(owned, join(fixture.paths.profileDir, 'node_modules', 'ghost-local'), 'junction')
      const generation = buildResolutionGeneration(null, [], fixture.paths.profileDir)
      expect(resolvePackageDir(generation, fixture.paths, 'ghost-local')).toBeNull()
    } finally {
      fixture.dispose()
    }
  })

  it('returns null when neither the profile nor the generation owns the name', () => {
    const { fixture } = installFixture()
    try {
      const anchor = locateInstallAnchor(fixture.paths, null)
      const generation = buildResolutionGeneration(anchor, [], fixture.paths.profileDir)
      expect(resolvePackageDir(generation, fixture.paths, 'ghost-package')).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})
