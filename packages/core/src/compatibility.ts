import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import type { PackageManifest } from './package-tree.js'

/**
 * dsh releases at or after this version check a bundle's `@deepseek-ai/dsh*`
 * peer ranges against the running dsh version and skip an incompatible bundle
 * (verified: the check shipped in 0.1.7-rc.1). Older releases load without it.
 */
export const COMPATIBILITY_MIN_VERSION = '0.1.7-rc.1'

/** Profile-local exact-version exemption file the official launcher reads. */
export const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'

/** A `workspace:` peer spec that always refers to the current runtime. */
const WORKSPACE_RUNTIME_SPECS = ['workspace:^', 'workspace:~', 'workspace:*']

/**
 * Read the profile's exact-version exemptions, mirroring the official
 * `readProfileVersionExemptions`: `{ "<name>@<version>": ["<dsh-version>"] }`.
 * A missing or unreadable file authorizes nothing.
 */
export function readProfileVersionExemptions(profileDir: string): Record<string, string[]> {
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  if (!existsSync(filename)) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string[]> = {}
    for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(versions) && versions.every((v) => typeof v === 'string')) {
        out[key] = versions as string[]
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Evaluate one bundle's `@deepseek-ai/dsh*` peers against the running dsh
 * version, mirroring the official `evaluatePluginCompatibility`: only
 * `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are checked; `workspace:^`,
 * `workspace:~`, and `workspace:*` refer to the runtime and always match; any
 * other range must satisfy the runtime with prereleases included.
 * @returns the incompatible peers, or null when none are incompatible.
 */
function incompatibleDshPeers(manifest: PackageManifest, runtimeVersion: string): Record<string, string> | null {
  const deps = manifest.peerDependencies
  if (deps === undefined) return null
  const peers: Record<string, string> = {}
  for (const [name, range] of Object.entries(deps)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = WORKSPACE_RUNTIME_SPECS.includes(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  return Object.keys(peers).length === 0 ? null : peers
}

/**
 * Rule 8: plugin version compatibility. On dsh 0.1.7-rc.1+ a bundle whose
 * `@deepseek-ai/dsh*` peer ranges reject the running dsh version is skipped by
 * the launcher — its features silently disappear unless an exact-version
 * exemption is granted. This static mirror names the bundle before the boot
 * loses it. A bundle with an active exemption is reported at info, not fatal.
 */
export function rulePluginCompatibility(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  if (ctx.dshVersion === null || !semver.valid(ctx.dshVersion) || semver.lt(ctx.dshVersion, COMPATIBILITY_MIN_VERSION)) {
    return []
  }
  const exemptions = readProfileVersionExemptions(ctx.paths.profileDir)
  const findings: Finding[] = []
  for (const bundle of resolved) {
    const peers = incompatibleDshPeers(bundle.manifest, ctx.dshVersion)
    if (peers === null) continue
    const version = typeof bundle.manifest.version === 'string' ? bundle.manifest.version : ''
    const key = `${bundle.name}@${version}`
    const exempted = exemptions[key]?.includes(ctx.dshVersion) === true
    findings.push({
      ruleId: 'plugin-compatibility',
      severity: exempted ? 'info' : 'fatal',
      packageName: bundle.name,
      message: exempted
        ? `bundle ${bundle.name} peer ranges ${JSON.stringify(peers)} reject dsh ${ctx.dshVersion}, but an exact-version exemption is active`
        : `bundle ${bundle.name} peer ranges ${JSON.stringify(peers)} reject dsh ${ctx.dshVersion}; the launcher skips this bundle`,
      detail: exempted
        ? 'the exemption names this exact bundle@version and runtime; the bundle loads despite the mismatch'
        : 'update the plugin, or grant an exact-version exemption (dsh plugin allow-version) then restart dsh',
      fix: { kind: 'none' },
    })
  }
  return findings
}
