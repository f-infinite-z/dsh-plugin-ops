/**
 * Session-container repair: a minimal, reversible fix layer for the two
 * corruption classes that abort a dsh boot — structure-broken artifacts and
 * path-mismatched session directories. Deep event-level diagnostics (seq gaps,
 * unknown types, empty text blocks, ...) stay with
 * `@argszero/cordis-plugin-session-audit`; this module only handles what a
 * pre-boot fix can safely do, and it never deletes anything.
 *
 * The header probe decodes the first Zstandard frame of a session container
 * with Node's built-in zstd (the harness writes one header line per first
 * frame). A container whose structure is broken fails this decode; a container
 * whose later frames are torn decodes fine, matching the harness's own
 * tolerance for crash tails.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** One session artifact that needs attention before the next boot. */
export interface SessionFinding {
  /** `unreadable` aborts the boot; `path-mismatch` aborts it when the backend re-derives the path. */
  kind: 'unreadable' | 'path-mismatch'
  /** Absolute session directory. */
  sessionDir: string
  /** Absolute artifact file inside {@link sessionDir}. */
  file: string
  /** Header id decoded from the first frame, when readable. */
  headerId: string | null
  /** Current directory name (compared against the header id). */
  directoryName: string
  /** Artifact size in bytes. */
  sizeBytes: number
  /** Human-readable diagnosis. */
  detail: string
}

/** Result of scanning one sessions root. */
export interface SessionScanResult {
  /** Absolute sessions root. */
  root: string
  /** Artifacts inspected. */
  scanned: number
  /** Artifacts needing attention. */
  findings: SessionFinding[]
}

const HEADER_PROBE_BYTES = 256 * 1024

function readPrefix(file: string, max: number, size: number): Buffer {
  const length = Math.min(max, size)
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

type HeaderProbe =
  | { kind: 'header'; line: string }
  | { kind: 'unreadable'; detail: string }

/** Decode the first frame (or line) of one session artifact. */
function probeHeader(file: string, size: number, compressed: boolean): HeaderProbe {
  const prefix = readPrefix(file, HEADER_PROBE_BYTES, size)
  if (compressed) {
    let text: string
    try {
      text = zstdDecompressSync(prefix).toString('utf8')
    } catch (error) {
      // A first frame larger than the probe cannot happen for a header line;
      // retry once with the whole file before declaring it unreadable.
      if (size > prefix.length) {
        try {
          text = zstdDecompressSync(readPrefix(file, size, size)).toString('utf8')
        } catch (fullError) {
          return { kind: 'unreadable', detail: `corrupt Zstandard session log: ${String(fullError)}` }
        }
      } else {
        return { kind: 'unreadable', detail: `corrupt Zstandard session log: ${String(error)}` }
      }
    }
    const line = text.split('\n', 1)[0] ?? ''
    return { kind: 'header', line }
  }
  const line = prefix.toString('utf8').split('\n', 1)[0] ?? ''
  return { kind: 'header', line }
}

function headerIdOf(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null
  } catch {
    return null
  }
}

/**
 * Scan every session artifact under one sessions root. Only the two
 * boot-blocking classes are reported: an artifact whose first frame cannot be
 * decoded (the harness's artifact listing aborts on it) and a session
 * directory whose name differs from its header id (the backend re-derives the
 * path and refuses the read). Empty artifacts and undecodable-but-present
 * headers are tolerated, matching the harness.
 * @param root - absolute sessions root (`$DSH_HOME/sessions`).
 * @returns the scan result with per-artifact findings.
 */
export function scanSessions(root: string): SessionScanResult {
  const findings: SessionFinding[] = []
  let scanned = 0
  if (!existsSync(root)) return { root, scanned: 0, findings: [] }
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      for (const name of readdirSync(sessionDir)) {
        if (!/^session.*\.jsonl(\.zstd)?$/.test(name)) continue
        const file = join(sessionDir, name)
        let size: number
        try {
          size = statSync(file).size
        } catch {
          continue
        }
        scanned++
        if (size === 0) continue
        const probe = probeHeader(file, size, name.endsWith('.zstd'))
        if (probe.kind === 'unreadable') {
          findings.push({
            kind: 'unreadable',
            sessionDir,
            file,
            headerId: null,
            directoryName: session.name,
            sizeBytes: size,
            detail: probe.detail,
          })
          continue
        }
        const headerId = headerIdOf(probe.line)
        if (headerId !== null && session.name !== headerId) {
          findings.push({
            kind: 'path-mismatch',
            sessionDir,
            file,
            headerId,
            directoryName: session.name,
            sizeBytes: size,
            detail: `directory "${session.name}" does not match the header id "${headerId}"`,
          })
        }
      }
    }
  }
  return { root, scanned, findings }
}

/** One executed or refused move. */
export interface SessionMove {
  from: string
  to: string
}

/** Outcome of applying one repair class. */
export interface SessionRepairResult {
  moved: SessionMove[]
  refused: { target: string; reason: string }[]
}

function emptyResult(): SessionRepairResult {
  return { moved: [], refused: [] }
}

/**
 * Move every path-mismatched session directory back to the name its header
 * identifies, inside the same project directory. A target that already exists
 * is refused rather than overwritten.
 * @param findings - scan findings (other kinds are ignored).
 * @returns executed and refused moves.
 */
export function repairSessionPaths(findings: readonly SessionFinding[]): SessionRepairResult {
  const result = emptyResult()
  for (const finding of findings) {
    if (finding.kind !== 'path-mismatch' || finding.headerId === null) continue
    const target = join(dirname(finding.sessionDir), finding.headerId)
    if (existsSync(target)) {
      result.refused.push({ target, reason: 'the target directory already exists' })
      continue
    }
    try {
      renameSync(finding.sessionDir, target)
      result.moved.push({ from: finding.sessionDir, to: target })
    } catch (error) {
      result.refused.push({ target, reason: String(error) })
    }
  }
  return result
}

/**
 * Move every unreadable session directory into a quarantine root (never
 * deleted), preserving the project name in the target for traceability.
 * @param findings - scan findings (other kinds are ignored).
 * @param quarantineRoot - absolute directory to move artifacts into.
 * @returns executed and refused moves.
 */
export function quarantineSessions(findings: readonly SessionFinding[], quarantineRoot: string): SessionRepairResult {
  const result = emptyResult()
  const unreadable = findings.filter((finding) => finding.kind === 'unreadable')
  if (unreadable.length === 0) return result
  mkdirSync(quarantineRoot, { recursive: true })
  for (const finding of unreadable) {
    const target = join(quarantineRoot, `${basename(dirname(finding.sessionDir))}-${finding.directoryName}`)
    if (existsSync(target)) {
      result.refused.push({ target, reason: 'the target directory already exists' })
      continue
    }
    try {
      renameSync(finding.sessionDir, target)
      result.moved.push({ from: finding.sessionDir, to: target })
    } catch (error) {
      result.refused.push({ target, reason: String(error) })
    }
  }
  return result
}
