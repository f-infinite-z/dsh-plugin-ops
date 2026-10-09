import { vi } from 'vitest'

// The global dsh version probe spawns the real `dsh` CLI, which is neither
// deterministic nor present on CI. Tests control the version through the
// profile mirror fixture, so the probe is stubbed to null and every scan
// falls back to the mirror anchor.
vi.mock('../src/dsh-version.js', () => ({
  readGlobalDshVersion: async () => null,
}))

// The CLI install anchor reads PATH, where a developer machine or CI runner
// may carry a real `dsh`; tests that build their own fixture homes must not
// inherit it. The anchor is stubbed to null here and exercised for real in
// cli-anchor.test.ts, which unmocks this module.
vi.mock('../src/cli-anchor.js', () => ({
  locateCliInstallAnchor: () => null,
  resetCliAnchorCache: () => {},
}))
