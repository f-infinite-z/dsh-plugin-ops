import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('dsh-plugin-ops-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-plugin-ops-core')>()
  return {
    ...actual,
    scanProfile: vi.fn(),
    alignToLockfile: vi.fn(),
  }
})

import * as core from 'dsh-plugin-ops-core'
import { runFixCommand } from '../src/fix-cmd.js'
import { runGateCommand } from '../src/gate-cmd.js'
import type { ScanReport, Finding } from 'dsh-plugin-ops-core'

const mockedScan = vi.mocked(core.scanProfile)
const mockedAlign = vi.mocked(core.alignToLockfile)

function makeHome(profile = 'web'): { home: string; paths: core.DshPaths; dispose(): void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ops-cli-test-'))
  const paths = core.resolveDshPaths(profile, home)
  return { home, paths, dispose: () => rmSync(home, { recursive: true, force: true }) }
}

function finding(severity: Finding['severity'], ruleId: Finding['ruleId'], fix: Finding['fix'], message = 'm'): Finding {
  return { ruleId, severity, message, fix }
}

function report(findings: Finding[], profileDir: string): ScanReport {
  return { profile: 'web', profileDir, findings, snapshot: { packages: {} } }
}

async function fakeDsh(exitCode: number): Promise<string> {
  const file = join(tmpdir(), `dsh-ops-fake-dsh-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, `process.exit(${exitCode})\n`, 'utf8')
  return file
}

describe('fix command', () => {
  beforeEach(() => {
    mockedScan.mockReset()
    mockedAlign.mockReset()
  })

  it('reports clean when nothing is alignable', async () => {
    const fixture = makeHome()
    try {
      mockedScan.mockResolvedValue(report([], fixture.paths.profileDir))
      const code = await runFixCommand({ paths: fixture.paths, profileName: 'web', dryRun: false, yes: false, config: {} })
      expect(code).toBe(0)
      expect(mockedAlign).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('refuses to run when a non-automatic fatal blocks the profile', async () => {
    const fixture = makeHome()
    try {
      mockedScan.mockResolvedValue(report([finding('fatal', 'patch-resolution', { kind: 'none' })], fixture.paths.profileDir))
      const code = await runFixCommand({ paths: fixture.paths, profileName: 'web', dryRun: false, yes: true, config: {} })
      expect(code).toBe(1)
      expect(mockedAlign).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('dry-run prints the plan and never executes', async () => {
    const fixture = makeHome()
    try {
      mockedScan.mockResolvedValue(report([finding('fatal', 'dependency-drift', { kind: 'align-lockfile' })], fixture.paths.profileDir))
      const code = await runFixCommand({ paths: fixture.paths, profileName: 'web', dryRun: true, yes: false, config: {} })
      expect(code).toBe(0)
      expect(mockedAlign).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('executes the realign with --yes and reports a clean rescan', async () => {
    const fixture = makeHome()
    try {
      mockedScan.mockResolvedValueOnce(report([finding('fatal', 'dependency-drift', { kind: 'align-lockfile' })], fixture.paths.profileDir))
      mockedAlign.mockResolvedValue({ ok: true, detail: 'realigned' })
      mockedScan.mockResolvedValueOnce(report([], fixture.paths.profileDir))
      const code = await runFixCommand({ paths: fixture.paths, profileName: 'web', dryRun: false, yes: true, config: {} })
      expect(code).toBe(0)
      expect(mockedAlign).toHaveBeenCalledTimes(1)
    } finally {
      fixture.dispose()
    }
  })
})

describe('gate command', () => {
  beforeEach(() => {
    mockedScan.mockReset()
    mockedAlign.mockReset()
  })

  it('passes through to dsh when the profile is clean', async () => {
    const fixture = makeHome()
    try {
      const fake = await fakeDsh(0)
      mockedScan.mockResolvedValue(report([], fixture.paths.profileDir))
      const code = await runGateCommand({
        paths: fixture.paths, profileName: 'web', bypass: false, noAttribution: false,
        bootThresholdMs: 20000, config: {}, dshCommand: ['node', fake],
      })
      expect(code).toBe(0)
      expect(mockedAlign).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('auto-fixes alignable drift, rescans clean, then launches dsh', async () => {
    const fixture = makeHome()
    try {
      const fake = await fakeDsh(0)
      mockedScan.mockResolvedValueOnce(report([finding('fatal', 'dependency-drift', { kind: 'align-lockfile' })], fixture.paths.profileDir))
      mockedAlign.mockResolvedValue({ ok: true, detail: 'realigned' })
      mockedScan.mockResolvedValueOnce(report([], fixture.paths.profileDir))
      const code = await runGateCommand({
        paths: fixture.paths, profileName: 'web', bypass: false, noAttribution: false,
        bootThresholdMs: 20000, config: {}, dshCommand: ['node', fake],
      })
      expect(code).toBe(0)
      expect(mockedAlign).toHaveBeenCalledTimes(1)
    } finally {
      fixture.dispose()
    }
  })

  it('blocks with exit 3 on manual findings without --bypass', async () => {
    const fixture = makeHome()
    try {
      mockedScan.mockResolvedValue(report([finding('fatal', 'structure', { kind: 'none' }, 'CJS entry')], fixture.paths.profileDir))
      const code = await runGateCommand({
        paths: fixture.paths, profileName: 'web', bypass: false, noAttribution: false,
        bootThresholdMs: 20000, config: {}, dshCommand: ['node', 'nope'],
      })
      expect(code).toBe(3)
    } finally {
      fixture.dispose()
    }
  })

  it('launches dsh anyway with --bypass and records the event', async () => {
    const fixture = makeHome()
    try {
      const fake = await fakeDsh(0)
      mockedScan.mockResolvedValue(report([finding('fatal', 'structure', { kind: 'none' })], fixture.paths.profileDir))
      const code = await runGateCommand({
        paths: fixture.paths, profileName: 'web', bypass: true, noAttribution: false,
        bootThresholdMs: 20000, config: {}, dshCommand: ['node', fake],
      })
      expect(code).toBe(0)
      const events = core.recentEvents(fixture.paths, 'web', 50)
      expect(events.some((e) => e.type === 'bypass')).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('returns the dsh exit code on a fast boot failure with no baseline', async () => {
    const fixture = makeHome()
    try {
      const fake = await fakeDsh(7)
      mockedScan.mockResolvedValue(report([], fixture.paths.profileDir))
      const code = await runGateCommand({
        paths: fixture.paths, profileName: 'web', bypass: false, noAttribution: false,
        bootThresholdMs: 60000, config: {}, dshCommand: ['node', fake],
      })
      expect(code).toBe(7)
      const events = core.recentEvents(fixture.paths, 'web', 50)
      expect(events.some((e) => e.type === 'failure')).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('passes one-shot profile exit codes through without attribution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ops-cli-test-'))
    const paths = core.resolveDshPaths('headless', home)
    try {
      const fake = await fakeDsh(9)
      mockedScan.mockResolvedValue(report([], paths.profileDir))
      const code = await runGateCommand({
        paths, profileName: 'headless', bypass: false, noAttribution: false,
        bootThresholdMs: 60000, config: {}, dshCommand: ['node', fake],
      })
      expect(code).toBe(9)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
