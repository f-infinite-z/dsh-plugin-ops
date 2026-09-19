# Changelog

All notable changes are tracked here.

## 0.8.0 — 2026-09-19

### dsh 0.1.6-alpha.2 compatibility: runtime resolution, official diagnostics, runtime verification

- **Runtime resolution table (rules 1/4/5)**: dsh 0.1.6-alpha.2 defaults to
  runtime resolution — the launcher builds one immutable package table from the
  installation manifest plus the selected bundles and installs it into Node's
  resolvers without materializing the `$DSH_HOME/profiles/node_modules` mirror.
  Static checks now rebuild the same table on disk (`generation.ts`, a port of
  the official `resolveModuleFallbackEntries` / `healProfileModuleFallback`):
  the profile's own tree wins natively (fallback projections excluded), then
  the generation table decides. The frozen disk mirror no longer decides; an
  explicit `installAnchor` config value covers runtime-only installs that never
  materialized the shared mirror.
- **Patch-row failures stay fatal — verified against the real launcher**: a bad
  bundle patch row aborts the whole boot (`failed to apply loader entry
  include`), because patch rows apply through the required bootstrap Include.
  The 0.1.6 optional-plugin tolerance covers activation failures of already
  imported plugins, not this import stage; rule 5 keeps the fatal severity
  (resolve-guarded rows stay at info).
- **Official startup diagnostics in gate attribution**: a failed boot reads the
  CLI's saved report (`$DSH_HOME/logs/startup-*.log`), extracts the dsh
  version, profile, and inactive-entry list, and marks changed packages the
  launcher already reported as failed.
- **`verify --runtime` (isolated boot check)**: packs the plugin — a local
  directory is packed with `pnpm pack` so `workspace:` protocols resolve and
  the package's own dependencies install (a directory install only links it) —
  installs it into an isolated DSH home through the official `dsh plugin`
  command, boots a web profile, and reports whether the boot survives. A failed
  boot names the failed loader entries extracted from the output and reads the
  official diagnostics when present. The Windows `.cmd` launch goes through a
  fixed, fully quoted `cmd.exe` argv (Node refuses `.cmd` without a shell).

## 0.7.0 — 2026-09-17

### False-positive triage against a real-plugin corpus

- **`verify` accepts npm package specs**:
  `dsh-ops verify <name|@scope/name|name@version>` downloads the published
  tarball through `npm pack` and runs the same static checks, so authors can
  validate what they actually shipped instead of a local checkout. Specs are
  validated before reaching the command line; ranges are rejected because
  Windows runs `npm pack` through `cmd.exe`.
- **Three false-positive classes removed**, found by scanning 30 real ecosystem
  plugins (10 hot tier / 20 ordinary tier):
  - `entry-exports` no longer requires an `apply` named export. Cordis accepts
    a default export, any named export, or a re-export; the rule now reports
    only an entry with no export statement at all. Previously it warned on
    dsh-im, dsh-tui, dsh-whale-widget, dsh-aimail and dsh-web3 — all healthy.
  - `esm-entry`/`entry-exports` skip pure bundle meta-packages (a patch whose
    rows all reference other packages, e.g. dsh-undo-plugin): they have no
    entry by design.
  - `files-completeness` glob matching: `lib/**/*.js` now covers
    `lib/index.js` (`**/` matches zero or more directory levels).
- Result: 28/30 corpus plugins report zero findings (the other 2 are not
  published on npm).

## 0.6.4 — 2026-09-16

### Runtime resolve guards are no longer fatal

- Rule 5 (patch resolution) recognizes rows whose `disabled` expression probes
  the row's own package through `require.resolve`/`import.meta.resolve` and
  reports them at info level when the package is absent: the Loader skips such
  rows at boot, so they cannot fail the tree. `@deepseek-harness-tui/dsh-tui`
  guards its `code-runtime` row this way after dsh 0.1.6 replaced
  `@deepseek-ai/dsh-code-runtime-worker-thread` with the PTC runtime — the row
  previously surfaced as a false-positive fatal on an otherwise healthy
  profile. Rows without the guard keep the fatal severity.
- Verified against the real dsh-tui profile on dsh 0.1.6-alpha.1: the scan
  drops the fatal and reports the guarded row at info level.

## 0.6.3 — 2026-09-16

### dsh 0.1.6 compatibility: flat installation layouts

- Resolution anchors now include the physical target of the shared closure's
  `@deepseek-ai/dsh` link (`realpath`). `npx` (the documented way to run dsh)
  and local installs hoist official packages next to the dsh package instead
  of nesting them under it; the link path alone walks the mirror's parents and
  never reaches the installation's own `node_modules`, so a scan between a
  dsh upgrade and the first boot reported every bundle as unresolvable (fatal).
  Rules 1/4/5/7 now resolve flat layouts through the resolved link target.
