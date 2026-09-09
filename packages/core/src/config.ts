import { existsSync } from 'node:fs'
import { readTextFile } from './fsutil.js'
import { parseDocument } from 'yaml'
import type { Finding, RuleId, Severity } from './types.js'

export interface RuleOverride {
  enabled?: boolean
  severity?: Severity
}

export interface OpsConfig {
  rules?: Partial<Record<RuleId, RuleOverride>>
  ignorePackages?: string[]
}

export interface ConfigRead {
  ok: boolean
  config: OpsConfig
  problem?: string
}

export const DEFAULT_CONFIG_FILENAME = 'dsh-ops.yml'

/**
 * Read the optional user config (default `$DSH_HOME/dsh-ops.yml`). A corrupt
 * file is reported as `ok: false` and the caller fails loud — misconfiguration
 * is not silently ignored. A missing file is a valid empty config.
 */
export function readOpsConfig(file: string): ConfigRead {
  if (!existsSync(file)) return { ok: true, config: {} }
  const raw = readTextFile(file)
  if (raw === null) return { ok: true, config: {} }
  try {
    const doc = parseDocument(raw)
    const value = doc.toJS()
    if (value === null || value === undefined) return { ok: true, config: {} }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, config: {}, problem: 'config is not a YAML mapping' }
    }
    return { ok: true, config: value as OpsConfig }
  } catch (error) {
    return { ok: false, config: {}, problem: `config is not valid YAML: ${String(error)}` }
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { fatal: 3, warn: 2, info: 1 }

/**
 * Post-process findings against the user config: dropped rules, severity
 * overrides, and ignored packages. The config can only demote severity
 * (fatal → warn → info), never promote — gate policy stays with the scanner.
 */
export function applyConfig(findings: Finding[], config: OpsConfig): Finding[] {
  const ignored = new Set(config.ignorePackages ?? [])
  const out: Finding[] = []
  for (const finding of findings) {
    if (finding.packageName !== undefined && ignored.has(finding.packageName)) continue
    const override = config.rules?.[finding.ruleId]
    if (override?.enabled === false) continue
    let severity = finding.severity
    if (override?.severity !== undefined && SEVERITY_ORDER[override.severity] < SEVERITY_ORDER[finding.severity]) {
      severity = override.severity
    }
    out.push({ ...finding, severity })
  }
  return out
}
