import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { readPackageManifest, type PackageManifest } from './package-tree.js'
import { splitBareSpecifier } from './patchres.js'

/**
 * Publish-time verification for plugin authors: static checks over a package
 * directory (no dsh, no profile, no network) against the harness contracts
 * that decide whether the package loads after `dsh plugin add`.
 */

export type VerifyRuleId = 'bundle-patch' | 'patch-resolution' | 'esm-entry' | 'client-export'

export interface VerifyFinding {
  ruleId: VerifyRuleId
  severity: 'error' | 'warn' | 'info'
  message: string
  detail?: string
}

export interface VerifyReport {
  packageDir: string
  packageName: string | null
  version: string | null
  findings: VerifyFinding[]
}

/** Module names referenced by one patch list, with `insert` groups expanded. */
function patchRowNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  const names: string[] = []
  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    if (row.disabled === true) continue
    if (typeof row.name === 'string') names.push(row.name)
    if (Array.isArray(row.insert)) names.push(...patchRowNames(row.insert))
  }
  return names
}

function declaredDependencies(manifest: PackageManifest): Set<string> {
  const out = new Set<string>()
  for (const field of [manifest.dependencies, manifest.peerDependencies]) {
    if (field === undefined) continue
    for (const name of Object.keys(field)) out.add(name)
  }
  return out
}

function exportsSubpath(exportsField: unknown, subpath: string): unknown {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) return undefined
  return (exportsField as Record<string, unknown>)[subpath]
}

function firstString(value: unknown, ...keys: string[]): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    for (const key of keys) {
      if (typeof obj[key] === 'string') return obj[key] as string
    }
  }
  return null
}

function isCjsEntry(manifest: PackageManifest, entry: string): boolean {
  if (manifest.type === 'module') return false
  if (entry.endsWith('.mjs')) return false
  if (entry.endsWith('.cjs')) return true
  return entry.endsWith('.js') || !entry.includes('.')
}

/**
 * Verify one plugin package against the harness publish contracts before it
 * is published. Checks: the `dsh.bundle.patch` declaration and parse, patch
 * rows resolving to declared dependencies or existing files, an ESM default
 * entry, and the `dsh.client` → `exports["./client"]` contract.
 */