- Verified against dsh 0.1.6-alpha.1: `check` reports the profile clean before
  and after the boot heal; the embedded panel (bundle 0.6.2) renders in the
  0.1.6 settings page unchanged.

## 0.6.2 — 2026-09-14

### dsh 0.1.5 compatibility: installation-closure resolution

- Resolution anchors now include the dsh installation manifest, reached
  through the shared closure's `@deepseek-ai/dsh` link. npm's nested
  installation layout keeps every official package inside the dsh package's
  own `node_modules`, and the shared closure mirror only links them at the
  next dsh boot — a scan between a dsh upgrade and the first boot reported
  official patch rows (for example
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` after the 0.1.5
  upgrade) as unresolvable fatals. Rules 1/4/5/7 now resolve them from the
  installation while the mirror is still one generation behind.
- Verified against dsh 0.1.5-rc.2: `check` reports all profiles clean before
  and after the boot heal; the embedded panel renders in the 0.1.5 settings
  page unchanged.

## 0.6.1 — 2026-09-13

### Documentation transparency and CLI help

- README (en/zh): the stale status line now tracks the published version, and
  the documented test count matches the suite. A new **Permissions and data
  access** section spells out every sensitive surface — profile files, the
  patch layer, command execution, the local server, LLM credentials, and
  network use — with its guardrails, as the human-readable counterpart of the
  dsh-xray capability card. The card and the awesome-dsh-plugin listing now
  appear as badges.
- CLI: `--help`/`-h` after a subcommand prints usage instead of executing the
  command (`dsh-ops check --help`); a help flag after the `gate --`
  passthrough separator still belongs to the dsh command.

## 0.6.0 — 2026-09-11

### In-panel feedback entry

- Both panels (`serve` and the embedded bundle) gain a **Feedback** button that
  opens a pre-filled GitHub issue (bug template) with the environment summary:
  dsh-ops version, surface, OS, current profile, and scan counts. Users do not
  collect diagnostics by hand; attaching the full scan report stays the user's
  choice (it may contain local paths).
- `GET /api/info` reports `opsVersion` (read from the engine's own
  package.json) so the pre-fill is accurate per release.
- GitHub Discussions enabled for questions and general feedback; issues stay
  for bugs and compatibility reports.

## 0.5.0 — 2026-09-11

### Plugin-author CI (reusable workflow) + cross-platform hardening

- **Reusable workflow** `.github/workflows/plugin-smoke.yml`: one job for a
  plugin repository — `dsh-ops verify` plus a boot smoke that installs dsh,
  installs the plugin into an isolated profile, boots `dsh web`, and prints
  the boot log on failure. Usage: [docs/plugin-author-ci.md](docs/plugin-author-ci.md).
- **Cross-platform hardening**: the `node_modules` rebuild retries transient
  file locks (Windows antivirus/editors) and reports a friendly error instead
  of crashing; the BOM fix covers Windows editors.
- **CI now runs on Ubuntu, Windows, and macOS** (build, typecheck, unit tests,
  and the offline e2e suite on all three; the network sandbox stays on Linux).
- README: platform support section and the plugin-author CI pointer (en/zh).

## 0.4.0 — 2026-09-11

### `dsh-ops verify`: four more publish-time checks

- **V4 entry exports** (warn): the default entry contains an `apply` named
  export — static detection, so re-exports and minified build artifacts may
  need a manual look.
- **V6 client bundle** (warn/info): the client entry registers through
  `window.__ModuleLoader__.load` and carries the package id.
- **V7 files completeness** (warn): a declared `files` field covers the bundle
  patch, the default entry, and the client entry (literal paths, directories,
  and simple globs are understood).
- **V8 dependency protocols** (error/warn): `file:`/`link:` specs error —
  consumers cannot resolve local protocols; `workspace:` specs warn — pnpm
  publish rewrites them, npm publish does not.
- Dogfooding: our own bundle reports exactly one warning (`workspace:*` on the
  core dependency, expected under pnpm publishing); four real ecosystem
  plugins pass without noise.

## 0.3.0 — 2026-09-11

### Publish-time verification for plugin authors (`dsh-ops verify`)

- New command: `dsh-ops verify [<dir>] [--json] [--strict]` — static checks
  over a plugin package directory (no dsh, no profile, no network), for
  running before `npm publish` or in plugin-author CI.
- Core checks:
  - **V1** `dsh.bundle.patch` declaration exists, the file parses, and it is
    a YAML list;
  - **V2** patch rows resolve — relative modules must exist, third-party bare
    packages must be declared in `dependencies`/`peerDependencies`, the
    bundle's own host row and official `@deepseek-ai/*` references are
    recognized (info: a peer entry pins the contract);
  - **V3** the default entry exists and is ESM (CommonJS entries fail, per the
    Loader's named-export requirement);
  - **V5** `dsh.client` declares a `web` platform and `exports["./client"]`
    resolves to an existing file.
- Exit codes: `0` pass / `1` errors (or warnings under `--strict`) / `2` usage.
- Issue templates for compatibility reports and bug reports; README feedback
  section (en/zh).

## 0.2.0 — 2026-09-10

### RAG knowledge base for the diagnosis chat

- **Knowledge deposit**: troubleshooting experience (bug symptom, cause, fix)
  lands as human-readable Markdown under `$DSH_HOME/cache/dsh-ops/knowledge/`.
  Two capture paths: a "deposit as knowledge" button that summarizes the
  current chat via the model, and automatic recording after successful
  `fix`/`gate` repairs.
- **Hybrid retrieval**: BM25 (self-contained, offline, CJK bigrams) runs by
  default; when an embedding key is configured the lexical top candidates are
  re-ranked by blending normalized BM25 with cosine similarity. Any embedding
  failure silently degrades to BM25.
- **Repeated problems merge**: identical tag sets (or titles) update the
  existing entry — occurrences +1, symptoms unioned, last seen refreshed —
  instead of appending duplicates; frequent entries rank slightly higher.
- **Panels** (`serve` and the embedded bundle) gain an "enhanced retrieval"
  toggle plus a knowledge manager (list / search / delete); when the toggle is
  on, the chat retrieves matching entries into the system prompt.
- New panel API: `GET /api/knowledge` (list / search), `POST /api/knowledge`,
  `POST /api/knowledge/delete`, `POST /api/knowledge/deposit`.

## 0.1.2 — 2026-09-10

- `fix` now rebuilds `node_modules` before realigning. pnpm trusts its
  workspace/module state files (`.pnpm-workspace-state-v1.json`,
  `.modules.yaml`, `.pnpm/lock.yaml`) and skipped reinstalling deleted or
  mutated packages even under `--force`, so drift repair silently did
  nothing on POSIX hardlink layouts (Windows passed only by accident, where
  pnpm copies across volumes). The rebuild links from the
  content-addressable store; nothing is re-downloaded.
- CI: build before typecheck/test, because fresh checkouts resolve workspace
  types through built artifacts.
- CI: e2e scripts are cross-platform (`pnpm` through `cmd.exe` only on
  Windows); the drift fixture write is atomic so the pnpm store is never
  corrupted through hardlinks.
- Release workflow skips versions already present on the registry, so tag
  pushes are safe to re-run.

## 0.1.1 — 2026-09-10

- Republish: the 0.1.0 CLI tarball did not become available on the registry
  CDN; all three packages are republished as 0.1.1. No functional changes.

## 0.1.0 — 2026-09-10

First public release: the startup-lifecycle guard for DeepSeek Harness plugins.

### v0.1 — pre-boot health gate core

- Rules 1/2/6: bundle declaration integrity, three-way dependency drift
  (manifest vs lockfile vs disk), session fault memory (JSONL, per-profile,
  success baseline + diff)
- `scan` / `fix` (auto-fix set: lockfile realign, disabled-row writes) /
  `gate` (block-first graded disposition, boot-failure attribution with
  interactive disable-and-retry, `--bypass` escape hatch)
- Real-environment smoke validated on shipped profiles

### v0.2 — full rule set and config

- Rules 3/4/5/7: registry versions via pnpm outdated (advisory, cached),
  peer gaps and framework double-instance detection, patch-row resolution,
  structure integrity (missing/CJS default entries fatal)
- User config `$DSH_HOME/dsh-ops.yml`: rule toggles, severity demotion,
  ignorePackages
- Gate platform grading: one-shot profiles (headless) pass exit codes through
  without attribution; `--no-attribution` override

### v0.3 — panels, embedded bundle, self-checks

- `selftest`: six built-in fault cases through the real rule engine
- Standalone local web panel (`dsh-ops serve`, zh/en): scans, findings,
  auto-fix preview/execute, plugin-row management (health badges, severity
  filter, 10-per-page paging, official-row protection, enable/disable), fault
  timeline
- Diagnosis chat over a model-channel seam (DeepSeek / ARK / DashScope /
  OpenAI-compatible probing; env, `$DSH_HOME/.env`, or `.credentials.yaml`)
- Embedded dsh bundle (`dsh-plugin-ops-bundle`): settings-page health panel;
  host half over `ctx.webServer` with optional `ctx.llm` routing, browser half
  registered through `dsh.client`; engine shipped as a self-contained file so
  the plugin tree carries no dependency-tree risk

### v1.0 — publish-ready

- Self-contained single-file builds (CLI `dist/index.js`, engine `dist/index.js`)
- npm packaging metadata, CI, governance files
- Public release
