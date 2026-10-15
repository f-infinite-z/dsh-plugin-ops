import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The global setup stubs the CLI anchor to null for deterministic fixture
// homes; this file exercises the real PATH probe.
vi.unmock('../src/cli-anchor.js')

import { locateCliInstallAnchor, resetCliAnchorCache } from '../src/cli-anchor.js'
import { locateInstallAnchor } from '../src/index.js'
import { makeHome, writeJson } from './helpers.js'

const SHIM_NAME = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
const MANIFEST = join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

const originalPath = process.env.PATH

function usePath(dir: string): void {
  process.env.PATH = dir
  resetCliAnchorCache()
}

afterEach(() => {
  process.env.PATH = originalPath
  resetCliAnchorCache()
})

describe('cli-anchor: locateCliInstallAnchor', () => {
  it('finds the installation beside the shim (npm prefix layout)', () => {
    const fixture = makeHome()
    try {
      const prefix = join(fixture.home, 'prefix')
      const bin = join(prefix, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, SHIM_NAME), shimText('shim-relative'), 'utf8')
      writeJson(join(prefix, MANIFEST), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' })
      usePath(bin)
      expect(locateCliInstallAnchor()).toBe(join(prefix, MANIFEST))
    } finally {
      fixture.dispose()
    }
  })

  it('finds the installation one level above a .bin shim (npx layout)', () => {
    const fixture = makeHome()
    try {
      const ghost = join(fixture.home, 'npm-cache', '_npx', '12345678')
      const bin = join(ghost, 'node_modules', '.bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, SHIM_NAME), shimText('shim-relative'), 'utf8')
      writeJson(join(ghost, MANIFEST), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' })
      usePath(bin)
      expect(locateCliInstallAnchor()).toBe(join(ghost, MANIFEST))
    } finally {
      fixture.dispose()
    }
  })

  it('falls back to the shim text for an absolute target outside the ancestor chain', () => {
    const fixture = makeHome()
    try {
      const bin = join(fixture.home, 'a', 'b', 'c', 'd', 'e', 'f', 'bin')
      const target = join(fixture.home, 'store', 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, SHIM_NAME), shimText(join(target, 'lib', 'bin.js')), 'utf8')
      writeJson(join(target, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' })
      usePath(bin)
      expect(locateCliInstallAnchor()).toBe(join(target, 'package.json'))
    } finally {
      fixture.dispose()
    }
  })

  it('rebases a self-relative shim reference at the shim directory', () => {
    const fixture = makeHome()
    try {
      const bin = join(fixture.home, 'loose', 'bin')
      const target = join(bin, 'store', 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, SHIM_NAME), shimText('self-relative'), 'utf8')
      writeJson(join(target, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' })
      usePath(bin)
      expect(locateCliInstallAnchor()).toBe(join(target, 'package.json'))
    } finally {
      fixture.dispose()
    }
  })

  it('skips an unresolvable shim and continues through PATH order', () => {
    const fixture = makeHome()
    try {
      const first = join(fixture.home, 'first')
      const second = join(fixture.home, 'second')
      mkdirSync(first, { recursive: true })
      mkdirSync(second, { recursive: true })
      writeFileSync(join(first, SHIM_NAME), '@ECHO off\necho nothing to see\n', 'utf8')
      writeFileSync(join(second, SHIM_NAME), shimText('shim-relative'), 'utf8')
      writeJson(join(second, MANIFEST), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' })
      usePath(`${first}${process.platform === 'win32' ? ';' : ':'}${second}`)
      expect(locateCliInstallAnchor()).toBe(join(second, MANIFEST))
    } finally {
      fixture.dispose()
    }
  })

  it('returns null when no PATH entry carries a resolvable shim', () => {
    const fixture = makeHome()
    try {
      const empty = join(fixture.home, 'empty')
      mkdirSync(empty, { recursive: true })
      usePath(empty)
      expect(locateCliInstallAnchor()).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})

describe('cli-anchor: locateInstallAnchor (CLI first, mirror fallback)', () => {
  it('prefers the PATH installation over a legacy shared-mirror copy', () => {
    const fixture = makeHome()
    try {
      writeJson(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'), {
        name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2',
      })
      const bin = join(fixture.home, 'prefix', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, SHIM_NAME), shimText('shim-relative'), 'utf8')
      writeJson(join(fixture.home, 'prefix', MANIFEST), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.3' })
      usePath(bin)
      expect(locateInstallAnchor(fixture.paths)).toBe(join(fixture.home, 'prefix', MANIFEST))
    } finally {
      fixture.dispose()
    }
  })

  it('falls back to the shared mirror when PATH carries no installation', () => {
    const fixture = makeHome()
    try {
      writeJson(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'), {
        name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2',
      })
      const empty = join(fixture.home, 'empty')
      mkdirSync(empty, { recursive: true })
      usePath(empty)
      expect(locateInstallAnchor(fixture.paths)).toBe(join(fixture.paths.sharedProfilesDir, '@deepseek-ai', 'dsh', 'package.json'))
    } finally {
      fixture.dispose()
    }
  })
})

/** A shim whose text names the target the way npm-generated shims do. */
function shimText(kind: 'shim-relative' | 'self-relative' | string): string {
  if (kind === 'shim-relative') {
    return process.platform === 'win32'
      ? '@ECHO off\n"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\n'
      : '#!/bin/sh\n$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"\n'
  }
  if (kind === 'self-relative') {
    return process.platform === 'win32'
      ? '@ECHO off\n"%dp0%\\store\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\n'
      : '#!/bin/sh\n$basedir/store/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"\n'
  }
  return `#!/usr/bin/env node\nimport('${kind}')\n`
}
