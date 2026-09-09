import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliIndex = fileURLToPath(new URL('../../packages/cli/lib/index.js', import.meta.url))
const samples = JSON.parse(readFileSync(fileURLToPath(new URL('./samples.json', import.meta.url)), 'utf8')).samples

function runDshOps(home, cmd, extra = []) {
  const r = spawnSync('node', [cliIndex, cmd, '--profile', 'sandbox', '--home', home, ...extra], { encoding: 'utf8', timeout: 120000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeProfile(web) {
  mkdirSync(web, { recursive: true })
  const deps = {}
  for (const sample of samples) deps[sample.name] = sample.version
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-sandbox', private: true, version: '0.0.0', dependencies: deps }, null, 2), 'utf8')
  writeFileSync(join(web, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
  // Real profiles never auto-install peers: the harness closure supplies the
  // @deepseek-ai peers. Auto-install would trigger a phantom dependency
  // (@deepseek-ai/dsh-compact) through the official rc chain.
  writeFileSync(join(web, '.npmrc'), 'auto-install-peers=false\n', 'utf8')
}

/** Mirror of the official reconcile: a package that declares dsh.bundle.patch becomes a layer. */
function reconcileBundles(web) {
  const root = join(web, 'node_modules')
  const names = []
  const tryAdd = (pkgDir, name) => {
    const manifestFile = join(pkgDir, 'package.json')
    if (!existsSync(manifestFile)) return
    const manifest = readJson(manifestFile)
    if (manifest.dsh?.bundle?.patch) names.push(name)
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory() || sub.isSymbolicLink()) tryAdd(join(root, entry.name, sub.name), `${entry.name}/${sub.name}`)
      }
    } else {
      tryAdd(join(root, entry.name), entry.name)
    }
  }
  const manifestFile = join(web, 'package.json')
  const manifest = readJson(manifestFile)
  manifest.dsh = { profile: { bundles: names, patchReload: 'startup' } }
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return names
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Guard: every mutation in this script must stay inside the temp sandbox. */
function assertSandboxed(path) {
  const resolved = path.replace(/\\/g, '/')
  assert(resolved.startsWith(tmpdir().replace(/\\/g, '/')), `refusing to mutate outside the temp sandbox: ${path}`)
}

// ---- build the sandbox ------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'ops-samples-'))
const web = join(home, 'profiles', 'sandbox')
try {
  writeProfile(web)
  console.log('installing pinned samples into an isolated sandbox...')
  const install = spawnSync('cmd.exe', ['/c', 'pnpm', 'install'], { cwd: web, encoding: 'utf8', timeout: 600000 })
  if (install.status !== 0) throw new Error(`sandbox install failed (status ${install.status}):\n${String(install.stdout).slice(-2000)}\n${String(install.stderr).slice(-2000)}`)

  const bundleNames = reconcileBundles(web)
  console.log(`reconciled ${bundleNames.length} bundle layer(s): ${bundleNames.join(', ') || '(none)'}`)

  // ---- baseline scan: a clean pinned install must carry no fatal ------------
  const base = runDshOps(home, 'scan', ['--skip-update-check'])
  console.log('baseline scan exit:', base.code)
  console.log(base.out)
  assert(base.code === 0, `baseline expected clean, got ${base.code}\n${base.out}\n${base.err}`)
  const baseline = base.out

  // ---- injection 1: drift the installed version of every sample ------------
  assertSandboxed(join(web, 'node_modules'))
  for (const entry of readdirSync(join(web, 'node_modules'), { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidates = entry.name.startsWith('@')
      ? readdirSync(join(web, 'node_modules', entry.name), { withFileTypes: true })
          .filter((s) => s.isDirectory() || s.isSymbolicLink())
          .map((s) => join(entry.name, s.name))
      : [entry.name]
    for (const rel of candidates) {
      const pkgJson = join(web, 'node_modules', rel, 'package.json')
      if (!existsSync(pkgJson)) continue
      const manifest = readJson(pkgJson)
      if (!manifest.version) continue
      writeFileSync(pkgJson, JSON.stringify({ ...manifest, version: `${manifest.version}-drift-test` }, null, 2), 'utf8')
    }
  }
  const drifted = runDshOps(home, 'scan', ['--skip-update-check'])
  assert(drifted.code === 1, `drift injection expected fatal exit 1, got ${drifted.code}\n${drifted.out}`)
  assert(drifted.out.includes('deviates from locked'), 'drift injection should report deviation findings')
  console.log('\n[injection 1] version drift detected OK')

  // fix realigns everything
  const fixed = runDshOps(home, 'fix', ['--yes', '--skip-update-check'])
  assert(fixed.code === 0, `fix expected 0, got ${fixed.code}\n${fixed.out}${fixed.err}`)
  const cleanAfterFix = runDshOps(home, 'scan', ['--skip-update-check'])
  assert(cleanAfterFix.code === 0, `rescan after fix expected 0, got ${cleanAfterFix.code}`)
  console.log('[injection 1] fix realigned the sandbox OK')

  // ---- injection 2: delete one bundle's patch file --------------------------
  const someBundle = bundleNames[0]
  if (someBundle) {
    const patchPath = (() => {
      const manifest = readJson(join(web, 'node_modules', ...someBundle.split('/'), 'package.json'))
      return join(web, 'node_modules', ...someBundle.split('/'), manifest.dsh.bundle.patch)
    })()
    rmSync(patchPath, { force: true })
    const broken = runDshOps(home, 'scan', ['--skip-update-check'])
    assert(broken.code === 1, `missing-patch injection expected fatal, got ${broken.code}\n${broken.out}`)
    assert(broken.out.includes('missing'), 'missing-patch injection should report a missing patch file')
    console.log(`[injection 2] missing patch file (${someBundle}) detected OK`)
    // restore
    const manifest = readJson(join(web, 'node_modules', ...someBundle.split('/'), 'package.json'))
    writeFileSync(join(web, 'node_modules', ...someBundle.split('/'), manifest.dsh.bundle.patch), '- id: probe\n', 'utf8')
    const restored = runDshOps(home, 'scan', ['--skip-update-check'])
    assert(restored.code === 0, `restored scan expected 0, got ${restored.code}`)
    console.log('[injection 2] restoration OK')
  } else {
    console.log('[injection 2] skipped: no bundle layers to break')
  }

  // ---- report the observed warnings for baseline review ---------------------
  const warnLines = baseline.split('\n').filter((l) => l.includes('WARN'))
  console.log(`\nbaseline warnings to review (${warnLines.length}):`)
  for (const line of warnLines) console.log(' ', line.trim())

  console.log('\nREAL-PLUGIN SANDBOX E2E OK')
} finally {
  rmSync(home, { recursive: true, force: true })
}
