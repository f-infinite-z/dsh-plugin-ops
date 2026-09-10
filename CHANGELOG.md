# Changelog

All notable changes are tracked here.

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
