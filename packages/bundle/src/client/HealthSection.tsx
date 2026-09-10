import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { DICTS, detectLang, format, type Lang } from './i18n.js'

const API = '/dsh-ops'
const PAGE_SIZE = 10

interface Info {
  home: string
  profiles: { name: string; bundles: number }[]
  defaultProfile: string | null
}

interface Finding {
  ruleId: string
  severity: 'fatal' | 'warn' | 'info'
  packageName?: string
  message: string
  detail?: string
  fix: { kind: string }
}

interface ScanResult {
  profile: string
  findings: Finding[]
  counts: { fatal: number; warn: number; info: number }
  ok: boolean
}

interface RowView {
  rowId: string
  source: string
  packageName?: string
  disabled: boolean
  protected: boolean
}

interface MemoryEvent {
  type: string
  ts: string
  detail: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

type Filter = 'all' | 'fatal' | 'warn' | 'ok'

async function api<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { body: init.body }),
    headers: { 'Content-Type': 'application/json' },
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

const STYLE_ID = 'dsh-ops-health-style'

const CSS = `
.dshops-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}
.dshops-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshops-title{font-size:15px;font-weight:600;margin-right:auto}
.dshops-sub{opacity:.65;font-size:12px}
.dshops-btn{border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
.dshops-btn:disabled{opacity:.5;cursor:default}
.dshops-btn-primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.dshops-select{border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:6px;padding:3px 6px;font-size:12px}
.dshops-card{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:10px 12px}
.dshops-card h3{margin:0 0 8px;font-size:13px;font-weight:600}
.dshops-counts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshops-pill{border-radius:10px;padding:1px 8px;font-size:11px}
.dshops-pill-fatal{background:rgba(229,57,53,.15);color:#e53935}
.dshops-pill-warn{background:rgba(251,140,0,.18);color:#fb8c00}
.dshops-pill-info{background:rgba(30,136,229,.15);color:#1e88e5}
.dshops-pill-ok{background:rgba(67,160,71,.15);color:#43a047}
.dshops-list{display:flex;flex-direction:column;gap:6px}
.dshops-item{border-left:3px solid rgba(128,128,128,.35);padding:4px 8px;background:rgba(128,128,128,.06);border-radius:4px}
.dshops-item-fatal{border-left-color:#e53935;background:rgba(229,57,53,.07)}
.dshops-item-warn{border-left-color:#fb8c00;background:rgba(251,140,0,.07)}
.dshops-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.12)}
.dshops-row:last-child{border-bottom:none}
.dshops-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.dshops-dim{opacity:.6}
.dshops-chat{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto}
.dshops-msg{max-width:85%;padding:6px 10px;border-radius:8px;white-space:pre-wrap}
.dshops-msg-user{align-self:flex-end;background:rgba(77,107,254,.18)}
.dshops-msg-assistant{align-self:flex-start;background:rgba(128,128,128,.12)}
.dshops-chatbar{display:flex;gap:6px;margin-top:8px}
.dshops-input{flex:1;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:5px 8px;background:transparent;color:inherit;font-size:12px}
.dshops-err{color:#e53935;font-size:12px}
.dshops-footer{display:flex;align-items:center;gap:8px;margin-top:8px}
`

function useStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    document.head.appendChild(el)
  }, [])
}

function severityOf(row: RowView, scan: ScanResult | null): 'fatal' | 'warn' | 'ok' {
  if (scan === null) return 'ok'
  let worst: 'fatal' | 'warn' | 'ok' = 'ok'
  for (const finding of scan.findings) {
    if (finding.packageName === undefined) continue
    if (finding.packageName !== row.packageName && finding.packageName !== row.rowId) continue
    if (finding.severity === 'fatal') return 'fatal'
    if (finding.severity === 'warn') worst = 'warn'
  }
  return worst
}

/**
 * Settings-page section for the embedded dsh-ops bundle: profile health
 * summary, scan findings, plugin-row enable/disable, fault timeline, and the
 * diagnosis chat. All data comes from the host half's same-origin `/dsh-ops`
 * API, which reuses the shared engine.
 */
