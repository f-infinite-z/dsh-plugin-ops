import semver from 'semver'
import { detectDesktop, isDesktopProfile } from './desktop.js'
import { readGlobalDshVersion } from './dsh-version.js'
import { buildResolutionGeneration, dshVersionOf, locateInstallAnchor } from './generation.js'
import { readProfileManifest, resolveBundles, type ResolvedBundle } from './profile.js'
import { unmetDshRequirements, readProfileVersionExemptions } from './compatibility.js'
import { classifyPeerRisk, type AdaptRisk } from './adapt.js'
import { isRetiredBundle } from './retired.js'
import { checkVersionFreshness, LATEST_KNOWN_VERSION, type VersionFreshness } from './versions.js'
import type { DshPaths } from './paths.js'
import type { OpsConfig } from './config.js'

/**
 * Whole-profile upgrade rehearsal: given a target dsh release, report which
 * installed third-party bundles that release's compatibility gate would skip,
 * and what each one's fix is — a compatible update, an exact-version
 * exemption, or disabling the row. Read-only: the report never writes to the
 * profile, and the rendering follows the same compatibility judgment
 * (`unmetDshRequirements`) the launcher and rule 8 use.
 */

/** The release a preview rehearses against. */
export interface PreviewTarget {
  version: string
  /** `explicit` = named by the caller; `registry` = newest dist-tag seen online; `table-latest` = newest known release. */
  source: 'explicit' | 'registry' | 'table-latest'
}

/** How the target release treats one bundle. */
export type PreviewVerdict =
  | 'skipped'
  | 'exempted'
  | 'compatible'
  | 'retired'
  | 'unresolved'

/** The recommended fix for a skipped bundle. */
export type PreviewFix = 'update' | 'exempt' | 'disable' | 'none'

/** One bundle's rehearsal result. */
export interface PreviewEntry {
  name: string
  /** Installed version from the bundle manifest; null when undeclared. */
  version: string | null
  verdict: PreviewVerdict
  /**
   * The unmet dsh requirements that reject the target release (keyed
   * `engines.dsh` or by peer name).
   */
  requirements?: Record<string, string>
  /**
   * @deprecated Legacy alias of {@link requirements}, kept one release for
   * existing report consumers; both keys carry the same object.
   */
  peers?: Record<string, string>
  /** Breaking-boundary classification of those requirements, when present. */
  risk?: AdaptRisk
  fix: PreviewFix
  /** Shell-ready commands implementing the fix; empty when the fix has no command form. */
  commands: string[]
  /** The registry's newest version, when the update check answered for this package. */
  latest?: string | null
  /** Whether the newest version accepts the target release; null when unknown or not applicable. */
  latestCompatible?: boolean | null
  detail: string
}

/** Aggregate counts over one preview report. */
export interface PreviewCounts {
  /** Bundles the target release would skip. */
  skipped: number
  /** Skipped bundles whose fix is a compatible update. */
  updatable: number
  /** Skipped bundles whose fix is an exact-version exemption. */
  exempt: number
  /** Skipped bundles with no fix path (no installed version to exempt). */
  disable: number
  /** Bundles whose active exemption already covers the target. */
  exempted: number
  compatible: number
  retired: number
  unresolved: number
}

/** One upgrade rehearsal's full result. */
export interface PreviewReport {
  profile: string
  profileDir: string
  /** The running dsh release, or null when unknown. */
  runningVersion: string | null
  target: PreviewTarget
  entries: PreviewEntry[]
  counts: PreviewCounts
  /** Present when the target resolution ran the registry check; `problem` names why it could not answer. */
  registry?: { checked: boolean; newest: string | null; problem: string | null }
}

