import semver from 'semver'

/**
 * Bundles an official dsh release retired. A launcher at or after
 * {@link RETIRED_BUNDLES_MIN_VERSION} removes a retired entry from a profile's
 * `dsh.profile.bundles` while loading it and rewrites the manifest, so a
 * leftover entry heals on the next start.
 *
 * The upstream set lives in `app-boot` `profile.ts` (`RETIRED_BUNDLES`);
 * keep this list in sync when a release retires another bundle.
 */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // Web mounts Schedule itself since 0.2.1-alpha.1; the Automation tasks
  // bundle only lived through the 0.2.0-rc line.
  '@deepseek-ai/dsh-experimental-schedule-bundle',
])

/**
 * The first release whose launcher drops {@link RETIRED_BUNDLES} entries from
 * profile manifests (verified against dsh-v0.2.1-alpha.1 sources; 0.2.0-rc.2
 * still shipped the bundle as an optional entry).
 */
export const RETIRED_BUNDLES_MIN_VERSION = '0.2.1-alpha.1'

/**
 * Whether `name` is a bundle the running (or planned) dsh release retires.
 * Unknown versions return false: without a launcher version to trust, the
 * caller keeps its regular judgment rather than guessing the release range.
 * @param name - bundle package name from `dsh.profile.bundles`.
 * @param dshVersion - installed dsh version, or null when unknown.
 * @returns true when the bundle is retired and the launcher drops it on load.
 */
export function isRetiredBundle(name: string, dshVersion: string | null): boolean {
  if (!RETIRED_BUNDLES.has(name)) return false
  if (dshVersion === null || semver.valid(dshVersion) === null) return false
  return semver.gte(dshVersion, RETIRED_BUNDLES_MIN_VERSION)
}
