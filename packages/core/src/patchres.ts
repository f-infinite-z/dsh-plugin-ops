import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import { allVisibleRows } from './rows.js'
import { packageDirFromAnchors } from './package-tree.js'

/**
 * Rule 5: patch rows must resolve. Every visible Loader row (bundle patches +
 * the user layer) names a module — a bare package through Node resolution, a
 * relative path against the profile directory, or a `cordis:` builtin. An
 * unresolvable row fails the boot, so this rule is fatal, mirroring the
 * official verify-cordis-config gate on the runtime plane. Disabled rows and
 * structural rows are skipped.
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
    const dir = packageDirFromAnchors(ctx.anchors, name)
    if (dir === null) {
      findings.push({
        ruleId: 'patch-resolution',
        severity: 'fatal',
        ...(row.id !== undefined ? { packageName: row.id } : {}),
        message: `patch row ${JSON.stringify(row.id ?? name)} references package ${name} that does not resolve from the profile tree`,
        detail: `declared in ${ref.source}; install the package or fix the row`,
        fix: { kind: 'none' },
      })
    }
  }
  return findings
}
