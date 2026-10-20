import { describe, expect, it } from 'vitest'
import { freshnessFromDistTags, LATEST_KNOWN_VERSION } from '../src/versions.js'

describe('freshnessFromDistTags', () => {
  it('reads every channel and finds the newest release', () => {
    const fresh = freshnessFromDistTags({ alpha: '0.2.1-alpha.2', latest: '0.2.0-rc.2', next: '0.2.0-rc.2' })
    expect(fresh.registryNewest).toBe('0.2.1-alpha.2')
    expect(fresh.problem).toBeNull()
    expect(fresh.fresh).toBe(true)
  })

  it('flags a stale table when any channel carries a newer release', () => {
    const fresh = freshnessFromDistTags({ alpha: '0.3.0-rc.1', latest: '0.2.0-rc.2' })
    expect(fresh.registryNewest).toBe('0.3.0-rc.1')
    expect(fresh.fresh).toBe(false)
    expect(fresh.tableCovers).toBe(LATEST_KNOWN_VERSION)
  })

  it('covers the current rc.2 release', () => {
    const fresh = freshnessFromDistTags({ latest: '0.2.1-rc.2' })
    expect(fresh.tableCovers).toBe('0.2.1-rc.2')
    expect(fresh.registryNewest).toBe('0.2.1-rc.2')
    expect(fresh.fresh).toBe(true)
  })

  it('degrades when the registry reports no valid versions', () => {
    const fresh = freshnessFromDistTags({ weird: 'not-a-version' })
    expect(fresh.registryNewest).toBeNull()
    expect(fresh.fresh).toBeNull()
    expect(fresh.problem).toContain('no valid versions')
  })
})
