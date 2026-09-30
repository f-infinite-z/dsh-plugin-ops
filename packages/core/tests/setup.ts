import { vi } from 'vitest'

// The global dsh version probe spawns the real `dsh` CLI, which is neither
// deterministic nor present on CI. Tests control the version through the
// profile mirror fixture, so the probe is stubbed to null and every scan
// falls back to the mirror anchor.
vi.mock('../src/dsh-version.js', () => ({
  readGlobalDshVersion: async () => null,
}))
