import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import { allVisibleRows, type RowRef } from './rows.js'
import type { PatchRow } from './patch-layer.js'
import { resolvePackageDir } from './generation.js'

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
 * A runtime resolve guard: the row's `disabled` expression probes the row's own
 * package through `require.resolve`/`import.meta.resolve` before use, so the
 * Loader skips the row when the installation no longer carries the package.
 * `@deepseek-harness-tui/dsh-tui` uses this for rows whose package dsh dropped
 * (its `code-runtime` row after 0.1.6). Static analysis cannot evaluate the
 * expression, but the guard's presence and target are literal text.
 */
function hasResolveGuard(row: PatchRow, pkg: string): boolean {
  const disabled = row.disabled
  if (typeof disabled !== 'string') return false
  const probes = disabled.includes('require.resolve') || disabled.includes('import.meta.resolve')
  return probes && disabled.includes(pkg)
}

/**
 * Rule 5: patch rows must resolve. Every visible Loader row (bundle patches +
 * the user layer) names a module — a bare package (with optional subpath)
 * through the runtime resolution table, a relative path against the profile
 * directory, or a `cordis:` builtin. Patch rows are applied through the
 * bootstrap Include, which is a required entry: an unresolvable row fails the
 * whole boot (verified against dsh 0.1.6-alpha.2: a bad bundle row aborts
 * startup with `failed to apply loader entry include`). The optional-plugin
 * tolerance of the startup audit covers activation failures of already
 * imported plugins, not this import stage.
 *
 * Patch layers apply in order — bundle patches first, the user layer last —
 * and a later row with the same id overrides earlier rows, so only the last
 * occurrence of an id decides whether that row resolves (a user-layer guard or
 * disable neutralizes a bundle-layer row). Rows without an id cannot be
 * matched by an override and are judged individually. Statically disabled rows
 * are skipped; a row whose `disabled` expression carries a runtime resolve
 * guard for its own package is reported at info level because the Loader
 * self-disables it when the package is absent.
 */
export function rulePatchResolution(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const refs = allVisibleRows(ctx.paths.profileDir, resolved)
  const lastById = new Map<string, RowRef>()
  for (const ref of refs) {
    const id = typeof ref.row.id === 'string' && ref.row.id.length > 0 ? ref.row.id : null
    if (id !== null) lastById.set(id, ref)
  }
  const seen = new Set<string>()
  for (const ref of refs) {
    const row = ref.row
    const name = typeof row.name === 'string' ? row.name : null
    if (name === null) continue
    const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : null
    if (id !== null && lastById.get(id) !== ref) continue
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
    const resolvedPackage = resolvePackageDir(ctx.generation, ctx.paths, pkg)
    if (resolvedPackage === null) {
      if (hasResolveGuard(row, pkg)) {
        findings.push({
          ruleId: 'patch-resolution',
          severity: 'info',
          ...(row.id !== undefined ? { packageName: row.id } : {}),
          message: `patch row ${JSON.stringify(row.id ?? name)} carries a runtime resolve guard for ${pkg}; the Loader skips it when the package is absent`,
          detail: `declared in ${ref.source}`,
          fix: { kind: 'none' },
        })
        continue
      }
      const isOfficial = pkg.startsWith('@deepseek-ai/')
      findings.push({
        ruleId: 'patch-resolution',
        severity: 'fatal',
        ...(row.id !== undefined ? { packageName: row.id } : {}),
        message: `patch row ${JSON.stringify(row.id ?? name)} references package ${pkg} that does not resolve`,
        detail: isOfficial
          ? `declared in ${ref.source}. Official packages resolve from the running dsh installation's dependency closure; if the installation is intact, start dsh once so the runtime table covers it (then re-scan), otherwise reinstall dsh.`
          : `declared in ${ref.source}; install the package (dsh plugin --profile <name> add ${pkg}) or fix the row`,
        fix: { kind: 'none' },
      })
    }
  }
  return findings
}
