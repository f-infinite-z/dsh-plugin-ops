import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import { allVisibleRows } from './rows.js'
import { packageDirFromAnchors } from './package-tree.js'

/**
 * Split a bare specifier into its package part and optional subpath:
 * `@scope/pkg/sub` → pkg `@scope/pkg` + sub `sub`; `pkg/sub` → pkg `pkg`.
 * Rows routinely reference package subpaths (e.g. `@deepseek-ai/dsh-web-app/startup`).
 */
export function splitBareSpecifier(name: string): { pkg: string; sub: string | null } {
  const segments = name.split('/')
  if (name.startsWith('@')) {
    if (segments.length <= 2) return { pkg: name, sub: null }
    return { pkg: segments.slice(0, 2).join('/'), sub: segments.slice(2).join('/') }
  }
  if (segments.length === 1) return { pkg: name, sub: null }
  return { pkg: segments[0]!, sub: segments.slice(1).join('/') }
}

/**
 * Rule 5: patch rows must resolve. Every visible Loader row (bundle patches +
 * the user layer) names a module — a bare package (with optional subpath)
 * through Node resolution, a relative path against the profile directory, or a
 * `cordis:` builtin. An unresolvable row fails the boot, so this rule is
 * fatal, mirroring the official verify-cordis-config gate on the runtime
 * plane. Disabled rows and structural rows are skipped.
 */
export function rulePatchResolution(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const refs = allVisibleRows(ctx.paths.profileDir, resolved)
  const seen = new Set<string>()
  for (const ref of refs) {
    const row = ref.row
    const name = typeof row.name === 'string' ? row.name : null
    if (name === null) continue
    if (row.disabled === true) continue
    if (name.startsWith('cordis:')) continue
    const key = `${ref.source}\u0000${name}`
    if (seen.has(key)) continue
    seen.add(key)
    if (name.startsWith('.')) {
      const target = join(ctx.paths.profileDir, name)
      if (!existsSync(target)) {
        findings.push({
          ruleId: 'patch-resolution',
          severity: 'fatal',
          ...(row.id !== undefined ? { packageName: row.id } : {}),
          message: `patch row ${JSON.stringify(row.id ?? name)} references a relative module that does not exist: ${name}`,
          detail: `declared in ${ref.source}`,
          fix: { kind: 'none' },
        })
      }
      continue
    }
    if (name.startsWith('/')) continue
    const { pkg } = splitBareSpecifier(name)
    const dir = packageDirFromAnchors(ctx.anchors, pkg)
    if (dir === null) {
      findings.push({
        ruleId: 'patch-resolution',
        severity: 'fatal',
        ...(row.id !== undefined ? { packageName: row.id } : {}),
        message: `patch row ${JSON.stringify(row.id ?? name)} references package ${pkg} that does not resolve from the profile tree`,
        detail: `declared in ${ref.source}; install the package or fix the row`,
        fix: { kind: 'none' },
      })
    }
  }
  return findings
}
