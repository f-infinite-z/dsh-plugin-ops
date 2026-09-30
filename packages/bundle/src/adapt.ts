import { classifyPeerRisk, type AdaptRisk } from 'dsh-plugin-ops-core'

/**
 * Installation adaptation for the embedded panel, driven by the official
 * plugin-manager service the host context exposes as `pluginManager`.
 *
 * The panel never fetches a manifest itself: it asks the official manager to
 * install the spec, and a refusal for incompatible peers carries the exact
 * `{ name, version, runtimeVersion, peers }` the launcher checked — that is the
 * diagnosis. Granting the exemption and retrying then uses the manager's own
 * `setVersionExemption`, so the profile's compatibility state stays owned by
 * the official code path. Every operation is contained: a rejected install
 * changes nothing, and a failed adapted install revokes the exemption it
 * granted.
 */

/** One package whose declared peers reject the running runtime. */
export interface AdaptIncompatible {
  name: string
  version: string
  runtimeVersion: string
  peers: Record<string, string>
  risk: AdaptRisk
}

/** Minimal view of one official change result. */
export interface ChangeLike {
  changed: boolean
  application: string
  target: string
  enabled?: boolean
  bundle?: string
  error?: {
    code: string
    message?: string
    incompatible?: Array<{ name: string; version: string; runtimeVersion: string; peers: Record<string, string> }>
  }
}

/** The official plugin-manager service surface this panel uses. */
export interface PluginManagerLike {
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<ChangeLike>
  removeBundle(name: string): Promise<ChangeLike>
  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeLike>
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }
}

/** One adapt operation's outcome, serialized to the panel client. */
export interface AdaptOutcome {
  ok: boolean
  /** Machine-readable failure class; `incompatible-version` carries `incompatible`. */
  code?: string
  message?: string
  /** Present for `incompatible-version`: what the exemption would need to accept. */
  incompatible?: AdaptIncompatible[]
  application?: string
  target?: string
  bundle?: string
  /** Present on a failed adapted install: whether the granted exemption was revoked. */
  rolledBack?: boolean
  /** Present on remove: exemptions dropped alongside the uninstall. */
  removedExemptions?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function incompatibleOf(items: NonNullable<ChangeLike['error']>['incompatible']): AdaptIncompatible[] {
  return (items ?? []).map((item) => ({ ...item, risk: classifyPeerRisk(item.peers, item.runtimeVersion) }))
}

/**
 * Attempt one install. A refusal for incompatible peers returns the diagnosis
 * instead of a plain failure; nothing is written on refusal.
 */
export async function installWithDiagnosis(manager: PluginManagerLike, spec: string): Promise<AdaptOutcome> {
  try {
    const result = await manager.installBundle(spec)
    if (result.error !== undefined) {
      if (result.error.code === 'incompatible-version' && result.error.incompatible !== undefined) {
        return {
          ok: false,
          code: 'incompatible-version',
          ...(result.error.message === undefined ? {} : { message: result.error.message }),
          incompatible: incompatibleOf(result.error.incompatible),
        }
      }
      return {
        ok: false,
        code: result.error.code,
        ...(result.error.message === undefined ? {} : { message: result.error.message }),
      }
    }
    return {
      ok: true,
      application: result.application,
      target: result.target,
      ...(result.bundle === undefined ? {} : { bundle: result.bundle }),
    }
  } catch (error) {
    return { ok: false, code: 'operation-error', message: messageOf(error) }
  }
}

/**
 * Grant the exact-version exemption, then install. A failed install revokes the
 * exemption so the profile is left unchanged.
 */
export async function applyAdaptedInstall(
  manager: PluginManagerLike,
  input: { spec: string; name: string; version: string; runtimeVersion: string },
): Promise<AdaptOutcome> {
  const key = `${input.name}@${input.version}`
  try {
    await manager.setVersionExemption(key, input.runtimeVersion, true, true)
  } catch (error) {
    return { ok: false, code: 'exemption-error', message: messageOf(error) }
  }
  const result = await installWithDiagnosis(manager, input.spec)
  if (!result.ok) {
    let rolledBack = false
    try {
      await manager.setVersionExemption(key, input.runtimeVersion, false)
      rolledBack = true
    } catch { /* keep the original failure; a stale exemption is recoverable from the list */ }
    return { ...result, rolledBack }
  }
  return result
}

/** Active exemptions, as the manager reports them. */
export function listExemptions(manager: PluginManagerLike): Record<string, string[]> {
  return manager.listVersionExemptions().exemptions
}

/** Revoke every exemption for one package name (any version). */
export async function revokeExemptionsFor(
  manager: PluginManagerLike,
  name: string,
): Promise<{ ok: boolean; removed: number; message?: string }> {
  let removed = 0
  try {
    for (const [key, runtimes] of Object.entries(manager.listVersionExemptions().exemptions)) {
      if (key !== name && !key.startsWith(`${name}@`)) continue
      for (const runtime of runtimes) {
        await manager.setVersionExemption(key, runtime, false)
        removed++
      }
    }
    return { ok: true, removed }
  } catch (error) {
    return { ok: false, removed, message: messageOf(error) }
  }
}

/** Uninstall one package and drop its exemptions in one step. */
export async function removeAndCleanup(manager: PluginManagerLike, name: string): Promise<AdaptOutcome> {
  try {
    const result = await manager.removeBundle(name)
    if (result.error !== undefined) {
      return {
        ok: false,
        code: result.error.code,
        ...(result.error.message === undefined ? {} : { message: result.error.message }),
      }
    }
    const revoked = await revokeExemptionsFor(manager, name)
    if (!revoked.ok) {
      return {
        ok: false,
        code: 'exemption-error',
        ...(revoked.message === undefined ? {} : { message: revoked.message }),
        target: result.target,
        removedExemptions: revoked.removed,
      }
    }
    return { ok: true, target: result.target, removedExemptions: revoked.removed }
  } catch (error) {
    return { ok: false, code: 'operation-error', message: messageOf(error) }
  }
}
