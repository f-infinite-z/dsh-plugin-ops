import { classifyPeerRisk, type AdaptRisk } from 'dsh-plugin-ops-core'

/**
 * Installation adaptation for the embedded panel, driven by the official
 * plugin-manager service the host context exposes as `pluginManager`.
 *
 * The panel never fetches a manifest itself: it asks the official manager to
 * install the spec, and a refusal for unmet requirements carries the exact
 * `{ name, version, runtimeVersion, requirements }` the launcher checked —
 * that is the diagnosis. dsh 0.2.1-rc.1 renamed the record field from `peers`
 * to `requirements`; both are accepted. Granting the exemption and retrying
 * then uses the manager's own `setVersionExemption`, so the profile's
 * compatibility state stays owned by the official code path. Every operation
 * is contained: a rejected install changes nothing, and a failed adapted
 * install revokes the exemption it granted.
 */

/** One package whose declared dsh requirements reject the running runtime. */
export interface AdaptIncompatible {
  name: string
  version: string
  runtimeVersion: string
  requirements: Record<string, string>
  /** Legacy field name returned before dsh 0.2.1-rc.1; kept when the host sends it. */
  peers?: Record<string, string>
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
    incompatible?: Array<{
      name: string
      version: string
      runtimeVersion: string
      requirements?: Record<string, string>
      peers?: Record<string, string>
    }>
  }
  /** The last package-manager run, whose output explains operational failures. */
  packageResult?: { output?: string; exitCode?: number; kind?: string; timedOut?: boolean }
}

/** The official plugin-manager service surface this panel uses. */
export interface PluginManagerLike {
  installBundle(spec: string, options?: {
    enabled?: boolean
    /**
     * dsh 0.2.2-rc.2+ install verification: the run must land this package at
     * this manifest version (or roll back with `unexpected-package`). Earlier
     * managers ignore the unknown option.
     */
    expected?: { name: string; version: string }
  }): Promise<ChangeLike>
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
  /** Raw package-manager output tail on operational failures, for the panel's detail view. */
  detail?: string
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

/** Upper bound of the package-manager output tail carried to the panel. */
const MAX_DETAIL_CHARS = 1500

/** Failure outcome for one change result, carrying the package-manager output tail. */
function failureOf(result: ChangeLike): AdaptOutcome {
  const output = result.packageResult?.output?.trim() ?? ''
  const detail = output === ''
    ? undefined
    : output.length <= MAX_DETAIL_CHARS ? output : output.slice(output.length - MAX_DETAIL_CHARS)
  return {
    ok: false,
    code: result.error?.code ?? 'operation-error',
    ...(result.error?.message === undefined ? {} : { message: result.error.message }),
    ...(detail === undefined ? {} : { detail }),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function incompatibleOf(items: NonNullable<ChangeLike['error']>['incompatible']): AdaptIncompatible[] {
  return (items ?? []).map((item) => {
    const requirements = item.requirements ?? item.peers ?? {}
    return { name: item.name, version: item.version, runtimeVersion: item.runtimeVersion, requirements, risk: classifyPeerRisk(requirements, item.runtimeVersion) }
  })
}

/** A full semver version, as a pinned registry spec names it. */
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * The exact `{ name, version }` a registry spec is pinned to, or null for a
 * spec that names no single version (a range, tag, Git, file, or workspace
 * spec). Only a pinned spec can carry the official `expected` installation
 * verification (dsh 0.2.2-rc.2+), which undoes a run that lands elsewhere.
 * @param spec - an npm install spec, such as `pkg-a@1.2.3` or `@scope/pkg@1.2.3`.
 * @returns the pinned package and version, or null.
 */
export function expectedFromSpec(spec: string): { name: string; version: string } | null {
  const raw = spec.trim()
  if (raw === '' || raw.startsWith('file:') || raw.startsWith('link:') || raw.startsWith('workspace:') || raw.startsWith('git+') || raw.includes('://')) return null
  const at = raw.lastIndexOf('@')
  // A scoped name's own '@' sits at index 0, so a separator at or before it
  // means the spec is a bare name.
  if (at <= 0) return null
  const name = raw.slice(0, at)
  const version = raw.slice(at + 1)
  return FULL_VERSION.test(version) ? { name, version } : null
}

/**
 * Attempt one install. A refusal for unmet dsh requirements returns the
 * diagnosis instead of a plain failure; nothing is written on refusal. A
 * pinned registry spec additionally carries the official `expected` check
 * where the manager supports it, so a run that installs another version or
 * package is rolled back instead of landing a surprise.
 * @param manager - the official plugin-manager service.
 * @param spec - the install spec.
 * @param expected - the exact package and version the caller expects, when it
 *   already knows them (an adapted install does); absent, derived from a
 *   pinned registry spec.
 */
export async function installWithDiagnosis(
  manager: PluginManagerLike,
  spec: string,
  expected?: { name: string; version: string },
): Promise<AdaptOutcome> {
  const pinned = expected ?? expectedFromSpec(spec)
  try {
    const result = await manager.installBundle(spec, pinned === null ? undefined : { expected: pinned })
    if (result.error !== undefined) {
      if (result.error.code === 'incompatible-version' && result.error.incompatible !== undefined) {
        return {
          ok: false,
          code: 'incompatible-version',
          ...(result.error.message === undefined ? {} : { message: result.error.message }),
          incompatible: incompatibleOf(result.error.incompatible),
        }
      }
      return failureOf(result)
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
  const result = await installWithDiagnosis(manager, input.spec, { name: input.name, version: input.version })
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
    if (result.error !== undefined) return failureOf(result)
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
