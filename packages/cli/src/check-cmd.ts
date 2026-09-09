import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  scanProfile, renderHuman, ScanError, reportOk, countSeverities, resolveDshPaths,
  type OpsConfig, type ScanReport, type DshPaths, type Finding,
} from 'dsh-plugin-ops-core'

export interface CheckCommandOptions {
  paths: DshPaths
  json: boolean
  config: OpsConfig
  updates: boolean
}

interface CheckProfile {
  name: string
  ok: boolean
  counts: { fatal: number; warn: number; info: number }
  findings: Finding[]
  profileDir: string
  error?: string
}

export interface CheckResult {
  checkedAt: string
  profiles: CheckProfile[]
  ok: boolean
}

function listProfileNames(paths: DshPaths): string[] {
  if (!existsSync(paths.profilesDir)) return []
  const out: string[] = []
  for (const entry of readdirSync(paths.profilesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') out.push(entry.name)
  }
  return out.sort()
}

/**
 * Full health check across every profile. Defaults to no network (registry
 * update check off) so the command stays fast enough for in-conversation
 * agents; pass --updates to include the advisory check.
 */
export async function runCheckCommand(options: CheckCommandOptions): Promise<number> {
  const names = listProfileNames(options.paths)
  const checkedAt = new Date().toISOString()
  const profiles: CheckProfile[] = []
  for (const name of names) {
    const paths = resolveDshPaths(name, options.paths.home)
    try {
      const report: ScanReport = await scanProfile({ paths, profileName: name, config: options.config, updateCheck: options.updates })
      profiles.push({
        name,
        ok: reportOk(report),
        counts: countSeverities(report),
        findings: report.findings,
        profileDir: report.profileDir,
      })
    } catch (error) {
      if (error instanceof ScanError) {
        profiles.push({ name, ok: false, counts: { fatal: 0, warn: 0, info: 0 }, findings: [], profileDir: paths.profileDir, error: error.message })
      } else {
        throw error
      }
    }
  }
  const result: CheckResult = { checkedAt, profiles, ok: profiles.every((p) => p.ok) }

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }

  const summary: string[] = []
  for (const profile of profiles) {
    const state = profile.error !== undefined ? `ERROR — ${profile.error}` : profile.ok ? 'OK' : 'BLOCKED'
    const counts = `fatal ${profile.counts.fatal}, warn ${profile.counts.warn}, info ${profile.counts.info}`
    summary.push(`${profile.name.padEnd(16)} ${state} — ${counts}`)
  }
  process.stdout.write(`dsh-ops check @ ${checkedAt}\nprofiles: ${profiles.length === 0 ? '(none found)' : profiles.map((p) => p.name).join(', ')}\n\n`)
  process.stdout.write(summary.join('\n'))
  process.stdout.write('\n')
  for (const profile of profiles) {
    if (profile.error !== undefined) continue
    const fatals = profile.findings.filter((f) => f.severity === 'fatal')
    for (const finding of fatals) {
      const pkg = finding.packageName === undefined ? '' : ` (${finding.packageName})`
      process.stdout.write(`\nfatal [${profile.name}] ${finding.message}${pkg}`)
      if (finding.fix.kind === 'align-lockfile') process.stdout.write(`\n  fix: dsh-ops fix --profile ${profile.name} --yes`)
      else if (finding.fix.kind === 'write-disabled') process.stdout.write(`\n  fix: disable the offending row (panel or dsh-ops gate)`)
      else process.stdout.write(`\n  fix: manual — see dsh-ops scan --profile ${profile.name} --json`)
    }
  }
  process.stdout.write(`\n\n${result.ok ? 'ALL PROFILES OK' : 'BLOCKED: fatal findings present (run the suggested fixes, then dsh-ops check again)'}\n`)
  return result.ok ? 0 : 1
}
