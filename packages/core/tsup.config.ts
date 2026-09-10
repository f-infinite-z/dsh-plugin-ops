import { defineConfig } from 'tsup'

/**
 * Self-contained engine bundle: every runtime dependency is inlined so the
 * published artifact carries no node_modules requirements. The embedded dsh
 * bundle imports this file inside the harness plugin tree, where one missing
 * transitive peer aborts the whole tree (self-reliance layer 1).
 *
 * The banner installs a real `require` (via createRequire) for the inlined
 * CommonJS dependencies (`@pnpm/lockfile-file` and friends), whose builtin
 * requires would otherwise hit esbuild's dynamic-require error in ESM output;
 * `shims` provides `__dirname`/`__filename` for the same modules.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  skipNodeModulesBundle: false,
  shims: true,
  banner: {
    js: "import { createRequire as __dshOpsCreateRequire } from 'node:module';\nconst require = __dshOpsCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.charset = 'utf8'
    options.mainFields = ['module', 'main']
  },
})
