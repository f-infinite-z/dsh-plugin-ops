export type Severity = 'fatal' | 'warn' | 'info'

export type RuleId =
  | 'bundle-declaration'
  | 'dependency-drift'
  | 'session-memory'
  | 'registry-version'
  | 'peer-gap'
  | 'patch-resolution'
  | 'structure'
  | 'plugin-compatibility'
  | 'release-age-exclude'
  | 'duplicate-copies'

export type Fix =
  | { kind: 'none' }
  | { kind: 'align-lockfile' }
  | { kind: 'write-disabled'; rowId: string }

export interface Finding {
  ruleId: RuleId
  severity: Severity
  packageName?: string
  message: string
  detail?: string
  /**
   * Version-range annotation for a version-sensitive finding under the `all`
   * reporting view: names the releases on each side of the semantic boundary
   * that changes this finding's behavior (see `versions.ts`).
   */
  versionNote?: string
  /**
   * A stable machine-consumable next step for this finding (an enum-like
   * short label), for agents and chained tooling: e.g. `remove-and-add`,
   * `update-plugin-or-grant-exemption`, `regenerate-lockfile`.
   */
  nextAction?: string
  /**
   * The version set a version-sensitive judgment evaluated and the running
   * release it anchored severity to: `evaluated: <a>..<b>; running: <v>`,
   * so a reader never has to infer which versions produced the verdict.
   */
  versionContext?: string
  fix: Fix
}

export interface PackageState {
  name: string
  declared: string | null
  locked: string | null
  installed: string | null
}

export interface PackageSnapshot {
  /** package name → installed version, or null when the package is absent. */
  packages: Record<string, string | null>
}

export interface SnapshotDiffEntry {
  name: string
  /** 'added' | 'changed' | 'removed' */
  change: 'added' | 'changed' | 'removed'
  previous: string | null
  current: string | null
}

export interface MemoryInfo {
  lastSuccessAt: string | null
  diffSinceLastSuccess: SnapshotDiffEntry[]
}

export interface ScanReport {
  profile: string
  profileDir: string
  findings: Finding[]
  snapshot: PackageSnapshot
}
