import { createInterface } from 'node:readline/promises'
import { dirname } from 'node:path'
import {
  fetchNpmPackage, readPackageManifest, readProfileManifest, diagnoseIncompatibility, renderAdaptDiagnosis,
  writeVersionExemption, removeVersionExemption, removeExemptionsForPackage, locateInstallAnchor,
  isDesktopProfile, detectDesktop, resolveDesktopCliLauncher, desktopCliSupportsPluginManagement,
  type DshPaths, type OpsConfig,
} from 'dsh-plugin-ops-core'
import { runRuntimeVerify } from './verify-cmd.js'
import { spawnCli } from './spawn-dsh.js'

export interface AdaptCommandOptions {
  paths: DshPaths
  profileName: string
  config: OpsConfig
  /** npm package spec (name, @scope/name, or name@version). */
  spec: string
  /** seconds a healthy isolated boot must survive. */
  timeoutSec: number
  /** skip the interactive confirmation. */
  yes: boolean
  /** uninstall the package and drop its exemptions instead of installing. */
  remove: boolean
}

/** Bare package name from an npm spec (drops any `@version` suffix). */
function packageNameFromSpec(spec: string): string | null {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return spec
  const suffix = spec.slice(at + 1)
  return suffix.includes('/') ? spec : spec.slice(0, at)
}

/** Read the global dsh CLI version (`dsh --version`); null when unavailable. */
async function readDshVersion(): Promise<string | null> {
  const result = await runDsh(['--version'])
  if (result.code !== 0) return null
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.output)
  return match === null ? null : match[1]!
}

/**
 * Resolve the running dsh version for one profile. The desktop app reads its
 * own release; otherwise the global dsh CLI version is authoritative (the
 * shared closure mirror goes stale under runtime resolution), with the mirror
 * as a fallback for non-standard installs.
 */
async function resolveProfileDshVersion(paths: DshPaths, profileName: string, config: OpsConfig): Promise<string | null> {
  if (isDesktopProfile(profileName)) return detectDesktop().version
  const global = await readDshVersion()
  if (global !== null) return global
  const anchor = locateInstallAnchor(paths, config.installAnchor ?? null)
  if (anchor === null) return null
  const manifest = readPackageManifest(dirname(anchor))
  return typeof manifest?.version === 'string' ? manifest.version : null
}

/**
 * The bundled desktop CLI (0.2.0-rc.1+), when the installed desktop release
 * ships one. Its `dsh plugin --profile desktop` may manage the reserved
 * profile while the app is quit; calling it by absolute path does not depend
 * on the user's PATH registration.
 */
function resolveDesktopCli(): string | null {
  const info = detectDesktop()
  if (info.installDir === null || !desktopCliSupportsPluginManagement(info.version)) return null
  return resolveDesktopCliLauncher(info.installDir)
}

/** Run one command with piped output. */
function runCommand(bin: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error) => resolve({ code: 127, output: String(error) }))
    child.on('close', (code) => resolve({ code, output }))
  })
}

/** Run one dsh command with the ambient environment. */
function runDsh(args: string[]): Promise<{ code: number | null; output: string }> {
  return runCommand('dsh', args)
}

/**
 * Uninstall one adapted package and drop its exact-version exemptions, so a
 * plugin removed after an adapted install leaves no stale compatibility grant
 * behind. The removal runs first; the exemption cleanup only follows a
 * successful uninstall.
 */