export interface PreviewInput {
  paths: DshPaths
  profileName: string
  /** Target dsh release to rehearse against; null resolves from the update check, then the known-release table. */
  target?: string | null
  /** Query the registry: the newest dsh dist-tag as the default target, and per-plugin newest versions for update fixes. */
  updateCheck?: boolean
  /** Registry base URL override (config or environment mirror); null uses registry.npmjs.org. */
  registry?: string | null
  config?: OpsConfig | null
  timeoutMs?: number
  /**
   * Override for the running dsh version the report names. undefined reads
   * the running install (desktop release, global CLI, then the mirror); null
   * forces "unknown". An override never changes the target.
   */
  dshVersion?: string | null
}

export class PreviewError extends Error {}

/** Value a JSON body may hold for the fields preview reads from a registry document. */
interface RegistryPackageDocument {
  'dist-tags'?: Record<string, unknown>
  versions?: Record<string, unknown>
}

/** One registry lookup for a package's newest release and its dsh requirements. */
interface LatestPackageInfo {
  latest: string | null
  /** All peerDependencies recorded for the newest release (the pre-alpha.4 source). */
  peers: Record<string, string> | null
  /** The newest release's own engines object; `engines.dsh` takes precedence from 0.2.1-alpha.4 on. */
  engines: Record<string, unknown> | null
}

/** The base judgment of one bundle, before the registry update pass. */
interface BundleBase {
  name: string
  version: string | null
  requirements: Record<string, string> | null
  risk: AdaptRisk | null
  kind: 'skipped' | 'exempted' | 'compatible' | 'retired' | 'official'
  detail: string
}

/** All peerDependencies recorded for one version entry in a registry document. */
function peerDependenciesOf(document: RegistryPackageDocument, version: string): Record<string, string> | null {
  const entry = document.versions?.[version]
  if (entry === null || typeof entry !== 'object') return null
  const peers = (entry as { peerDependencies?: unknown }).peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return {}
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(peers as Record<string, unknown>)) {
    if (typeof range === 'string') out[name] = range
  }
  return out
}

/** The engines object recorded for one version entry, or null when it is absent or malformed. */
function enginesOf(document: RegistryPackageDocument, version: string): Record<string, unknown> | null {
  const entry = document.versions?.[version]
  if (entry === null || typeof entry !== 'object') return null
  const engines = (entry as { engines?: unknown }).engines
  if (engines === null || typeof engines !== 'object' || Array.isArray(engines)) return null
  return engines as Record<string, unknown>
}

/**
 * Read one package's newest release and its dsh requirements from the
 * registry. The abbreviated metadata format keeps the response small; a mirror
 * that ignores it still answers with the full document, which has the same
 * fields. Every failure degrades to `null` fields instead of throwing.
 */
