import { defineConfig } from 'tsup'

/** Browser-side platform modules provided by the harness shell (never bundled). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Browser half: one CJS file registered through the harness module loader.
 * The wrapper mirrors the official client-bundle contract
 * (`window.__ModuleLoader__.load({ id, factory })`); platform modules stay
 * external and resolve through the shell's module table at runtime.
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  external: PLATFORM_MODULES,
  outExtension: () => ({ js: '.js' }),
  esbuildOptions(options) {
    options.jsx = 'automatic'
    options.charset = 'utf8'
  },
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-plugin-ops-bundle", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
