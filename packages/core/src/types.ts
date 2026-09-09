export type Severity = 'fatal' | 'warn' | 'info'

export type RuleId =
  | 'bundle-declaration'
  | 'dependency-drift'
  | 'session-memory'
  | 'registry-version'
  | 'peer-gap'
  | 'patch-resolution'
  | 'structure'

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
