import { describe, expect, it } from 'vitest'
import { makeHome } from './helpers.js'
import {
  bm25Search,
  deleteKnowledge,
  formatKnowledgeContext,
  listKnowledge,
  parseDepositReply,
  readKnowledge,
  recordFixKnowledge,
  tokenize,
  upsertKnowledge,
  writeKnowledge,
} from '../src/index.js'

describe('knowledge store', () => {
  it('writes, reads, lists, and deletes entries', () => {
    const fixture = makeHome()
    try {
      const written = writeKnowledge(fixture.paths, {
        title: '依赖漂移修复',
        source: 'fix',
        tags: ['dependency-drift', 'is-odd'],
        symptom: 'installed 9.9.9 deviates from locked 3.0.1',
        cause: '包文件被篡改',
        fix: '重建 node_modules 后 frozen install',
        notes: 'profile: web',
      })
      expect(written.ok).toBe(true)
      expect(written.id).toBeDefined()
      const entries = listKnowledge(fixture.paths)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.occurrences).toBe(1)
      const read = readKnowledge(fixture.paths, written.id!)
      expect(read?.title).toBe('依赖漂移修复')
      expect(read?.tags).toContain('is-odd')
      expect(read?.lastSeenAt).toBe(read?.createdAt)
      expect(deleteKnowledge(fixture.paths, written.id!)).toBe(true)
      expect(listKnowledge(fixture.paths)).toHaveLength(0)
    } finally {
      fixture.dispose()
    }
  })

  it('rejects unsafe ids', () => {
    const fixture = makeHome()
    try {
      expect(readKnowledge(fixture.paths, '../../etc/passwd')).toBeNull()
      expect(deleteKnowledge(fixture.paths, '../x')).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})

describe('tokenize + bm25', () => {
  it('produces ascii words and CJK bigrams', () => {
    const tokens = tokenize('修复 is-odd 依赖漂移')
    expect(tokens).toContain('is-odd')
    expect(tokens).toContain('依赖')
    expect(tokens).toContain('漂移')
  })

  it('ranks the matching entry first', () => {
    const fixture = makeHome()
    try {
      writeKnowledge(fixture.paths, {
        title: '依赖漂移',
        source: 'fix',
        tags: ['dependency-drift'],
        symptom: 'installed version deviates from locked version',
        cause: '',
        fix: 'realign',
      })
      writeKnowledge(fixture.paths, {
        title: 'peer 缺口',
        source: 'fix',
        tags: ['peer-gap'],
        symptom: 'peer dependency cannot resolve',
        cause: '',
        fix: 'install peer',
      })
      const entries = listKnowledge(fixture.paths)
      const hits = bm25Search(entries, 'dependency drift installed locked')
      expect(hits[0]?.entry.title).toBe('依赖漂移')
    } finally {
      fixture.dispose()
    }
  })
})

describe('upsert / merge', () => {
  it('merges a repeated problem into one entry', () => {
    const fixture = makeHome()
    try {
      const first = upsertKnowledge(fixture.paths, {
        title: '自动记录：dependency-drift (is-odd)',
        source: 'fix',
        tags: ['dependency-drift', 'is-odd'],
        symptom: 'installed 9.9.9 deviates',
        cause: '',
        fix: 'rebuild',
      })
      expect(first.ok).toBe(true)
      const second = upsertKnowledge(fixture.paths, {
        title: '自动记录：dependency-drift (is-odd)',
        source: 'gate',
        tags: ['is-odd', 'dependency-drift'],
        symptom: 'installed 8.8.8 deviates',
        cause: '',
        fix: 'rebuild',
      })
      expect(second.ok).toBe(true)
      const entries = listKnowledge(fixture.paths)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.occurrences).toBe(2)
      expect(entries[0]?.symptom).toContain('9.9.9')
      expect(entries[0]?.symptom).toContain('8.8.8')
    } finally {
      fixture.dispose()
    }
  })

  it('creates separate entries for different problems', () => {
    const fixture = makeHome()
    try {
      upsertKnowledge(fixture.paths, { title: 'A', source: 'fix', tags: ['rule-a'], symptom: 'sa', cause: '', fix: 'fa' })
      upsertKnowledge(fixture.paths, { title: 'B', source: 'fix', tags: ['rule-b'], symptom: 'sb', cause: '', fix: 'fb' })
      expect(listKnowledge(fixture.paths)).toHaveLength(2)
    } finally {
      fixture.dispose()
    }
  })

  it('recordFixKnowledge merges repeated fatal findings', () => {
    const fixture = makeHome()
    try {
      const finding = {
        ruleId: 'dependency-drift' as const,
        severity: 'fatal' as const,
        packageName: 'is-odd',
        message: 'installed 9.9.9 deviates from locked 3.0.1',
        fix: { kind: 'align-lockfile' as const },
      }
      recordFixKnowledge(fixture.paths, { profile: 'web', source: 'fix', findings: [finding], action: 'align-lockfile', detail: 'realigned' })
      recordFixKnowledge(fixture.paths, { profile: 'web', source: 'gate', findings: [finding], action: 'align-lockfile', detail: 'realigned' })
      const entries = listKnowledge(fixture.paths)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.occurrences).toBe(2)
    } finally {
      fixture.dispose()
    }
  })
})

describe('deposit parsing + prompt context', () => {
  it('parses a JSON reply, tolerating code fences', () => {
    const draft = parseDepositReply(
      '```json\n{"title":"T","symptom":"S","cause":"C","fix":"F","tags":["a"],"notes":"N"}\n```',
    )
    expect(draft).toEqual({ title: 'T', symptom: 'S', cause: 'C', fix: 'F', tags: ['a'], notes: 'N' })
    expect(parseDepositReply('not json')).toBeNull()
    expect(parseDepositReply('{"symptom":"no title"}')).toBeNull()
  })

  it('formats knowledge context for the prompt', () => {
    const fixture = makeHome()
    try {
      writeKnowledge(fixture.paths, { title: 'T1', source: 'manual', tags: [], symptom: 'S1', cause: 'C1', fix: 'F1' })
      const entry = listKnowledge(fixture.paths)[0]
      expect(entry).toBeDefined()
      const text = formatKnowledgeContext([{ entry: entry!, score: 1, bm25: 1, vector: null }])
      expect(text).toContain('### 1. T1')
      expect(text).toContain('- 修复: F1')
    } finally {
      fixture.dispose()
    }
  })
})