async function runAdaptRemove(options: AdaptCommandOptions): Promise<number> {
  const name = packageNameFromSpec(options.spec)
  if (name === null || name === '') {
    process.stderr.write('adapt: cannot derive a package name from the spec\n')
    return 2
  }
  if (isDesktopProfile(options.profileName)) {
    const desktopCli = resolveDesktopCli()
    const manifest = readProfileManifest(options.paths.profileManifest)
    const installed = manifest?.dependencies !== undefined && name in manifest.dependencies
    if (installed && desktopCli !== null) {
      process.stdout.write(`adapt: desktop CLI found; uninstalling ${name} (the desktop app must be fully quit)...\n`)
      const remove = await runCommand(desktopCli, ['plugin', '--profile', options.profileName, 'remove', name])
      if (remove.code !== 0) {
        process.stderr.write(`adapt: desktop CLI uninstall failed (exit ${remove.code ?? 'timeout'}); if the desktop app is running, quit it completely and retry\n  ${remove.output.slice(-1500)}\n`)
        return 1
      }
      const cleanup = removeExemptionsForPackage(options.paths.profileDir, name)
      process.stdout.write(`adapt: uninstalled ${name}${cleanup.ok ? `; ${cleanup.detail}` : ''}\n`)
      return 0
    }
    if (installed) {
      // Cleanup must follow the uninstall: dropping the exemption while the
      // plugin stays installed would make the launcher skip it silently.
      process.stdout.write(`adapt: desktop profile: ${name} is still installed — uninstall it from the desktop app's Plugins page first, then re-run:\n  dsh-ops adapt ${name} --profile ${options.profileName} --remove\n`)
      return 0
    }
    const cleanup = removeExemptionsForPackage(options.paths.profileDir, name)
    process.stdout.write(`adapt: desktop profile: ${name} is not installed; ${cleanup.ok ? cleanup.detail : 'exemption cleanup failed'}\n`)
    return cleanup.ok ? 0 : 1
  }
  process.stdout.write(`adapt: uninstalling ${name} from profile ${options.profileName}...\n`)
  const remove = await runDsh(['plugin', '--profile', options.profileName, 'remove', name])
  if (remove.code !== 0) {
    process.stderr.write(`adapt: uninstall failed (exit ${remove.code ?? 'timeout'})\n  ${remove.output.slice(-2000)}\n`)
    return 1
  }
  const cleanup = removeExemptionsForPackage(options.paths.profileDir, name)
  process.stdout.write(`adapt: uninstalled ${name}${cleanup.ok ? `; ${cleanup.detail}` : ''}\n`)
  return 0
}

/**
 * Adapt one plugin rejected by the official compatibility gate: diagnose the
 * incompatible peers, classify the risk, grant the exact-version exemption in
 * an isolated boot first (canary), and only write the real profile and install
 * once that boot survives. A failed canary or install rolls the exemption back
 * so the profile is left unchanged.
 */
