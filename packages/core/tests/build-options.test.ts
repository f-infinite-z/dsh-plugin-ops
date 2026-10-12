import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAllowBuildsState, setAllowBuilds } from '../src/build-options.js'

function withProfile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-buildopts-'))
  if (content !== null) writeFileSync(join(dir, 'pnpm-workspace.yaml'), content, 'utf8')
  return dir
}

describe('readAllowBuildsState', () => {
  it('reads an absent file or key as no options', () => {
    const a = withProfile(null)
    const b = withProfile('nodeLinker: hoisted\n')
    try {
      expect(readAllowBuildsState(a)).toEqual({ value: null, placeholders: [] })
      expect(readAllowBuildsState(b)).toEqual({ value: null, placeholders: [] })
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('accepts a fully decided map and collects placeholder entries', () => {
    const decided = withProfile('allowBuilds:\n  protobufjs@7.0.0: true\n  sharp@1.0.0: false\n')
    const mixed = withProfile('allowBuilds:\n  protobufjs@7.0.0: true\n  "@google/genai@1.0.0": set this to true or false\n')
    try {
      expect(readAllowBuildsState(decided).placeholders).toEqual([])
      expect(readAllowBuildsState(mixed).placeholders).toEqual(['@google/genai@1.0.0'])
    } finally {
      rmSync(decided, { recursive: true, force: true })
      rmSync(mixed, { recursive: true, force: true })
    }
  })

  it('flags a scalar stand-in for the whole map', () => {
    const dir = withProfile('allowBuilds: choose true or false\n')
    try {
      expect(readAllowBuildsState(dir).placeholders).toEqual(['(the whole allowBuilds map)'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('setAllowBuilds', () => {
  it('creates the mapping when absent and keeps the rest of the document intact', () => {
    const dir = withProfile('packages:\n  - .\n\n# keep this comment\nnodeLinker: hoisted\n')
    try {
      const write = setAllowBuilds(dir, { 'protobufjs@7.0.0': true })
      expect(write.ok).toBe(true)
      expect(write.backup).not.toBeNull()
      const text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      expect(text).toContain('# keep this comment')
      expect(text).toContain('nodeLinker: hoisted')
      const state = readAllowBuildsState(dir)
      expect(state.placeholders).toEqual([])
      expect((state.value as Record<string, boolean>)['protobufjs@7.0.0']).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces placeholder values with decisions', () => {
    const dir = withProfile('allowBuilds:\n  "@google/genai@1.0.0": set this to true or false\n  protobufjs@7.0.0: choose\n')
    try {
      const write = setAllowBuilds(dir, { '@google/genai@1.0.0': true, 'protobufjs@7.0.0': false })
      expect(write.ok).toBe(true)
      const state = readAllowBuildsState(dir)
      expect(state.placeholders).toEqual([])
      expect((state.value as Record<string, boolean>)['@google/genai@1.0.0']).toBe(true)
      expect((state.value as Record<string, boolean>)['protobufjs@7.0.0']).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a scalar allowBuilds instead of overwriting it', () => {
    const dir = withProfile('allowBuilds: choose true or false\n')
    try {
      const write = setAllowBuilds(dir, { 'pkg@1.0.0': true })
      expect(write.ok).toBe(false)
      expect(write.problem).toContain('not a mapping')
      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('choose true or false')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
