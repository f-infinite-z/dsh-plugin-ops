import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveDshPaths, readProfileManifest, profileBundles, scanProfile, recentEvents,
  alignToLockfile, appendMemory, reportOk, ScanError,
  type DshPaths, type OpsConfig,
} from 'dsh-plugin-ops-core'

export interface ServeOptions {
  paths: DshPaths
  host: string
  port: number
  config: OpsConfig
}

interface ProfileInfo {
  name: string
  bundles: number
  manifest: boolean
}

function listProfiles(paths: DshPaths): ProfileInfo[] {
  if (!existsSync(paths.profilesDir)) return []
  const out: ProfileInfo[] = []
  for (const entry of readdirSync(paths.profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const profileDir = join(paths.profilesDir, entry.name)
    const manifestFile = join(profileDir, 'package.json')
    const manifest = readProfileManifest(manifestFile)
    out.push({
      name: entry.name,
      manifest: existsSync(manifestFile),
      bundles: manifest === null ? 0 : profileBundles(manifest).length,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function jsonError(res: ServerResponse, status: number, error: unknown): void {
  json(res, status, { error: error instanceof Error ? error.message : String(error) })
}

/**
 * Loopback-only guard: the panel hosts no user content and only talks to the
 * engine on this machine, but a browser page on the same machine must not be
 * able to drive writes cross-site. Only same-origin or bare (CLI/curl)
 * requests may reach the API.
 */
function originAllowed(req: IncomingMessage, options: ServeOptions): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const host = new URL(origin).host
    return host === `127.0.0.1:${options.port}` || host === `localhost:${options.port}` || host === `[::1]:${options.port}`
  } catch {
    return false
  }
}

function serveAssets(res: ServerResponse): void {
  const root = dirname(fileURLToPath(import.meta.url))
  const html = join(root, 'assets', 'index.html')
  if (!existsSync(html)) {
    jsonError(res, 500, 'assets missing — rebuild the cli package (pnpm --filter dsh-plugin-ops build)')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(readFileSync(html, 'utf8'))
}

function profilePaths(options: ServeOptions, profile: string): DshPaths {
  return resolveDshPaths(profile, options.paths.home)
}

export async function serve(options: ServeOptions): Promise<number> {
  const server = createServer(async (req, res) => {
    if (!originAllowed(req, options)) {
      jsonError(res, 403, 'cross-origin request rejected')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveAssets(res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        json(res, 200, {
          home: options.paths.home,
          profiles: listProfiles(options.paths),
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/scan') {
        const profile = url.searchParams.get('profile') ?? 'web'
        const paths = profilePaths(options, profile)
        const report = await scanProfile({
          paths, profileName: profile, config: options.config,
          updateCheck: url.searchParams.get('updates') === 'true',
        })
        const counts = { fatal: 0, warn: 0, info: 0 }
        for (const finding of report.findings) counts[finding.severity]++
        json(res, 200, { ...report, counts, ok: reportOk(report) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/memory') {
        const profile = url.searchParams.get('profile') ?? 'web'
        const paths = profilePaths(options, profile)
        const events = recentEvents(paths, profile, 12).map((event) => ({
          type: event.type,
          ts: event.ts,
          detail: 'detail' in event && typeof event.detail === 'string' ? event.detail : '',
        }))
        json(res, 200, { events })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/fix/preview') {
        const profile = url.searchParams.get('profile') ?? 'web'
        const paths = profilePaths(options, profile)
        const report = await scanProfile({ paths, profileName: profile, config: options.config, updateCheck: false })
        const alignable = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
        json(res, 200, {
          actions: alignable.length > 0
            ? [`pnpm install --frozen-lockfile --force (fixes ${alignable.length} drift finding(s)) in ${paths.profileDir}`]
            : [],
          ok: reportOk(report),
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/fix/execute') {
        const profile = url.searchParams.get('profile') ?? 'web'
        const paths = profilePaths(options, profile)
        const report = await scanProfile({ paths, profileName: profile, config: options.config, updateCheck: false })
        const alignable = report.findings.filter((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile')
        if (alignable.length === 0) {
          json(res, 200, { ok: true, detail: 'nothing to realign' })
          return
        }
        const result = await alignToLockfile(paths.profileDir)
        if (result.ok) {
          appendMemory(paths, {
            type: 'fix', ts: new Date().toISOString(), profile, kind: 'align-lockfile', detail: result.detail,
          })
        }
        json(res, result.ok ? 200 : 500, { ok: result.ok, detail: result.detail })
        return
      }
      jsonError(res, 404, `no route for ${req.method} ${url.pathname}`)
    } catch (error) {
      if (error instanceof ScanError) jsonError(res, 400, error.message)
      else jsonError(res, 500, error)
    }
  })
  server.listen(options.port, options.host)
  await new Promise<void>((resolve) => server.on('listening', resolve))
  process.stdout.write(`dsh-ops panel: http://${options.host}:${options.port}/ (Ctrl+C to stop)\n`)
  return new Promise<number>((resolve) => {
    const stop = () => {
      server.close(() => resolve(0))
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
