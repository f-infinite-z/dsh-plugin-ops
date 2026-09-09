import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDshPaths } from './paths.js'
import { scanProfile } from './scan.js'
import type { DshPaths } from './paths.js'
import type { RuleId } from './types.js'

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function installPackage(paths: DshPaths, name: string, dirName: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
  const dir = join(paths.profileDir, 'node_modules', dirName)
  writeJson(join(dir, 'package.json'), { name, version: '1.0.0', ...manifest })
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
}

function writeLockfile(paths: DshPaths, locked: Record<string, string>): void {
  const deps = Object.entries(locked)
    .map(([name, version]) => `      ${JSON.stringify(name)}:\n        specifier: ^${version.split('.')[0]}.0.0\n        version: ${version}`)
    .join('\n')
  writeFileSync(
    join(paths.profileDir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\nimporters:\n  .:\n    dependencies:\n${deps}\n`,
    'utf8',
  )
}

interface SelfTestCase {
  name: string
  setup(paths: DshPaths): void
  expectFatalRules: RuleId[]
}

const EMPTY = () => undefined

const CASES: SelfTestCase[] = [
  {
    name: 'clean profile has no fatal findings',
    setup(paths) {
      writeJson(paths.profileManifest, { name: 'dsh-profile-selftest', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })
      writeLockfile(paths, {})
    },
    expectFatalRules: [],
  },
  {
    name: 'installed version deviating from the lockfile is a drift fatal',
    setup(paths) {
      writeJson(paths.profileManifest, { name: 'dsh-profile-selftest', private: true, dependencies: { 'pkg-a': '^1.0.0' } })
      installPackage(paths, 'pkg-a', 'pkg-a', {}, {})
      writeLockfile(paths, { 'pkg-a': '1.0.1' })
      const manifestFile = join(paths.profileDir, 'node_modules', 'pkg-a', 'package.json')
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
      writeJson(manifestFile, { ...manifest, version: '9.9.9' })
    },
    expectFatalRules: ['dependency-drift'],
  },
  {
    name: 'bundle whose patch file is missing is fatal',
    setup(paths) {
      writeJson(paths.profileManifest, {
        name: 'dsh-profile-selftest', private: true, dependencies: { 'pkg-b': '1.0.0' },
        dsh: { profile: { bundles: ['pkg-b'] } },
      })
      installPackage(paths, 'pkg-b', 'pkg-b', { dsh: { bundle: { patch: 'cordis.patch.yml' } } }, {})
      writeLockfile(paths, { 'pkg-b': '1.0.0' })
    },
    expectFatalRules: ['bundle-declaration'],
  },
  {
    name: 'double instance of framework core is fatal',
    setup(paths) {
      writeJson(paths.profileManifest, {
        name: 'dsh-profile-selftest', private: true, dependencies: { 'pkg-c': '1.0.0' },
        dsh: { profile: { bundles: ['pkg-c'] } },
      })
      installPackage(paths, 'pkg-c', 'pkg-c', {
        type: 'module', main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }, { 'cordis.patch.yml': '- id: probe\n', 'lib/index.js': 'export const name = "pkg-c"\n' })
      // host copy in the shared closure, embedded copy inside the plugin
      const host = join(paths.sharedProfilesDir, '@deepseek-ai', 'cordis')
      writeJson(join(host, 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.0' })
      const embedded = join(paths.profileDir, 'node_modules', 'pkg-c', 'node_modules', '@deepseek-ai', 'cordis')
      writeJson(join(embedded, 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.0' })
      writeLockfile(paths, { 'pkg-c': '1.0.0' })
    },
    expectFatalRules: ['peer-gap'],
  },
  {
    name: 'patch row referencing an unresolvable package is fatal',
    setup(paths) {
      writeJson(paths.profileManifest, { name: 'dsh-profile-selftest', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })
      mkdirSync(paths.profileDir, { recursive: true })
      writeFileSync(join(paths.profileDir, 'cordis.patch.yml'), '- id: ghost-row\n  name: ghost-package\n', 'utf8')
      writeLockfile(paths, {})
    },
    expectFatalRules: ['patch-resolution'],
  },
  {
    name: 'CommonJS default entry is fatal',
    setup(paths) {
      writeJson(paths.profileManifest, {
        name: 'dsh-profile-selftest', private: true, dependencies: { 'pkg-d': '1.0.0' },
        dsh: { profile: { bundles: ['pkg-d'] } },
      })
      installPackage(paths, 'pkg-d', 'pkg-d', {
        main: 'lib/index.js',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }, { 'cordis.patch.yml': '- id: probe\n', 'lib/index.js': 'module.exports = {}\n' })
      writeLockfile(paths, { 'pkg-d': '1.0.0' })
    },
    expectFatalRules: ['structure'],
  },
]

export interface SelfTestResult {
  caseName: string
  ok: boolean
  detail: string
}

export async function runSelfTest(): Promise<{ results: SelfTestResult[]; ok: boolean }> {
  const results: SelfTestResult[] = []
  for (const testCase of CASES) {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ops-selftest-'))
    const paths = resolveDshPaths('selftest', home)
    try {
      testCase.setup(paths)
      const report = await scanProfile({ paths, profileName: 'selftest', updateCheck: false })
      const fatalRules = [...new Set(report.findings.filter((f) => f.severity === 'fatal').map((f) => f.ruleId))]
      const expected = [...testCase.expectFatalRules].sort()
      const actual = [...fatalRules].sort()
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      results.push({
        caseName: testCase.name,
        ok,
        detail: ok
          ? `fatal rules matched: ${actual.join(', ') || '(none)'}`
          : `expected fatal rules ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}:\n${report.findings.map((f) => `  [${f.severity}] ${f.ruleId}: ${f.message}`).join('\n')}`,
      })
    } catch (error) {
      results.push({ caseName: testCase.name, ok: false, detail: `selftest case crashed: ${String(error)}` })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  return { results, ok: results.every((r) => r.ok) }
}
