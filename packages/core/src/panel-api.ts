import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshPaths } from './paths.js'
import { readProfileManifest, profileBundles, resolveBundles, type ProfileManifest } from './profile.js'
import { scanProfile, ScanError } from './scan.js'
import { recentEvents } from './memory.js'
import { alignToLockfile } from './fix.js'
import { appendMemory } from './memory.js'
import { reportOk } from './report.js'
import { allVisibleRows } from './rows.js'
import { appendDisabledRow, removeDisabledRow } from './patch-layer.js'
import type { DshPaths, OpsConfig } from './index.js'

/**
 * Panel API shared by the standalone `dsh-ops serve` server and the embedded
 * cordis bundle host half. Routes are whitelist-only: scans read the engine,
 * writes are limited to align-lockfile and row disable/enable.
 */
export class PanelApiError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message)
  }
}

export interface PanelApiOptions {
  paths: DshPaths
  config: OpsConfig
  /** Profile used when the request carries no `?profile=`; the embedded bundle host passes the profile it runs in. */
  defaultProfile?: string
}

export interface RowView {
  rowId: string
  source: string
  packageName: string | undefined
  disabled: boolean
  protected: boolean
}

function isOfficialSource(source: string, packageName: string | undefined): boolean {
  return source.startsWith('@deepseek-ai/') || packageName?.startsWith('@deepseek-ai/') === true
}

function pathsFor(options: PanelApiOptions, profile: string): DshPaths {
  return resolveDshPaths(profile, options.paths.home)
}

function readManifestSafe(profileDir: string): ProfileManifest | null {
  return readProfileManifest(join(profileDir, 'package.json'))
}

function rowViews(options: PanelApiOptions, profile: string): RowView[] {
  const paths = pathsFor(options, profile)
  const manifest = readManifestSafe(paths.profileDir)
  if (manifest === null) return []
  const { resolved } = resolveBundles(paths, manifest)
  const refs = allVisibleRows(paths.profileDir, resolved)
  // A row id may appear in several sources; later layers override earlier
  // ones. The user patch layer is the last layer, so a user-layer occurrence
  // of an id wins over bundle occurrences (which appear before it in file
  // order only per file, not globally). Track the effective row per id:
  // user-layer rows replace bundle rows entirely.
  const byId = new Map<string, { rowId: string; source: string; packageName: string | undefined; disabled: boolean; protected: boolean }>()
  for (const ref of refs) {
    if (ref.row.id === undefined) continue
    const isUserLayer = ref.source.includes('(user layer)')
    const existing = byId.get(ref.row.id)
    if (existing !== undefined && !isUserLayer) continue
    if (existing !== undefined && existing.source.includes('(user layer)')) continue
    byId.set(ref.row.id, {
      rowId: ref.row.id,
      source: ref.source,
      packageName: ref.row.name,
      disabled: ref.row.disabled === true,
      protected: isOfficialSource(ref.source, ref.row.name),
    })
  }
  return [...byId.values()].sort((a, b) => a.rowId.localeCompare(b.rowId))
}

async function readJsonBody(rawBody: string | undefined): Promise<Record<string, unknown>> {
  if (rawBody === undefined || rawBody.trim() === '') return {}
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw new Error('body must be a JSON object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new PanelApiError(`invalid JSON body: ${String(error)}`, 400)
  }
}

