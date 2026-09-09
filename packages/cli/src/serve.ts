import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handlePanelApi, PanelApiError, ScanError, type PanelApiOptions } from 'dsh-plugin-ops-core'
import type { DshPaths, OpsConfig } from 'dsh-plugin-ops-core'

export interface ServeOptions {
  paths: DshPaths
  host: string
  port: number
  config: OpsConfig
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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
    json(res, 500, { error: 'assets missing — rebuild the cli package (pnpm --filter dsh-plugin-ops build)' })
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(readFileSync(html, 'utf8'))
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
      throw new PanelApiError('request body too large', 413)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function serve(options: ServeOptions): Promise<number> {
  const apiOptions: PanelApiOptions = { paths: options.paths, config: options.config }
  const server = createServer(async (req, res) => {
    if (!originAllowed(req, options)) {
      json(res, 403, { error: 'cross-origin request rejected' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveAssets(res)
        return
      }
      if (!url.pathname.startsWith('/api/')) {
        json(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
        return
      }
      const body = req.method === 'POST' ? await collectBody(req) : undefined
      const result = await handlePanelApi(req.method ?? 'GET', url, apiOptions, body)
      json(res, result.status, result.body)
    } catch (error) {
      if (error instanceof PanelApiError) json(res, error.status, { error: error.message })
      else if (error instanceof ScanError) json(res, 400, { error: error.message })
      else json(res, 500, { error: error instanceof Error ? error.message : String(error) })
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
