import { defineConfig } from 'tsup'

/**
 * Self-contained single-file CLI: everything (core + all npm dependencies) is
 * bundled into dist/index.js so the published binary has no runtime
 * node_modules requirements — no dependency tree to drift (self-reliance
 * layer 1). Node builtins stay external. Static panel assets are copied to
 * dist/assets and resolved relative to the bundle (same layout as lib/assets
 * in dev builds).
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  publicDir: 'assets',
  esbuildOptions(options) {
    options.charset = 'utf8'
  },
})