export function HealthSection(): ReactNode {
  useStyles()
  const [lang, setLang] = useState<Lang>(detectLang)
  const t = DICTS[lang]
  const [info, setInfo] = useState<Info | null>(null)
  const [profile, setProfile] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [rows, setRows] = useState<RowView[]>([])
  const [events, setEvents] = useState<MemoryEvent[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(0)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatState, setChatState] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (name: string, scanOnly = false): Promise<void> => {
    setError('')
    setBusy(scanOnly ? 'scan' : 'load')
    try {
      const encoded = encodeURIComponent(name)
      const scanRes = await api<ScanResult>(`/api/scan?profile=${encoded}`)
      setScan(scanRes)
      if (!scanOnly) {
        const [rowsRes, memRes] = await Promise.all([
          api<{ rows: RowView[] }>(`/api/plugins?profile=${encoded}`),
          api<{ events: MemoryEvent[] }>(`/api/memory?profile=${encoded}`),
        ])
        setRows(rowsRes.rows)
        setEvents(memRes.events)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const infoRes = await api<Info>('/api/info')
        if (cancelled) return
        setInfo(infoRes)
        const initial = infoRes.defaultProfile ?? infoRes.profiles[0]?.name ?? 'web'
        setProfile(initial)
        await load(initial)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const changeProfile = (name: string): void => {
    setProfile(name)
    setPage(0)
    setScan(null)
    setRows([])
    setEvents([])
    setChat([])
    void load(name)
  }

  const alignFindings = scan?.findings.filter((f) => f.severity === 'fatal' && f.fix.kind === 'align-lockfile') ?? []

  const runFix = async (): Promise<void> => {
    if (profile === '') return
    setBusy('fix')
    setError('')
    try {
      await api(`/api/fix/execute?profile=${encodeURIComponent(profile)}`, { method: 'POST', body: '{}' })
      await load(profile)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const toggleRow = async (row: RowView): Promise<void> => {
    setError('')
    try {
      const action = row.disabled ? 'enable' : 'disable'
      await api(`/api/plugins/${action}?profile=${encodeURIComponent(profile)}`, {
        method: 'POST',
        body: JSON.stringify({ rowId: row.rowId }),
      })
      await load(profile, true)
      const rowsRes = await api<{ rows: RowView[] }>(`/api/plugins?profile=${encodeURIComponent(profile)}`)
      setRows(rowsRes.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const sendChat = async (): Promise<void> => {
    const text = chatInput.trim()
    if (text === '' || busy === 'chat') return
    const next: ChatMsg[] = [...chat, { role: 'user', content: text }]
    setChat(next)
    setChatInput('')
    setBusy('chat')
    setChatState(t.chatThinking)
    try {
      const res = await api<{ ok: boolean; reply: string; error?: string }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ profile, lang, messages: next }),
      })
      if (res.ok) {
        setChat([...next, { role: 'assistant', content: res.reply }])
      } else {
        setChatState(res.error ?? t.chatNoChannel)
      }
    } catch (e) {
      setChatState(`${t.loadFail}${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
      setChatState((state) => (state === t.chatThinking ? '' : state))
    }
  }

  const visibleRows = rows.filter((row) => filter === 'all' || severityOf(row, scan) === filter)
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE))
  const pageRows = visibleRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div className="dshops-root">
      <div className="dshops-head">
        <span className="dshops-title">{t.title}</span>
        <span className="dshops-sub">{t.subtitle}</span>
        <button className="dshops-btn" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
          {lang === 'zh' ? 'EN' : '中文'}
        </button>
        <button className="dshops-btn" disabled={profile === '' || busy !== ''} onClick={() => void load(profile)}>
          {busy === 'scan' ? t.scanning : t.refresh}
        </button>
        <button className="dshops-btn dshops-btn-primary" disabled={profile === '' || busy !== ''} onClick={() => void load(profile, true)}>
          {t.scan}
        </button>
      </div>

      <div className="dshops-head">
        <span className="dshops-dim">{t.profile}:</span>
        <select className="dshops-select" value={profile} onChange={(e) => changeProfile(e.target.value)}>
          {(info?.profiles ?? []).map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.bundles})
            </option>
          ))}
        </select>
        {info !== null && <span className="dshops-dim dshops-mono">{info.home}</span>}
      </div>

      {error !== '' && <div className="dshops-err">{error}</div>}

      <div className="dshops-card">
        <h3>{t.findings}</h3>
        {scan === null ? (
          <span className="dshops-dim">{busy === 'load' ? t.scanning : ''}</span>
        ) : (
          <>
            <div className="dshops-counts">
              <span className="dshops-pill dshops-pill-fatal">
                {t.fatal} {scan.counts.fatal}
              </span>
              <span className="dshops-pill dshops-pill-warn">
                {t.warn} {scan.counts.warn}
              </span>
              <span className="dshops-pill dshops-pill-info">
                {t.info} {scan.counts.info}
              </span>
              {scan.ok && <span className="dshops-pill dshops-pill-ok">{t.clean}</span>}
              {alignFindings.length > 0 && (
                <button className="dshops-btn" disabled={busy !== ''} onClick={() => void runFix()}>
                  {busy === 'fix' ? t.fixing : t.fix}
                </button>
              )}
            </div>
            <div className="dshops-list" style={{ marginTop: 8 }}>
              {scan.findings.map((finding, index) => (
                <div key={`${finding.ruleId}-${index}`} className={`dshops-item dshops-item-${finding.severity}`}>
                  <span className={`dshops-pill dshops-pill-${finding.severity}`}>{finding.severity}</span>{' '}
                  <span className="dshops-mono">[{finding.ruleId}]</span>{' '}
                  {finding.packageName !== undefined && <span className="dshops-mono">{finding.packageName}</span>}{' '}
                  {finding.message}
                  {finding.detail !== undefined && <div className="dshops-dim">{finding.detail}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="dshops-card">
        <h3>
          {t.rows}{' '}
          <select className="dshops-select" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setPage(0) }}>
            <option value="all">{t.filterAll}</option>
            <option value="fatal">{t.filterFatal}</option>
            <option value="warn">{t.filterWarn}</option>
            <option value="ok">{t.filterOk}</option>
          </select>
        </h3>
        <div>
          {pageRows.map((row) => {
            const severity = severityOf(row, scan)
            return (
              <div key={`${row.rowId}-${row.source}`} className="dshops-row">
                <span className={`dshops-pill dshops-pill-${severity === 'ok' ? 'ok' : severity}`}>{severity}</span>
                <span className="dshops-mono">{row.rowId}</span>
                <span className="dshops-dim dshops-mono">{row.packageName ?? ''}</span>
                <span style={{ marginLeft: 'auto' }} className="dshops-dim">
                  {row.protected && <span className="dshops-pill">{t.protectedTag}</span>}
                  {row.disabled && <span className="dshops-pill dshops-pill-warn">{t.disabledTag}</span>}
                </span>
                {!row.protected && (
                  <button className="dshops-btn" disabled={busy !== ''} onClick={() => void toggleRow(row)}>
                    {row.disabled ? t.enable : t.disable}
                  </button>
                )}
              </div>
            )
          })}
          {visibleRows.length === 0 && <div className="dshops-dim">{t.clean}</div>}
        </div>
        <div className="dshops-footer">
          <button className="dshops-btn" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            {t.prev}
          </button>
          <span className="dshops-dim">{format(t.pageOf, { cur: page + 1, total: totalPages })}</span>
          <button className="dshops-btn" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t.next}
          </button>
        </div>
      </div>

      <div className="dshops-card">
        <h3>{t.timeline}</h3>
        <div className="dshops-list">
          {events.map((event, index) => (
            <div key={`${event.ts}-${index}`} className="dshops-item">
              <span className="dshops-mono">{event.ts}</span> <span className="dshops-mono">[{event.type}]</span> {event.detail}
            </div>
          ))}
          {events.length === 0 && <div className="dshops-dim">{t.emptyTimeline}</div>}
        </div>
      </div>

      <div className="dshops-card">
        <h3>
          {t.chat} <span className="dshops-dim">{t.chatHint}</span>
        </h3>
        <div className="dshops-chat">
          {chat.length === 0 && <div className="dshops-msg dshops-msg-assistant dshops-dim">{t.chatWelcome}</div>}
          {chat.map((message, index) => (
            <div key={index} className={`dshops-msg dshops-msg-${message.role}`}>
              {message.content}
            </div>
          ))}
        </div>
        {chatState !== '' && <div className="dshops-err" style={{ marginTop: 6 }}>{chatState}</div>}
        <div className="dshops-chatbar">
          <input
            className="dshops-input"
            value={chatInput}
            placeholder={t.chatPlaceholder}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendChat()
            }}
          />
          <button className="dshops-btn dshops-btn-primary" disabled={busy === 'chat'} onClick={() => void sendChat()}>
            {busy === 'chat' ? t.chatThinking : t.chatSend}
          </button>
        </div>
      </div>
    </div>
  )
}
