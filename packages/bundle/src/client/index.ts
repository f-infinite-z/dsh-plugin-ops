/**
 * dsh-plugin-ops browser half: the health-check section in the harness
 * settings page, plus the sandbox surfaces — a sidebar footer entry and a
 * right-column panel (with tab title and guide capsule) that drive the
 * isolated "number 2 dsh". Data comes from the host half's same-origin
 * `/dsh-ops` API. Platform modules (react, slots) stay external and resolve
 * through the shell module table at runtime.
 *
 * The sandbox surfaces need the right column's services; a harness that
 * ships neither keeps the settings section and silently skips the surfaces,
 * so the client half never holds a boot.
 */
import { HealthSection } from './HealthSection.js'
import { SandboxPanel } from './SandboxPanel.js'
import { SandboxEntry, SandboxGuide, SandboxTitle } from './SandboxEntry.js'
import { detectLang } from './i18n.js'
import { SANDBOX_DICTS } from './sandbox-i18n.js'

interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContext {
  slots: SlotsLike
  get(name: string): unknown
  inject(deps: string[], callback: (ctx: ClientContext) => void): unknown
  effect(callback: () => (() => void) | void, label?: string): unknown
}

interface SidebarRightLike {
  openTab(kind: string): void
}

interface SidebarRightTabsLike {
  register(definition: Record<string, unknown>): () => void
}

export const inject = ['slots']

/** The right-column tab kind and the registry key the body/title register under. */
const SANDBOX_KIND = 'dsh-ops-sandbox'
const SANDBOX_ID = 'dsh-plugin-ops-bundle'

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-ops',
        order: 50,
        label: () => 'dsh-ops',
      },
      HealthSection,
    ),
  )
  try {
    ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scoped) => {
      registerSandboxSurfaces(ctx, scoped)
    })
  } catch (error) {
    console.error('[dsh-ops] sandbox surfaces disabled:', error)
  }
}

function registerSandboxSurfaces(ctx: ClientContext, scoped: ClientContext): void {
  const sidebarRight = scoped.get('sidebarRight') as SidebarRightLike | null | undefined
  const tabs = scoped.get('sidebarRightTabs') as SidebarRightTabsLike | null | undefined
  if (sidebarRight === null || sidebarRight === undefined || tabs === null || tabs === undefined
    || typeof sidebarRight.openTab !== 'function' || typeof tabs.register !== 'function') {
    return
  }
  const open = (): void => { sidebarRight.openTab(SANDBOX_KIND) }
  scoped.effect(() => tabs.register({
    id: SANDBOX_ID,
    kind: SANDBOX_KIND,
    multiple: false,
    title: () => SANDBOX_DICTS[detectLang()].title,
    guide: [{
      id: SANDBOX_KIND,
      order: 120,
      title: () => SANDBOX_DICTS[detectLang()].title,
      description: () => SANDBOX_DICTS[detectLang()].guide,
    }],
  }), 'dsh-ops-bundle: sandbox tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SANDBOX_ID },
    SandboxPanel,
  ))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SANDBOX_ID },
    SandboxTitle,
  ))
  ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.guide.entry', key: SANDBOX_ID,
      inject: (): { open: () => void } => ({ open }),
    },
    SandboxGuide,
  ))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action', id: 'dsh-ops-sandbox', order: 120,
      inject: (): { open: () => void } => ({ open }),
    },
    SandboxEntry,
  ))
}
