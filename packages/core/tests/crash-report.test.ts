import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLatestCrashReport } from '../src/index.js'

const CRASH_BODY = [
  'time: 2026-09-30T06:00:00.000Z',
  'source: host',
  'phase: startup',
  'app: DeepSeek Harness 0.2.0-rc.2',
  'platform: win32 x64',
  'electron: 44.0.0',
  'node: 24.21.0',
  'locale: zh-CN',
  'shell pid: 1234',
  '',
  '--- error ---',
  "StartupError: dsh: plugin tree failed to load",
  "  inactive entries: [{ id: 'webserver', module: '@deepseek-ai/dsh-host-webserver', required: true }, { id: 'some-plugin', module: 'some-plugin', required: false }]",
  '',
  '--- host diagnostic (as reported by the Host process) ---',
  'Error: ...',
  '',
].join('\n')

describe('desktop crash report reader', () => {
  it('parses header facts and inactive entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
    try {
      writeFileSync(join(dir, 'crash-2026-09-30T06-00-00-000Z-host.log'), CRASH_BODY, 'utf8')
      const report = readLatestCrashReport(dir)
      expect(report).not.toBeNull()
      expect(report?.source).toBe('host')
      expect(report?.phase).toBe('startup')
      expect(report?.appVersion).toBe('0.2.0-rc.2')
      expect(report?.hostDiagnostic).toBe(true)
      expect(report?.entries).toEqual([
        { id: 'webserver', module: '@deepseek-ai/dsh-host-webserver', required: true },
        { id: 'some-plugin', module: 'some-plugin', required: false },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when no crash report exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
    try {
      expect(readLatestCrashReport(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the directory does not exist', () => {
    expect(readLatestCrashReport(join(tmpdir(), 'dsh-crash-missing'))).toBeNull()
  })

  it('ignores reports older than sinceMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
    try {
      const file = join(dir, 'crash-2026-09-30T06-00-00-000Z-host.log')
      writeFileSync(file, CRASH_BODY, 'utf8')
      const past = new Date('2026-09-30T06:00:00.000Z')
      utimesSync(file, past, past)
      expect(readLatestCrashReport(dir, Date.parse('2026-10-01T00:00:00.000Z'))).toBeNull()
      expect(readLatestCrashReport(dir, Date.parse('2026-09-29T00:00:00.000Z'))).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
