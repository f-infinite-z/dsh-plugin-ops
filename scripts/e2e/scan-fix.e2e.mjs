import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { fileURLToPath } from 'node:url'
const cliIndex = fileURLToPath(new URL('../../packages/cli/lib/index.js', import.meta.url))

function run(home, cmd, extra = []) {
  extra = [...extra, '--skip-update-check']
  const r = spawnSync('node', [cliIndex, cmd, '--profile', 'web', '--home', home, ...extra], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// ---- scenario A: clean profile, no fatal ----
const homeA = mkdtempSync(join(tmpdir(), 'ops-e2e-a-'))
const webA = join(homeA, 'profiles', 'web')
mkdirSync(webA, { recursive: true })
writeFileSync(join(webA, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, version: '0.0.0',
  dependencies: { 'is-odd': '^3.0.1' },
}, null, 2), 'utf8')
mkdirSync(join(webA, 'node_modules'), { recursive: true })
const a = run(homeA, 'scan')
console.log('A scan code:', a.code)
console.log(a.out.slice(0, 600))
if (a.code !== 0) throw new Error(`A expected 0, got ${a.code}`)

const af = run(homeA, 'fix')
console.log('A fix code:', af.code, '|', af.out.trim().slice(0, 200))
if (af.code !== 0) throw new Error(`A fix expected 0, got ${af.code}`)

// ---- scenario B: drift — real install, then disk mutated away from the lock ----
const homeB = mkdtempSync(join(tmpdir(), 'ops-e2e-b-'))
const webB = join(homeB, 'profiles', 'web')
mkdirSync(webB, { recursive: true })
writeFileSync(join(webB, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, version: '0.0.0',
  dependencies: { 'is-odd': '^3.0.1' },
}, null, 2), 'utf8')
writeFileSync(join(webB, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
// Cross-platform: pnpm.cmd needs cmd.exe on Windows; POSIX spawns pnpm directly.
const install = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/c', 'pnpm', 'install'], { cwd: webB, encoding: 'utf8', timeout: 120000 })
  : spawnSync('pnpm', ['install'], { cwd: webB, encoding: 'utf8', timeout: 120000 })
if (install.status !== 0) throw new Error(`fixture install failed: ${String(install.stderr).slice(0, 800)}`)

const oddPkgDir = join(webB, 'node_modules', 'is-odd')

// Atomic replace: writing through the pnpm symlink with a truncating write
// would corrupt the shared global store (hardlinks). Delete + rename instead.
function replaceJsonAtomic(file, next) {
  const tmp = `${file}.dshops-tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  rmSync(file, { force: true })
  renameSync(tmp, file)
}
const oddOriginal = JSON.parse(readFileSync(join(oddPkgDir, 'package.json'), 'utf8'))
replaceJsonAtomic(join(oddPkgDir, 'package.json'), { ...oddOriginal, version: '9.9.9' })

const b = run(homeB, 'scan')
console.log('B scan code:', b.code)
console.log(b.out.slice(0, 900))
if (b.code !== 1) throw new Error(`B expected 1 (drift fatal), got ${b.code}`)

const bf = run(homeB, 'fix', ['--yes'])
console.log('B fix code:', bf.code)
console.log((bf.out + bf.err).slice(0, 900))
if (bf.code !== 0) throw new Error(`B fix expected 0 after realign, got ${bf.code}`)

const b2 = run(homeB, 'scan')
if (b2.code !== 0) throw new Error(`B rescan expected 0, got ${b2.code}:\n${b2.out}`)
console.log('B rescan code:', b2.code)

rmSync(homeA, { recursive: true, force: true })
rmSync(homeB, { recursive: true, force: true })
console.log('\nE2E OK: clean scan, drift detection, lockfile realign fix')
