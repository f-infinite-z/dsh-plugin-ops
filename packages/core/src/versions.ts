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
