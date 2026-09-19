import { describe, expect, it } from 'vitest'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLatestStartupReport } from '../src/index.js'
import { makeHome } from './helpers.js'

function writeReport(home: string, name: string, lines: readonly string[]): string {
  const file = join(home, 'logs', name)
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

const REPORT_LINES = [
  'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.',
  '',
  '{',
  "  timestamp: '2026-09-19T07:44:42.859Z',",
  "  dshVersion: '0.1.6-alpha.2',",
  "  nodeVersion: 'v22.19.0',",
  "  platform: 'win32',",
  "  arch: 'x64',",
  "  profile: 'web',",
  '  error: StartupError {',
  '    entries: [',
  '      {',
  "        id: 'agent-loop',",
  "        module: 'some-package',",
  '        required: true,',
  '        fiberState: 3,',
  "        outcome: { kind: 'failed', error: [Getter] }",
  '      },',
  '      {',
  "        id: 'optional-widget',",
  "        module: 'widget-pkg',",
  '        required: false,',
  '        fiberState: 3,',
  "        outcome: { kind: 'failed', error: [Getter] }",
  '      }',
  '    ]',
  '  }',
  '}',
]

describe('startup diagnostics reader', () => {
  it('returns null when no log directory exists', () => {
    const fixture = makeHome()
    try {
      expect(readLatestStartupReport(fixture.paths)).toBeNull()
    } finally {
      fixture.dispose()
    }
  })

  it('parses metadata and the failed-entry list', () => {
    const fixture = makeHome()
    try {
      const file = writeReport(fixture.home, 'startup-2026-09-19T07-44-42.859Z-abc.log', REPORT_LINES)
      const report = readLatestStartupReport(fixture.paths)
      expect(report?.file).toBe(file)
      expect(report?.dshVersion).toBe('0.1.6-alpha.2')
      expect(report?.profile).toBe('web')
      expect(report?.timestamp).toBe('2026-09-19T07:44:42.859Z')
      expect(report?.entries).toEqual([
        { id: 'agent-loop', module: 'some-package', required: true },
        { id: 'optional-widget', module: 'widget-pkg', required: false },
      ])
    } finally {
      fixture.dispose()
    }
  })

  it('reads the newest report first', () => {
    const fixture = makeHome()
    try {
      writeReport(fixture.home, 'startup-2026-09-18T00-00-00.000Z-old.log', [
        "{ timestamp: '2026-09-18T00:00:00.000Z', dshVersion: '0.1.5-rc.2', profile: 'web', error: StartupError {} }",
      ])
      writeReport(fixture.home, 'startup-2026-09-19T07-44-42.859Z-new.log', REPORT_LINES)
      const report = readLatestStartupReport(fixture.paths)
      expect(report?.dshVersion).toBe('0.1.6-alpha.2')
    } finally {
      fixture.dispose()
    }
  })

  it('skips reports older than the launch time bound', () => {
    const fixture = makeHome()
    try {
      const file = writeReport(fixture.home, 'startup-2026-09-19T07-44-42.859Z-abc.log', REPORT_LINES)
      const past = new Date(Date.now() - 60_000)
      utimesSync(file, past, past)
      expect(readLatestStartupReport(fixture.paths, Date.now() - 10_000)).toBeNull()
      expect(readLatestStartupReport(fixture.paths, Date.now() - 120_000)?.dshVersion).toBe('0.1.6-alpha.2')
    } finally {
      fixture.dispose()
    }
  })

  it('degrades to metadata without entries when the entry list is unrecognized', () => {
    const fixture = makeHome()
    try {
      writeReport(fixture.home, 'startup-2026-09-19T07-44-42.859Z-abc.log', [
        '{',
        "  timestamp: '2026-09-19T07:44:42.859Z',",
        "  dshVersion: '0.1.6-alpha.2',",
        "  profile: 'web',",
        '  error: StartupError { entries: <some new layout> }',
        '}',
      ])
      const report = readLatestStartupReport(fixture.paths)
      expect(report?.dshVersion).toBe('0.1.6-alpha.2')
      expect(report?.entries).toEqual([])
    } finally {
      fixture.dispose()
    }
  })
})
