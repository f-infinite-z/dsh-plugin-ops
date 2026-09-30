import { describe, expect, it } from 'vitest'
import { diagnoseIncompatibility, renderAdaptDiagnosis, type PackageManifest } from '../src/index.js'

function manifest(peerRange: string): PackageManifest {
  return { name: 'some-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-agent': peerRange } }
}

describe('adapt diagnosis', () => {
  it('classifies a same-minor 0.x range as narrow', () => {
    const d = diagnoseIncompatibility(manifest('0.1.5'), '0.1.7')
    expect(d?.risk).toBe('narrow')
    expect(d?.incompatiblePeers).toEqual({ '@deepseek-ai/dsh-agent': '0.1.5' })
  })

  it('classifies a 0.x minor jump as cross-major', () => {
    const d = diagnoseIncompatibility(manifest('^0.1.0-rc.6'), '0.2.0-rc.2')
    expect(d?.risk).toBe('cross-major')
  })

  it('classifies a cross-major range as cross-major', () => {
    const d = diagnoseIncompatibility(manifest('^1.0.0'), '0.2.0')
    expect(d?.risk).toBe('cross-major')
  })

  it('classifies an unparsable range as cross-major', () => {
    const d = diagnoseIncompatibility(manifest('999.0.0'), '0.2.0')
    expect(d?.risk).toBe('cross-major')
  })

  it('returns empty peers when compatible', () => {
    const d = diagnoseIncompatibility(manifest('workspace:*'), '0.2.0')
    expect(d?.incompatiblePeers).toEqual({})
  })

  it('returns null for an unnamed manifest', () => {
    expect(diagnoseIncompatibility({ name: undefined }, '0.2.0')).toBeNull()
  })

  it('is conservative when the runtime version is unknown', () => {
    const d = diagnoseIncompatibility(manifest('^0.1.0'), null)
    expect(d?.risk).toBe('cross-major')
    expect(d?.incompatiblePeers).toEqual({})
  })

  it('renders a readable summary naming the risk and peers', () => {
    const d = diagnoseIncompatibility(manifest('^0.1.0-rc.6'), '0.2.0-rc.2')
    const text = renderAdaptDiagnosis(d!)
    expect(text).toContain('CROSS-MAJOR')
    expect(text).toContain('@deepseek-ai/dsh-agent')
  })
})
