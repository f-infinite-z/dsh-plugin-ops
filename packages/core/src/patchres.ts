import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import { allVisibleRows, type RowRef } from './rows.js'
import type { PatchRow } from './patch-layer.js'
import { resolvePackageDir, toleratesOptionalBundles, OPTIONAL_TOLERANCE_MIN_VERSION } from './generation.js'
import { boundaryNote, decisionVersion } from './versions.js'

/**
 * Entry ids whose presence defines a usable dsh application. Ported from the
 * official startup audit (`requiredStartupEntryIds` in
 * packages/boot/app-boot/src/index.ts; unchanged in 0.1.7-alpha.1): only these
 * entries abort the boot when inactive. An optional entry's failure is skipped
 * with a warning on 0.1.7+ and aborts older releases, so severity follows both
 * this list and the installed dsh version.
 */
export const REQUIRED_ENTRY_IDS = new Set([
  'agent-loop',
  'webserver',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

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
 * Rule 5: patch rows must resolve.
 *
 * The composition follows the include's own patch algorithm (`applyEntryPatches`
 * plus the entry-store update it feeds), which gives the two row forms
 * different roles. An `insert` directive is the only form that creates an
 * entry, and a later insert for the same id replaces the whole row. A flat row
 * without `insert` is a configuration patch: it merges its fields into an
 * entry an earlier insert created, never introduces one, and its `name`, when
 * present, is only an assertion that must match the entry's name or the patch
 * is skipped. A flat row whose id no earlier insert introduced is skipped by
 * the include with a warning and reported at info here, because the intended
 * change never applies.
 *
 * The effective row of each id — the last insert for that id with any later
 * configuration patches merged in — therefore decides whether the module
 * resolves, not "the last row carrying the id". Rows an insert introduces
 * without an id cannot be addressed by patches and are judged individually.
 * A relative module path resolves against the directory of the patch file
 * that introduced the row (app boot anchors inserted paths beside their
 * patch); an absolute path is taken as written.
 *
 * Inserted rows are applied through the bootstrap Include, which is a required
 * entry: an unresolvable inserted row fails the whole boot (verified against
 * dsh 0.1.6-alpha.2: a bad bundle row aborts startup with `failed to apply
 * loader entry include`; verified against real bundles on 0.1.7-rc.2 and
 * 0.2.1-alpha.1: every bundle introduces its rows through one `insert`).
 * From 0.1.7 on an optional row's activation failure is skipped with a
 * warning, and an unresolvable row follows the version-aware severity for
 * non-required ids. Statically disabled rows are skipped; a row whose
 * `disabled` expression carries a runtime resolve guard for the row's own
 * package is reported at info because the Loader self-disables it when the
 * package is absent.
 */
export function rulePatchResolution(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const refs = allVisibleRows(ctx.paths.profileDir, resolved)

  // Compose the effective entry list in layer order (every bundle patch file
  // in bundle order, then the user layer), mirroring applyEntryPatches.
  const effective = new Map<string, RowRef>()
  const standalone: RowRef[] = []
  for (const ref of refs) {
    const id = typeof ref.row.id === 'string' && ref.row.id.length > 0 ? ref.row.id : null
    if (ref.inserted) {
      if (id === null) standalone.push(ref)
      else effective.set(id, ref)
      continue
    }
    if (id === null) continue
    const target = effective.get(id)
    if (target === undefined) {
      // Desktop ships its official bundle layers inside the packaged asar,
      // which a plain Node process cannot read, so a user-layer row may
      // legitimately address an official entry this scan cannot see; only
      // non-desktop profiles can prove that no earlier layer introduces the id.
      if (!ctx.isDesktop) {
        findings.push({
          ruleId: 'patch-resolution',
          severity: 'info',
          message: `patch row ${JSON.stringify(id)} does not apply: no earlier layer in this profile introduces this entry id, so the include skips it. Add the entry with an \`insert\` directive first`,
          detail: `declared in ${ref.source}`,
          fix: { kind: 'none' },
        })
      }
      continue
    }
    const asserted = typeof ref.row.name === 'string' ? ref.row.name : null
    if (asserted !== null && asserted !== target.row.name) continue
    if (ref.row.disabled !== undefined) {
      effective.set(id, {
        source: target.source,
        baseDir: target.baseDir,
        inserted: true,
        row: { ...target.row, disabled: ref.row.disabled },
      })
    }
  }

  const seen = new Set<string>()
  const judge = (ref: RowRef): void => {
    const row = ref.row
    const name = typeof row.name === 'string' ? row.name : null
    if (name === null) return
    if (row.disabled === true) return
    if (name.startsWith('cordis:')) return
    const key = `${ref.source}\u0000${name}`
    if (seen.has(key)) return
    seen.add(key)
    const required = typeof row.id === 'string' && REQUIRED_ENTRY_IDS.has(row.id)
    const version = decisionVersion(ctx.versionView, ctx.dshVersion)
    const tolerant = !required && toleratesOptionalBundles(version)
    const versionNote = ctx.versionView === 'all' && !required
      ? boundaryNote(OPTIONAL_TOLERANCE_MIN_VERSION, 'the boot aborts on this row', 'this optional entry is skipped with a warning')
      : undefined
    if (name.startsWith('.') || isAbsolute(name)) {
      const target = name.startsWith('.') ? join(ref.baseDir, name) : name
      if (!existsSync(target)) {
        findings.push({
          ruleId: 'patch-resolution',
          severity: tolerant ? 'warn' : 'fatal',
          ...(row.id !== undefined ? { packageName: row.id } : {}),
          message: tolerant
            ? `patch row ${JSON.stringify(row.id ?? name)} references a module path that does not exist: ${name}; dsh ${version} skips this optional entry and continues the boot`
            : `patch row ${JSON.stringify(row.id ?? name)} references a module path that does not exist: ${name}; the boot aborts on this row`,
          detail: `declared in ${ref.source}`,
          ...(versionNote !== undefined ? { versionNote } : {}),
          fix: { kind: 'none' },
        })
      }
      return
    }
    const { pkg } = splitBareSpecifier(name)
    const resolvedPackage = resolvePackageDir(ctx.generation, ctx.paths, pkg)
    if (resolvedPackage !== null) return
    if (hasResolveGuard(row, pkg)) {
      findings.push({
        ruleId: 'patch-resolution',
        severity: 'info',
        ...(row.id !== undefined ? { packageName: row.id } : {}),
        message: `patch row ${JSON.stringify(row.id ?? name)} carries a runtime resolve guard for ${pkg}; the Loader skips it when the package is absent`,
        detail: `declared in ${ref.source}`,
        fix: { kind: 'none' },
      })
      return
    }
    // Desktop ships its official packages inside the packaged asar, so they
    // never resolve from a plain Node process; the launcher verifies the
    // packaged runtime before boot, so official rows are trusted.
    if (ctx.isDesktop && pkg.startsWith('@deepseek-ai/')) return
    const isOfficial = pkg.startsWith('@deepseek-ai/')
    findings.push({
      ruleId: 'patch-resolution',
      severity: tolerant ? 'warn' : 'fatal',
      ...(row.id !== undefined ? { packageName: row.id } : {}),
      message: required
        ? `patch row ${JSON.stringify(row.id ?? name)} references package ${pkg} that does not resolve; the row id is a required startup entry, so the boot aborts`
        : tolerant
          ? `patch row ${JSON.stringify(row.id ?? name)} references package ${pkg} that does not resolve; dsh ${version} skips this optional entry and continues the boot`
          : `patch row ${JSON.stringify(row.id ?? name)} references package ${pkg} that does not resolve; the boot aborts on this row`,
      detail: isOfficial
        ? `declared in ${ref.source}. Official packages resolve from the running dsh installation's dependency closure; if the installation is intact, start dsh once so the runtime table covers it (then re-scan), otherwise reinstall dsh.`
        : `declared in ${ref.source}; install the package (dsh plugin --profile <name> add ${pkg}) or fix the row`,
      ...(versionNote !== undefined ? { versionNote } : {}),
      fix: { kind: 'none' },
    })
  }

  for (const ref of effective.values()) judge(ref)
  for (const ref of standalone) judge(ref)
  return findings
}
