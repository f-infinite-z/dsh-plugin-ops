import { describe, expect, it } from 'vitest'
import {
  classifyDesktopReadiness,
  desktopNeedsPortPatch,
  desktopPortPatchYaml,
  desktopVerifyProfileFiles,
} from '../src/index.js'

describe('desktop verify: sandbox profile', () => {
  it('initializes the desktop profile with the shipped web template', () => {
    const files = desktopVerifyProfileFiles()
    const manifest = JSON.parse(files['package.json']!) as {
      name: string
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-desktop')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(files['cordis.yml']).toBe('[]\n')
    expect(files['pnpm-workspace.yaml']).toContain('nodeLinker: hoisted')
  })

  it('pins the sandbox host port with a full webserver config (every key restated)', () => {
    const yaml = desktopPortPatchYaml(19403)
    expect(yaml).toContain('- id: webserver')
    expect(yaml).toContain('port: 19403')
    expect(yaml).toContain('host: 127.0.0.1')
    expect(yaml).toContain('compression: gzip')
    expect(yaml).toContain('compressionLevel: 1')
    expect(yaml).toContain('compressionThresholdBytes: 1024')
  })

  it('needs the port patch below the --port 0 release, and for an unknown version', () => {
    expect(desktopNeedsPortPatch('0.2.0-rc.2')).toBe(true)
    expect(desktopNeedsPortPatch('0.2.1-alpha.1')).toBe(false)
    expect(desktopNeedsPortPatch('0.3.0')).toBe(false)
    expect(desktopNeedsPortPatch(null)).toBe(true)
  })
})

describe('desktop verify: readiness classification', () => {
  const base = { alive: true, exitCode: null as number | null, listening: false, crashLogs: [] as string[] }

  it('stays undecided before the deadline', () => {
    expect(classifyDesktopReadiness({ ...base, listening: true }, 5000, 45000)).toBeNull()
  })

  it('is ready at the deadline when alive with a listening port', () => {
    expect(classifyDesktopReadiness({ ...base, listening: true }, 45000, 45000)).toEqual({ kind: 'ready', elapsedMs: 45000 })
  })

  it('times out at the deadline without a listening port', () => {
    expect(classifyDesktopReadiness({ ...base }, 45000, 45000)).toEqual({ kind: 'timeout', elapsedMs: 45000 })
  })

  it('reports a crash before anything else', () => {
    const outcome = classifyDesktopReadiness({ ...base, crashLogs: ['/x/crash-1.log'] }, 1000, 45000)
    expect(outcome?.kind).toBe('crashed')
  })

  it('reports an exited process with its code', () => {
    const outcome = classifyDesktopReadiness({ ...base, alive: false, exitCode: 3 }, 1000, 45000)
    expect(outcome).toEqual({ kind: 'exited', exitCode: 3, elapsedMs: 1000 })
  })
})