export function verifyPluginPackage(packageDir: string): VerifyReport {
  const findings: VerifyFinding[] = []
  const manifest = readPackageManifest(packageDir)
  if (manifest === null) {
    return {
      packageDir,
      packageName: null,
      version: null,
      findings: [{ ruleId: 'bundle-patch', severity: 'error', message: 'package.json is missing or unreadable' }],
    }
  }
  const packageName = typeof manifest.name === 'string' ? manifest.name : null
  const version = typeof manifest.version === 'string' ? manifest.version : null

  // ---- V1: bundle patch declaration ----
  const bundle = manifest.dsh?.bundle
  const patchRel = typeof bundle?.patch === 'string' && bundle.patch !== '' ? bundle.patch : null
  const hasClient = manifest.dsh?.client !== undefined
  let rows: unknown = null
  if (patchRel === null) {
    if (hasClient) {
      findings.push({
        ruleId: 'bundle-patch',
        severity: 'warn',
        message: 'declares dsh.client but no dsh.bundle.patch',
        detail: 'client-only packages cannot be installed with `dsh plugin add`; add a bundle patch or ship the client through a host bundle roster',
      })
    } else {
      findings.push({
        ruleId: 'bundle-patch',
        severity: 'error',
        message: 'no dsh.bundle.patch declaration — this package is not an installable dsh plugin',
        detail: 'add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } to package.json',
      })
    }
  } else {
    const patchFile = join(packageDir, patchRel)
    if (!existsSync(patchFile)) {
      findings.push({
        ruleId: 'bundle-patch',
        severity: 'error',
        message: `dsh.bundle.patch points at a missing file: ${patchRel}`,
      })
    } else {
      try {
        const value = parseDocument(readFileSync(patchFile, 'utf8')).toJS()
        if (!Array.isArray(value)) {
          findings.push({
            ruleId: 'bundle-patch',
            severity: 'error',
            message: `patch file ${patchRel} is not a YAML list`,
          })
        } else {
          rows = value
        }
      } catch (error) {
        findings.push({
          ruleId: 'bundle-patch',
          severity: 'error',
          message: `patch file ${patchRel} is not valid YAML: ${String(error)}`,
        })
      }
    }
  }

  // ---- V2: patch rows resolve to declared dependencies or existing files ----
  if (rows !== null) {
    const declared = declaredDependencies(manifest)
    const seen = new Set<string>()
    for (const name of patchRowNames(rows)) {
      if (seen.has(name)) continue
      seen.add(name)
      if (name.startsWith('cordis:')) continue
      if (name.startsWith('.')) {
        if (!existsSync(join(packageDir, name))) {
          findings.push({
            ruleId: 'patch-resolution',
            severity: 'error',
            message: `patch row references a relative module that does not exist: ${name}`,
          })
        }
        continue
      }
      if (name.startsWith('/')) continue
      const { pkg } = splitBareSpecifier(name)
      // The bundle's own host row (name === package name) is the standard shape.
      if (pkg === packageName) continue
      if (pkg.startsWith('@deepseek-ai/')) {
        if (!declared.has(pkg)) {
          findings.push({
            ruleId: 'patch-resolution',
            severity: 'info',
            message: `patch row references ${pkg} without a peerDependencies entry`,
            detail: 'official packages resolve from the host closure; a peer entry pins the contract for users',
          })
        }
        continue
      }
      if (!declared.has(pkg)) {
        findings.push({
          ruleId: 'patch-resolution',
          severity: 'error',
          message: `patch row references ${pkg}, which is not declared in dependencies or peerDependencies`,
          detail: `a bare package referenced by a patch row must be declared so it resolves after install (row: ${name})`,
        })
      }
    }
  }

  // ---- V3: ESM default entry ----
  const dot = exportsSubpath(manifest.exports, '.')
  let defaultEntry = firstString(dot, 'import', 'default', 'require')
  if (defaultEntry === null && typeof manifest.main === 'string') defaultEntry = manifest.main
  if (defaultEntry === null) {
    findings.push({
      ruleId: 'esm-entry',
      severity: 'warn',
      message: 'no default entry declared (exports["."] or main)',
    })
  } else if (!existsSync(join(packageDir, defaultEntry))) {
    findings.push({
      ruleId: 'esm-entry',
      severity: 'error',
      message: `declared default entry ${defaultEntry} does not exist`,
    })
  } else if (isCjsEntry(manifest, defaultEntry)) {
    findings.push({
      ruleId: 'esm-entry',
      severity: 'error',
      message: `default entry ${defaultEntry} is CommonJS (no "type": "module")`,
      detail: 'the Loader requires ESM named exports for plugin function namespaces; publish an ESM entry',
    })
  }

  // ---- V5: client export contract ----
  if (hasClient) {
    const client = manifest.dsh?.client as Record<string, unknown> | undefined
    const platform = client?.platform
    if (platform !== 'web') {
      findings.push({
        ruleId: 'client-export',
        severity: 'warn',
        message: `dsh.client.platform is ${JSON.stringify(platform ?? null)}; the harness client system only loads platform "web"`,
      })
    }
    const clientEntry = firstString(exportsSubpath(manifest.exports, './client'), 'default')
    if (clientEntry === null) {
      findings.push({
        ruleId: 'client-export',
        severity: 'error',
        message: 'declares dsh.client but exports no "./client" bundle',
        detail: 'add "exports": { "./client": { "default": "./lib/client.js" } }',
      })
    } else if (!existsSync(join(packageDir, clientEntry))) {
      findings.push({
        ruleId: 'client-export',
        severity: 'error',
        message: `client entry ${clientEntry} does not exist`,
      })
    }
  }

  return { packageDir, packageName, version, findings }
}

/** True when the report passes; `strict` also fails on warnings. */
export function verifyOk(report: VerifyReport, strict = false): boolean {
  return !report.findings.some(
    (finding) => finding.severity === 'error' || (strict && finding.severity === 'warn'),
  )
}
