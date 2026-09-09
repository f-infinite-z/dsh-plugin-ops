import { scanProfile, renderHuman, renderJson, ScanError, reportOk, countSeverities, type OpsConfig } from 'dsh-plugin-ops-core'
import type { DshPaths } from 'dsh-plugin-ops-core'

export interface ScanCommandOptions {
  paths: DshPaths
  profileName: string
  json: boolean
  config: OpsConfig
  updateCheck: boolean
}

export async function runScanCommand(options: ScanCommandOptions): Promise<number> {
  let report
  try {
    report = await scanProfile({
      paths: options.paths,
      profileName: options.profileName,
      config: options.config,
      updateCheck: options.updateCheck,
    })
  } catch (error) {
    if (error instanceof ScanError) {
      process.stderr.write(`scan: ${error.message}\n`)
      return 2
    }
    throw error
  }
  if (options.json) {
    process.stdout.write(renderJson(report))
  } else {
    process.stdout.write(renderHuman(report))
  }
  void countSeverities(report)
  return reportOk(report) ? 0 : 1
}