export async function runAdaptCommand(options: AdaptCommandOptions): Promise<number> {
  if (options.remove) {
    return runAdaptRemove(options)
  }
  process.stdout.write(`adapt: fetching ${options.spec} from the npm registry...\n`)
  const fetched = await fetchNpmPackage(options.spec)
  if (!fetched.ok || fetched.packageDir === null) {
    process.stderr.write(`adapt: ${fetched.error ?? 'download failed'}\n`)
    fetched.cleanup()
    return 2
  }
  const packageDir = fetched.packageDir
  try {
    const manifest = readPackageManifest(packageDir)
    if (manifest === null || typeof manifest.name !== 'string' || manifest.name.length === 0) {
      process.stderr.write('adapt: downloaded package has no readable name\n')
      return 2
    }
    const dshVersion = await resolveProfileDshVersion(options.paths, options.profileName, options.config)
    const desktopCli = isDesktopProfile(options.profileName) ? resolveDesktopCli() : null
    const diagnosis = diagnoseIncompatibility(manifest, dshVersion)
    if (diagnosis === null) {
      process.stderr.write('adapt: could not diagnose the package\n')
      return 2
    }

    if (Object.keys(diagnosis.incompatiblePeers).length === 0) {
      process.stdout.write(`adapt: ${diagnosis.packageName} is already compatible with dsh ${diagnosis.dshVersion ?? 'unknown'}; install it directly with:\n`)
      process.stdout.write(`  dsh plugin --profile ${options.profileName} add ${options.spec}\n`)
      return 0
    }

    if (diagnosis.version === null) {
      process.stderr.write('adapt: package declares no version; an exact-version exemption cannot be granted\n')
      return 2
    }

    process.stdout.write(`${renderAdaptDiagnosis(diagnosis)}\n`)

    if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = await rl.question('\ngrant the exemption and verify in an isolated boot first? [y/N] ')
        if (!/^y(es)?$/i.test(answer.trim())) {
          process.stderr.write('adapt: cancelled\n')
          return 1
        }
      } finally {
        rl.close()
      }
    }

    process.stdout.write('\nadapt: isolated boot check (grant exemption + install + launch)...\n')
    const packageName = manifest.name
    const packageVersion = diagnosis.version
    const canary = await runRuntimeVerify(
      packageDir,
      { kind: 'spec', value: options.spec },
      options.timeoutSec,
      async ({ paths: isoPaths, dsh }) => {
        // Init the isolated profile first so the canary runs the same dsh
        // release the real install will use; the exemption then names that
        // exact runtime (the shared closure mirror is absent under runtime
        // resolution, so the resolved version is authoritative).
        await dsh(['plugin', '--profile', 'web', 'install'])
        if (dshVersion !== null) {
          writeVersionExemption(isoPaths.profileDir, packageName, packageVersion, dshVersion)
        }
      },
      desktopCli ?? 'dsh',
    )
    if (!canary.ok) {
      process.stderr.write(`\nadapt: FAILED — the package did not survive an isolated boot even with the exemption:\n  ${canary.detail}\n`)
      process.stderr.write('no change was written to the real profile; the plugin likely needs a code fix from its author\n')
      return 1
    }
    process.stdout.write(`  isolated boot: BOOTED (${canary.elapsedMs}ms)\n`)

    const write = writeVersionExemption(options.paths.profileDir, packageName, packageVersion, dshVersion ?? '')
    if (!write.ok) {
      process.stderr.write(`adapt: could not write the exemption: ${write.detail}\n`)
      return 1
    }
    if (isDesktopProfile(options.profileName)) {
      if (desktopCli === null) {
        // This desktop release predates the bundled CLI (or ships none); the
        // install must run from the app. The exemption we just wrote makes it pass.
        process.stdout.write(`\nadapt: exemption granted (${write.detail})\n`)
        process.stdout.write('desktop profile: this desktop release has no bundled CLI — open the desktop app\'s Plugins page and install now; the active exemption lets it pass.\n')
        return 0
      }
      process.stdout.write(`\nadapt: exemption granted (${write.detail}); installing with the desktop CLI (the desktop app must be fully quit)...\n`)
      const desktopAdd = await runCommand(desktopCli, ['plugin', '--profile', options.profileName, 'add', options.spec])
      if (desktopAdd.code !== 0) {
        const rollback = removeVersionExemption(options.paths.profileDir, packageName, packageVersion, dshVersion ?? '')
        process.stderr.write(`\nadapt: desktop CLI install failed (exit ${desktopAdd.code ?? 'timeout'})${rollback.ok ? `; exemption revoked (${rollback.detail})` : ''}; if the desktop app is running, quit it completely and retry\n  ${desktopAdd.output.slice(-1500)}\n`)
        return 1
      }
      process.stdout.write(`\nadapt: installed ${options.spec} with an exact-version exemption; start the desktop app to activate\n`)
      return 0
    }
    process.stdout.write(`\nadapt: exemption granted (${write.detail}); installing...\n`)
    const add = await runDsh(['plugin', '--profile', options.profileName, 'add', options.spec])
    if (add.code !== 0) {
      const rollback = removeVersionExemption(options.paths.profileDir, packageName, packageVersion, dshVersion ?? '')
      process.stderr.write(`\nadapt: install failed (exit ${add.code ?? 'timeout'})${rollback.ok ? `; exemption revoked (${rollback.detail})` : ''}\n`)
      process.stderr.write(`  ${add.output.slice(-2000)}\n`)
      return 1
    }
    process.stdout.write(`\nadapt: installed ${options.spec} with an exact-version exemption; restart dsh to activate (or run dsh-ops gate --profile ${options.profileName} to pre-check)\n`)
    return 0
  } finally {
    fetched.cleanup()
  }
}
