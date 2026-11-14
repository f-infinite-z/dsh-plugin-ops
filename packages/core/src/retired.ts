import semver from 'semver'

/**
 * Bundles an official dsh release retired, mapped to the first launcher
 * release that removes the entry from a profile's `dsh.profile.bundles`
 * while loading it and rewrites the manifest, so a leftover entry heals on
 * the next start.
 *
 * The upstream set lives in `@deepseek-ai/dsh-official-bundles`
 * (`RETIRED_BUNDLES`, imported by app-boot's `profile.ts`); keep this list in
 * sync when a release retires another bundle.
 */
export const RETIRED_BUNDLE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  // Web mounts Schedule itself since 0.2.1-alpha.1; the Automation tasks
  // bundle only lived through the 0.2.0-rc line.
  '@deepseek-ai/dsh-experimental-schedule-bundle': '0.2.1-alpha.1',
  // 0.2.2-rc.2 retires the agent-team profile after folding its capabilities
  // into the shipped optional bundles.
  '@deepseek-ai/dsh-experimental-agent-team-profile': '0.2.2-rc.2',
})

/** Every bundle an official release retired (at or after {@link RETIRED_BUNDLES_MIN_VERSION}). */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set(Object.keys(RETIRED_BUNDLE_VERSIONS))

/**
 * The earliest release whose launcher drops retired bundles from profile
 * manifests (verified against dsh-v0.2.1-alpha.1 sources; 0.2.0-rc.2 still
 * shipped the schedule bundle as an optional entry). Each bundle's own
 * retirement boundary lives in {@link RETIRED_BUNDLE_VERSIONS}.
 */
export const RETIRED_BUNDLES_MIN_VERSION = '0.2.1-alpha.1'

/**
 * The first launcher release that retires `name`, or null when no release
 * retires it.
 * @param name - bundle package name from `dsh.profile.bundles`.
 * @returns the retiring release, or null.
 */
export function retiredBundleVersion(name: string): string | null {
  return RETIRED_BUNDLE_VERSIONS[name] ?? null
}

/**
 * Whether `name` is a bundle the running (or planned) dsh release retires.
 * Unknown versions return false: without a launcher version to trust, the
 * caller keeps its regular judgment rather than guessing the release range.
 * @param name - bundle package name from `dsh.profile.bundles`.
 * @param dshVersion - installed dsh version, or null when unknown.
 * @returns true when the bundle is retired and the launcher drops it on load.
 */
export function isRetiredBundle(name: string, dshVersion: string | null): boolean {
  const retiredAt = retiredBundleVersion(name)
  if (retiredAt === null) return false
  if (dshVersion === null || semver.valid(dshVersion) === null) return false
  return semver.gte(dshVersion, retiredAt)
}
