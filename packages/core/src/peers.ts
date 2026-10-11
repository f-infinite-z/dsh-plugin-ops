import { existsSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import type { Finding } from './types.js'
import type { RuleContext } from './rules.js'
import type { ResolvedBundle } from './profile.js'
import { readPackageManifest } from './package-tree.js'
import { resolvePackageDir } from './generation.js'

/**
 * The vendored framework core. A second physical copy of any of these next to
 * the host copy means plugins import a different cordis instance than the
 * Loader runs — the module-identity split the moduleFallback machinery exists
 * to prevent.
 */
export const CORE_PACKAGES = new Set([
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
])

function embeddedCopy(dir: string, peerName: string): string | null {
  const relative = peerName.split('/')
  const path = relative.length === 2
    ? join(dir, 'node_modules', relative[0]!, relative[1]!)
    : join(dir, 'node_modules', peerName)
  return existsSync(join(path, 'package.json')) ? path : null
}

/**
 * Shell-seeded baseline modules: every web client bundle receives these from
 * the client module table at load time, so a host-side resolution of them is
 * never expected (the harness explicitly discourages declaring them).
 */
const CLIENT_SHELL_MODULES = new Set(['react', 'react-dom'])

/** Whether the bundle ships a browser half (`dsh.client`). */
function hasClientHalf(manifest: { dsh?: { client?: unknown } }): boolean {
  const client = manifest.dsh?.client
  return typeof client === 'object' && client !== null
}

/**
 * Rule 4: peer gaps and double-instance detection. Every direct peer of every
 * tracked package must resolve through the anchor chain (the host the harness
 * closure provides) or the package's own embedded copy. A peer that resolves
 * to both — host copy and embedded copy — splits module identity: fatal for
 * framework core, warn otherwise. An unreachable peer is a gap: warn (a real
 * import failure only surfaces at load time, so the static signal is advisory
 * unless the peer is a duplicate).
 *
 * Three resolution realities suppress the gap judgment: a bundle's
 * shell-seeded client modules (react/react-dom) reach the browser half through
 * the client module table; the desktop profile's official packages live inside
 * the packaged asar and are trusted (rule 1/5's policy); and without a located
 * installation the closure half of the resolution is unknown, so official
 * peers judged against it would be phantom gaps.
 */
export function rulePeerGap(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  const closureUnknown = ctx.generation.installAnchor === null
  if (closureUnknown && !ctx.isDesktop) {
    findings.push({
      ruleId: 'peer-gap',
      severity: 'info',
      message: 'the dsh installation could not be located, so harness-closure peer resolution is degraded',
      detail: 'official peers are only judged through the profile and bundle closures; point `installAnchor` in dsh-ops.yml at the installation for full resolution',
      fix: { kind: 'none' },
    })
  }
  for (const bundle of resolved) {
    const peerNames = Object.keys(bundle.manifest.peerDependencies ?? {})
    if (peerNames.length === 0) continue
    const embedded = (name: string) => embeddedCopy(bundle.dir, name)
    for (const peerName of peerNames) {
      const key = `${bundle.name}\u0000${peerName}`
      if (seen.has(key)) continue
      seen.add(key)
      const host = resolvePackageDir(ctx.generation, ctx.paths, peerName)?.dir ?? null
      const internal = embedded(peerName)
      if (host !== null && internal !== null) {
        const core = CORE_PACKAGES.has(peerName)
        findings.push({
          ruleId: 'peer-gap',
          severity: core ? 'fatal' : 'warn',
          packageName: bundle.name,
          message: core
            ? `double instance of framework peer ${peerName}: host copy resolves, but ${bundle.name} embeds its own copy`
            : `double instance of peer ${peerName}: host copy resolves, but ${bundle.name} embeds its own copy`,
          detail: 'the embedded copy breaks module identity; align the embedded dependency with the host resolution or remove it',
          fix: { kind: 'none' },
        })
      } else if (host === null && internal === null) {
        // Three trusted-absence cases keep this from being a gap: a client
        // bundle's shell-seeded modules arrive through the client module
        // table; the desktop profile's official packages live inside the
        // packaged asar; and without a located installation the remaining
        // official peers may sit in an unreadable installation closure.
        if (hasClientHalf(bundle.manifest) && CLIENT_SHELL_MODULES.has(peerName)) continue
        if (peerName.startsWith('@deepseek-ai/') && (ctx.isDesktop || closureUnknown)) continue
        findings.push({
          ruleId: 'peer-gap',
          severity: 'warn',
          packageName: bundle.name,
          message: `peer ${peerName} does not resolve from the profile tree or the package itself`,
          detail: 'an import of this peer fails at load time; install it into the profile or add it to the harness closure',
          fix: { kind: 'none' },
        })
      }
    }
  }
  return findings
}

/**
 * Rule 4b: host-declared peers must be satisfiable by the locked version when
 * a lockfile exists (declared range vs locked version), mirroring rule 2 for
 * the peer plane. Locked versions may carry a peer-context suffix.
 */
export function rulePeerDrift(ctx: RuleContext, resolved: ResolvedBundle[]): Finding[] {
  const findings: Finding[] = []
  const { missing, incompatible, versions: locked } = ctx.locked
  if (missing || incompatible) return findings
  for (const bundle of resolved) {
    const dir = resolvePackageDir(ctx.generation, ctx.paths, bundle.name)?.dir ?? null
    const manifest = dir === null ? null : readPackageManifest(dir)
    if (manifest === null) continue
    for (const [peerName, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const lockedVersion = locked[peerName]
      if (lockedVersion === undefined || typeof range !== 'string') continue
      if (!semver.satisfies(lockedVersion, range)) {
        findings.push({
          ruleId: 'peer-gap',
          severity: 'warn',
          packageName: bundle.name,
          message: `locked peer ${peerName}@${lockedVersion} does not satisfy the declared range ${range}`,
          fix: { kind: 'none' },
        })
      }
    }
  }
  return findings
}
