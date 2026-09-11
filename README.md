# dsh-plugin-ops

English | [中文](README.zh.md)

> DeepSeek Harness plugin operations: one-command health check, pre-boot gate, failure attribution and recovery, dependency-tree governance — the doctor for the plugin ecosystem, converging into an integrated plugin-management suite.

**Status: v0.1.1 published on npm. Interception, repair, and memory mechanics: [docs/architecture.md](docs/architecture.md).**

## Names

| Layer | Name | Notes |
|---|---|---|
| GitHub repository / npm packages | `dsh-plugin-ops` (CLI), `dsh-plugin-ops-core` (engine), `dsh-plugin-ops-bundle` (embedded bundle) | one public name across all |
| Command | `dsh-ops` | the bin installed by the CLI package |

## Why

The DeepSeek Harness (dsh) plugin ecosystem has grown explosively since August 2026, but the loading model is: static patches apply first → plugin rows activate concurrently → **any single failure aborts the whole tree**. After installing a few plugins, "it booted yesterday but not today" becomes routine.

Existing ecosystem tools cover **change-time protection** (dry runs during install/update) and runtime observation; **none do whole-tree pre-boot checks and automatic attribution after a failed boot**. dsh-plugin-ops fills that gap.

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
| 5 | Patch-row resolution | fatal | packages referenced by patch rows (including subpaths) unresolvable |
| 6 | Fault memory | info/warn | packages that changed since the last successful boot (attribution baseline) |
| 7 | Structure integrity | fatal/warn | missing default entry / CJS entry (the Loader needs ESM named exports) / missing types or client |

Real-ecosystem validation: dangling peer declarations (authors referencing official packages that were never published) were detected on multiple third-party plugins.

## Commands

| Surface | Description |
|---|---|
| `check` | one-shot health check across all profiles (offline by default) |
| `scan` | single-profile deep scan: rules 1-7 plus optional update check |
| `fix` | auto-fix set: disk↔lockfile realign (`pnpm install --frozen-lockfile --force`); plan → confirm → execute → backup |
| `gate` | block-first graded disposition: fatal findings block (auto-fix then pass; complex ones get loud guidance; `--bypass` is a logged escape hatch); a boot failure attributes the changed packages and offers interactive disable-and-retry; one-shot headless profiles pass exit codes through without attribution |
| `serve` | local web panel: health cards / findings / fix execution / **plugin-row management** (health badges, severity filter, 10-per-page paging, official-row protection, enable/disable) / fault timeline / **diagnosis chat** with an **enhanced-retrieval (RAG) toggle** — troubleshooting experience deposits as Markdown and matching entries are retrieved into the chat (BM25 + optional embedding re-rank), zh/en switch |
| `selftest` | engine self-check over six built-in fault samples |
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

## Roadmap

- **Desktop adaptation.** The official desktop app runs its own plugin tree without a CLI launch point; dsh-ops will adapt once the desktop plugin-management ecosystem exposes a boot hook. File-level `scan`/`fix` already work against desktop profiles.
- **Consistency verification for plugin authors.** A verification tool that checks a plugin package against the harness contracts (bundle declaration, ESM exports/structure, client declarations, patch layers) before publishing — so authors can develop and update plugins with confidence that they will load.
- **Integrated plugin management (v2).** Absorb the ecosystem's change-time protections (canary runs, enable/disable, update checks, market) into the startup-lifecycle guard, with the pre-boot gate as the single entry point.

## Development

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test      # 62 tests (core 38 + bundle 14 + cli 10)
node packages/cli/lib/index.js selftest  # engine self-check
node scripts/e2e/scan-fix.e2e.mjs        # offline E2E (real pnpm repair)
node scripts/e2e/gate.e2e.mjs            # gate scenarios (pass/block/bypass/attribution/headless)
node scripts/e2e/real-plugins.e2e.mjs    # real third-party plugin sandbox (network)
```

Release: core, then cli, then bundle (order enforced by the CI release workflow).

## Ecosystem positioning

Not another market or manager, but startup-lifecycle protection: it fills the **every-boot** gap that change-time protection leaves open. Later versions absorb market/enable-disable/update protection into the same architecture, converging into an integrated plugin-management suite.

## Feedback

- **Plugin compatibility problem** (a plugin fails to install or boot, or dsh-ops reports it as broken): open a [compatibility issue](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=compatibility.yml) with the `dsh-ops scan --json` output.
- **dsh-ops itself misbehaving**: open a [bug report](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=bug.yml).
- Real failure samples are welcome — they become selftest fixtures and knowledge-base entries.

## References

- [docs/architecture.md](docs/architecture.md) — interception, repair, and memory mechanics
- Upstream: https://github.com/deepseek-ai/deepseek-harness
- License: MIT (see [LICENSE](LICENSE))
