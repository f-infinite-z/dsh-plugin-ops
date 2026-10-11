import type { ReactNode } from 'react'
import { detectLang } from './i18n.js'
import { SANDBOX_DICTS } from './sandbox-i18n.js'

/**
 * The sandbox surfaces beside the panel: the sidebar footer action that opens
 * it, the tab title, and the guide capsule. Each registration injects an
 * `open` callback; clicks are contained because opening the column throws
 * while no session seat is mounted.
 */

/** Injected into the entry and guide registrations. */
interface OpenProps {
  open?: () => void
}

function openSafely(props: OpenProps): void {
  try {
    props.open?.()
  } catch {
    /* no mounted session seat: nothing to open into */
  }
}

/** Compact sidebar footer button that opens (or focuses) the sandbox panel. */
export function SandboxEntry(props: OpenProps): ReactNode {
  const t = SANDBOX_DICTS[detectLang()]
  return (
    <button
      type="button"
      title={`dsh-ops · ${t.title}`}
      aria-label={`dsh-ops · ${t.title}`}
      onClick={() => { openSafely(props) }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, border: 'none', background: 'transparent',
        borderRadius: 6, cursor: 'pointer', color: 'inherit', opacity: 0.85,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M2.5 6.5h11M6 3V1.8M10 3V1.8" />
      </svg>
    </button>
  )
}

/** Right-column tab title (registered under `sidebar.right.pane.tab.title`). */
export function SandboxTitle(): ReactNode {
  const t = SANDBOX_DICTS[detectLang()]
  return <span>{t.title}</span>
}

/** Guide capsule offered on the right column's guide page. */
export function SandboxGuide(props: OpenProps): ReactNode {
  const t = SANDBOX_DICTS[detectLang()]
  return (
    <button
      type="button"
      onClick={() => { openSafely(props) }}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
        border: '1px solid rgba(127,127,127,.3)', borderRadius: 8,
        background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600 }}>{t.title}</div>
      <div style={{ opacity: 0.65, marginTop: 2 }}>{t.guide}</div>
    </button>
  )
}
