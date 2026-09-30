import { describe, expect, it } from 'vitest'
import {
  applyAdaptedInstall, installWithDiagnosis, listExemptions, removeAndCleanup, revokeExemptionsFor,
  type ChangeLike, type PluginManagerLike,
} from '../src/adapt.js'

function change(overrides: Partial<ChangeLike> = {}): ChangeLike {
  return { changed: true, application: 'applied', target: 'pkg', ...overrides }
}

/** Minimal fake of the official plugin-manager service surface. */
class FakeManager implements PluginManagerLike {
  exemptions: Record<string, string[]> = {}
  installs: string[] = []
  removes: string[] = []
  constructor(private readonly results: ChangeLike[] = []) {}

  installBundle(spec: string): Promise<ChangeLike> {
    this.installs.push(spec)
    return Promise.resolve(this.results.shift() ?? change())
  }

  removeBundle(name: string): Promise<ChangeLike> {
    this.removes.push(name)
    return Promise.resolve(change({ target: name }))
  }

  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean): Promise<ChangeLike> {
    const list = this.exemptions[packageVersion] ?? []
    if (enabled) {
      if (!list.includes(runtimeVersion)) list.push(runtimeVersion)
      this.exemptions[packageVersion] = list
    } else {
      const next = list.filter((value) => value !== runtimeVersion)
      if (next.length === 0) delete this.exemptions[packageVersion]
      else this.exemptions[packageVersion] = next
    }
    return Promise.resolve(change({ target: packageVersion }))
  }

  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] } {
    return { exemptions: { ...this.exemptions }, warnings: [] }
  }
}

describe('installWithDiagnosis', () => {
  it('returns success for a plain install', async () => {
    const manager = new FakeManager([change({ bundle: 'pkg-a' })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome).toEqual({ ok: true, application: 'applied', target: 'pkg', bundle: 'pkg-a' })
  })

  it('carries the incompatible peers and their risk on a refusal', async () => {
    const manager = new FakeManager([change({
      error: {
        code: 'incompatible-version',
        message: 'refused',
        incompatible: [{ name: 'pkg-a', version: '1.0.0', runtimeVersion: '0.2.0', peers: { '@deepseek-ai/dsh-llm': '^0.1.0' } }],
      },
    })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('incompatible-version')
    expect(outcome.message).toBe('refused')
    expect(outcome.incompatible).toEqual([
      { name: 'pkg-a', version: '1.0.0', runtimeVersion: '0.2.0', peers: { '@deepseek-ai/dsh-llm': '^0.1.0' }, risk: 'cross-major' },
    ])
  })

  it('classifies a same-boundary range as narrow', async () => {
    const manager = new FakeManager([change({
      error: {
        code: 'incompatible-version',
        incompatible: [{ name: 'pkg-a', version: '1.0.0', runtimeVersion: '0.2.0', peers: { '@deepseek-ai/dsh-llm': '~0.2.1' } }],
      },
    })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome.incompatible?.[0]?.risk).toBe('narrow')
  })

  it('surfaces other management errors', async () => {
    const manager = new FakeManager([change({ error: { code: 'not-a-bundle', message: 'not a bundle' } })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome).toEqual({ ok: false, code: 'not-a-bundle', message: 'not a bundle' })
  })

  it('carries the package-manager output tail on a plain failure', async () => {
    const manager = new FakeManager([change({
      error: { code: 'operation-error', message: 'install failed' },
      packageResult: { exitCode: 1, output: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION 2 lockfile entries failed verification' },
    })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('operation-error')
    expect(outcome.message).toBe('install failed')
    expect(outcome.detail).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
  })

  it('bounds the carried output tail', async () => {
    const manager = new FakeManager([change({
      error: { code: 'operation-error' },
      packageResult: { output: `${'x'.repeat(5000)}THE-END` },
    })])
    const outcome = await installWithDiagnosis(manager, 'pkg-a')
    expect(outcome.detail?.length).toBe(1500)
    expect(outcome.detail?.endsWith('THE-END')).toBe(true)
  })
})

describe('applyAdaptedInstall', () => {
  it('grants the exemption, then installs', async () => {
    const manager = new FakeManager([change()])
    const outcome = await applyAdaptedInstall(manager, { spec: 'pkg-a@1.0.0', name: 'pkg-a', version: '1.0.0', runtimeVersion: '0.2.0' })
    expect(outcome.ok).toBe(true)
    expect(manager.exemptions).toEqual({ 'pkg-a@1.0.0': ['0.2.0'] })
  })

  it('revokes the exemption when the adapted install still fails', async () => {
    const manager = new FakeManager([change({ error: { code: 'operation-error', message: 'boom' } })])
    const outcome = await applyAdaptedInstall(manager, { spec: 'pkg-a@1.0.0', name: 'pkg-a', version: '1.0.0', runtimeVersion: '0.2.0' })
    expect(outcome.ok).toBe(false)
    expect(outcome.rolledBack).toBe(true)
    expect(manager.exemptions).toEqual({})
  })
})

describe('exemption cleanup', () => {
  it('lists exemptions from the manager', () => {
    const manager = new FakeManager()
    manager.exemptions = { 'pkg-a@1.0.0': ['0.2.0'] }
    expect(listExemptions(manager)).toEqual({ 'pkg-a@1.0.0': ['0.2.0'] })
  })

  it('revokes only the named package', async () => {
    const manager = new FakeManager()
    manager.exemptions = { 'pkg-a@1.0.0': ['0.2.0'], 'pkg-b@2.0.0': ['0.2.0'] }
    const result = await revokeExemptionsFor(manager, 'pkg-a')
    expect(result).toEqual({ ok: true, removed: 1 })
    expect(manager.exemptions).toEqual({ 'pkg-b@2.0.0': ['0.2.0'] })
  })

  it('removes a plugin and drops its exemptions in one step', async () => {
    const manager = new FakeManager()
    manager.exemptions = { 'pkg-a@1.0.0': ['0.2.0'] }
    const outcome = await removeAndCleanup(manager, 'pkg-a')
    expect(outcome.ok).toBe(true)
    expect(outcome.removedExemptions).toBe(1)
    expect(manager.removes).toEqual(['pkg-a'])
    expect(manager.exemptions).toEqual({})
  })
})
