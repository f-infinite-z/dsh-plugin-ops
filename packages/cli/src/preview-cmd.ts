import { writeFileSync } from 'node:fs'
import {
  buildPreviewReport,
  renderPreviewReport,
  renderPreviewMatrix,
  PreviewError,
  type DshPaths,
  type OpsConfig,
} from 'dsh-plugin-ops-core'

export interface PreviewCommandOptions {
  paths: DshPaths
  profileName: string
  config: OpsConfig
  json: boolean
  /** Target dsh release; absent resolves from the update check, then the known-release table. */
  target?: string
  /** Query the registry (offline by default): newest dsh release as the target, per-plugin newest versions for updates. */
  updates: boolean
  /** Write the rehearsal as a Markdown matrix. */
  report?: string
  /**
   * Override the running dsh version the report names (tests pin this to
   * avoid probing the global CLI); undefined reads the running install.
   */
  dshVersion?: string | null
}

/**
 * `dsh-ops preview`: rehearse a profile upgrade against a target dsh release
 * and print each skipped bundle's fix. Read-only; exit code 1 signals that at
 * least one plugin would be skipped (not a command failure).
 */
export async function runPreviewCommand(options: PreviewCommandOptions): Promise<number> {
  const registry = (options.config.registry ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? '').trim()
  let report
  try {
    report = await buildPreviewReport({
      paths: options.paths,
      profileName: options.profileName,
      config: options.config,
      target: options.target ?? null,
      updateCheck: options.updates,
      registry: registry === '' ? null : registry,
      ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
    })
  } catch (error) {
    if (error instanceof PreviewError) {
      process.stderr.write(`preview: ${error.message}\n`)
      return 2
    }
    throw error
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderPreviewReport(report)}\n`)
  }
  if (options.report !== undefined) {
    try {
      writeFileSync(options.report, renderPreviewMatrix(report), 'utf8')
      if (!options.json) process.stdout.write(`\nmatrix report written to ${options.report}\n`)
    } catch (error) {
      process.stderr.write(`preview: cannot write the matrix report: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  return report.counts.skipped > 0 ? 1 : 0
}
