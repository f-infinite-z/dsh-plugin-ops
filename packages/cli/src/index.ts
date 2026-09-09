#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolveDshPaths } from 'dsh-plugin-ops-core'
import { runScanCommand } from './scan-cmd.js'
import { runFixCommand } from './fix-cmd.js'
import { runGateCommand } from './gate-cmd.js'

const USAGE = `dsh-ops — DeepSeek Harness plugin operations (v0.1)

usage:
  dsh-ops scan  [--profile <name>] [--home <dir>] [--json]
  dsh-ops fix   [--profile <name>] [--home <dir>] [--dry-run] [--yes]
  dsh-ops gate  [--profile <name>] [--home <dir>] [--bypass] [--boot-threshold-ms <n>] [--] <dsh command...>
  dsh-ops help

exit codes:
  0  ok (or dsh's own exit code after a gate pass)
  1  findings are fatal after the action taken
  2  usage error / profile missing
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
  'boot-threshold-ms': { type: 'string' },
} as const

function parse(rawArgs: string[]) {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  })
  return { values: values as { profile: string; home?: string; json?: boolean; 'dry-run'?: boolean; yes?: boolean; bypass?: boolean; 'boot-threshold-ms'?: string }, positionals }
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
      if (command === 'scan') return runScanCommand({ paths, profileName: values.profile, json: values.json ?? false })
      if (command === 'fix') return runFixCommand({ paths, profileName: values.profile, dryRun: values['dry-run'] ?? false, yes: values.yes ?? false })
      const bootThresholdMs = values['boot-threshold-ms'] === undefined ? 20000 : Number(values['boot-threshold-ms'])
      if (!Number.isFinite(bootThresholdMs) || bootThresholdMs <= 0) {
        process.stderr.write('invalid --boot-threshold-ms\n')
        return 2
      }
      return runGateCommand({
        paths,
        profileName: values.profile,
        bypass: values.bypass ?? false,
        bootThresholdMs,
        dshCommand: positionals.length > 0 ? positionals : ['dsh', '--profile', values.profile],
      })
    }
    default:
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
      return 2
  }
}

main().then((code) => {
  process.exitCode = code
})
