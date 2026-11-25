import semver from 'semver'

/**
 * Node.js requirements the official dsh releases declare in `engines.node`.
 * The launcher refuses to start below its floor, so dsh-ops reports the gap
 * before an upgrade instead of letting the boot fail blind.
 *
 * Keep this table in sync with the official release notes when a release
 * raises the floor (`docs/upgrade-guide/*` in the `@deepseek-ai/dsh` tarball).
 */
export const DSH_NODE_REQUIREMENTS: readonly { since: string; range: string }[] = Object.freeze([
  // The undici security floor: 24.22.3 is the first bundled-undici release
  // with the November 2026 fixes, and every earlier 24.x and 26.x release is
  // no longer supported.
  { since: '0.2.3-alpha.2', range: '^24.22.3 || >=26.13.1' },
])

/**
 * The `engines.node` range a dsh release requires, or null when the release
 * predates the first tracked requirement (or the version is unknown).
 * @param dshVersion - installed or planned dsh version, or null when unknown.
 * @returns the newest declared range at or before the version, or null.
 */
export function dshNodeRequirement(dshVersion: string | null | undefined): string | null {
  if (dshVersion === null || dshVersion === undefined || semver.valid(dshVersion) === null) return null
  let requirement: string | null = null
  // The table is oldest-first, so the last satisfied boundary wins.
  for (const entry of DSH_NODE_REQUIREMENTS) {
    if (semver.gte(dshVersion, entry.since)) requirement = entry.range
  }
  return requirement
}

/**
 * Whether one Node.js version satisfies a declared engines range. Prerelease
 * Node builds (nightly/RC) are judged with the same semantics npm uses.
 * @param nodeVersion - a `process.version`-shaped version (`24.22.1` or `v24.22.1`).
 * @param range - the `engines.node` range to check.
 * @returns true when the version satisfies the range; false when it does not
 *   or either input is unusable.
 */
export function nodeSatisfiesRequirement(nodeVersion: string, range: string): boolean {
  const normalized = nodeVersion.replace(/^v/u, '')
  if (semver.valid(normalized) === null || semver.validRange(range) === null) return false
  return semver.satisfies(normalized, range, { includePrerelease: true })
}