export async function handlePanelApi(
  method: string,
  url: URL,
  options: PanelApiOptions,
  rawBody?: string,
): Promise<{ status: number; body: unknown }> {
  const pathname = url.pathname
  const profile = url.searchParams.get('profile') ?? options.defaultProfile ?? 'web'

  if (method === 'GET' && pathname === '/api/info') {
    const profiles: { name: string; bundles: number }[] = []
    if (existsSync(options.paths.profilesDir)) {
      for (const entry of readdirSync(options.paths.profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue
        const manifest = readManifestSafe(join(options.paths.profilesDir, entry.name))
        profiles.push({ name: entry.name, bundles: manifest === null ? 0 : profileBundles(manifest).length })
      }
      profiles.sort((a, b) => a.name.localeCompare(b.name))
    }
    return { status: 200, body: { home: options.paths.home, profiles, defaultProfile: options.defaultProfile ?? null } }
  }

  if (method === 'GET' && pathname === '/api/scan') {
    const paths = pathsFor(options, profile)
    const report = await scanProfile({
      paths, profileName: profile, config: options.config,
      updateCheck: url.searchParams.get('updates') === 'true',
    })
    const counts = { fatal: 0, warn: 0, info: 0 }
    for (const finding of report.findings) counts[finding.severity]++
    return { status: 200, body: { ...report, counts, ok: reportOk(report) } }
  }

  if (method === 'GET' && pathname === '/api/memory') {
    const paths = pathsFor(options, profile)
    const events = recentEvents(paths, profile, 12).map((event) => ({
      type: event.type,
      ts: event.ts,
      detail: 'detail' in event && typeof event.detail === 'string' ? event.detail : '',
    }))
    return { status: 200, body: { events } }
  }

  if (method === 'GET' && pathname === '/api/plugins') {
    return { status: 200, body: { rows: rowViews(options, profile) } }
  }

  if (method === 'GET' && pathname === '/api/fix/preview') {
    const paths = pathsFor(options, profile)
    const report = await scanProfile({ paths, profileName: profile, config: options.config, updateCheck: false })
    const alignable = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
    return {
      status: 200,
      body: {
        actions: alignable.length > 0
          ? [`pnpm install --frozen-lockfile --force (fixes ${alignable.length} drift finding(s)) in ${paths.profileDir}`]
          : [],
        ok: reportOk(report),
      },
    }
  }

  if (method === 'POST' && pathname === '/api/fix/execute') {
    const paths = pathsFor(options, profile)
    const report = await scanProfile({ paths, profileName: profile, config: options.config, updateCheck: false })
    const alignable = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
    if (alignable.length === 0) return { status: 200, body: { ok: true, detail: 'nothing to realign' } }
    const drifted = [...new Set(alignable.map((f) => f.packageName).filter((n): n is string => n !== undefined))]
    const result = await alignToLockfile(paths.profileDir, drifted)
    if (result.ok) {
      appendMemory(paths, { type: 'fix', ts: new Date().toISOString(), profile, kind: 'align-lockfile', detail: result.detail })
    }
    return { status: result.ok ? 200 : 500, body: { ok: result.ok, detail: result.detail } }
  }

  if (method === 'POST' && pathname === '/api/plugins/disable') {
    const paths = pathsFor(options, profile)
    const body = await readJsonBody(rawBody)
    const rowId = String(body.rowId ?? '')
    if (rowId === '') throw new PanelApiError('rowId is required', 400)
    const view = rowViews(options, profile).find((r) => r.rowId === rowId)
    if (view === undefined) throw new PanelApiError('row not found', 404)
    if (view.protected) throw new PanelApiError('row belongs to the official bundle set and cannot be disabled', 403)
    if (view.disabled) return { status: 200, body: { ok: true, detail: 'already disabled' } }
    const result = appendDisabledRow(paths.profileDir, rowId)
    if (!result.ok) throw new PanelApiError(result.problem ?? 'disable failed', 500)
    appendMemory(paths, { type: 'fix', ts: new Date().toISOString(), profile, kind: 'write-disabled', detail: `disabled row ${rowId}` })
    return { status: 200, body: { ok: true, backup: result.backup } }
  }

  if (method === 'POST' && pathname === '/api/plugins/enable') {
    const paths = pathsFor(options, profile)
    const body = await readJsonBody(rawBody)
    const rowId = String(body.rowId ?? '')
    if (rowId === '') throw new PanelApiError('rowId is required', 400)
    const result = removeDisabledRow(paths.profileDir, rowId)
    if (!result.ok) throw new PanelApiError(result.problem ?? 'enable failed', 500)
    appendMemory(paths, { type: 'fix', ts: new Date().toISOString(), profile, kind: 'write-disabled', detail: `enabled row ${rowId}` })
    return { status: 200, body: { ok: true, backup: result.backup } }
  }

  return { status: 404, body: { error: `no route for ${method} ${pathname}` } }
}

export function isScanError(error: unknown): boolean {
  return error instanceof ScanError
}
