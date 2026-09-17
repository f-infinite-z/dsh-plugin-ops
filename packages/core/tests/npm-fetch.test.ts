import { describe, expect, it } from 'vitest'
import { fetchNpmPackage } from '../src/index.js'

describe('fetchNpmPackage', () => {
  it('rejects specs that could reach the command line as shell input', async () => {
    const bad = [
      '',
      'has space',
      'name;rm -rf /',
      'name@^1.0.0',
      'name@>=1.0.0',
      'name@1.0.0 && echo pwned',
      '../../etc',
      '@scope/',
      'name@1.0.0|cat',
      '"quoted"',
    ]
    for (const spec of bad) {
      const result = await fetchNpmPackage(spec, 1000)
      expect(result.ok, spec).toBe(false)
      expect(result.error, spec).toContain('invalid npm package spec')
      expect(result.packageDir, spec).toBeNull()
      result.cleanup()
    }
  })

  it('accepts plain names, scoped names, and pinned versions', async () => {
    // Validation is the only offline-observable step; downloads are covered by
    // the network-gated e2e. A spec that passes validation reaches `npm pack`
    // and fails on the missing network or package, never on the guard.
    const result = await fetchNpmPackage('@dsh-ops-does-not-exist/pkg@0.0.1', 1000)
    expect(result.error ?? '').not.toContain('invalid npm package spec')
    result.cleanup()
  })
})
