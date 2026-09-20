# dsh-plugin-ops

English | [中文](README.zh.md)

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ff-infinite-z__dsh-plugin-ops.json)](https://unstone.github.io/dsh-xray/registry.html#f-infinite-z__dsh-plugin-ops)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome-dsh--plugin-listed-blue)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

> DeepSeek Harness plugin operations: one-command health check, pre-boot gate, failure attribution and recovery, dependency-tree governance — the doctor for the plugin ecosystem, converging into an integrated plugin-management suite.

**Status: v0.8.0 published on npm. Interception, repair, and memory mechanics: [docs/architecture.md](docs/architecture.md).**

## Names

| Layer | Name | Notes |
|---|---|---|
| GitHub repository / npm packages | `dsh-plugin-ops` (CLI), `dsh-plugin-ops-core` (engine), `dsh-plugin-ops-bundle` (embedded bundle) | one public name across all |
| Command | `dsh-ops` | the bin installed by the CLI package |

## Why

The DeepSeek Harness (dsh) plugin ecosystem has grown explosively since August 2026, but its loading model is unforgiving: static patches apply through a required bootstrap Include, so **one patch row that cannot be imported aborts the whole boot**. Since 0.1.6, an already-imported plugin that fails to activate is only skipped with a warning — its features silently disappear instead of failing loud. The same version moved the launcher to **runtime resolution**: the package table is built in-process from the installation's dependency graph plus the selected bundles, so checks that trust the disk layout alone drift from what the launcher actually resolves.

Existing ecosystem tools cover **change-time protection** (dry runs during install/update) and runtime observation; **none do whole-tree pre-boot checks, follow the launcher's runtime resolution table, and attribute a failed boot through the official diagnostics**. dsh-plugin-ops fills that gap.

## Quick start

```sh
npm i -g dsh-plugin-ops
dsh-ops check                  # scan every profile (offline, seconds)
dsh-ops scan --profile web     # deep scan one profile (--json for machines)
dsh-ops fix --profile web      # lockfile realign (--dry-run to preview)
dsh-ops gate -- dsh web        # pre-boot gate; attribute failures automatically
dsh-ops serve                  # local web panel at http://127.0.0.1:8912 (zh/en)
dsh-ops selftest               # run built-in fault samples through all rules
```

`check` prints one summary line per profile plus per-finding fix hints; `--json` is model-friendly.

## Scan rules (7, fully static and deterministic)

| # | Rule | Severity | What it catches |
|---|---|---|---|
| 1 | Bundle declaration integrity | fatal | layer package unresolvable / no `dsh.bundle.patch` / patch file missing |
| 2 | Three-way dependency drift | fatal / auto-fix | package.json declaration vs pnpm-lock.yaml vs disk |
| 3 | Registry version comparison | warn | updates via `pnpm outdated`; advisory, never blocks |
| 4 | Peer gaps / double instances | double instance fatal | peers that cannot resolve; two physical copies of framework core |
| 5 | Patch-row resolution | fatal | packages referenced by patch rows (including subpaths) unresolvable; patch rows apply through the required bootstrap Include, so one bad row aborts the boot (verified against dsh 0.1.6-alpha.2) |
| 6 | Fault memory | info/warn | packages that changed since the last successful boot (attribution baseline) |
| 7 | Structure integrity | fatal/warn | missing default entry / CJS entry (the Loader needs ESM named exports) / missing types or client |

Resolution follows the launcher's runtime generation (0.1.6+): the profile's own tree wins natively, then the package table rebuilt from the installation manifest and the selected bundles — the frozen disk mirror no longer decides.

Real-ecosystem validation: dangling peer declarations (authors referencing official packages that were never published) were detected on multiple third-party plugins.

## Commands

| Surface | Description |
|---|---|
| `check` | one-shot health check across all profiles (offline by default) |
| `scan` | single-profile deep scan: rules 1-7 plus optional update check |
| `fix` | auto-fix set: disk↔lockfile realign (`pnpm install --frozen-lockfile --force`); plan → confirm → execute → backup |
| `gate` | block-first graded disposition: fatal findings block (auto-fix then pass; complex ones get loud guidance; `--bypass` is a logged escape hatch); a boot failure reads the official startup diagnostics (`$DSH_HOME/logs/startup-*.log`), attributes the changed packages and the launcher-reported failed plugins, and offers interactive disable-and-retry; one-shot headless profiles pass exit codes through without attribution |
| `serve` | local web panel: health cards / findings / fix execution / **plugin-row management** (health badges, severity filter, 10-per-page paging, official-row protection, enable/disable) / fault timeline / **diagnosis chat** with an **enhanced-retrieval (RAG) toggle** — troubleshooting experience deposits as Markdown and matching entries are retrieved into the chat (BM25 + optional embedding re-rank), zh/en switch |
| `selftest` | engine self-check over six built-in fault samples |
| `verify` | publish-time check for plugin authors: accepts a local directory or an **npm package spec** (`dsh-ops verify <name\|@scope/name\|name@version>`, downloaded from the registry); covers bundle patch declaration/parse, patch-row resolution, dependency protocols (`file:`/`workspace:`), ESM entry and exports, client export contract and bundle shape, files completeness (`--json`, `--strict` for CI); **`--runtime`** additionally boots the package in an isolated DSH home (official install + launch) and reports whether the boot survives, naming the failed loader entries |
| Embedded bundle (`dsh-plugin-ops-bundle`) | adds a "dsh-ops" health section to the dsh Web settings page (scan / rows / timeline / chat with the RAG knowledge base); the host half shares the same engine and route whitelist as `serve`; chat prefers the official `ctx.llm` seam and falls back to a direct channel |

Exit codes: `0` ok (or dsh's own code) / `1` fatal findings remain / `2` usage or profile missing / `3` gate blocked by fatal findings / `4-5` gate attribution outcomes.

## Configuration (`$DSH_HOME/dsh-ops.yml`)

```yaml
rules:
  registry-version:
    enabled: false          # disable a rule
  peer-gap:
    severity: info          # severity can only be demoted
ignorePackages:
  - some-noisy-plugin
```

## Architecture and self-reliance

- **Core logic lives outside the dsh plugin tree** (a standalone wrapper process reading files): a crashing dsh does not affect diagnosis, and a failing diagnosis does not block dsh (fail-open applies only to dsh-ops' own faults).
- **Self-contained builds**: core and CLI ship as single files with every dependency inlined (zero runtime node_modules) — no dependency tree to drift; the in-tree bundle host half therefore carries no dependency-gap risk into the plugin tree.
- Engine messages are English-only (one fact source for CLI/JSON/panel); the panel UI is dictionary-driven zh/en. The `serve` panel includes diagnosis chat (ModelChannel: explicit `DSH_OPS_LLM_API_KEY`/`_BASE_URL`/`_MODEL` overrides, or probing DEEPSEEK/ARK/DASHSCOPE/OPENAI keys from env, `.env`, `.credentials.yaml`; the embedded form prefers the official `ctx.llm` seam and falls back to a direct channel).
- Writes are whitelisted, same-origin checked, and backed up; fault-injection tests assert temp-sandbox paths.

## Permissions and data access

dsh-ops touches sensitive surfaces by design; here is exactly what, when, and under which guardrails. Nothing runs without an explicit user action.

| Surface | Access | Purpose | Guardrails |
|---|---|---|---|
| Profile files | `package.json`, `pnpm-lock.yaml`, `node_modules` metadata, patch YAML | the diagnosis itself (`check`/`scan`) | read-only; writes go only through the two whitelisted repair channels below |
| Patch layer | structured write of `disabled` rows into the profile's user `cordis.patch.yml` | disable the plugin row that breaks boot | plan → confirm → backup → validated write; delete the row to revert; official `@deepseek-ai/*` rows are refused (403) |
| Command execution | `pnpm install --frozen-lockfile --force` (fixed arguments); the `dsh` command passed to `gate` | realign drift; launch dsh after a passed gate | never arbitrary commands; only on explicit confirmation or the exact command the user typed |
| Local HTTP server | loopback `127.0.0.1:8912` (`serve` panel); the embedded bundle reuses dsh's own web server | the web panel | same-origin checks, loopback only, route whitelist |
| LLM credentials | `DSH_OPS_LLM_*`, or provider keys from env / `.env` / `.credentials.yaml` | the optional diagnosis chat only | read only when chat is used; every static feature works with no key at all |
| Network | `pnpm outdated` (opt-in via `--updates`); the configured LLM API | update advisories; diagnosis chat | `check`/`fix`/`gate` and default `scan` are fully offline |

dsh-xray rates this project C3 (a capability-surface rating, not intent); the table above is its human-readable counterpart.

## Roadmap

- **Desktop adaptation.** The official desktop app runs its own plugin tree without a CLI launch point; dsh-ops will adapt once the desktop plugin-management ecosystem exposes a boot hook. File-level `scan`/`fix` already work against desktop profiles.
- **Consistency verification for plugin authors.** `dsh-ops verify` accepts a local directory or an npm package spec and ships eight checks (bundle patch declaration/parse, patch-row resolution, ESM entry and exports, client export contract and bundle shape, files completeness); false positives were triaged against 30 real ecosystem plugins (28 report zero findings). `verify --runtime` boots the package in an isolated DSH home through the official install and launch commands and reports whether the boot survives. Next: peer contracts.
- **Integrated plugin management (v2).** Absorb the ecosystem's change-time protections (canary runs, enable/disable, update checks, market) into the startup-lifecycle guard, with the pre-boot gate as the single entry point.

## Development

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test      # 129 tests (core 98 + bundle 14 + cli 17)
node packages/cli/lib/index.js selftest  # engine self-check
node scripts/e2e/scan-fix.e2e.mjs        # offline E2E (real pnpm repair)
node scripts/e2e/gate.e2e.mjs            # gate scenarios (pass/block/bypass/attribution/headless)
node scripts/e2e/real-plugins.e2e.mjs    # real third-party plugin sandbox (network)
```

Release: core, then cli, then bundle (order enforced by the CI release workflow).

## Ecosystem positioning

Not another market or manager, but startup-lifecycle protection: it fills the **every-boot** gap that change-time protection leaves open. Later versions absorb market/enable-disable/update protection into the same architecture, converging into an integrated plugin-management suite.

Complementary surface: stored session containers are audited by [@argszero/cordis-plugin-session-audit](https://github.com/argszero/cordis-plugin-session-audit) — a pre-boot audit for the `$DSH_HOME/sessions` tree with an exit code a launcher can gate on. `gate` points at it when a failed boot comes from the workspace registry instead of the plugin tree.

## Platform support

Windows, macOS, and Linux (Node `^22.19 || >=24` — the same engines as dsh). CI runs build, typecheck, unit tests, and the offline e2e suite on all three platforms.

## Feedback

- **In the panels**: `serve` and the embedded bundle have a **Feedback** button that opens a pre-filled issue with your environment (version, surface, OS, profile, scan counts) — no manual diagnostic collection.
- **Plugin compatibility problem** (a plugin fails to install or boot, or dsh-ops reports it as broken): open a [compatibility issue](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=compatibility.yml) with the `dsh-ops scan --json` output.
- **dsh-ops itself misbehaving**: open a [bug report](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=bug.yml).
- **Questions and general discussion**: [GitHub Discussions](https://github.com/f-infinite-z/dsh-plugin-ops/discussions).
- **Plugin author?** Give your repository the publish gate: [plugin-author CI](docs/plugin-author-ci.md) — `dsh-ops verify` plus a boot smoke as a reusable workflow.
- Real failure samples are welcome — they become selftest fixtures and knowledge-base entries.

## References

- [docs/architecture.md](docs/architecture.md) — interception, repair, and memory mechanics
- Upstream: https://github.com/deepseek-ai/deepseek-harness
- License: MIT (see [LICENSE](LICENSE))
