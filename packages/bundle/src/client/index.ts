/**
 * dsh-plugin-ops browser half: registers the health-check section in the
 * harness settings page. Data comes from the host half's same-origin
 * `/dsh-ops` API. Platform modules (react, slots) stay external and resolve
 * through the shell module table at runtime.
 */
import { HealthSection } from './HealthSection.js'

interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: () => unknown): () => void
}

interface ClientContext {
  slots: SlotsLike
}

export const inject = ['slots']

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
}
