import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export function readTextFile(file: string): string | null {
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

export function readJsonFile<T>(file: string): T | null {
  const text = readTextFile(file)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function writeTextAtomic(file: string, content: string): void {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export function backupFile(file: string): string | null {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.dsh-ops-${stamp}.bak`
  writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
  return backup
}
