#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolveDshPaths, readOpsConfig, runSelfTest } from 'dsh-plugin-ops-core'
import { runScanCommand } from './scan-cmd.js'
import { runFixCommand } from './fix-cmd.js'
import { runGateCommand } from './gate-cmd.js'
import { serve } from './serve.js'
import { runCheckCommand } from './check-cmd.js'
import { runVerifyCommand } from './verify-cmd.js'

const USAGE = `dsh-ops — DeepSeek Harness plugin operations

usage:
  dsh-ops check [--home <dir>] [--json] [--config <file>] [--updates]
  dsh-ops scan  [--profile <name>] [--home <dir>] [--json] [--config <file>] [--skip-update-check]
  dsh-ops fix   [--profile <name>] [--home <dir>] [--dry-run] [--yes] [--config <file>]
  dsh-ops gate  [--profile <name>] [--home <dir>] [--bypass] [--no-attribution]
                [--boot-threshold-ms <n>] [--config <file>] [--] <dsh command...>
  dsh-ops serve [--home <dir>] [--port <n>] [--host <addr>] [--config <file>]
  dsh-ops verify [<dir>] [--json] [--strict]
  dsh-ops selftest
  dsh-ops help

config: read from <DSH_HOME>/dsh-ops.yml by default (rules on/off, severity
  demotion, ignorePackages); corrupt config fails loud.

exit codes:
  0  ok (or dsh's own exit code after a gate pass)
  1  findings are fatal after the action taken
  2  usage error / profile missing / corrupt config
  3  gate blocked by findings that need manual resolution (no --bypass)
  4  gate: dsh failed at boot and the user skipped attribution
  5  gate: dsh failed at boot, attribution available but stdin is not a TTY
`

const OPTIONS = {
  profile: { type: 'string', default: 'web' },
  home: { type: 'string' },
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  bypass: { type: 'boolean', default: false },
  'no-attribution': { type: 'boolean', default: false },
  config: { type: 'string' },
  'skip-update-check': { type: 'boolean', default: false },
  updates: { type: 'boolean', default: false },
  strict: { type: 'boolean', default: false },
  port: { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' },
  'boot-threshold-ms': { type: 'string' },
} as const

type Flags = { profile: string; home?: string; json?: boolean; 'dry-run'?: boolean; yes?: boolean; bypass?: boolean; 'no-attribution'?: boolean; config?: string; 'skip-update-check'?: boolean; updates?: boolean; strict?: boolean; port?: string; host?: string; 'boot-threshold-ms'?: string }

function parse(rawArgs: string[]): { values: Flags; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  })
  return { values: values as Flags, positionals }
}

/** Load the user config; a corrupt file is a hard usage error. */
function loadConfig(file: string | undefined, defaultFile: string) {
  const read = readOpsConfig(file ?? defaultFile)
  if (!read.ok) {
    process.stderr.write(`dsh-ops: ${read.problem ?? 'config unreadable'}\n`)
    return null
  }
  return read.config
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    case 'scan':
    case 'fix':
    case 'gate': {
      const { values, positionals } = parse(rest)
      if (!/^[\w.-]+$/.test(values.profile)) {
        process.stderr.write(`invalid --profile ${JSON.stringify(values.profile)}\n`)
        return 2
      }
      const paths = resolveDshPaths(values.profile, values.home)
      const config = loadConfig(values.config, paths.configFile)
      if (config === null) return 2
      if (command === 'scan') {
        return runScanCommand({
          paths, profileName: values.profile, json: values.json ?? false,
          config, updateCheck: !(values['skip-update-check'] ?? false),
        })
      }
      if (command === 'fix') {
        return runFixCommand({
          paths, profileName: values.profile, dryRun: values['dry-run'] ?? false,
          yes: values.yes ?? false, config,
        })
      }
      const bootThresholdMs = values['boot-threshold-ms'] === undefined ? 20000 : Number(values['boot-threshold-ms'])
      if (!Number.isFinite(bootThresholdMs) || bootThresholdMs <= 0) {
        process.stderr.write('invalid --boot-threshold-ms\n')
        return 2
      }
      return runGateCommand({
        paths, profileName: values.profile,
        bypass: values.bypass ?? false,
        noAttribution: values['no-attribution'] ?? false,
        bootThresholdMs,
        config,
        dshCommand: positionals.length > 0 ? positionals : ['dsh', '--profile', values.profile],
      })
    }
    case 'check': {
      const { values } = parse(rest)
      const paths = resolveDshPaths('web', values.home)
      const config = loadConfig(values.config, paths.configFile)
      if (config === null) return 2
      return runCheckCommand({ paths, json: values.json ?? false, config, updates: values.updates ?? false })
    }
    case 'verify': {
      const { values, positionals } = parse(rest)
      return runVerifyCommand({
        dir: positionals[0] ?? '.',
        json: values.json ?? false,
        strict: values.strict ?? false,
      })
    }
    case 'selftest': {
      const { results, ok } = await runSelfTest()
      for (const result of results) {
        process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.caseName}\n`)
        if (!result.ok) {
          for (const line of result.detail.split('\n')) process.stdout.write(`      ${line}\n`)
        }
      }
      process.stdout.write(`\nselftest: ${results.filter((r) => r.ok).length}/${results.length} cases passed\n`)
      return ok ? 0 : 1
    }
    case 'serve': {
      const { values } = parse(rest)
      const paths = resolveDshPaths('web', values.home)
      const config = loadConfig(values.config, paths.configFile)
      if (config === null) return 2
      const port = values.port === undefined ? 8912 : Number(values.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write('invalid --port\n')
        return 2
      }
      return serve({ paths, host: values.host ?? '127.0.0.1', port, config })
    }
    default:
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
      return 2
  }
}

main().then((code) => {
  process.exitCode = code
})
