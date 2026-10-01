import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDesktopProfile, readDesktopVersion, detectDesktopInstall, detectDesktop, resolveDesktopCliLauncher, desktopCliSupportsPluginManagement } from '../src/index.js'
import { writeJson } from './helpers.js'

afterEach(() => { vi.unstubAllEnvs() })

function desktopResources(dir: string): string {
  return process.platform === 'darwin' ? join(dir, 'Contents', 'Resources') : join(dir, 'resources')
}

function writeDesktopInstall(dir: string, version: string): void {
  const resources = desktopResources(dir)
  mkdirSync(join(resources, 'runtime', 'primary-runtime'), { recursive: true })
  writeFileSync(join(resources, 'app.asar'), 'asar', 'utf8')
  writeJson(join(resources, 'runtime', 'primary-runtime', 'runtime.json'), { desktopVersion: version })
}

describe('desktop profile detection', () => {
  it('identifies the desktop profile name', () => {
    expect(isDesktopProfile('desktop')).toBe(true)
    expect(isDesktopProfile('web')).toBe(false)
    expect(isDesktopProfile('headless')).toBe(false)
  })

  it('reads the release version from the primary-runtime manifest', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    try {
      const dir = join(tmp, 'DeepSeek Harness')
      writeDesktopInstall(dir, '0.2.0-rc.2')
      expect(readDesktopVersion(dir)).toBe('0.2.0-rc.2')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns null when the runtime manifest is absent or lacks desktopVersion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    try {
      expect(readDesktopVersion(join(tmp, 'nothing'))).toBe(null)
      const dir = join(tmp, 'DeepSeek Harness')
      writeDesktopInstall(dir, '0.2.0-rc.2')
      writeJson(join(desktopResources(dir), 'runtime', 'primary-runtime', 'runtime.json'), { platform: 'win32' })
      expect(readDesktopVersion(dir)).toBe(null)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('locates a desktop install under LOCALAPPDATA on Windows', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    const programs = join(tmp, 'Programs')
    const installDir = join(programs, 'DeepSeek Harness')
    writeDesktopInstall(installDir, '0.2.0-rc.2')
    const emptyProgramFiles = join(tmp, 'no-program-files')
    vi.stubEnv('LOCALAPPDATA', tmp)
    vi.stubEnv('PROGRAMFILES', emptyProgramFiles)
    try {
      expect(detectDesktopInstall()).toBe(installDir)
      expect(detectDesktop()).toEqual({ installDir, version: '0.2.0-rc.2' })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns null when no desktop install exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    vi.stubEnv('LOCALAPPDATA', join(empty, 'none'))
    vi.stubEnv('PROGRAMFILES', join(empty, 'none-pf'))
    try {
      expect(detectDesktop()).toEqual({ installDir: null, version: null })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('desktop bundled CLI', () => {
  it('resolves the launcher only when the installation ships one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    try {
      const dir = join(tmp, 'DeepSeek Harness')
      expect(resolveDesktopCliLauncher(dir)).toBe(null)
      const binDir = join(desktopResources(dir), 'runtime', 'cli', 'bin')
      mkdirSync(binDir, { recursive: true })
      const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
      writeFileSync(join(binDir, name), 'launcher', 'utf8')
      expect(resolveDesktopCliLauncher(dir)).toBe(join(binDir, name))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('gates plugin management on the desktop release version', () => {
    expect(desktopCliSupportsPluginManagement('0.2.0-rc.1')).toBe(true)
    expect(desktopCliSupportsPluginManagement('0.2.0-rc.2')).toBe(true)
    expect(desktopCliSupportsPluginManagement('0.2.0')).toBe(true)
    expect(desktopCliSupportsPluginManagement('0.1.7-rc.2')).toBe(false)
    expect(desktopCliSupportsPluginManagement(null)).toBe(false)
    expect(desktopCliSupportsPluginManagement('not-a-version')).toBe(false)
  })
})
