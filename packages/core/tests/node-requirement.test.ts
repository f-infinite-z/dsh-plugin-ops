import { describe, expect, it } from 'vitest'
import { dshNodeRequirement, nodeSatisfiesRequirement } from '../src/node-requirement.js'

describe('dshNodeRequirement', () => {
  it('reports no tracked requirement before 0.2.3-alpha.2', () => {
    expect(dshNodeRequirement('0.2.2-rc.5')).toBeNull()
    expect(dshNodeRequirement('0.2.3-alpha.1')).toBeNull()
    expect(dshNodeRequirement('0.2.1-rc.1')).toBeNull()
  })

  it('reports the undici security floor from 0.2.3-alpha.2 on', () => {
    expect(dshNodeRequirement('0.2.3-alpha.2')).toBe('^24.22.3 || >=26.13.1')
    expect(dshNodeRequirement('0.2.3')).toBe('^24.22.3 || >=26.13.1')
    expect(dshNodeRequirement('0.3.0')).toBe('^24.22.3 || >=26.13.1')
  })

  it('degrades to null for unknown or unparsable versions', () => {
    expect(dshNodeRequirement(null)).toBeNull()
    expect(dshNodeRequirement(undefined)).toBeNull()
    expect(dshNodeRequirement('not-a-version')).toBeNull()
  })
})

describe('nodeSatisfiesRequirement', () => {
  const range = '^24.22.3 || >=26.13.1'

  it('rejects the Node releases the floor dropped', () => {
    expect(nodeSatisfiesRequirement('24.22.1', range)).toBe(false)
    expect(nodeSatisfiesRequirement('v24.22.1', range)).toBe(false)
    expect(nodeSatisfiesRequirement('24.9.0', range)).toBe(false)
    expect(nodeSatisfiesRequirement('26.13.0', range)).toBe(false)
    expect(nodeSatisfiesRequirement('25.5.0', range)).toBe(false)
  })

  it('accepts the supported lines', () => {
    expect(nodeSatisfiesRequirement('24.22.3', range)).toBe(true)
    expect(nodeSatisfiesRequirement('v24.22.3', range)).toBe(true)
    expect(nodeSatisfiesRequirement('24.23.0', range)).toBe(true)
    expect(nodeSatisfiesRequirement('26.13.1', range)).toBe(true)
    expect(nodeSatisfiesRequirement('27.0.0', range)).toBe(true)
  })

  it('reports false for unusable inputs instead of throwing', () => {
    expect(nodeSatisfiesRequirement('not-a-version', range)).toBe(false)
    expect(nodeSatisfiesRequirement('24.22.3', 'not a range')).toBe(false)
  })
})
