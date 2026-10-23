import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SandboxManager,
  desktopInstallFromEntry,
  packageNameFromSpec,
  pnpmInstallFlags,
  readPluginManagerLog,
  redactToken,
  resolveIdleTimeout,
  resolveInstallTimeout,
  resolveInstallTuning,
} from '../src/sandbox.js'

describe('packageNameFromSpec', () => {
  it('extracts the bare name from registry specs', () => {
    expect(packageNameFromSpec('dsh-whale-widget')).toBe('dsh-whale-widget')
    expect(packageNameFromSpec('dsh-whale-widget@0.4.2')).toBe('dsh-whale-widget')
    expect(packageNameFromSpec('@scope/name')).toBe('@scope/name')
    expect(packageNameFromSpec('@scope/name@^1.0.0')).toBe('@scope/name')
    expect(packageNameFromSpec('  @scope/name@1.0.0  ')).toBe('@scope/name')
  })

  it('rejects path-like and protocol targets that cannot be verified', () => {
    expect(packageNameFromSpec('./pkg')).toBeNull()
    expect(packageNameFromSpec('file:C:/x/pkg.tgz')).toBeNull()
    expect(packageNameFromSpec('https://x.example/pkg.tgz')).toBeNull()
    expect(packageNameFromSpec('C:\\x\\pkg')).toBeNull()
    expect(packageNameFromSpec('some/pkg.tgz')).toBeNull()
    expect(packageNameFromSpec('')).toBeNull()
    expect(packageNameFromSpec('@scope')).toBeNull()
  })
})

describe('redactToken', () => {
  it('masks the launch token while keeping the address readable', () => {
    expect(redactToken('dsh web: http://127.0.0.1:55984/?token=abcDEF-123_xyz&x=1'))
      .toBe('dsh web: http://127.0.0.1:55984/?token=***&x=1')
  })

  it('masks a token when it is the last parameter and leaves clean text alone', () => {
    expect(redactToken('http://127.0.0.1:1/?token=zzz')).toBe('http://127.0.0.1:1/?token=***')
    expect(redactToken('boot line without credentials')).toBe('boot line without credentials')
  })
})

describe('resolveInstallTimeout', () => {
  it('defaults to five minutes and clamps explicit values', () => {
    expect(resolveInstallTimeout()).toBe(300_000)
    expect(resolveInstallTimeout(Number.NaN)).toBe(300_000)
    expect(resolveInstallTimeout(2_000)).toBe(30_000)
    expect(resolveInstallTimeout(600_000)).toBe(600_000)
    expect(resolveInstallTimeout(9_999_999)).toBe(900_000)
  })
})

describe('resolveIdleTimeout', () => {
  it('defaults to two minutes and clamps explicit values', () => {
    expect(resolveIdleTimeout()).toBe(120_000)
    expect(resolveIdleTimeout(1_000)).toBe(30_000)
    expect(resolveIdleTimeout(300_000)).toBe(300_000)
    expect(resolveIdleTimeout(9_999_999)).toBe(600_000)
  })
})

describe('install tuning', () => {
  it('sends nothing unless the caller asks for it', () => {
    expect(pnpmInstallFlags(resolveInstallTuning({}))).toEqual([])
  })

  it('maps the opt-in fetch controls to pnpm flags and clamps them', () => {
    const tuning = resolveInstallTuning({
      fetchTimeoutMs: 15_000,
      fetchRetries: 1,
      networkConcurrency: 32,
      preferOffline: true,
    })
    expect(pnpmInstallFlags(tuning)).toEqual([
      '--fetch-timeout=15000',
      '--fetch-retries=1',
      '--network-concurrency=32',
      '--prefer-offline',
    ])
    expect(resolveInstallTuning({ fetchRetries: 99 }).fetchRetries).toBe(10)
    expect(resolveInstallTuning({ networkConcurrency: 0 }).networkConcurrency).toBe(1)
  })
})

describe('readPluginManagerLog', () => {
  it('returns the newest operation log and degrades without one', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ops-sandbox-test-'))
    try {
      const profileDir = join(home, 'profiles', 'web')
      const logs = join(profileDir, '.plugin-manager', 'logs')
      mkdirSync(join(logs, 'operation-old'), { recursive: true })
      mkdirSync(join(logs, 'operation-new'), { recursive: true })
      writeFileSync(join(logs, 'operation-old', 'pnpm.log'), 'old failure\n', 'utf8')
      writeFileSync(join(logs, 'operation-new', 'pnpm.log'), 'Command failed with exit code 1\n', 'utf8')
      utimesSync(join(logs, 'operation-old', 'pnpm.log'), new Date(1_000), new Date(1_000))
      utimesSync(join(logs, 'operation-new', 'pnpm.log'), new Date(2_000), new Date(2_000))
      const log = readPluginManagerLog(profileDir)
      expect(log?.file).toBe(join(logs, 'operation-new', 'pnpm.log'))
      expect(log?.text).toContain('Command failed with exit code 1')
      expect(readPluginManagerLog(join(home, 'profiles', 'desktop'))).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('desktopInstallFromEntry', () => {
  it('rejects missing or unrelated entries', () => {
    expect(desktopInstallFromEntry(undefined)).toBeNull()
    expect(desktopInstallFromEntry('')).toBeNull()
    expect(desktopInstallFromEntry('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBeNull()
  })

  if (process.platform === 'win32') {
    it('derives the install directory from the desktop executable', () => {
      expect(desktopInstallFromEntry('C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'))
        .toBe('C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness')
    })

    it('does not mistake a similarly named binary for the desktop app', () => {
      expect(desktopInstallFromEntry('C:\\tools\\DeepSeek Harness\\dsh.cmd')).toBeNull()
    })
  }

  if (process.platform === 'darwin') {
    it('derives the app bundle from the macOS executable', () => {
      expect(desktopInstallFromEntry('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'))
        .toBe('/Applications/DeepSeek Harness.app')
    })
  }

  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    it('has no desktop host shape on other platforms', () => {
      expect(desktopInstallFromEntry('/opt/deepseek/DeepSeek Harness.exe')).toBeNull()
    })
  }
})

describe('SandboxManager shapes', () => {
  it('defaults to the web shape', () => {
    const status = new SandboxManager().status()
    expect(status.kind).toBe('web')
    expect(status.state).toBe('stopped')
    expect(status.home).toBeNull()
  })

  it('runs the desktop shape when constructed for it', () => {
    expect(new SandboxManager({ kind: 'desktop' }).status().kind).toBe('desktop')
  })

  it('reports no scan without a home in either shape', async () => {
    expect(await new SandboxManager().scan()).toBeNull()
    expect(await new SandboxManager({ kind: 'desktop' }).scan()).toBeNull()
  })

  it('rejects fixes without a home in either shape', async () => {
    const web = await new SandboxManager().fix(['some-row'])
    expect(web.applied[0]?.ok).toBe(false)
    expect(web.restarted).toBe(false)

    const desktop = await new SandboxManager({ kind: 'desktop' }).fix(['some-row'])
    expect(desktop.applied[0]?.ok).toBe(false)
    expect(desktop.restarted).toBe(false)
  })

  it('reports an empty diagnosis without a home', () => {
    const diagnosis = new SandboxManager({ kind: 'desktop' }).diagnose()
    expect(diagnosis.startup).toBeNull()
    expect(diagnosis.crash).toBeNull()
    expect(diagnosis.errorLines).toEqual([])
  })
})
