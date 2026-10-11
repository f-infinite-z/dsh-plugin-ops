import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { detectLang, type Lang } from './i18n.js'
import { SANDBOX_DICTS } from './sandbox-i18n.js'

/**
 * The right-column sandbox panel: drives the isolated "number 2 dsh" from
 * outside — start/stop, open it in a new tab, watch its output live, scan and
 * diagnose it, and apply disable-row repairs (each repair restarts the
 * sandbox so the outcome proves whether it worked). Data comes from the host
 * half's same-origin `/dsh-ops` API.
 */

const API = '/dsh-ops'
const POLL_MS = 2500
const MAX_LOG_LINES = 400
const STYLE_ID = 'dsh-ops-sandbox-style'

interface SandboxStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping'
  url: string | null
  home: string | null
  startedAt: string | null
  problem: string | null
  lastExit: { code: number | null; at: string } | null
}

interface SandboxLog {
  seq: number
  ts: string
  line: string
}

interface Finding {
  ruleId: string
  severity: 'fatal' | 'warn' | 'info' | string
  packageName?: string
  message: string
}

function useStyle(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
.dshops-sb { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.5; height: 100%; overflow: auto; }
.dshops-sb .sb-badge { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 11px; margin-left: 6px; }
.dshops-sb .sb-stopped { background: rgba(127,127,127,.18); }
.dshops-sb .sb-running { background: rgba(46,160,67,.22); }
.dshops-sb .sb-pending { background: rgba(210,153,34,.25); }
.dshops-sb-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dshops-sb button { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: transparent; cursor: pointer; }
.dshops-sb button:disabled { opacity: .5; cursor: default; }
.dshops-sb .sb-kv { display: flex; gap: 6px; }
.dshops-sb .sb-kv .k { opacity: .65; flex: none; }
.dshops-sb .sb-url { word-break: break-all; }
.dshops-sb .sb-problem { color: #d29922; white-space: pre-wrap; }
.dshops-sb .sb-msg { white-space: pre-wrap; }
.dshops-sb .sb-finding { border-left: 3px solid rgba(127,127,127,.4); padding: 2px 0 2px 8px; margin: 4px 0; }
.dshops-sb .sb-fatal { border-color: #f85149; }
.dshops-sb .sb-warn { border-color: #d29922; }
.dshops-sb .sb-info { border-color: #58a6ff; }
.dshops-sb .sb-fixrow { display: flex; gap: 6px; }
.dshops-sb .sb-fixrow input { flex: 1; min-width: 0; font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
.dshops-sb pre.sb-log { margin: 0; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.1); max-height: 260px; overflow: auto; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.dshops-sb .sb-section { font-weight: 600; margin-top: 2px; }
.dshops-sb .sb-dim { opacity: .65; }
`
    document.head.appendChild(el)
  }, [])
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T
  if (!res.ok) {
    const message = typeof (data as { message?: unknown }).message === 'string' ? (data as { message: string }).message : `HTTP ${res.status}`
    throw new Error(message)
  }
  return data
}

/** The sandbox tab body (registered under `sidebar.right.pane.tab`). */
export function SandboxPanel(): ReactNode {
  useStyle()
  const lang: Lang = useMemo(() => detectLang(), [])
  const t = SANDBOX_DICTS[lang]
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [logs, setLogs] = useState<SandboxLog[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [errorLines, setErrorLines] = useState<string[] | null>(null)
  const [fixInput, setFixInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const seqRef = useRef(0)
  const logRef = useRef<HTMLPreElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await api<{ status: SandboxStatus; logs: SandboxLog[]; nextSeq: number }>(`/api/sandbox/status?after=${seqRef.current}`)
      setStatus(data.status)
      if (data.logs.length > 0) {
        seqRef.current = data.nextSeq
        setLogs((prev) => [...prev, ...data.logs].slice(-MAX_LOG_LINES))
      }
    } catch {
      /* transient: the host half may be restarting */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [logs])

  const act = useCallback(async (name: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(name)
    setMessage(null)
    try {
      const data = await api<Record<string, unknown>>(path, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (typeof data.status === 'object' && data.status !== null) setStatus(data.status as SandboxStatus)
      return data
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(null)
    }
  }, [])

  const runScan = useCallback(async (): Promise<void> => {
    setBusy('scan')
    setScanNote(null)
    try {
      const data = await api<{ ok: boolean; findings?: Finding[]; message?: string }>('/api/sandbox/scan')
      if (data.ok) {
        setFindings(data.findings ?? [])
      } else {
        setScanNote(data.message ?? t.startFirst)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [t])

  const runDiagnose = useCallback(async (): Promise<void> => {
    setBusy('diagnose')
    try {
      const data = await api<{ diagnosis: { errorLines: string[] } }>('/api/sandbox/diagnose')
      setErrorLines(data.diagnosis.errorLines)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [])

  const applyFix = useCallback(async (): Promise<void> => {
    const rows = fixInput.split(/[,，\s]+/).map((row) => row.trim()).filter((row) => row !== '')
    if (rows.length === 0) return
    const data = await act('fix', '/api/sandbox/fix', { rows })
    if (data === null) return
    const applied = Array.isArray(data.applied) ? (data.applied as { row: string; ok: boolean; detail: string }[]) : []
    const lines = applied.map((entry) => `${entry.ok ? t.fixApplied : t.fixFailed}${entry.row}`)
    const restarted = data.restarted === true
    const restart = data.status as SandboxStatus | undefined
    if (!restarted) {
      lines.push(t.fixNotApplied)
    } else if (restart !== undefined) {
      lines.push(restart.state === 'running' ? t.restartHeld : t.restartBroke)
    }
    setMessage(lines.join('\n'))
  }, [act, fixInput, t])

  const stateKey = status?.state ?? 'stopped'
  const badgeClass = stateKey === 'running' ? 'sb-running' : stateKey === 'stopped' ? 'sb-stopped' : 'sb-pending'
  const stateLabel = stateKey === 'running' ? t.stateRunning : stateKey === 'starting' ? t.stateStarting : stateKey === 'stopping' ? t.stateStopping : t.stateStopped
  const notStopped = stateKey === 'running' || stateKey === 'starting'

  return (
    <div className="dshops-sb">
      <div>
        <span className="sb-section">{t.title}</span>
        <span className={`sb-badge ${badgeClass}`}>{stateLabel}</span>
      </div>
      <div className="sb-dim">{t.subtitle}</div>

      <div className="dshops-sb-actions">
        <button disabled={busy !== null || notStopped} onClick={() => { void act('start', '/api/sandbox/start') }}>{t.start}</button>
        <button disabled={busy !== null || stateKey !== 'running'} onClick={() => { void act('restart', '/api/sandbox/restart') }}>{t.restart}</button>
        <button disabled={busy !== null || !notStopped} onClick={() => { void act('stop', '/api/sandbox/stop') }}>{t.stop}</button>
        <button disabled={status?.url === null || status?.url === undefined} onClick={() => { if (status?.url != null) window.open(status.url, '_blank', 'noopener') }}>{t.open}</button>
        <button disabled={busy !== null} onClick={() => { void runScan() }}>{t.scan}</button>
        <button disabled={busy !== null} onClick={() => { void runDiagnose() }}>{t.diagnose}</button>
        <button disabled={busy !== null} onClick={() => { void refresh() }}>{t.refresh}</button>
      </div>

      {busy !== null ? <div className="sb-dim">{t.busy}</div> : null}
      {message !== null ? <div className="sb-msg">{message}</div> : null}

      {status !== null ? (
        <div>
          {status.url !== null ? (
            <div className="sb-kv"><span className="k">{t.url}</span><span className="sb-url">{status.url}</span></div>
          ) : null}
          {status.home !== null ? (
            <div className="sb-kv"><span className="k">{t.home}</span><span className="sb-url">{status.home}</span></div>
          ) : null}
          {status.problem !== null ? <div className="sb-problem">{status.problem}</div> : null}
        </div>
      ) : null}

      {scanNote !== null ? <div className="sb-dim">{scanNote}</div> : null}
      {findings !== null ? (
        <div>
          <div className="sb-section">{t.findings}</div>
          {findings.length === 0 ? <div className="sb-dim">{t.noFindings}</div> : findings.map((finding, index) => (
            <div key={`${finding.ruleId}-${index}`} className={`sb-finding sb-${finding.severity === 'fatal' || finding.severity === 'warn' ? finding.severity : 'info'}`}>
              <div>[{finding.severity}] {finding.ruleId}: {finding.message}</div>
              {finding.packageName !== undefined ? (
                <button
                  onClick={() => {
                    setFixInput((prev) => (prev.trim() === '' ? finding.packageName! : `${prev}, ${finding.packageName!}`))
                  }}
                >
                  {t.useRow}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {errorLines !== null ? (
        <div>
          <div className="sb-section">{t.errorLines}</div>
          {errorLines.length === 0 ? <div className="sb-dim">{t.noFindings}</div> : <pre className="sb-log">{errorLines.join('\n')}</pre>}
        </div>
      ) : null}

      <div>
        <div className="sb-section">{t.fixTitle}</div>
        <div className="sb-dim">{t.fixHint}</div>
        <div className="sb-fixrow">
          <input
            value={fixInput}
            placeholder={t.fixPlaceholder}
            onChange={(event) => { setFixInput(event.target.value) }}
          />
          <button disabled={busy !== null || fixInput.trim() === '' || !notStopped} onClick={() => { void applyFix() }}>{t.fixApply}</button>
        </div>
      </div>

      <div>
        <div className="sb-section">{t.logs}</div>
        <pre className="sb-log" ref={logRef}>{logs.map((entry) => entry.line).join('\n')}</pre>
      </div>
    </div>
  )
}
