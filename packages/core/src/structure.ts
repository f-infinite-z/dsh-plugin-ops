import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from './types.js'
import type { ResolvedBundle } from './profile.js'
import type { PackageManifest } from './package-tree.js'

interface EntryPoints {
  defaultEntry: string | null
  typesEntry: string | null
  clientEntry: string | null
}

function exportsSubpath(exportsField: unknown, subpath: string): unknown {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) return undefined
  return (exportsField as Record<string, unknown>)[subpath]
}

function firstString(value: unknown, ...rest: string[]): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    for (const key of rest) {
      if (typeof obj[key] === 'string') return obj[key] as string
    }
  }
  return null
}

function entryPoints(manifest: PackageManifest): EntryPoints {
  const dot = exportsSubpath(manifest.exports, '.')
  let typesEntry = firstString(dot, 'types')
  let defaultEntry = firstString(dot, 'import', 'default', 'require')
  const client = exportsSubpath(manifest.exports, './client')
  const clientEntry = firstString(client, 'default')
  if (defaultEntry === null && typeof manifest.main === 'string') defaultEntry = manifest.main
  if (typesEntry === null && typeof manifest.types === 'string') typesEntry = manifest.types
  return { defaultEntry, typesEntry, clientEntry }
}

function isCjsEntry(manifest: PackageManifest, entry: string): boolean {
  if (manifest.type === 'module') return false
  if (entry.endsWith('.mjs')) return false
  if (entry.endsWith('.cjs')) return true
  // No "type": "module" and a plain .js entry: Node treats it as CommonJS.
  return entry.endsWith('.js') || !entry.includes('.')
}

/**
 * Rule 7: package structure integrity. The default entry must exist; a
 * CommonJS default entry is fatal (the Loader needs ESM named exports for
 * plugin function namespaces — postmortem 0001). Missing types and client
 * entries are warnings: they degrade tooling and the browser half without
 * killing the host.
 */
export function ruleStructure(resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  for (const bundle of resolved) {
    const points = entryPoints(bundle.manifest)
    if (points.defaultEntry !== null) {
      const target = join(bundle.dir, points.defaultEntry)
      if (!existsSync(target)) {
        findings.push({
          ruleId: 'structure',
          severity: 'fatal',
          packageName: bundle.name,
          message: `declared default entry ${points.defaultEntry} does not exist`,
          fix: { kind: 'none' },
        })
      } else if (isCjsEntry(bundle.manifest, points.defaultEntry)) {
        findings.push({
          ruleId: 'structure',
          severity: 'fatal',
          packageName: bundle.name,
          message: `default entry ${points.defaultEntry} is CommonJS (no "type": "module" in package.json)`,
          detail: 'the Loader requires ESM named exports for plugin function namespaces; publish an ESM entry',
          fix: { kind: 'none' },
        })
      }
    }
    if (points.typesEntry !== null && !existsSync(join(bundle.dir, points.typesEntry))) {
      findings.push({
        ruleId: 'structure',
        severity: 'warn',
        packageName: bundle.name,
        message: `declared types entry ${points.typesEntry} does not exist`,
        fix: { kind: 'none' },
      })
    }
    if (points.clientEntry !== null && !existsSync(join(bundle.dir, points.clientEntry))) {
      findings.push({
        ruleId: 'structure',
        severity: 'warn',
        packageName: bundle.name,
        message: `declared client entry ${points.clientEntry} does not exist`,
        fix: { kind: 'none' },
      })
    }
  }
  return findings
}
