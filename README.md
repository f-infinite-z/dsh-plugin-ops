# dsh-plugin-ops

English | [中文](README.zh.md)

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ff-infinite-z__dsh-plugin-ops.json)](https://unstone.github.io/dsh-xray/registry.html#f-infinite-z__dsh-plugin-ops)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome-dsh--plugin-listed-blue)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![npm version](https://img.shields.io/npm/v/dsh-plugin-ops?label=npm)](https://www.npmjs.com/package/dsh-plugin-ops)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-ops?label=downloads)](https://www.npmjs.com/package/dsh-plugin-ops)

> **A plugin broke your dsh profile?** `dsh-ops` names the one that did it, tells you whether the official launcher would skip it, and hands you the fix as a runnable command — **before** the boot fails, and without touching your live instance.

## Three steps, no guessing

1. **Check** — `dsh-ops check` scans every profile offline in seconds. The 10 static rules follow the launcher's own runtime resolution rather than the disk layout, and every finding carries its fix.
2. **Rehearse** — `dsh-ops preview` runs the **next** dsh release against your installed plugins using the launcher's own compatibility semantics: *which plugins that release would skip*, and each one's fix.
3. **Prove it in isolation** — installs, repairs and adaptations are verified first in a **second isolated instance** (its own DSH home and user-data-dir); only a surviving boot writes your real profile.

Against dsh `0.2.1-alpha.2` this project's own web profile reports that `dsh-lsp-actions@0.4.5` and `dsh-mcp-connector@0.2.37` would be skipped, and that `dsh-lsp-actions@0.5.12` / `dsh-mcp-connector@0.2.70` are the releases that survive.

**Install:** desktop → **Settings → Plugins → `dsh-plugin-ops-bundle`**. Web/CLI profiles and the terminal are in [Install](#install).

**Status: v0.20.1 — upgrade preview: rehearse the next dsh release against every installed plugin ("which ones get skipped — and each one's fix as a runnable command"), with `--updates` resolving the newest registry release; both panels gained the preview card. New scan rule 10 detects same-version duplicate physical copies inside one install tree (the field case where a swallowed loader error hid a koffi type collision). Interception, repair, and memory mechanics: [docs/architecture.md](docs/architecture.md).**

## Names

| Layer | Name | Notes |
|---|---|---|
| GitHub repository / npm packages | `dsh-plugin-ops` (CLI), `dsh-plugin-ops-core` (engine), `dsh-plugin-ops-bundle` (embedded bundle) | one public name across all |
| Command | `dsh-ops` | the bin installed by the CLI package |

## Why

The DeepSeek Harness (dsh) plugin ecosystem has grown explosively since August 2026, but its loading model is unforgiving: static patches apply through a required bootstrap Include, so **one patch row that cannot be imported aborts the whole boot**. Since 0.1.6, an already-imported plugin that fails to activate is only skipped with a warning — its features silently disappear instead of failing loud. The same version moved the launcher to **runtime resolution**: the package table is built in-process from the installation's dependency graph plus the selected bundles, so checks that trust the disk layout alone drift from what the launcher actually resolves.

Existing ecosystem tools cover **change-time protection** (dry runs during install/update) and runtime observation; **none do whole-tree pre-boot checks, follow the launcher's runtime resolution table, and attribute a failed boot through the official diagnostics**. dsh-plugin-ops fills that gap.

## Install

| You are | Install |
|---|---|
| **Desktop app** | Settings → Plugins → install `dsh-plugin-ops-bundle` (or just ask DSH to install it) |
| **Web / CLI profile** | `dsh plugin --profile web add dsh-plugin-ops-bundle` |
| **Terminal** | `npm i -g dsh-plugin-ops` |

```sh
dsh-ops check                  # scan every profile (offline, seconds)
dsh-ops scan --profile web     # deep scan one profile (--json for machines; --version-view latest for newest-only)
dsh-ops fix --profile web      # lockfile realign (--dry-run to preview)
dsh-ops gate -- dsh web        # pre-boot gate; attribute failures automatically
dsh-ops adapt <pkg>            # adapt a plugin the official gate rejects (canary + exemption)
dsh-ops preview --profile web  # upgrade rehearsal: which plugins the target release skips + each fix (--updates checks the registry)
dsh-ops verify <pkg> --runtime # author gate: static checks + an isolated boot (--report writes a matrix)
dsh-ops serve                  # local web panel at http://127.0.0.1:8912 (zh/en)
dsh-ops selftest               # run built-in fault samples through all rules
```

`check` prints one summary line per profile plus per-finding fix hints; `--json` is model-friendly.

## Scan rules (10, fully static and deterministic)

| # | Rule | Severity | What it catches |
|---|---|---|---|
| 1 | Bundle declaration integrity | fatal | layer package unresolvable / no `dsh.bundle.patch` / a declared patch file missing (a bundle may list several patch files in order, 0.1.7+) |
| 2 | Three-way dependency drift | fatal / auto-fix | package.json declaration vs pnpm-lock.yaml vs disk |
| 3 | Registry version comparison | warn | updates via `pnpm outdated`; advisory, never blocks |
| 4 | Peer gaps / double instances | double instance fatal | peers that cannot resolve — with trusted and legal absences exempted: shell-seeded client modules (`react`/`react-dom`), `peerDependenciesMeta.optional` peers, official packages on the desktop profile (they live in the packaged asar), and official peers when no installation anchor can be located; two physical copies of framework core stay fatal |
| 5 | Patch-row resolution (composition semantics) | fatal/info | a package referenced by an inserted row that does not resolve aborts the boot (required entries / version semantics); a flat row is a configuration patch whose `name` is only a match assertion, reported at info when no visible layer introduces its id; the last insert for an id is the effective row (vendored sources 0.1.7-rc.2 + 0.2.1-alpha.1, `--dump-config` probes) |
| 6 | Fault memory | info/warn | packages that changed since the last successful boot (attribution baseline) |
| 7 | Structure integrity | fatal/warn | missing default entry / CJS entry (the Loader needs ESM named exports) / missing types or client |
| 8 | Plugin version compatibility | fatal / info (exempted) | `@deepseek-ai/dsh*` peer ranges that reject the running dsh version — dsh 0.1.7-rc.1+ skips such a bundle, silently dropping its features unless an exact-version exemption is granted |
| 9 | Release-age exclusion hygiene | warn | `minimumReleaseAgeExclude` with two versioned entries for one package breaks pnpm 11's lockfile exemption, so every later install in the profile fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (reproduced against pnpm 11.7); the bare package name is the recommended fix |
| 10 | Duplicate physical copies | fatal / warn | `@deepseek-ai/*` and framework-core packages existing as more than one **same-version** physical copy inside one installation tree (pnpm store entities behind symlinks dedupe to one physical copy; different-version nesting is ordinary npm resolution and stays silent; the legacy shared-closure mirror is excluded — no launcher since 0.1.6 reads it). Cumulative installs/upgrades leave same-version residues, and packages that register process-global names at module evaluation (native bindings, koffi types) fail on the second copy with the reason swallowed by the loader; the official static gate passes (field case 2026-10-13: four copies of `@deepseek-ai/dsh-win32-process`, `Duplicate type name 'DSH_STARTUPINFOW'`) |

Resolution follows the launcher's runtime generation (0.1.6+): the profile's own tree wins natively, then the package table rebuilt from the installation manifest and the selected bundles — the frozen disk mirror no longer decides. The Node lookup follows the anchor's physical ancestor chain only; environment-injected paths (NODE_PATH, global paths, loader chains) are ignored, matching the launcher's own table.

Real-ecosystem validation: dangling peer declarations (authors referencing official packages that were never published) were detected on multiple third-party plugins.

## Commands

| Surface | Description |
|---|---|
| `check` | one-shot health check across all profiles (offline by default) |
| `scan` | single-profile deep scan: rules 1-9 plus optional update check; `--version-view all\|latest` selects the version view (all by default: every known release with version-range notes; latest: newest semantics only; severity always follows the actual install) |
| `fix` | auto-fix set: disk↔lockfile realign (`pnpm install --frozen-lockfile --force`); plan → confirm → execute → backup |
| `gate` | block-first graded disposition: fatal findings block (auto-fix then pass; complex ones get loud guidance; `--bypass` is a logged escape hatch); a boot failure reads the official startup diagnostics (`$DSH_HOME/logs/startup-*.log`), attributes the changed packages and the launcher-reported failed plugins, and offers interactive disable-and-retry that is **first verified in an isolated copy of the profile** — web profiles boot the copy in a temporary DSH home, the desktop profile through the reusable desktop sandbox from the latest crash report; only a surviving sandbox boot writes the real profile, and an unavailable sandbox falls back to applying the fix directly; one-shot headless profiles pass exit codes through without attribution |
| `serve` | local web panel: health cards / findings / fix execution / **upgrade preview** (target rehearsal with copy-ready fix commands) / **plugin-row management** (health badges, severity filter, 10-per-page paging, official-row protection, enable/disable) / fault timeline / **diagnosis chat** with an **enhanced-retrieval (RAG) toggle** — troubleshooting experience deposits as Markdown and matching entries are retrieved into the chat (BM25 + optional embedding re-rank), zh/en switch |
| `selftest` | engine self-check over six built-in fault samples |
| `verify` | publish-time check for plugin authors: accepts a local directory or an **npm package spec** (`dsh-ops verify <name\|@scope/name\|name@version>`, downloaded from the registry); covers bundle patch declaration/parse, patch-row resolution, dependency protocols (`file:`/`workspace:`), peer contracts (peer keys must be package names, peer ranges must be semver), **dsh-peer release coverage** (a declared `@deepseek-ai/dsh*` peer range must cover every known release boundary; gaps are named — a compatibility-matrix requirement for marketplace listings), ESM entry and exports, client export contract and bundle shape, files completeness (`--json`, `--strict` for CI); **`--runtime`** additionally boots the package in an isolated DSH home (official install + launch); **`--desktop`** boots it in an isolated desktop sandbox — a temporary `DSH_HOME` with its own desktop profile, an isolated Electron user-data-dir, and a sandbox-only webserver port, installed through the desktop app's own bundled CLI (0.2.0-rc.1+), judged by crash report / process / host port, tearing down only its own process tree and never touching a live instance or real data; pass **`--runtime` and `--desktop` together** to check both targets in one run (JSON reports a `runtimes: { web, desktop }` map); **`--report <file.md>`** writes the run as a marketplace-style compatibility matrix (static checks, dsh peer declaration coverage against the known release boundaries, measured targets with their versions, lifecycle coverage with unmeasured phases named) and `--json` carries the same model under `matrix` |
| `adapt` | installation adaptation for a plugin the official gate rejects over incompatible `@deepseek-ai/dsh*` peer ranges: diagnoses the offending peers and classifies the risk (narrow bound versus cross-major / 0.x-minor), grants the official exact-version exemption in an **isolated canary boot first** (an isolated DSH home for a web profile; a real isolated desktop sandbox for a desktop profile), and writes the real profile only once that boot survives — a failed canary or install rolls the exemption back; for the **desktop profile** it drives the app's own bundled CLI (0.2.0-rc.1+, unit-tested; an end-to-end run is still pending) to install/remove directly once the app is fully exited, and falls back to writing the exemption with a pointer at the Plugins page when no CLI is available; `--remove` uninstalls the package and drops its exemptions in one step |
| `preview` | **Upgrade rehearsal**: against a target dsh release (`--target <version>`, or the newest known release; `--updates` resolves the newest registry release as the target and asks the registry for each skipped plugin's newest release), judges every installed third-party bundle with the launcher's own compatibility semantics and reports which bundles that release would skip, each with its fix as a **runnable command** — update (`dsh plugin --profile <p> add <name>@<newest>`, only when the newest release accepts the target), the official exact-version exemption (`dsh plugin --profile <p> allow-version ... --accept-risk`), or disable; official bundles and retired entries are named, never judged; read-only; `--json`, and `--report <file.md>` writes a profile-level Markdown matrix (the companion to `verify --report`); exit code 1 means "at least one plugin would be skipped", not a failure |
| `sessions` | session-container repair: scans `$DSH_HOME/sessions` for the two boot-blocking corruption classes (an artifact whose first frame cannot be decoded; a session directory that does not match its header id); `--repair-paths` moves a renamed directory back to its header id, `--quarantine` moves unreadable session directories into `$DSH_HOME/cache/dsh-ops/quarantine` (never deleted); read-only plan by default, deep event-level diagnostics stay with `@argszero/cordis-plugin-session-audit` |
| `dev` | development watcher for one plugin directory: static checks after every change (debounced, numbered, tagged with the package identity), `--runtime` also boots the package in an isolated DSH home after each clean pass and reports when it skips a dirty pass, **`--desktop`** also boots it in an isolated desktop sandbox after each clean pass (both may be combined); a summary of checks/failures/elapsed prints on shutdown; never touches a running dsh |
| Embedded bundle (`dsh-plugin-ops-bundle`) | adds a "dsh-ops" health section to the dsh Web settings page (scan / rows / **upgrade preview** / installation adaptation — exempt-install through the official `pluginManager` service, with the exemption list and revoke / uninstall-and-clean actions / timeline / chat with the RAG knowledge base), plus the **sandbox console**: a sidebar footer entry opens a right-column panel that starts an isolated "number 2 dsh" — in a temporary home for a web host; as a **second desktop window** (its own `--user-data-dir` and temporary DSH home, booted through the installed app's own executable) for a desktop host — shows its live log and official startup diagnostics, scans it, **installs and uninstalls plugins with read-back registration verification (a half-registered residue is repaired automatically with remove + add)**, **resolves the pnpm build gate (`allowBuilds` placeholders) in place**, keeps a **session report** that outlives the sandbox home, restarts it keeping state, and applies disable-row repairs whose outcome is the restart — `fix` resolves row visibility through the running installation's closure (desktop shape: official bundles stay inside the packaged asar and their rows are refused) and reports "cannot resolve" separately from "no such row". Ten agent tools (`dsh_ops_sandbox_start` / `_stop` / `_restart` / `_status` / `_scan` / `_install` / `_uninstall` / `_approve_builds` / `_report` / `_fix`) expose the same surface to the running agent. Every `/dsh-ops` route passes the harness connection's admission (trust fence + launch-token/cookie browser authentication — the same gate the harness API uses; fail-closed without it). The host half shares the same engine as `serve`; chat prefers the official `ctx.llm` seam and falls back to a direct channel |

Exit codes: `0` ok (or dsh's own code) / `1` fatal findings remain (for `preview`: at least one plugin would be skipped) / `2` usage or profile missing / `3` gate blocked by fatal findings / `4-5` gate attribution outcomes.

## Configuration (`$DSH_HOME/dsh-ops.yml`)

```yaml
rules:
  registry-version:
    enabled: false          # disable a rule
  peer-gap:
    severity: info          # severity can only be demoted
versionView: all            # version view: all (default: every known release + version-range notes) | latest
ignorePackages:
  - some-noisy-plugin
registry: https://registry.npmmirror.com   # sandbox installs / desktop scaffold / preview registry checks; environment fallback; the embedded host reads it once at activation — restart dsh after changing it
```

## Architecture and self-reliance

- **Core logic lives outside the dsh plugin tree** (a standalone wrapper process reading files): a crashing dsh does not affect diagnosis, and a failing diagnosis does not block dsh (fail-open applies only to dsh-ops' own faults).
- **Self-contained builds**: core and CLI ship as single files with every dependency inlined (zero runtime node_modules) — no dependency tree to drift; the in-tree bundle host half therefore carries no dependency-gap risk into the plugin tree.
- Engine messages are English-only (one fact source for CLI/JSON/panel); the panel UI is dictionary-driven zh/en. The `serve` panel includes diagnosis chat (ModelChannel: explicit `DSH_OPS_LLM_API_KEY`/`_BASE_URL`/`_MODEL` overrides, or probing DEEPSEEK/ARK/DASHSCOPE/OPENAI keys from `.credentials.yaml`, env, or `$DSH_HOME/.env` — stored credentials win, matching the harness since dsh 0.2.1-alpha.3; the embedded form prefers the official `ctx.llm` seam and falls back to a direct channel).
- Writes are whitelisted and backed up; fault-injection tests assert temp-sandbox paths. Every route of the embedded surface passes the harness connection's admission; the sandbox manager observes its child only from outside (its files, diagnostics, and output).

## Permissions and data access

dsh-ops touches sensitive surfaces by design; here is exactly what, when, and under which guardrails. Nothing runs without an explicit user action.

| Surface | Access | Purpose | Guardrails |
|---|---|---|---|
| Profile files | `package.json`, `pnpm-lock.yaml`, `node_modules` metadata, patch YAML | the diagnosis itself (`check`/`scan`) | read-only; writes go only through the two whitelisted repair channels below |
| Patch layer | structured write of `disabled` rows into the profile's user `cordis.patch.yml` | disable the plugin row that breaks boot | plan → confirm → backup → validated write; delete the row to revert; official `@deepseek-ai/*` rows are refused (403) |
| Session containers | read the `$DSH_HOME/sessions` tree; `--repair-paths` renames a session directory to its header id, `--quarantine` moves a session directory into the dsh-ops cache | the `sessions` repair command | explicit flags only; nothing is ever deleted; the read-only plan runs first and reports every move |
| Command execution | `pnpm install --frozen-lockfile --force` (fixed arguments); the `dsh` command passed to `gate`; `session-audit` when present | realign drift; launch dsh after a passed gate; session-container pre-check | never arbitrary commands; only on explicit confirmation or the exact command the user typed |
| Sandbox process | a second `dsh` spawned in a temporary DSH home through the running installation's own CLI entry (the sandbox home as cwd), or a second desktop window of the installed app (isolated `--user-data-dir` plus a temporary home) for the desktop host | the sandbox console (panel and `dsh_ops_sandbox_*` tools) | started only on explicit action; runs as this user with the inherited environment — configuration isolation for plugin work, not a security boundary (stated in the UI: user-level credentials such as the `~/.npmrc` auth token and git credential stores are readable from the sandbox); stopped with full cleanup |
| Local HTTP server | loopback `127.0.0.1:8912` (`serve` panel); the embedded bundle reuses dsh's own web server | the web panel | loopback only, route whitelist; the embedded surface additionally passes the harness connection's browser admission (launch-token/cookie) and refuses requests without it |
| LLM credentials | `DSH_OPS_LLM_*`, or provider keys from `.credentials.yaml` / env / `$DSH_HOME/.env` (stored credentials win, matching the harness) | the optional diagnosis chat only | read only when chat is used; every static feature works with no key at all |
| Network | `pnpm outdated` (opt-in via `--updates`); the configured LLM API | update advisories; diagnosis chat | `check`/`fix`/`gate` and default `scan` are fully offline |

dsh-xray rates this project C3 (a capability-surface rating, not intent); the table above is its human-readable counterpart.

## Roadmap

- **Persistent sandboxes and terminal targets (later).** A sandbox that survives a restart, and verification targets for the terminal profiles (`tui`/`headless`/`acp`) — added when plugin workflows need them.
- **Marketplace-facing verification (on demand).** `verify --report` already emits the compatibility matrix; aligning it with a concrete marketplace submission format waits for that format to exist.
- **Integrated plugin management (v2).** Absorb the ecosystem's change-time protections (canary runs, enable/disable, update checks, market) into the startup-lifecycle guard, with the pre-boot gate as the single entry point.

## Development

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test      # 336 tests (core 260 + bundle 39 + cli 37; one POSIX-only test skipped on Windows)
node packages/cli/lib/index.js selftest  # engine self-check
node scripts/e2e/scan-fix.e2e.mjs        # offline E2E (real pnpm repair)
node scripts/e2e/gate.e2e.mjs            # gate scenarios (pass/block/bypass/attribution/headless)
node scripts/e2e/real-plugins.e2e.mjs    # real third-party plugin sandbox (network)
```

Release: core, then cli, then bundle (order enforced by the CI release workflow).

## Ecosystem positioning

Not another market or manager, but startup-lifecycle protection: it fills the **every-boot** gap that change-time protection leaves open, and the sandbox console extends the same philosophy to risky plugin work — an isolated number-2 dsh driven entirely from outside, with the panel and the running agent sharing one observable surface. Later versions absorb market/enable-disable/update protection into the same architecture, converging into an integrated plugin-management suite.

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
