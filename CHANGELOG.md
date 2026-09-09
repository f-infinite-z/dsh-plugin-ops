# Changelog

All notable changes are tracked here.

## Unreleased (local work, not yet published)

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

### v0.3 — panels and self-checks (in progress)

- `selftest`: six built-in fault cases through the real rule engine
- Standalone local web panel (`dsh-ops serve`, zh/en): scans, findings,
  auto-fix preview/execute, plugin-row enable/disable with official-row
  protection, fault-memory timeline
- Shared panel API consumed by serve and the embedded bundle host
- Embedded dsh settings-section bundle (in progress)
- `explain`: optional LLM interpretation of scan results (in progress)

### v1.0 — publish-ready (in progress)

- Self-contained single-file CLI build (tsup; no runtime node_modules)
- npm packaging metadata, CI, governance files
- Public release after manual acceptance testing
