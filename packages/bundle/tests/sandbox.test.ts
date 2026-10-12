import { describe, expect, it } from 'vitest'
import { SandboxManager, desktopInstallFromEntry } from '../src/sandbox.js'

describe('desktopInstallFromEntry', () => {
  it('rejects missing or unrelated entries', () => {
    expect(desktopInstallFromEntry(undefined)).toBeNull()
    expect(desktopInstallFromEntry('')).toBeNull()
    expect(desktopInstallFromEntry('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBeNull()
  })

  if (process.platform === 'win32') {
    it('derives the install directory from the desktop executable', () => {
      expect(desktopInstallFromEntry('C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'))
        .toBe('C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness')
    })

    it('does not mistake a similarly named binary for the desktop app', () => {
      expect(desktopInstallFromEntry('C:\\tools\\DeepSeek Harness\\dsh.cmd')).toBeNull()
    })
  }

  if (process.platform === 'darwin') {
    it('derives the app bundle from the macOS executable', () => {
      expect(desktopInstallFromEntry('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'))
        .toBe('/Applications/DeepSeek Harness.app')
    })
  }

  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    it('has no desktop host shape on other platforms', () => {
      expect(desktopInstallFromEntry('/opt/deepseek/DeepSeek Harness.exe')).toBeNull()
    })
  }
})

describe('SandboxManager shapes', () => {
  it('defaults to the web shape', () => {
    const status = new SandboxManager().status()
    expect(status.kind).toBe('web')
    expect(status.state).toBe('stopped')
    expect(status.home).toBeNull()
  })

  it('runs the desktop shape when constructed for it', () => {
    expect(new SandboxManager({ kind: 'desktop' }).status().kind).toBe('desktop')
  })

  it('reports no scan without a home in either shape', async () => {
    expect(await new SandboxManager().scan()).toBeNull()
    expect(await new SandboxManager({ kind: 'desktop' }).scan()).toBeNull()
  })

  it('rejects fixes without a home in either shape', async () => {
    const web = await new SandboxManager().fix(['some-row'])
    expect(web.applied[0]?.ok).toBe(false)
    expect(web.restarted).toBe(false)

    const desktop = await new SandboxManager({ kind: 'desktop' }).fix(['some-row'])
    expect(desktop.applied[0]?.ok).toBe(false)
    expect(desktop.restarted).toBe(false)
  })

  it('reports an empty diagnosis without a home', () => {
    const diagnosis = new SandboxManager({ kind: 'desktop' }).diagnose()
    expect(diagnosis.startup).toBeNull()
    expect(diagnosis.crash).toBeNull()
    expect(diagnosis.errorLines).toEqual([])
  })
})
