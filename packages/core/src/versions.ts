import semver from 'semver'

/**
 * Representative releases of the known dsh semantic eras, oldest first. A
 * version-sensitive rule reads one boundary rather than a range: `all`
 * evaluates against the oldest (its strictest semantics abort on failures
 * newer releases merely warn about), `latest` against the newest, and gate or
 * unspecified callers keep the actually installed version. The era table and
 * the verified boundaries live in the private research note
 * `docs/research/dsh-version-semantics.md`.
 */
export const KNOWN_VERSION_BOUNDARIES: readonly string[] = [
  // Strict era: patch/include failures abort the whole boot.
  '0.1.5-rc.2',
  // Tolerance era: optional entry and unreadable-bundle failures degrade to warnings.
  '0.1.7-rc.2',
  // Install-compatibility-gate era (0.1.7-rc.1+) and the desktop CLI (0.2.0-rc.1+).
  '0.2.0-rc.2',
  // Retired-bundle era: the launcher drops retired bundle entries on load.
  '0.2.1-alpha.1',
  // Alpha line; loading semantics unchanged from alpha.1 (bundles reshuffled).
  '0.2.1-alpha.2',
  // Newest alpha line; boot-time loading semantics unchanged from alpha.2
  // (runtime recomposition, HMR package reload, and stored-credential
  // precedence changed; the static pre-boot checks judge boot semantics).
  '0.2.1-alpha.3',
  // engines.dsh-first era: installation and profile startup read an own
  // engines.dsh range before dsh peers (0.2.1-alpha.4+); the static rule 8
  // mirror switches to the same requirement rules at this boundary.
  '0.2.1-alpha.4',
  // rc line; boot and requirement semantics unchanged from alpha.4
  // (alpha.5 and rc.1 refined UI, PTC, and terminal behavior only).
  '0.2.1-rc.1',
  // rc.2 adds DeepSeek Search/Fetch and the Flash 1017 label; boot and
  // requirement semantics are unchanged from rc.1.
  '0.2.1-rc.2',
  // rc.3 republishes the rc line with version bumps only (the boot,
  // plugin-manager, and requirement sources are unchanged from rc.2).
  '0.2.1-rc.3',
]

/** Newest known release; the `latest` reporting target. */
export const LATEST_KNOWN_VERSION: string = KNOWN_VERSION_BOUNDARIES[KNOWN_VERSION_BOUNDARIES.length - 1]!

/** How version-sensitive severities are evaluated. */
export type VersionView = 'all' | 'latest'

/**
 * Resolve the version a version-sensitive rule evaluates against. `all` reads
 * the oldest known boundary (strictest semantics), `latest` the newest, and an
 * absent view keeps the actual version; an unknown or invalid actual version
 * falls back to the oldest boundary so it never reads as tolerant.
 * @param view - the requested reporting view, or undefined for the actual install.
 * @param actual - detected installed dsh version, or null when unknown.
 * @returns the version string the rule should judge against.
 */
export function decisionVersion(view: VersionView | undefined, actual: string | null): string {
  if (view === 'all') return KNOWN_VERSION_BOUNDARIES[0]!
  if (view === 'latest') return LATEST_KNOWN_VERSION
  return actual !== null && semver.valid(actual) !== null ? actual : KNOWN_VERSION_BOUNDARIES[0]!
}

/**
 * Version boundaries at or after a release; the compatibility gate only exists
 * from 0.1.7-rc.1 on, so earlier boundaries are not evaluated for it.
 * @param minVersion - the lowest release the caller evaluates.
 * @returns the matching known boundaries, oldest first.
 */
export function boundariesFrom(minVersion: string): string[] {
  return KNOWN_VERSION_BOUNDARIES.filter((version) => semver.gte(version, minVersion))
}

/**
 * A note naming the releases on each side of a semantic boundary, attached to
 * version-sensitive findings under the `all` view so a reader sees the range
 * that changes behavior.
 * @param boundaryVersion - the release whose semantics change.
 * @param strictText - behavior below the boundary.
 * @param tolerantText - behavior at or above the boundary.
 */
export function boundaryNote(boundaryVersion: string, strictText: string, tolerantText: string): string {
  return `dsh < ${boundaryVersion}: ${strictText}; dsh >= ${boundaryVersion}: ${tolerantText}`
}

/** Freshness of the known-release table against a registry's dist-tags. */
export interface VersionFreshness {
  /** The newest release the table knows. */
  tableCovers: string
  /** The newest release the registry reports (any dist-tag), or null when unreadable. */
  registryNewest: string | null
  /** Whether the table covers the registry's newest release; null when it could not be checked. */
  fresh: boolean | null
  /** Why the check could not run, when it could not. */
  problem: string | null
}

/**
 * Compare a registry's dist-tags against the known-release table. The newest
 * tag value across all channels is the freshness target — an untracked release
 * anywhere means version-sensitive judgments may under-report.
 * @param tags - dist-tag name → version, as the registry reports them.
 * @param tableLatest - the newest release the table knows (defaults to {@link LATEST_KNOWN_VERSION}).
 */
export function freshnessFromDistTags(tags: Record<string, string>, tableLatest: string = LATEST_KNOWN_VERSION): VersionFreshness {
  let newest: string | null = null
  for (const value of Object.values(tags)) {
    if (typeof value !== 'string' || semver.valid(value) === null) continue
    if (newest === null || semver.gt(value, newest)) newest = value
  }
  if (newest === null) {
    return { tableCovers: tableLatest, registryNewest: null, fresh: null, problem: 'the registry reported no valid versions' }
  }
  return { tableCovers: tableLatest, registryNewest: newest, fresh: !semver.gt(newest, tableLatest), problem: null }
}

/**
 * Check whether the known-release table covers the newest dsh release the
 * registry carries. Network access is explicit: callers gate this behind a
 * flag, and every failure degrades to a `problem` instead of throwing.
 * @param options - registry override (config/environment mirror) and timeout.
 */
export async function checkVersionFreshness(options: { registry?: string | null; timeoutMs?: number } = {}): Promise<VersionFreshness> {
  const registry = (options.registry ?? '').trim()
  const base = registry === '' ? 'https://registry.npmjs.org' : registry.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/@deepseek-ai%2Fdsh`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { tableCovers: LATEST_KNOWN_VERSION, registryNewest: null, fresh: null, problem: `registry responded HTTP ${res.status}` }
    }
    const body = (await res.json()) as { 'dist-tags'?: Record<string, unknown> }
    const tags: Record<string, string> = {}
    for (const [name, value] of Object.entries(body['dist-tags'] ?? {})) {
      if (typeof value === 'string') tags[name] = value
    }
    return freshnessFromDistTags(tags)
  } catch (error) {
    return {
      tableCovers: LATEST_KNOWN_VERSION,
      registryNewest: null,
      fresh: null,
      problem: error instanceof Error && error.name === 'TimeoutError' ? 'the registry did not respond in time' : String(error),
    }
  }
}
