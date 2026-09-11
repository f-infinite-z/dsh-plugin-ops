import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Read this package's own version at module load; `unknown` when unreadable. */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // tsc output (lib/version.js) and the bundled dist/index.js both sit one
    // directory below the package root.
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The engine's own version, reported by the panel API for feedback reports. */
export const OPS_VERSION = readVersion()
