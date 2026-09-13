/**
 * Whether a help flag is requested before any `--` passthrough separator.
 *
 * `gate` passes everything after `--` to the dsh command, so help flags there
 * belong to dsh, not to dsh-ops.
 *
 * @param command - The first CLI argument (subcommand name or undefined).
 * @param rest - The remaining CLI arguments.
 * @returns True when `--help` or `-h` appears before a `--` separator.
 */
export function helpRequested(command: string | undefined, rest: string[]): boolean {
  if (command === undefined) return false
  const separator = rest.indexOf('--')
  const flags = separator === -1 ? rest : rest.slice(0, separator)
  return flags.includes('--help') || flags.includes('-h')
}
