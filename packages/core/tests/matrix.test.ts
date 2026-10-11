import { describe, expect, it } from 'vitest'

import { buildVerifyMatrix, renderVerifyMatrix, dshPeersOf, type VerifyMatrixInput } from '../src/matrix.js'
import type { VerifyFinding } from '../src/verify.js'

function finding(severity: VerifyFinding['severity']): VerifyFinding {
  return { ruleId: 'esm-entry', severity, message: 'm' }
}

function input(overrides: Partial<VerifyMatrixInput> = {}): VerifyMatrixInput {
  return {
    packageName: 'demo-plugin',
    version: '1.0.0',
    findings: [],
    dshPeers: {},
    web: null,
    desktop: null,
    ...overrides,
  }
}

describe('dshPeersOf', () => {
  it('extracts dsh-related peer ranges only', () => {
    expect(dshPeersOf({
      peerDependencies: {
        '@deepseek-ai/dsh': '^0.1.7',
        '@deepseek-ai/dsh-fs': '>=0.1.2',
        'react-dom': '^18.2.0',
      },
    })).toEqual({ '@deepseek-ai/dsh': '^0.1.7', '@deepseek-ai/dsh-fs': '>=0.1.2' })
  })

  it('returns an empty record without peer declarations', () => {
    expect(dshPeersOf({})).toEqual({})
  })
})

describe('buildVerifyMatrix', () => {
  it('counts findings by severity', () => {
    const matrix = buildVerifyMatrix(input({ findings: [finding('error'), finding('warn'), finding('warn'), finding('info')] }))
    expect(matrix.staticChecks).toEqual({ error: 1, warn: 2, info: 1 })
  })

  it('marks each known release covered or uncovered from the peer ranges', () => {
    const matrix = buildVerifyMatrix(input({ dshPeers: { '@deepseek-ai/dsh': '>=0.1.7-rc.1 <0.2.0-rc.1' } }))
    expect(matrix.dshPeers.coveredVersions).toEqual(['0.1.7-rc.2'])
    expect(matrix.dshPeers.uncoveredVersions).toEqual(['0.1.5-rc.2', '0.2.0-rc.2', '0.2.1-alpha.1'])
  })

  it('leaves coverage empty when no dsh peers are declared', () => {
    const matrix = buildVerifyMatrix(input())
    expect(matrix.dshPeers.coveredVersions).toEqual([])
    expect(matrix.dshPeers.uncoveredVersions).toEqual([])
  })

  it('lists every lifecycle phase, with the unmeasured ones explicit', () => {
    const noRuntime = buildVerifyMatrix(input())
    expect(noRuntime.lifecycle.map((phase) => phase.phase)).toEqual(['install', 'boot', 'visibility', 'uninstall', 'rollback'])
    expect(noRuntime.lifecycle[0]!.covered).toBe(false)
    const withRuntime = buildVerifyMatrix(input({ web: { ok: true, detail: 'BOOTED', runtimeVersion: '0.1.7-rc.2' } }))
    expect(withRuntime.lifecycle[0]!.covered).toBe(true)
    expect(withRuntime.lifecycle[1]!.covered).toBe(true)
    expect(withRuntime.lifecycle[2]!.covered).toBe(false)
  })
})

describe('renderVerifyMatrix', () => {
  it('renders measured and unmeasured runtime rows', () => {
    const md = renderVerifyMatrix(buildVerifyMatrix(input({
      web: { ok: true, detail: 'boot survived 45s', runtimeVersion: '0.1.7-rc.2' },
      desktop: { ok: false, detail: 'exited 1 after 3s', runtimeVersion: null },
    })))
    expect(md).toContain('| web | dsh 0.1.7-rc.2 | BOOTED | boot survived 45s |')
    expect(md).toContain('| desktop | unknown | FAILED | exited 1 after 3s |')
  })

  it('marks unmeasured runtime targets as not run', () => {
    const md = renderVerifyMatrix(buildVerifyMatrix(input()))
    expect(md).toContain('| web | not run | - | pass --runtime/--desktop to measure |')
    expect(md).toContain('| desktop | not run | - | pass --runtime/--desktop to measure |')
  })

  it('names the declaration state and lifecycle coverage', () => {
    const md = renderVerifyMatrix(buildVerifyMatrix(input({ dshPeers: { '@deepseek-ai/dsh': '>=0.1.7-rc.2 <0.2.0-rc.1' } })))
    expect(md).toContain('| @deepseek-ai/dsh | >=0.1.7-rc.2 <0.2.0-rc.1 |')
    expect(md).toContain('covered known releases: 0.1.7-rc.2')
    expect(md).toContain('not covered: 0.1.5-rc.2, 0.2.0-rc.2, 0.2.1-alpha.1')
    expect(md).toContain('| visibility | no | planned |')
    const none = renderVerifyMatrix(buildVerifyMatrix(input()))
    expect(none).toContain('(no dsh peer ranges declared)')
  })

  it('escapes pipes and newlines in cells', () => {
    const md = renderVerifyMatrix(buildVerifyMatrix(input({ web: { ok: false, detail: 'a|b\nc', runtimeVersion: null } })))
    expect(md).toContain('a\\|b c')
  })
})
