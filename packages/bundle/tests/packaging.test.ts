import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal glob semantics for the tarball `files` list (`*` = one path segment). */
function matches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`).test(path)
}

describe('published files', () => {
  it('covers every host-half module the bundle entry imports', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { files: string[] }
    const sources = readdirSync(join(packageDir, 'src'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    for (const source of sources) {
      const output = `lib/${source.replace(/\.ts$/, '.js')}`
      expect(
        manifest.files.some((pattern) => matches(pattern, output)),
        `${output} is not covered by the files list`,
      ).toBe(true)
    }
  })
})
