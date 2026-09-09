import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveDshPaths, type DshPaths } from '../src/index.js'

export interface HomeFixture {
  home: string
  paths: DshPaths
  dispose(): void
}

export function makeHome(profileName = 'web'): HomeFixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ops-test-'))
  return {
    home,
    paths: resolveDshPaths(profileName, home),
    dispose: () => rmSync(home, { recursive: true, force: true }),
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export interface ProfileFixture {
  dependencies: Record<string, string>
  bundles?: string[]
}

export function writeProfile(paths: DshPaths, spec: ProfileFixture): void {
  writeJson(paths.profileManifest, {
    name: `dsh-profile-${paths.profileDir.split(/[\\/]/).pop()}`,
    private: true,
    dependencies: spec.dependencies,
    ...(spec.bundles === undefined ? {} : { dsh: { profile: { bundles: spec.bundles } } }),
  })
}

export interface InstalledPackage {
  name: string
  version: string
  /** directory inside node_modules (needed for scoped names). */
  dirName?: string
  /** declare dsh.bundle.patch; the patch file is created unless patchExists is false. */
  dshBundlePatch?: string
  patchExists?: boolean
}

/** Simulate a hoisted pnpm install under the profile's own node_modules. */
export function writeInstalledPackages(paths: DshPaths, packages: InstalledPackage[]): void {
  for (const pkg of packages) {
    const dir = join(paths.profileDir, 'node_modules', pkg.dirName ?? pkg.name)
    const manifest: Record<string, unknown> = { name: pkg.name, version: pkg.version }
    if (pkg.dshBundlePatch !== undefined && pkg.dshBundlePatch !== '') {
      manifest.dsh = { bundle: { patch: pkg.dshBundlePatch } }
    }
    writeJson(join(dir, 'package.json'), manifest)
    if (pkg.dshBundlePatch !== undefined && pkg.dshBundlePatch !== '' && pkg.patchExists !== false) {
      writeFileSync(join(dir, pkg.dshBundlePatch), '- id: probe\n', 'utf8')
    }
  }
}

/** Write a minimal pnpm-lock.yaml (lockfileVersion 9) for the project importer. */
export function writeLockfile(paths: DshPaths, locked: Record<string, string>): void {
  const deps = Object.entries(locked)
    .map(([name, version]) => `      ${JSON.stringify(name)}:\n        specifier: ^${version.split('.')[0]}.0.0\n        version: ${version}`)
    .join('\n')
  writeFileSync(
    join(paths.profileDir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\nimporters:\n  .:\n    dependencies:\n${deps}\n`,
    'utf8',
  )
}