async function fetchLatestPackageInfo(
  name: string,
  registry: string | null,
  timeoutMs: number,
): Promise<LatestPackageInfo> {
  const trimmed = (registry ?? '').trim()
  const base = trimmed === '' ? 'https://registry.npmjs.org' : trimmed.replace(/\/+$/, '')
  const encoded = name.replace('/', '%2F')
  try {
    const res = await fetch(`${base}/${encoded}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return { latest: null, peers: null, engines: null }
    const document = (await res.json()) as RegistryPackageDocument
    const latest = document['dist-tags']?.latest
    if (typeof latest !== 'string' || semver.valid(latest) === null) return { latest: null, peers: null, engines: null }
    return { latest, peers: peerDependenciesOf(document, latest), engines: enginesOf(document, latest) }
  } catch {
    return { latest: null, peers: null, engines: null }
  }
}

/** Whether an active exemption names this exact bundle version and runtime. */
function exemptionCovers(
  exemptions: Record<string, string[]>,
  name: string,
  version: string | null,
  runtime: string,
): boolean {
  if (version === null) return false
  return exemptions[`${name}@${version}`]?.includes(runtime) === true
}

/** Escaped Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** The verdict order a report renders in: at-risk first. */
const VERDICT_ORDER: Record<PreviewVerdict, number> = {
  skipped: 0,
  exempted: 1,
  retired: 2,
  unresolved: 3,
  compatible: 4,
}

/**
 * Rehearse one profile upgrade. Resolves the target release (explicit, via the
 * registry when the update check is on, or the newest known release), then
 * judges every installed third-party bundle against that release's
 * compatibility gate and derives each one's fix.
 * @param input - profile locations, target override, and update-check policy.
 * @returns the rehearsal report; never writes to the profile.
 * @throws PreviewError when the profile has no readable manifest or the target is not a valid version.
 */
export async function buildPreviewReport(input: PreviewInput): Promise<PreviewReport> {
  const manifest = readProfileManifest(input.paths.profileManifest)
  if (manifest === null) {
    throw new PreviewError(
      `profile ${JSON.stringify(input.profileName)} has no readable manifest at ${input.paths.profileManifest}; `
      + "start the profile once with dsh to initialize it, or check DSH_HOME",
    )
  }
  if (input.target !== null && input.target !== undefined && semver.valid(input.target) === null) {
    throw new PreviewError(`target is not a valid dsh version: ${JSON.stringify(input.target)}`)
  }
  const timeoutMs = input.timeoutMs ?? 10_000
  const desktop = isDesktopProfile(input.profileName) ? detectDesktop() : null
  const installAnchor = locateInstallAnchor(input.paths, input.config?.installAnchor ?? null)
  const { resolved, problems } = resolveBundles(input.paths, manifest, installAnchor, desktop !== null)
  const generation = buildResolutionGeneration(installAnchor, resolved, input.paths.profileDir)
  const runningVersion = input.dshVersion === undefined
    ? desktop?.version ?? (await readGlobalDshVersion()) ?? dshVersionOf(generation)
    : input.dshVersion

  let target: PreviewTarget
  let registryInfo: PreviewReport['registry']
  if (input.target !== null && input.target !== undefined) {
    target = { version: input.target, source: 'explicit' }
  } else if (input.updateCheck === true) {
    const freshness: VersionFreshness = await checkVersionFreshness({ registry: input.registry ?? null, timeoutMs })
    registryInfo = { checked: true, newest: freshness.registryNewest, problem: freshness.problem }
    target = freshness.registryNewest !== null
      ? { version: freshness.registryNewest, source: 'registry' }
      : { version: LATEST_KNOWN_VERSION, source: 'table-latest' }
  } else {
    target = { version: LATEST_KNOWN_VERSION, source: 'table-latest' }
  }

  const exemptions = readProfileVersionExemptions(input.paths.profileDir)
  const bases = resolved.map((bundle) => judgeBundle(bundle, target.version, exemptions))
  const updateNames = input.updateCheck === true
    ? [...new Set(bases.filter((base) => base.kind === 'skipped').map((base) => base.name))]
    : []
  const updates = new Map<string, LatestPackageInfo>()
  await Promise.all(updateNames.map(async (name) => {
    updates.set(name, await fetchLatestPackageInfo(name, input.registry ?? null, timeoutMs))
  }))

  const entries: PreviewEntry[] = []
  for (const base of bases) {
    if (base.kind === 'official') continue
    entries.push(finalizeEntry(base, target.version, input.profileName, updates.get(base.name), input.updateCheck === true))
  }
  for (const problem of problems) {
    if (problem.name.startsWith('@deepseek-ai/')) continue
    entries.push({
      name: problem.name,
      version: null,
      verdict: 'unresolved',
      fix: 'none',
      commands: [],
      detail: problem.message,
    })
  }
  entries.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.name.localeCompare(b.name))

  const counts: PreviewCounts = {
    skipped: 0, updatable: 0, exempt: 0, disable: 0,
    exempted: 0, compatible: 0, retired: 0, unresolved: 0,
  }
  for (const entry of entries) {
    counts[entry.verdict]++
    if (entry.verdict === 'skipped') {
      if (entry.fix === 'update') counts.updatable++
      else if (entry.fix === 'exempt') counts.exempt++
      else if (entry.fix === 'disable') counts.disable++
    }
  }

  return {
    profile: input.profileName,
    profileDir: input.paths.profileDir,
    runningVersion,
    target,
    entries,
    counts,
    ...(registryInfo === undefined ? {} : { registry: registryInfo }),
  }
}

/**
 * Judge one resolved bundle against the target release without network access.
 * Official `@deepseek-ai/` bundles ship with the installation and evolve with
 * it, so they are never judged; a retired bundle and an active exemption are
 * reported as such.
 */
function judgeBundle(
  bundle: ResolvedBundle,
  targetVersion: string,
  exemptions: Record<string, string[]>,
): BundleBase {
  const version = typeof bundle.manifest.version === 'string' ? bundle.manifest.version : null
  if (isRetiredBundle(bundle.name, targetVersion)) {
    return {
      name: bundle.name,
      version,
      requirements: null,
      risk: null,
      kind: 'retired',
      detail: `dsh ${targetVersion} retires this bundle; the launcher drops the entry on load`,
    }
  }
  if (bundle.name.startsWith('@deepseek-ai/')) {
    return {
      name: bundle.name,
      version,
      requirements: null,
      risk: null,
      kind: 'official',
      detail: 'official bundle — ships with the installation and evolves with it; not evaluated',
    }
  }
  const requirements = unmetDshRequirements(bundle.manifest, targetVersion)
  if (requirements === null) {
    return {
      name: bundle.name,
      version,
      requirements: null,
      risk: null,
      kind: 'compatible',
      detail: `dsh requirements accept ${targetVersion}`,
    }
  }
  const risk = classifyPeerRisk(requirements, targetVersion)
  if (exemptionCovers(exemptions, bundle.name, version, targetVersion)) {
    return {
      name: bundle.name,
      version,
      requirements,
      risk,
      kind: 'exempted',
      detail: `an exact-version exemption covers ${bundle.name}@${version} on dsh ${targetVersion}; the bundle keeps loading`,
    }
  }
  return {
    name: bundle.name,
    version,
    requirements,
    risk,
    kind: 'skipped',
    detail: `dsh requirements reject ${targetVersion}`,
  }
}

/**
 * Turn one base judgment into its report entry, deriving a skipped bundle's
 * fix from the registry answer when the update check ran: a newer compatible
 * release means update; otherwise an exemption (or disable when no version can
 * be named).
 */
function finalizeEntry(
  base: BundleBase,
  targetVersion: string,
  profile: string,
  update: LatestPackageInfo | undefined,
  checked: boolean,
): PreviewEntry {
  if (base.kind !== 'skipped') {
    // Official bundles are filtered by the caller before finalization; the
    // mapping keeps this branch total without a runtime assertion.
    const verdict: PreviewVerdict = base.kind === 'official' ? 'compatible' : base.kind
    return {
      name: base.name,
      version: base.version,
      verdict,
      ...(base.requirements === null ? {} : { requirements: base.requirements, peers: base.requirements }),
      ...(base.risk === null ? {} : { risk: base.risk }),
      fix: 'none',
      commands: [],
      detail: base.detail,
    }
  }
  const head = {
    name: base.name,
    version: base.version,
    verdict: 'skipped' as const,
    requirements: base.requirements ?? {},
    peers: base.requirements ?? {},
    ...(base.risk === null ? {} : { risk: base.risk }),
  }
  if (checked && update !== undefined) {
    const latest = update.latest
    const latestCompatible = latest !== null && (update.peers !== null || update.engines !== null)
      ? unmetDshRequirements({
          ...(update.peers !== null ? { peerDependencies: update.peers } : {}),
          ...(update.engines !== null ? { engines: update.engines } : {}),
        }, targetVersion) === null
      : null
    if (latest !== null && latest !== base.version && latestCompatible === true) {
      return {
        ...head,
        fix: 'update',
        latest,
        latestCompatible: true,
        commands: [`dsh plugin --profile ${profile} add ${base.name}@${latest}`],
        detail: `${latest} accepts ${targetVersion}; update before upgrading`,
      }
    }
    if (base.version === null) {
      return {
        ...head,
        fix: 'disable',
        latest,
        latestCompatible,
        commands: [],
        detail: latest !== null && latest !== base.version && latestCompatible === false
          ? `the installed bundle declares no version to exempt and even ${latest} rejects ${targetVersion}; update the plugin or disable the row`
          : `the bundle declares no version to exempt; update the plugin or disable the row`,
      }
    }
    if (latest === base.version) {
      return {
        ...head,
        fix: 'exempt',
        latest,
        latestCompatible: false,
        commands: [exemptionCommand(profile, base.name, base.version, targetVersion)],
        detail: `${base.version} is the newest release and still rejects ${targetVersion}; grant the exemption or disable the row`,
      }
    }
    if (latest !== null && latestCompatible === false) {
      return {
        ...head,
        fix: 'exempt',
        latest,
        latestCompatible: false,
        commands: [exemptionCommand(profile, base.name, base.version, targetVersion)],
        detail: `even the newest release ${latest} rejects ${targetVersion}; grant the exemption or disable the row`,
      }
    }
    return {
      ...head,
      fix: 'exempt',
      latest,
      latestCompatible,
      commands: [exemptionCommand(profile, base.name, base.version, targetVersion)],
      detail: latest === null
        ? 'the registry did not answer for this package; grant the exemption or re-run with --updates'
        : 'grant the exemption or disable the row',
    }
  }
  if (base.version === null) {
    return {
      ...head,
      fix: 'disable',
      commands: [],
      detail: 'the bundle declares no version, so an exact-version exemption cannot be granted; update the plugin or disable the row',
    }
  }
  return {
    ...head,
    fix: 'exempt',
    commands: [exemptionCommand(profile, base.name, base.version, targetVersion)],
    detail: 'grant the exemption (re-run with --updates to check for a compatible update first)',
  }
}

/** The official CLI command that grants one exact-version exemption. */
function exemptionCommand(profile: string, name: string, version: string, dshVersion: string): string {
  return `dsh plugin --profile ${profile} allow-version ${name}@${version} --dsh-version ${dshVersion} --accept-risk`
}

/** Target provenance in prose. */
function targetSourceText(target: PreviewTarget): string {
  if (target.source === 'explicit') return 'requested target'
  if (target.source === 'registry') return 'newest registry release'
  return 'newest known release'
}

/**
 * Render the report for the CLI: the upgrade direction, per-verdict bundles
 * with their fix commands, then the same judgment caveats the engine applies.
 */
export function renderPreviewReport(report: PreviewReport): string {
  const lines: string[] = []
  lines.push(`dsh-ops preview — profile ${report.profile}`)
  lines.push(`running dsh ${report.runningVersion ?? 'unknown'} → target ${report.target.version} (${targetSourceText(report.target)})`)
  lines.push('')
  const { counts } = report
  if (counts.skipped > 0) {
    const fixSummary = [
      counts.updatable > 0 ? `${counts.updatable} with a compatible update` : '',
      counts.exempt > 0 ? `${counts.exempt} needing an exemption` : '',
      counts.disable > 0 ? `${counts.disable} with no fix path` : '',
    ].filter((text) => text !== '').join(', ')
    lines.push(`${counts.skipped} plugin(s) would be skipped by this upgrade: ${fixSummary}`)
  } else {
    lines.push('no plugin would be skipped by this upgrade')
  }
  const context = [
    counts.exempted > 0 ? `${counts.exempted} already exempted` : '',
    counts.retired > 0 ? `${counts.retired} retired` : '',
    counts.unresolved > 0 ? `${counts.unresolved} unresolved` : '',
    `${counts.compatible} compatible`,
  ].filter((text) => text !== '').join('; ')
  lines.push(`(${context})`)
  lines.push('')

  const skipped = report.entries.filter((entry) => entry.verdict === 'skipped')
  if (skipped.length > 0) {
    lines.push('SKIPPED')
    for (const entry of skipped) {
      const requirements = Object.entries(entry.requirements ?? entry.peers ?? {})
        .map(([name, range]) => `${name}: ${range}`)
        .join(', ')
      lines.push(`  ${entry.name}@${entry.version ?? '?'} — dsh requirements reject ${report.target.version}`)
      lines.push(`    requirements: ${requirements} (risk: ${entry.risk === 'narrow' ? 'NARROW' : 'CROSS-MAJOR'})`)
      lines.push(`    ${entry.detail}`)
      for (const command of entry.commands) lines.push(`      ${command}`)
    }
    lines.push('')
  }
  const exempted = report.entries.filter((entry) => entry.verdict === 'exempted')
  if (exempted.length > 0) {
    lines.push('ALREADY EXEMPTED')
    for (const entry of exempted) lines.push(`  ${entry.name}@${entry.version ?? '?'} — ${entry.detail}`)
    lines.push('')
  }
  const retired = report.entries.filter((entry) => entry.verdict === 'retired')
  if (retired.length > 0) {
    lines.push('RETIRED')
    for (const entry of retired) lines.push(`  ${entry.name} — ${entry.detail}`)
    lines.push('')
  }
  const unresolved = report.entries.filter((entry) => entry.verdict === 'unresolved')
  if (unresolved.length > 0) {
    lines.push('UNRESOLVED')
    for (const entry of unresolved) lines.push(`  ${entry.name} — ${entry.detail}`)
    lines.push('')
  }
  const compatible = report.entries.filter((entry) => entry.verdict === 'compatible')
  if (compatible.length > 0) {
    lines.push(`COMPATIBLE (${compatible.length})`)
    lines.push(`  ${compatible.map((entry) => entry.name).join(', ')}`)
    lines.push('')
  }
  lines.push('notes:')
  lines.push('- official @deepseek-ai/* bundles ship with the installation and are not evaluated')
  lines.push('- requirements come from engines.dsh (dsh 0.2.1-alpha.4+) or dsh peer ranges')
  if (report.registry === undefined) {
    lines.push('- update check skipped (offline); pass --updates to ask the registry for compatible releases')
  } else if (report.registry.problem !== null) {
    lines.push(`- update check degraded: ${report.registry.problem}`)
  }
  return lines.join('\n')
}

/**
 * Render the report as a Markdown compatibility table — the profile-level
 * companion to `verify --report`'s package-level matrix. Deterministic: no
 * timestamps are embedded.
 */
export function renderPreviewMatrix(report: PreviewReport): string {
  const lines: string[] = []
  lines.push(`# Upgrade preview — profile \`${report.profile}\``)
  lines.push('')
  lines.push(`- running dsh: ${report.runningVersion ?? 'unknown'}`)
  lines.push(`- target: ${report.target.version} (${targetSourceText(report.target)})`)
  if (report.registry !== undefined) {
    lines.push(`- registry check: ${report.registry.problem === null ? `newest seen ${report.registry.newest ?? 'unknown'}` : `degraded — ${report.registry.problem}`}`)
  } else {
    lines.push('- registry check: not run (offline)')
  }
  lines.push('')
  lines.push('| plugin | version | verdict | unmet requirements | fix |')
  lines.push('|---|---|---|---|---|')
  for (const entry of report.entries) {
    const requirements = Object.entries(entry.requirements ?? entry.peers ?? {}).map(([name, range]) => `${name}: ${range}`).join(', ')
    const fix = entry.commands.length > 0 ? entry.commands[0]! : entry.fix
    lines.push(`| ${cell(entry.name)} | ${cell(entry.version ?? '')} | ${entry.verdict} | ${cell(requirements)} | ${cell(fix)} |`)
  }
  lines.push('')
  return lines.join('\n')
}
