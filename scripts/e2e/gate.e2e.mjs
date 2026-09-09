import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { fileURLToPath } from 'node:url'
const cliIndex = fileURLToPath(new URL('../../packages/cli/lib/index.js', import.meta.url))

function gate(home, extra) {
  const r = spawnSync('node', [cliIndex, 'gate', '--profile', 'web', '--home', home, ...extra], { encoding: 'utf8', timeout: 60000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function memoryLines(home) {
  const file = join(home, 'cache', 'dsh-ops', 'memory.jsonl')
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function writeProfile(web, deps) {
  mkdirSync(web, { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, version: '0.0.0', dependencies: deps }, null, 2), 'utf8')
}

const fakeDshOk = join(tmpdir(), `fake-dsh-ok-${process.pid}.mjs`)
const fakeDshFail = join(tmpdir(), `fake-dsh-fail-${process.pid}.mjs`)
writeFileSync(fakeDshOk, 'process.exit(0)\n', 'utf8')
writeFileSync(fakeDshFail, 'console.error("boom"); process.exit(7)\n', 'utf8')

// G1: no fatal findings -> pass through; dsh exit code forwarded; success recorded
const homeG1 = mkdtempSync(join(tmpdir(), 'ops-g1-'))
writeProfile(join(homeG1, 'profiles', 'web'), {})
const g1 = gate(homeG1, ['--', 'node', fakeDshOk])
console.log('G1 code:', g1.code)
if (g1.code !== 0) throw new Error(`G1 expected 0, got ${g1.code}`)
const mem1 = memoryLines(homeG1)
if (!mem1.some((e) => e.type === 'success')) throw new Error('G1 expected a success memory event')

// G2: boot failure, no baseline -> attribution guidance, dsh code returned
const homeG2 = mkdtempSync(join(tmpdir(), 'ops-g2-'))
writeProfile(join(homeG2, 'profiles', 'web'), {})
const g2 = gate(homeG2, ['--', 'node', fakeDshFail])
console.log('G2 code:', g2.code)
if (g2.code !== 7) throw new Error(`G2 expected 7 (dsh code passthrough), got ${g2.code}`)
if (!memoryLines(homeG2).some((e) => e.type === 'failure')) throw new Error('G2 expected a failure memory event')

// G3: fatal findings block without --bypass (rule 1: unresolvable bundle)
const homeG3 = mkdtempSync(join(tmpdir(), 'ops-g3-'))
writeProfile(join(homeG3, 'profiles', 'web'), {})
writeFileSync(join(homeG3, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, version: '0.0.0', dependencies: {},
  dsh: { profile: { bundles: ['ghost-bundle'] } },
}, null, 2), 'utf8')
const g3 = gate(homeG3, ['--', 'node', fakeDshOk])
console.log('G3 code:', g3.code)
if (g3.code !== 3) throw new Error(`G3 expected 3 (blocked), got ${g3.code}`)
if (!g3.err.includes('GATE BLOCKED')) throw new Error('G3 expected blocked message on stderr')

// G4: --bypass starts dsh anyway and records it (rule 1: unresolvable bundle)
const homeG4 = mkdtempSync(join(tmpdir(), 'ops-g4-'))
writeProfile(join(homeG4, 'profiles', 'web'), {})
writeFileSync(join(homeG4, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, version: '0.0.0', dependencies: {},
  dsh: { profile: { bundles: ['ghost-bundle'] } },
}, null, 2), 'utf8')
const g4 = gate(homeG4, ['--bypass', '--', 'node', fakeDshOk])
console.log('G4 code:', g4.code)
if (g4.code !== 0) throw new Error(`G4 expected 0 with bypass, got ${g4.code}`)
if (!memoryLines(homeG4).some((e) => e.type === 'bypass')) throw new Error('G4 expected a bypass memory event')

// G5: auto-fixable fatal (drift) is realigned before launch, then dsh runs
const homeG5 = mkdtempSync(join(tmpdir(), 'ops-g5-'))
const web5 = join(homeG5, 'profiles', 'web')
writeProfile(web5, { 'is-odd': '^3.0.1' })
writeFileSync(join(web5, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
const install = spawnSync('cmd.exe', ['/c', 'pnpm', 'install'], { cwd: web5, encoding: 'utf8', timeout: 120000 })
if (install.status !== 0) throw new Error(`G5 fixture install failed: ${String(install.stderr).slice(0, 400)}`)
const oddPkgDir = join(web5, 'node_modules', 'is-odd')
const oddPkg = JSON.parse(readFileSync(join(oddPkgDir, 'package.json'), 'utf8'))
writeFileSync(join(oddPkgDir, 'package.json'), JSON.stringify({ ...oddPkg, version: '9.9.9' }, null, 2), 'utf8')
const g5 = gate(homeG5, ['--', 'node', fakeDshOk])
console.log('G5 code:', g5.code)
if (g5.code !== 0) throw new Error(`G5 expected 0 after auto-fix + launch, got ${g5.code}`)
const rescan = spawnSync('node', [cliIndex, 'scan', '--profile', 'web', '--home', homeG5], { encoding: 'utf8' })
if (!rescan.stdout.includes('OK: no fatal findings')) throw new Error(`G5 rescan not clean: ${rescan.stdout.slice(0, 400)}`)

for (const home of [homeG1, homeG2, homeG3, homeG4, homeG5]) rmSync(home, { recursive: true, force: true })
rmSync(fakeDshOk, { force: true })
rmSync(fakeDshFail, { force: true })
console.log('\nGATE E2E OK: pass-through, failure record, block, bypass, auto-fix-then-launch')
