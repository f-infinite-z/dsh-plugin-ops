import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { backupFile, writeTextAtomic } from './fsutil.js'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import type { PackageManifest } from './package-tree.js'
import { boundariesFrom, LATEST_KNOWN_VERSION } from './versions.js'

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
export function incompatibleDshPeers(manifest: PackageManifest, runtimeVersion: string): Record<string, string> | null {
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
 * Compact peer rendering for findings: a short object literal, with the peer
 * count appended when the bundle declares many (the tui bundle declares 26).
 */
function peerSummary(peers: Record<string, string>): string {
  const entries = Object.entries(peers)
  if (entries.length <= 2) return JSON.stringify(peers)
  const head = entries.slice(0, 2).map(([name, range]) => `${JSON.stringify(name)}: ${JSON.stringify(range)}`).join(', ')
  return `{${head}, … ${entries.length} dsh peers total}`
}

/**
 * Rule 8: plugin version compatibility. On dsh 0.1.7-rc.1+ a bundle whose
 * `@deepseek-ai/dsh*` peer ranges reject the running dsh version is skipped by
 * the launcher — its features silently disappear unless an exact-version
 * exemption is granted. This static mirror names the bundle before the boot
 * loses it. A bundle with an active exemption is reported at info, not fatal.
 *
 * Version views: `all` evaluates every known boundary at or after the gate's
 * minimum release and reports a bundle any of them rejects (the version note
 * names the rejected and accepted releases); `latest` evaluates only the
 * newest known release; an absent view keeps the actual install — a release
 * older than the gate, or an unknown one, is not evaluated. Severity follows
 * the actual install: only a bundle the running release itself rejects is
 * fatal, so a cross-release view reports a future upgrade blocker as a
 * warning. Official `@deepseek-ai/` bundles ship with the installation and
 * evolve with it, so a cross-release view does not evaluate them.
 */
export function rulePluginCompatibility(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const evaluate: string[] = []
  if (ctx.versionView === 'all') {
    evaluate.push(...boundariesFrom(COMPATIBILITY_MIN_VERSION))
  } else if (ctx.versionView === 'latest') {
    if (semver.gte(LATEST_KNOWN_VERSION, COMPATIBILITY_MIN_VERSION)) evaluate.push(LATEST_KNOWN_VERSION)
  } else if (ctx.dshVersion !== null && semver.valid(ctx.dshVersion) !== null && semver.gte(ctx.dshVersion, COMPATIBILITY_MIN_VERSION)) {
    evaluate.push(ctx.dshVersion)
  }
  if (evaluate.length === 0) return []
  const exemptions = readProfileVersionExemptions(ctx.paths.profileDir)
  const findings: Finding[] = []
  for (const bundle of resolved) {
    if (ctx.versionView !== undefined && bundle.name.startsWith('@deepseek-ai/')) continue
    const rejected = evaluate.filter((runtime) => incompatibleDshPeers(bundle.manifest, runtime) !== null)
    if (rejected.length === 0) continue
    const version = typeof bundle.manifest.version === 'string' ? bundle.manifest.version : ''
    const key = `${bundle.name}@${version}`
    const unexempted = rejected.filter((runtime) => exemptions[key]?.includes(runtime) !== true)
    const accepted = evaluate.filter((runtime) => !rejected.includes(runtime))
    const peers = incompatibleDshPeers(bundle.manifest, rejected[rejected.length - 1]!) ?? {}
    const rejectedList = rejected.join(', ')
    // Severity follows the actual install: a launch-blocking skip exists only
    // when the running release is itself rejected (or the release is unknown,
    // which stays conservative). A cross-release view therefore reports a
    // future upgrade blocker as a warning rather than a fatal.
    const actual = ctx.dshVersion
    const severityOnActual: 'fatal' | 'warn' = actual !== null && semver.valid(actual) !== null
      ? (semver.gte(actual, COMPATIBILITY_MIN_VERSION) && incompatibleDshPeers(bundle.manifest, actual) !== null ? 'fatal' : 'warn')
      : 'fatal'
    const summary = peerSummary(peers)
    findings.push({
      ruleId: 'plugin-compatibility',
      severity: unexempted.length > 0 ? severityOnActual : 'info',
      packageName: bundle.name,
      message: unexempted.length > 0
        ? `bundle ${bundle.name} peer ranges ${summary} reject dsh ${rejectedList}; the launcher skips this bundle${severityOnActual === 'warn' ? ' on those releases' : ''}`
        : `bundle ${bundle.name} peer ranges ${summary} reject dsh ${rejectedList}, but an exact-version exemption is active`,
      detail: unexempted.length > 0
        ? 'update the plugin, or grant an exact-version exemption (dsh plugin allow-version) then restart dsh'
        : 'the exemption names this exact bundle@version and runtime; the bundle loads despite the mismatch',
      ...(ctx.versionView === 'all'
        ? {
            versionNote: accepted.length > 0
              ? `rejected by ${rejectedList}; accepted by ${accepted.join(', ')}`
              : `rejected by every known release at or after ${COMPATIBILITY_MIN_VERSION}`,
          }
        : {}),
      fix: { kind: 'none' },
    })
  }
  return findings
}

/** Result of one exemption-file write. */
export interface ExemptionWriteResult {
  ok: boolean
  detail: string
  backup: string | null
}

/**
 * Grant an exact-version exemption: authorize `<name>@<version>` to run on
 * `dshVersion` despite its incompatible `@deepseek-ai/dsh*` peers. Mirrors the
 * official `setVersionExemption` by writing the profile's `compatibility.json`
 * (`{ "<name>@<version>": ["<dsh-version>"] }`), preserving existing entries.
 * The write is backed up and atomic; the exemption is the launcher's own
 * escape hatch, so it never reaches outside the whitelisted profile file.
 */
export function writeVersionExemption(
  profileDir: string,
  name: string,
  version: string,
  dshVersion: string,
): ExemptionWriteResult {
  const file = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const existing = readProfileVersionExemptions(profileDir)
  const key = `${name}@${version}`
  const list = [...(existing[key] ?? [])]
  if (!list.includes(dshVersion)) list.push(dshVersion)
  const backup = backupFile(file)
  writeTextAtomic(file, `${JSON.stringify({ ...existing, [key]: list }, null, 2)}\n`)
  return { ok: true, detail: `granted ${key} -> ${dshVersion}`, backup }
}

/**
 * Revoke one exact-version exemption, removing the runtime from
 * `<name>@<version>`'s list and dropping the key when it becomes empty.
 * Idempotent; a missing file or key is a successful no-op.
 */
export function removeVersionExemption(
  profileDir: string,
  name: string,
  version: string,
  dshVersion: string,
): ExemptionWriteResult {
  const file = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const existing = readProfileVersionExemptions(profileDir)
  const key = `${name}@${version}`
  if (existing[key] === undefined) return { ok: true, detail: `no exemption for ${key}`, backup: null }
  const list = existing[key]!.filter((v) => v !== dshVersion)
  const next = { ...existing }
  if (list.length === 0) delete next[key]
  else next[key] = list
  const backup = backupFile(file)
  writeTextAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, detail: `revoked ${key} -> ${dshVersion}`, backup }
}

/**
 * Remove every exact-version exemption for one package name (any version).
 * Used by the uninstall path so a plugin removed after an adapted install
 * does not leave a stale exemption behind. Idempotent; a missing file or an
 * absent name is a successful no-op.
 */
export function removeExemptionsForPackage(profileDir: string, name: string): ExemptionWriteResult {
  const file = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const existing = readProfileVersionExemptions(profileDir)
  const keys = Object.keys(existing).filter((key) => key === name || key.startsWith(`${name}@`))
  if (keys.length === 0) return { ok: true, detail: `no exemptions for ${name}`, backup: null }
  const next = { ...existing }
  for (const key of keys) delete next[key]
  const backup = backupFile(file)
  writeTextAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, detail: `removed ${keys.length} exemption(s) for ${name}`, backup }
}
