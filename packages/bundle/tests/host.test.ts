import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelChannel } from 'dsh-plugin-ops-core'
import { createHostHandler, profileFromBaseUrl } from '../src/host.js'

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ops-bundle-test-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  return home
}

function profileUrl(home: string, name = 'web'): string {
  return `${pathToFileURL(join(home, 'profiles', name)).href}/`
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function handlerFor(home: string, channel: ModelChannel | null) {
  return createHostHandler({ home, profile: 'web', config: {}, channel: () => channel })
}

describe('profileFromBaseUrl', () => {
  it('accepts a profile directory URL', () => {
    expect(profileFromBaseUrl(profileUrl('C:/Users/x/.dsh'))).toBe('web')
  })

  it('rejects directories outside profiles/', () => {
    const url = `${pathToFileURL(join('C:/Users/x', 'other', 'web')).href}/`
    expect(profileFromBaseUrl(url)).toBeNull()
  })

  it('rejects missing or unparsable values', () => {
    expect(profileFromBaseUrl(undefined)).toBeNull()
    expect(profileFromBaseUrl('')).toBeNull()
    expect(profileFromBaseUrl('not a url')).toBeNull()
  })
})

describe('createHostHandler', () => {
  it('serves info with the embedded default profile', async () => {
    const home = makeHome()
    try {
      await withServer(handlerFor(home, null), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/info`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { defaultProfile: string | null; profiles: { name: string }[] }
        expect(body.defaultProfile).toBe('web')
        expect(body.profiles.some((p) => p.name === 'web')).toBe(true)
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('delegates scan to the shared engine', async () => {
    const home = makeHome()
    try {
      await withServer(handlerFor(home, null), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/scan?profile=web`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { profile: string; counts: { fatal: number } }
        expect(body.profile).toBe('web')
        expect(typeof body.counts.fatal).toBe('number')
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects requests outside the prefix', async () => {
    const home = makeHome()
    try {
      await withServer(handlerFor(home, null), async (base) => {
        const res = await fetch(`${base}/api/info`)
        expect(res.status).toBe(404)
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects cross-origin requests', async () => {
    const home = makeHome()
    try {
      await withServer(handlerFor(home, null), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/info`, { headers: { origin: 'http://evil.example' } })
        expect(res.status).toBe(403)
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports a missing channel instead of failing chat', async () => {
    const home = makeHome()
    try {
      await withServer(handlerFor(home, null), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: 'web', lang: 'en', messages: [{ role: 'user', content: 'hi' }] }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean; error?: string }
        expect(body.ok).toBe(false)
        expect(body.error).toContain('no model channel')
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('answers chat through the provided channel', async () => {
    const home = makeHome()
    const channel: ModelChannel = { complete: async () => ({ reply: 'hello', ok: true }) }
    try {
      await withServer(handlerFor(home, channel), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: 'web', lang: 'en', messages: [{ role: 'user', content: 'hi' }] }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean; reply: string }
        expect(body).toEqual({ ok: true, reply: 'hello' })
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects chat without messages', async () => {
    const home = makeHome()
    const channel: ModelChannel = { complete: async () => ({ reply: 'x', ok: true }) }
    try {
      await withServer(handlerFor(home, channel), async (base) => {
        const res = await fetch(`${base}/dsh-ops/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: 'web', messages: [] }),
        })
        expect(res.status).toBe(400)
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
