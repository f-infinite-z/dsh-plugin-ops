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

export type VerifyRuleId =
  | 'bundle-patch'
  | 'patch-resolution'
  | 'dependency-protocol'
  | 'esm-entry'
  | 'entry-exports'
  | 'client-export'
  | 'client-bundle'
  | 'files-completeness'

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

/** Read a text file with a byte cap; null when unreadable. */
function readTextSafe(file: string, maxBytes = 512 * 1024): string | null {
  try {
    return readFileSync(file).subarray(0, maxBytes).toString('utf8')
  } catch {
    return null
  }
}

/** Whether an npm `files` entry (literal path, directory, or simple glob) covers a relative path. */
function filesCover(files: readonly string[], rel: string): boolean {
  const normalized = rel.replace(/^\.\//, '')
  for (const entry of files) {
    const pattern = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern === '') continue
    if (pattern === normalized) return true
    if (normalized.startsWith(`${pattern}/`)) return true
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`)
      if (regex.test(normalized)) return true
    }
  }
  return false
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

  // ---- V8: publishable dependency protocols ----
  const depFields: Array<[string, Record<string, string> | undefined]> = [
    ['dependencies', manifest.dependencies],
    ['peerDependencies', manifest.peerDependencies],
    ['optionalDependencies', manifest.optionalDependencies],
  ]
  for (const [field, deps] of depFields) {
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue
      if (spec.startsWith('file:') || spec.startsWith('link:')) {
        findings.push({
          ruleId: 'dependency-protocol',
          severity: 'error',
          message: `${field}.${name} uses the ${spec.split(':')[0]}: protocol (${spec})`,
          detail: 'consumers cannot resolve local protocols; use a registry version range',
        })
      } else if (spec.startsWith('workspace:')) {
        findings.push({
          ruleId: 'dependency-protocol',
          severity: 'warn',
          message: `${field}.${name} uses the workspace: protocol (${spec})`,
          detail: 'pnpm publish rewrites it, npm publish does not; make sure your release tooling is pnpm',
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

  // ---- V4: named plugin exports ----
  if (defaultEntry !== null && existsSync(join(packageDir, defaultEntry))) {
    const content = readTextSafe(join(packageDir, defaultEntry))
    if (content !== null) {
      const hasApply =
        /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+apply\b/.test(content) ||
        /\bexport\s*\{[^}]*\bapply\b[^}]*\}/.test(content)
      if (!hasApply) {
        findings.push({
          ruleId: 'entry-exports',
          severity: 'warn',
          message: `could not find an "apply" named export in ${defaultEntry}`,
          detail: 'the Loader needs ESM named exports for plugin function namespaces; ignore this if the entry is a re-export or a minified build artifact',
        })
      }
    }
  }

  // ---- V5: client export contract ----
  let clientEntry: string | null = null
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
    clientEntry = firstString(exportsSubpath(manifest.exports, './client'), 'default')
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

  // ---- V6: client bundle shape ----
  if (hasClient && clientEntry !== null && existsSync(join(packageDir, clientEntry))) {
    const content = readTextSafe(join(packageDir, clientEntry))
    if (content !== null) {
      if (!content.includes('__ModuleLoader__.load')) {
        findings.push({
          ruleId: 'client-bundle',
          severity: 'warn',
          message: `${clientEntry} does not register through window.__ModuleLoader__.load`,
          detail: 'harness client bundles are CJS single files wrapped as window.__ModuleLoader__.load({ id, factory })',
        })
      } else if (packageName !== null && !content.includes(`"${packageName}"`) && !content.includes(`'${packageName}'`)) {
        findings.push({
          ruleId: 'client-bundle',
          severity: 'info',
          message: `client bundle does not contain the package id ${JSON.stringify(packageName)}`,
          detail: 'the registration id must match the package name for the client module system to bind it',
        })
      }
    }
  }

  // ---- V7: files completeness ----
  const files = Array.isArray(manifest.files) ? manifest.files.filter((f): f is string => typeof f === 'string') : []
  if (files.length > 0) {
    const critical: Array<{ label: string; rel: string }> = []
    if (patchRel !== null) critical.push({ label: 'bundle patch', rel: patchRel })
    if (defaultEntry !== null) critical.push({ label: 'default entry', rel: defaultEntry })
    if (hasClient && clientEntry !== null) critical.push({ label: 'client entry', rel: clientEntry })
    for (const item of critical) {
      if (!filesCover(files, item.rel)) {
        findings.push({
          ruleId: 'files-completeness',
          severity: 'warn',
          message: `files field may exclude the ${item.label} ${item.rel} from the published package`,
          detail: `add ${JSON.stringify(item.rel)} (or its directory) to "files"`,
        })
      }
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
