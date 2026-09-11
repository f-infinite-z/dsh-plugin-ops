import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyOk, verifyPluginPackage } from '../src/index.js'

function makePkg(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-verify-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return dir
}

const GOOD_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'good-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': { default: './lib/index.js' },
      './client': { default: './lib/client.js' },
    },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }),
  'cordis.patch.yml': '- insert:\n    - id: good\n      name: good-plugin\n',
  'lib/index.js': 'export function apply() {}\n',
  'lib/client.js': 'window.__ModuleLoader__.load({ id: "good-plugin", factory: () => ({}) });\n',
}

function withPkg<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = makePkg(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verifyPluginPackage', () => {
  it('passes a complete plugin package', () => {
    withPkg(GOOD_FILES, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings).toEqual([])
      expect(verifyOk(report)).toBe(true)
      expect(report.packageName).toBe('good-plugin')
      expect(report.version).toBe('1.0.0')
    })
  })

  it('errors when package.json is missing', () => {
    withPkg({}, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]?.severity).toBe('error')
      expect(verifyOk(report)).toBe(false)
    })
  })

  it('errors without dsh.bundle.patch', () => {
    withPkg(
      {
        'package.json': JSON.stringify({ name: 'x', version: '1.0.0', type: 'module', main: 'i.js' }),
        'i.js': 'export function apply() {}\n',
      },
      (dir) => {
        const report = verifyPluginPackage(dir)
        expect(report.findings.some((f) => f.ruleId === 'bundle-patch' && f.severity === 'error')).toBe(true)
      },
    )
  })

  it('warns for client-only packages', () => {
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'client-only',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          exports: { './client': { default: './c.js' } },
          dsh: { client: { platform: 'web' } },
        }),
        'i.js': 'export function apply() {}\n',
        'c.js': 'window.__ModuleLoader__.load({ id: "client-only", factory: () => ({}) });\n',
      },
      (dir) => {
        const report = verifyPluginPackage(dir)
        expect(report.findings.some((f) => f.ruleId === 'bundle-patch' && f.severity === 'warn')).toBe(true)
        expect(verifyOk(report)).toBe(true)
        expect(verifyOk(report, true)).toBe(false)
      },
    )
  })

  it('errors when the patch file is missing or not a list', () => {
    withPkg(
      { 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', type: 'module', main: 'i.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }), 'i.js': '' },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.message.includes('missing file'))).toBe(true)
      },
    )
    withPkg(
      {
        'package.json': JSON.stringify({ name: 'x', version: '1.0.0', type: 'module', main: 'i.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        'i.js': '',
        'cordis.patch.yml': 'id: not-a-list\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.message.includes('not a YAML list'))).toBe(true)
      },
    )
  })

  it('checks patch rows: own package and official packages pass, undeclared third parties error', () => {
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'row-test',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'i.js': 'export function apply() {}\n',
        'cordis.patch.yml':
          '- insert:\n    - id: self\n      name: row-test\n    - id: official\n      name: "@deepseek-ai/dsh-web-app/startup"\n    - id: third\n      name: some-third-party\n',
      },
      (dir) => {
        const report = verifyPluginPackage(dir)
        expect(report.findings.some((f) => f.ruleId === 'patch-resolution' && f.severity === 'error' && f.message.includes('some-third-party'))).toBe(true)
        expect(report.findings.some((f) => f.ruleId === 'patch-resolution' && f.severity === 'info' && f.message.includes('@deepseek-ai/'))).toBe(true)
        expect(verifyOk(report)).toBe(false)
      },
    )
  })

  it('passes declared third-party patch rows and missing relative modules error', () => {
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'row-ok',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          dependencies: { 'some-third-party': '^1.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'i.js': 'export function apply() {}\n',
        'cordis.patch.yml': '- insert:\n    - id: third\n      name: some-third-party\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings).toEqual([])
      },
    )
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'row-rel',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'i.js': 'export function apply() {}\n',
        'cordis.patch.yml': '- insert:\n    - id: rel\n      name: ./missing-entry.js\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.ruleId === 'patch-resolution' && f.severity === 'error')).toBe(true)
      },
    )
  })

  it('errors on a CommonJS or missing default entry', () => {
    withPkg(
      {
        'package.json': JSON.stringify({ name: 'cjs', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './p.yml' } } }),
        'lib/index.js': 'module.exports = {}\n',
        'p.yml': '- insert:\n    - id: cjs\n      name: cjs\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.ruleId === 'esm-entry' && f.severity === 'error')).toBe(true)
      },
    )
    withPkg(
      {
        'package.json': JSON.stringify({ name: 'no-entry', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './p.yml' } } }),
        'p.yml': '- insert:\n    - id: x\n      name: no-entry\n',
      },
      (dir) => {
        const report = verifyPluginPackage(dir)
        expect(report.findings.some((f) => f.ruleId === 'esm-entry' && f.severity === 'warn')).toBe(true)
        expect(verifyOk(report, true)).toBe(false)
      },
    )
  })

  it('errors when dsh.client has no ./client export or the file is missing', () => {
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'bad-client',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          dsh: { bundle: { patch: './p.yml' }, client: { platform: 'web' } },
        }),
        'i.js': 'export function apply() {}\n',
        'p.yml': '- insert:\n    - id: x\n      name: bad-client\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.ruleId === 'client-export' && f.severity === 'error')).toBe(true)
      },
    )
    withPkg(
      {
        'package.json': JSON.stringify({
          name: 'missing-client-file',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
          exports: { './client': { default: './lib/client.js' } },
          dsh: { bundle: { patch: './p.yml' }, client: { platform: 'web' } },
        }),
        'i.js': 'export function apply() {}\n',
        'p.yml': '- insert:\n    - id: x\n      name: missing-client-file\n',
      },
      (dir) => {
        expect(verifyPluginPackage(dir).findings.some((f) => f.ruleId === 'client-export' && f.message.includes('does not exist'))).toBe(true)
      },
    )
  })

  it('reads a package.json written with a UTF-8 BOM (Windows editors)', () => {
    const withBom = `\uFEFF${GOOD_FILES['package.json']}`
    withPkg({ ...GOOD_FILES, 'package.json': withBom }, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.packageName).toBe('good-plugin')
      expect(verifyOk(report)).toBe(true)
    })
  })

  it('warns when the entry has no apply named export (V4)', () => {
    withPkg({ ...GOOD_FILES, 'lib/index.js': 'export const other = 1\n' }, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings.some((f) => f.ruleId === 'entry-exports' && f.severity === 'warn')).toBe(true)
    })
  })

  it('warns when the client bundle lacks the module-loader registration (V6)', () => {
    withPkg({ ...GOOD_FILES, 'lib/client.js': 'console.log("hi")\n' }, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings.some((f) => f.ruleId === 'client-bundle' && f.severity === 'warn')).toBe(true)
    })
  })

  it('warns when files excludes critical artifacts (V7)', () => {
    const manifest = JSON.parse(GOOD_FILES['package.json']!) as Record<string, unknown>
    manifest.files = ['lib/index.js']
    withPkg({ ...GOOD_FILES, 'package.json': JSON.stringify(manifest) }, (dir) => {
      const report = verifyPluginPackage(dir)
      const findings = report.findings.filter((f) => f.ruleId === 'files-completeness')
      expect(findings.length).toBeGreaterThanOrEqual(2)
      expect(findings.every((f) => f.severity === 'warn')).toBe(true)
    })
  })

  it('covers critical artifacts through a files directory entry (V7)', () => {
    const manifest = JSON.parse(GOOD_FILES['package.json']!) as Record<string, unknown>
    manifest.files = ['lib', 'cordis.patch.yml']
    withPkg({ ...GOOD_FILES, 'package.json': JSON.stringify(manifest) }, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings.filter((f) => f.ruleId === 'files-completeness')).toEqual([])
    })
  })

  it('errors on file:/link: protocols and warns on workspace: (V8)', () => {
    const manifest = JSON.parse(GOOD_FILES['package.json']!) as Record<string, unknown>
    manifest.dependencies = { 'local-dep': 'file:../local-dep' }
    manifest.peerDependencies = { 'ws-dep': 'workspace:*' }
    withPkg({ ...GOOD_FILES, 'package.json': JSON.stringify(manifest) }, (dir) => {
      const report = verifyPluginPackage(dir)
      expect(report.findings.some((f) => f.ruleId === 'dependency-protocol' && f.severity === 'error')).toBe(true)
      expect(report.findings.some((f) => f.ruleId === 'dependency-protocol' && f.severity === 'warn')).toBe(true)
    })
  })
})
