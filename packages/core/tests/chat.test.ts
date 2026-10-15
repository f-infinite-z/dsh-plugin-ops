import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeHome } from './helpers.js'
import { lookupSecret } from '../src/index.js'

const KEY = 'DSH_OPS_TEST_KEY'
const saved = process.env[KEY]

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe('lookupSecret precedence (dsh 0.2.1-alpha.3: stored credentials win)', () => {
  it('prefers the credentials ref over the environment and $DSH_HOME/.env', () => {
    const fixture = makeHome()
    try {
      writeFileSync(join(fixture.home, '.credentials.yaml'), `version: 1\nrefs:\n  ${KEY}: from-credentials\n`, 'utf8')
      writeFileSync(join(fixture.home, '.env'), `${KEY}=from-dotenv\n`, 'utf8')
      process.env[KEY] = 'from-env'
      expect(lookupSecret(KEY, fixture.home)).toBe('from-credentials')
    } finally {
      fixture.dispose()
    }
  })

  it('falls back to the environment, then $DSH_HOME/.env', () => {
    const fixture = makeHome()
    try {
      writeFileSync(join(fixture.home, '.env'), `${KEY}=from-dotenv\n`, 'utf8')
      process.env[KEY] = 'from-env'
      expect(lookupSecret(KEY, fixture.home)).toBe('from-env')
      delete process.env[KEY]
      expect(lookupSecret(KEY, fixture.home)).toBe('from-dotenv')
    } finally {
      fixture.dispose()
    }
  })

  it('skips empty stored values and returns null without any layer', () => {
    const fixture = makeHome()
    try {
      writeFileSync(join(fixture.home, '.credentials.yaml'), `version: 1\nrefs:\n  ${KEY}: ''\n`, 'utf8')
      process.env[KEY] = 'from-env'
      expect(lookupSecret(KEY, fixture.home)).toBe('from-env')
      delete process.env[KEY]
      expect(lookupSecret(KEY, fixture.home)).toBeNull()
    } finally {
      fixture.dispose()
    }
  })
})
