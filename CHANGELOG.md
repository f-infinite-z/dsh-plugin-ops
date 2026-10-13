# Changelog

All notable changes are tracked here.

## 0.20.0 — unreleased

### Upgrade preview: rehearse the next release before committing to it

- **New `dsh-ops preview`** rehearses a profile upgrade without touching it.
  Against a target dsh release (`--target <version>`; the newest known release
  by default; `--updates` resolves the newest registry release as the target
  and asks the registry for each skipped plugin's newest release), it judges
  every installed third-party bundle with the launcher's own compatibility
  semantics — the same `incompatibleDshPeers` judgment rule 8 and the official
  gate use — and reports which bundles that release would skip. Each skipped
  bundle gets its fix as a runnable command: **update** to the newest release
  when that release accepts the target, the official **exact-version
  exemption** (`dsh plugin --profile <p> allow-version ... --accept-risk`,
  naming the target release), or disable. Official bundles ship with the
  installation and are never judged; retired entries are named as such;
  bundles whose active exemption already covers the target are reported as
  exempted. Read-only; nothing is written, and no new write channel exists.
  Exit code 1 means "at least one plugin would be skipped", not a failure.
- **`--report <file.md>`** writes the rehearsal as a profile-level Markdown
  matrix — the companion to `verify --report`'s package-level one. `--json`
  carries the same model.
- **Both panels** (the serve panel and the embedded bundle's health section)
  gain an upgrade-preview card: a target-version input, an optional registry
  check, and the verdict list with copy-ready fix commands.

327 tests (core 251 + bundle 39 + cli 37; one POSIX-only test skipped on
Windows). The real-profile rehearsal matched the field observation: on the
web profile the 0.2.1-alpha.2 gate would skip `dsh-lsp-actions@0.4.5` and
`dsh-mcp-connector@0.2.37`, and the update check named their compatible
successors (0.5.12 / 0.2.70).

## 0.19.2 — 2026-10-12

### The change half lands: install, verify, approve, recover — inside the sandbox

- **Install and uninstall tools**: `dsh_ops_sandbox_install` / `_uninstall`
  (plus the panel's install box) drive the official plugin manager against
  the sandbox profile — the desktop shape through the app's own bundled CLI,
  the web shape through the running CLI. After every install the profile is
  read back: the outcome follows `dsh.profile.bundles` registration, not the
  exit code, and a half-registered residue (declared in dependencies, missing
  from the activation list — the aftermath of a failed install that the
  official reconcile keeps treating as a user choice) is repaired
  automatically with remove + add.
- **The pnpm build gate is resolvable in place**: installs blocked by
  `ERR_PNPM_IGNORED_BUILDS` report the placeholder `allowBuilds` entries
  (the field case named `@google/genai` and `protobufjs`), and
  `dsh_ops_sandbox_approve_builds` sets them to true/false — a backed-up,
  structure-preserving write — so the retry succeeds. Verified end to end
  against a real plugin: block → detect → approve → retry → half-registered →
  auto-repair → registered.
- **The registry comes from config**: a GUI-launched desktop host carries no
  `npm_config_registry`, so sandbox installs silently fell back to the default
  registry; `dsh-ops.yml` gains a `registry` field (config, then environment,
  then default) used by installs and the sandbox profile scaffold alike.
- **Session reports**: every change action and installed package@version is
  persisted under the host home (`cache/dsh-ops/sandbox-reports`, newest 20
  kept), readable through `dsh_ops_sandbox_report` and shown in the panel —
  the conclusion survives the sandbox home's cleanup, so "what did I verify
  in there?" outlives the session.
- **RESTART, exposed** as `dsh_ops_sandbox_restart` (the panel already had it).
- **Field-reported polish**: the known-release table gains `0.2.1-alpha.2`
  with a `check --freshness` registry comparison ("table covers ≤ x; newest
  seen y"); the desktop profile no longer evaluates pre-desktop boundaries it
  can never run; findings carry `nextAction` and `versionContext` (the
  evaluated version set plus the running release); `remove` is never handed
  `--registry` (the CLI rejects it); the isolation wording states plainly
  that nothing outside the DSH home — the OS home directory included — is
  isolated.

310 tests (core 238 + bundle 39 + cli 33; one POSIX-only test skipped on
Windows). The end-to-end desktop run covers the full change story against a
real registry plugin: install → build gate → approval → auto-repair →
uninstall → session report.

## 0.19.1 — 2026-10-12

### Desktop sandbox console: the second window

- **The sandbox console now covers the desktop host.** The shape follows the
  host profile: a `desktop` profile drives a **second desktop window** of the
  installed app through the verified desktop-sandbox recipe — a scaffolded
  desktop profile under a temporary DSH home, an isolated `--user-data-dir`,
  and an isolated webserver port pin for the fixed-port releases. The scaffold
  boots with no install step (~5s to its Web UI line, which the desktop host
  forwards on stdout exactly like the web shape).
- **Electron child environments are cleaned before the second window
  starts.** The host half itself runs inside an Electron child process whose
  environment carries `ELECTRON_RUN_AS_NODE`; inherited, it made the second
  executable start as a Node script and die on `--user-data-dir` (exit 9).
  The desktop spawn strips the Electron-injected variables.
- **Desktop-shape repair semantics.** `scan` judges the desktop profile with
  the official packages trusted inside the packaged asar; `fix` resolves
  visible rows without the official bundles (their patch files are unreadable
  inside the asar), so official rows are refused as "no visible row" while
  third-party rows and the user patch layer keep working; `diagnose` reads the
  newest crash report from the sandbox user-data logs (macOS degrades
  gracefully: the shared log directory is never read) alongside the
  error-looking output lines.
- **Peer-gap stops judging a bundle's own client-injected modules** (field
  report): a browser half receives whatever it lists in `dsh.client.inject`
  from the client module table, so a host-side resolution of those peers
  (e.g. `@deepseek-ai/dsh-client-runtime`) is never expected — two
  independent client plugins tripped the warning with no legal absence
  marker of their own.
- **Empty-dependency profiles no longer warn about a missing lockfile**
  (field report from a four-profile self-check): the waiver for a
  dependency-free profile was scoped to the desktop profile, so the shipped
  headless/tui/web templates (an empty dependency table, no lockfile by
  design) tripped the "versions are not locked against drift" warning; the
  waiver now follows the empty table itself, whatever the profile.
- **A damaged lockfile is reported as damaged**: the unusable-lockfile
  message claimed an "unsupported format version" even when the file could
  not be parsed at all (the field case had its first 16 KiB filled with NUL
  bytes after a partial write, with `lockfileVersion` gone entirely). The
  reader now keeps the two apart and names the version it found when the
  format really is the problem.
- **Launch tokens never enter the log** (field report): the sandbox log ring
  stored raw output lines, so the `token=` of the boot URL leaked into tool
  output and session logs while the status URL was already masked; masking
  now happens at storage time and covers every exit.
- **A bundle that is installed but not activated is named** (field report
  from the desktop sandbox): a dependency that ships a bundle patch while
  missing from `dsh.profile.bundles` is never loaded — either the user
  disabled it on purpose, or a failed install/remove left it half-registered
  (the official reconcile then treats the residue as a user choice, and
  re-running `add` alone does not recover it). The scan reports it as an info
  naming both readings and the remove + add recovery.
- **Shape-aware surfaces**: status and panel carry the shape (`kind`), the
  panel names the second window and shows the crash-report file, and the
  `dsh_ops_sandbox_start` tool describes the desktop shape.
- 297 tests (core 227 + bundle 37 + cli 33; one POSIX-only test skipped on
  Windows). The end-to-end desktop smoke passes on the real app: an isolated
  desktop number-1 installs the bundle through the app's own CLI, boots the
  second window, installs a bad plugin into it, scans it, refuses an official
  row, disables the bad row, restarts to prove the repair, and stops with
  full cleanup — never touching the real desktop profile or instance.

## 0.19.0 — 2026-10-11

### Sandbox console: drive an isolated number-2 dsh from the panel, behind an authenticated API

- **Isolated sandbox instance**: a new manager starts a second dsh in a
  temporary DSH home (the running installation's own CLI entry, sandbox home
  as cwd), observes its boot, keeps a bounded output log, reads its official
  startup diagnostics, scans its profile, and stops with full cleanup. The
  sandbox is configuration-level isolation for plugin work — it runs this
  user's environment and file-system access, stated as such in the tool and
  panel copy.
- **Agent tools**: `dsh_ops_sandbox_start` / `_stop` / `_status` / `_scan` /
  `_fix` — start, observe, scan, and repair the sandbox from the running
  agent; the launch token is redacted in tool output.
- **Panel surfaces**: a sidebar footer entry opens a right-column sandbox
  panel (start / restart-keeping-state / stop, open in a new tab, live log,
  diagnostics, scan findings, disable-row repair), with tab title and guide
  capsule; hosts without the right column keep the settings section and skip
  the surfaces silently.
- **Honest repair semantics**: `fix` resolves visible rows through the
  running installation's closure (the fresh sandbox home has no anchor of its
  own), reports "cannot resolve the closure" separately from "no such row",
  and claims a successful restart only when one actually happened.
- **`/dsh-ops/*` is authenticated**: every route passes the harness
  connection's admission (Host/Origin trust fence + launch-token/cookie
  browser authentication — the same gate the harness API uses); a host
  without the connection service is refused (fail-closed). The surface was
  previously open to any local process (external security review).
- **Hardening from three external verification rounds**: teardown kills whole
  POSIX process groups and surfaces an unexpected sandbox exit in the status;
  a kill that outlives SIGTERM+SIGKILL keeps the home for diagnosis;
  cleanup retries are bounded and timers are unref'd; peer-gap honors
  `peerDependenciesMeta.optional` and resolves through the anchor chain only.
- 275 tests (core 221 + bundle 27 + cli 33; one POSIX-only test skipped on
  Windows); three external verification rounds passed (auth matrix,
  fresh-sandbox repair, fake-success wording, isolation and cleanup).
- The release workflow now rejects a tag whose name disagrees with the
  package manifests.

## 0.18.1 — 2026-10-11

### Peer-gap false positives fixed (field report from a real desktop user)

- **Desktop profiles**: the official packages live inside the packaged asar
  and a plain Node process can never observe them; the peer-gap rule now
  trusts official peers there exactly like rules 1/2/5 already did. This
  removes the bulk of a reported 14-warning wall against installed 0.2.x
  plugins.
- **Client bundles**: `react` and `react-dom` reach every bundle with a
  browser half (`dsh.client`) through the client module table, so host-side
  resolution of them is never expected; they are exempt from the gap
  judgment.
- **Anchor-chain-only resolution**: the Node lookup now ignores
  environment-injected search paths (NODE_PATH, global paths,
  loader-supplied chains) — the official launcher resolves through its own
  package table and never through them, and neither do we.
- When no installation anchor can be located, official peers are no longer
  judged against an unknown closure; one info finding states the
  degradation instead of a wall of phantom gaps.
- 219 core tests (+5) pin the new behavior.

## 0.18.0 — 2026-10-11

### Sandbox-verified gate recovery + compatibility matrix report

- **Gate fix verification in a copied profile**: before a disable-fix touches
  the real profile, it is applied to an isolated copy and booted. Web profiles
  boot the copy in a temporary DSH home (official `plugin install
  --frozen-lockfile` from the copied lockfile, then the copied patch plus the
  proposed rows, observed on a host port); the desktop profile reuses the
  reusable desktop sandbox through a new `profileCopyFrom` mode. Only a
  surviving sandbox boot writes the real profile; a failed or unavailable
  sandbox falls back to applying the fix directly — the verifier never blocks
  recovery. The desktop gate offers the same flow from the latest crash
  report's third-party entries.
- **Profile copies mirror relative `file:` dependencies**: pnpm records a
  `file:` dependency's resolution relative to the profile directory, so a copy
  elsewhere resolved those references to nowhere and the install failed
  (ENOENT). Copies now re-create relative targets at the same relative
  location (files are copied, directories junctioned/symlinked).
- **`verify --report <file.md>` compatibility matrix**: one verification run
  renders as a marketplace-style matrix — static check counts, dsh peer
  declaration coverage against the known release boundaries, measured runtime
  targets with their versions, and an explicit lifecycle coverage list
  (visibility/uninstall/rollback named as not covered). `--json` carries the
  same model under `matrix`.
- **macOS teardown and crash detection hardened**: process trees are killed
  as POSIX process groups (SIGTERM, then a SIGKILL sweep) so Electron helpers
  and pnpm grandchildren cannot survive teardown; macOS desktop readiness
  explicitly degrades to process liveness, exit code, and the host port, and
  never reads the shared `~/Library/Logs` (its crash reports cannot be
  attributed to one instance).
- The session audit and core pnpm timeouts share the same group-kill
  behavior; the patch layer's structural appends share one helper
  (`appendDisabledRow` / `appendActivationRow` / `appendConfigRow`).
- 273 tests (core 214 + bundle 26 + cli 33; one POSIX-only test skipped on
  Windows). Real-machine smoke: fix verification BOOTED on both targets
  (web 4.1s, desktop 45.4s), a broken required row was observed as
  exited/crashed, and the `--report` matrix was written and verified.

## 0.17.1 — 2026-10-09

### Output and help cleanups

- Fix a leftover `—?` in the `verify --runtime` result line and in the
  startup-diagnostics entry line (an em dash followed by a stray question
  mark, present since the runtime check was introduced).
- The CLI usage text now documents `dev` — static checks plus the isolated
  web boot (`--runtime`) and the isolated desktop sandbox (`--desktop`)
  after each clean pass.
- 255 tests (core 204 + bundle 26 + cli 25).

## 0.17.0 — 2026-10-09

### Reusable desktop sandbox + `dev --desktop` + multi-target verify + desktop adapt canary

- **Fresh-home install anchor (the unreleased 0.16.2 fix, folded in)**:
  `locateInstallAnchor` recognized only the legacy
  `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` mirror. Modern dsh
  (runtime resolution, 0.1.6+) reads, writes, and deletes no physical links
  there — the launcher derives its own anchor from the running CLI's real
  path — so a freshly installed home reported `dsh-base`/`dsh-web-app` as
  unresolvable bundle fatals and flagged installation-closure peers as gaps.
  The anchor now falls back to the `dsh` shim on PATH (the same command the
  version probe runs): the ancestor `node_modules` chain around the shim
  (npm and npx layouts, Unix `lib/node_modules`), then the shim text whose
  generated forms name the target relative to their own directory (`%dp0%`,
  `$basedir`) or absolutely. Found by the 0.2.1-alpha.2 upgrade smoke on an
  isolated home; there the scan now reports 0 fatal / 0 warn.
- **Reusable desktop sandbox**: the `verify --desktop` orchestration is now
  one internal capability (`desktop-sandbox.ts`) shared by every consumer
  instead of a verify-only path.
- **Sandbox registry inheritance**: the sandbox profile receives an `.npmrc`
  with the caller's `npm_config_registry` when one is set, so a mirror-only
  network installs through the desktop's bundled pnpm (found by the first
  end-to-end sandbox run against a registry package).
- **`dev --desktop`**: the development watcher can boot each clean pass in an
  isolated desktop sandbox, side by side with `--runtime` (the isolated web
  boot); the startup banner lists what each pass runs.
- **Multi-target verify**: `verify --runtime --desktop` checks both surfaces
  in one run and reports a per-target matrix; JSON carries a
  `runtimes: { web, desktop }` map for the combined run (single-target runs
  keep the existing `runtime` field).
- **Desktop adapt canary**: the `adapt` canary for a desktop profile now
  boots the package in a real desktop sandbox (the exemption is written into
  the sandbox profile) instead of a web home driven by the desktop CLI.
- Verified end to end against the 0.2.0-rc.2 desktop: `verify --desktop`
  BOOTED, `verify --runtime --desktop` BOOTED on both targets, `dev
  --desktop` BOOTED.
- 255 tests (core 204 + bundle 26 + cli 25).

## 0.16.1 — 2026-10-06

### Version-view exposure in both panels

- The `serve` panel and the embedded desktop bundle now scan under the same
  version view as the CLI (`config.versionView ?? 'all'`) and render the
  `versionNote` on version-sensitive findings — previously both panels judged
  against the actual install and dropped the note, so the 0.16.0 version view
  was CLI-only.
- 248 tests (core 198 + bundle 26 + cli 24).

## 0.16.0 — 2026-10-06

### Patch-row composition correctness + reporting version views + desktop verification

- **Patch-row semantics (rule 5)**: the composition now mirrors the include's
  own patch algorithm exactly. An `insert` directive is the only form that
  creates an entry; a flat id-targeted row is a configuration patch that
  merges into an entry an earlier insert created and is skipped (with the
  launcher's warning) when no earlier layer introduces its id — its `name`
  is only a match assertion, never the row's identity. The rule judges each
  id's effective row (the last insert with later configuration patches
  merged) and reports an unresolvable inserted row; relative module paths
  resolve against the patch file's own directory (bundle directory or profile
  directory); a flat row whose id no visible layer introduces is reported at
  info ("does not apply") instead of being misjudged as a row. Verified
  against the vendored include sources (0.1.7-rc.2 and 0.2.1-alpha.1) and by
  `--dump-config` runs on an isolated home.
- **Activation rows are inserts now**: `verify --runtime` mounted plain
  plugins with a flat `id + name` row, which the include silently skips
  ("patch: entry not found") — the row never activated, so the runtime check
  reported a boot that had never loaded the plugin. `appendActivationRow`
  now writes an `insert` directive; an end-to-end probe (a plugin that writes
  a marker file from `apply`) confirms the row activates.
- **Reporting version views (`--version-view all|latest`, config
  `versionView`)**: version-sensitive rules (bundle declaration, patch
  resolution, plugin compatibility) can judge every known dsh release
  boundary (`all`, the CLI default) or only the newest (`latest`). `all`
  findings carry a `versionNote` naming the releases on each side of the
  semantic boundary. Severity follows the actual install: a bundle the running
  release rejects is fatal, and when the release is unknown only a bundle
  every evaluated release rejects (no supported install can load it) is fatal;
  a partial gap is a warning. Official `@deepseek-ai/` bundles (which ship and
  evolve with the installation) are not evaluated under a cross-release view.
  Gate keeps the actual-install judgment and exposes no view.
- **Author-side version coverage**: `verify` now checks that a declared
  `@deepseek-ai/dsh*` peer range covers every known release boundary, naming
  the uncovered releases (a compatibility-matrix requirement for marketplace
  listings).
- **`verify --desktop`**: boots a package in an isolated desktop sandbox — a
  temporary `DSH_HOME` with its own desktop profile plus an isolated Electron
  `--user-data-dir`, installed through the desktop app's own bundled CLI
  (absolute launcher path, `DSH_HOME` pointed at the sandbox) and observed on
  an isolated host port (the 0.2.0-rc fixed-port line gets a webserver port
  patch; 0.2.1+ binds a system-assigned port). A crash report or an early
  exit fails the check; teardown kills only the sandbox's own process tree.
  Verified end-to-end against 0.2.0-rc.2 (BOOTED, no residue, live instance
  and real profile untouched).
- 246 tests (core 196 + bundle 26 + cli 24).

## 0.15.2 — 2026-10-03

### Bundle packaging fix: publish lib/adapt.js

- The published `dsh-plugin-ops-bundle` tarball was missing `lib/adapt.js`
  since 0.14.0: the module entered the source tree with the in-panel
  adaptation feature, but the `files` list never gained it (`lib/*.d.ts` only
  covered its declaration). The host half then failed to import in the desktop
  app — "1 entry did not activate: dsh-ops-bundle (failed to import)" — and
  the settings panel never appeared. Every workspace-style test ran against
  the linked source tree, so the gap stayed invisible until a published
  install (found on 0.15.1 after the upgrade; confirmed by restoring the file
  in an isolated sandbox and by `npm pack --dry-run`).
- Fixed by adding `lib/adapt.js` to `files`, plus a packaging test that
  requires the built file of every host-half source module to be covered by
  the `files` list.
- Affected published versions: 0.14.0, 0.14.1, 0.15.0, 0.15.1. Upgrade to
  0.15.2 to get the desktop panel back.
- 220 tests (core 170 + bundle 26 + cli 24).

## 0.15.1 — 2026-10-03

### dsh 0.2.1-alpha.1 compatibility + housekeeping

- **Retired-bundle awareness**: dsh 0.2.1-alpha.1 retires
  `@deepseek-ai/dsh-experimental-schedule-bundle` and drops a leftover entry
  from `dsh.profile.bundles` while loading a profile (its upgrade guide asks
  other profile-writing tools to drop the entry themselves). Rule 1 now
  recognizes a retired bundle under a launcher that removes it
  (0.2.1-alpha.1+), reporting it at info with a self-heal note instead of
  blocking a boot the launcher would fix on its own; unknown or older launcher
  versions keep the previous judgment (verified against an isolated
  0.2.1-alpha.1 install).
- **Selftest machine-independence**: the built-in fault samples now pin the
  dsh version they judge against (pre-0.1.7 semantics), so a machine with a
  newer global dsh no longer flips the case outcomes; `runSelfTest` is covered
  by a unit test and passes 6/6.
- **Housekeeping**: removed dead code (five unused exports plus several unused
  imports), dropped the unused `yaml` dependency from the CLI package, and
  stopped re-exporting two internal-only core helpers. Compiled with
  `noUnusedLocals`/`noUnusedParameters` clean on all three packages. No
  behavior change beyond the rules above.
- 219 tests (core 170 + bundle 25 + cli 24).

## 0.15.0 — 2026-10-01

### Desktop CLI for adaptation + pnpm release-age exclusion hygiene

- **Desktop-profile adaptation now drives the app's own CLI**: when the
  installed desktop release ships a launcher (0.2.0-rc.1+) and it is reachable,
  `dsh-ops adapt` runs `dsh plugin --profile desktop add` (or `remove`)
  directly — the app must be fully exited; a failed install rolls the exemption
  back and says so — instead of only writing the exemption and pointing at the
  Plugins page. The isolated canary boots through the same launcher, so the
  probed runtime matches the install target. The launcher path and the version
  gate are unit-tested; an end-to-end run on a machine with the desktop CLI
  registered is still pending.
- **New rule 9 (`release-age-exclude`)**: pnpm 11 appends a `name@version`
  entry to `minimumReleaseAgeExclude` for each fresh release it installs; once
  a package has two versioned entries there, pnpm's lockfile exemption breaks
  and every later install in that profile fails with
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (reproduced against the packaged
  pnpm 11.7). The rule reports the state at warn with three fixes, recommended
  first: replace the entries with the bare package name, set
  `minimumReleaseAge: 0`, or keep only the newest entry. Bare names, a single
  versioned entry, and an explicitly disabled policy stay silent.
- 214 tests (core 165 + bundle 25 + cli 24).

## 0.14.1 — 2026-09-30

### Panel adapt flow: in-card errors with package-manager output

- The adapt card now reports failures **inside the card** (message plus a
  collapsible raw package-manager output tail) instead of only the section-level
  error line at the top, which was easy to miss while scrolled to the card.
- Operational failures carry the last pnpm run's output tail
  (`AdaptOutcome.detail`, bounded to 1500 characters), so causes like the
  minimum-release-age lockfile refusal are visible without opening logs.
- 205 tests (core 156 + bundle 25 + cli 24).

## 0.14.0 — 2026-09-30

### In-panel installation adaptation + desktop CLI path

- **Panel adapt card** (`dsh-plugin-ops-bundle`): the settings-page panel now
  installs adapted plugins directly. "Check & install" calls the official
  `pluginManager` service through the same host process; a refusal for
  incompatible peers is shown with the offending peers and a risk class
  (narrow versus cross-breaking), and "Exempt & install" grants the official
  exact-version exemption, retries the install, and revokes the exemption
  automatically when the retry fails. Works in the desktop app, where the
  official CLI cannot install at all.
- **Exemptions card**: lists active exact-version exemptions with revoke and
  uninstall-and-clean actions, closing the install → adapt → remove loop.
- **CLI desktop branch** (`dsh-ops adapt`): the official CLI refuses profile
  `desktop`, so the command now writes the exemption and canary result and
  directs the user to finish the install in the desktop Plugins page; `--remove`
  drops the exemption only after the plugin is gone from profile dependencies.
- **Select popup hardening**: `<select>` dropdowns force `color-scheme: light`
  on top of the explicit option colors, so option text stays readable whatever
  the page or OS color scheme.
- 203 tests (core 156 + bundle 23 + cli 24).

## 0.13.0 — 2026-09-30

### Installation adaptation (`dsh-ops adapt`) + authoritative dsh version

- **`dsh-ops adapt <pkg>`**: when the official gate rejects a plugin over
  incompatible `@deepseek-ai/dsh*` peer ranges, the new command diagnoses the
  offending peers, classifies the risk (narrow bound versus a cross-major /
  0.x-minor jump), grants the official exact-version exemption in an isolated
  boot first (canary), and only writes the real profile and installs once that
  boot survives. A failed canary or install rolls the exemption back, so the
  profile is left unchanged.
- **`dsh-ops adapt <pkg> --remove`**: uninstall an adapted package and drop its
  exact-version exemptions in one step, so a removal never leaves a stale
  compatibility grant behind.
- **Exemption writes**: `writeVersionExemption`, `removeVersionExemption`, and
  `removeExemptionsForPackage` mirror the official `compatibility.json`
  contract with a backup and an atomic write; the exemption remains the
  launcher's own escape hatch, confined to the whitelisted profile file.
- **Authoritative dsh version**: `scan`/`check` now read the running dsh
  version from the global CLI (`dsh --version`), with the shared-closure mirror
  as fallback. Under runtime resolution (0.1.6+) that mirror goes stale (it no
  longer heals), which previously made rule 8 (plugin compatibility) skip
  silently against an outdated mirror version.
- 194 tests (core 156 + bundle 14 + cli 24).

## 0.12.1 — 2026-09-30

### Embedded panel: readable select options on dark themes

- The `Profile` and row-filter `<select>` dropdowns inherited the theme's light
  text color, so their options rendered blank against the browser's default
  white popup on dark themes (text only appeared on hover). Options now carry an
  explicit readable foreground/background, so the dropdown lists are legible on
  both light and dark themes.

## 0.12.0 — 2026-09-30

### Official desktop adaptation (dsh desktop 0.2.0+)

- **Desktop profile recognition.** The official desktop app ships dsh inside its
  packaged `resources/app.asar` and runs its own profile (`$DSH_HOME/profiles/desktop`)
  without a CLI launch point. `scan`/`check` now recognize the desktop profile,
  read its release version from the primary-runtime manifest (`runtime.json`
  `desktopVersion`), and stop misreporting official bundles and rows that only
  live inside the compressed asar.
- **Official-package trust on desktop.** Rules 1 (bundle declaration), 5
  (patch resolution), and 8 (plugin compatibility) no longer report official
  `@deepseek-ai/*` bundles and patch rows on the desktop profile: the shared
  closure may hold a different (CLI) version of them, and the launcher verifies
  the packaged runtime before boot. Third-party plugins are still scanned.
- **Desktop gate.** `dsh-ops gate --profile desktop` pre-checks without exec'ing
  a boot (the desktop app has no CLI launch point) and attributes the latest
  desktop crash report (`crash-*.log` in the Electron logs directory; overridable
  via the `desktopCrashReportDir` config key).
- **Desktop crash-report reader.** New `readLatestCrashReport` parses the
  desktop recovery report's header facts and inactive loader entries the way the
  CLI startup report is parsed, so a desktop boot failure can be attributed.
- 181 tests (core 143 + bundle 14 + cli 24).

## 0.11.1 — 2026-09-27

### Plugin-author peer contract (verify V9) + dev watcher polish

- **V9 `peer-contract` check**: `dsh-ops verify` now validates the
  `peerDependencies` table before publishing. A peer key that is not a bare
  package name (a `file:`/`link:`/`workspace:`/`npm:`/`git:` protocol, a URL,
  a filesystem path, or whitespace) reports an error; a peer range that is not
  a semver range reports a warning. Protocol-prefixed specs stay with the
  existing V8 dependency-protocol check, so they are not double-reported.
- **`dev` watcher polish**: the header now shows the package identity
  (`name@version`) and the watched directory; each check is numbered and
  tagged with the identity; a skipped isolated boot (static errors still
  present) is called out explicitly; and shutdown prints a summary of checks
  run, failures, and elapsed time.
- 169 tests (core 131 + bundle 14 + cli 24).

## 0.11.0 — 2026-09-24

### dsh 0.1.7-rc.2 compatibility: multi-patch bundles and plugin version compatibility

- **Multi-patch-file bundles (rules 1/5, verify V1/V7)**: `dsh.bundle.patch` now
  accepts an ordered list of files in addition to a single path (the official
  `bundlePatchFiles` contract). Rule 1 reports each missing file; rule 5 composes
  rows from every declared file in order; `verify` parses each file and merges its
  rows; `runtime-verify` recognizes a list as a bundle declaration.
- **New rule 8 (`plugin-compatibility`)**: a static port of the official
  `evaluatePluginCompatibility`. On dsh 0.1.7-rc.1+ a bundle whose
  `@deepseek-ai/dsh*` peer ranges reject the running dsh version is skipped by the
  launcher, so the scan reports it as fatal; `workspace:^`/`workspace:~`/
  `workspace:*` are always-compatible, prereleases participate in ranges, and an
  exact-version exemption read from the profile's `compatibility.json` demotes the
  finding to info.
- **Session V4 verified**: the sessions repair command's filename pattern
  (`session*.jsonl[.zstd]`) and header-id probe are generation-agnostic, so the V4
  log format needs no code change.
- 163 tests (core 127 + bundle 14 + cli 22).

## 0.10.1 — 2026-09-22

### Version-aware severity for the 0.1.7 optional tolerance

- dsh 0.1.7-alpha.1 continues Profile loading past unreadable optional bundles
  and entries (skipped with a warning; the plugin manager keeps disable/remove
  controls). Rule 5 (patch-row resolution) and rule 1 (bundle declaration) now
  read the installed dsh version: on 0.1.7+ an optional entry or bundle that
  cannot be read reports `warn` with the version in the message, while a
  required entry id (`agent-loop`, `webserver`, `modules`, `connection`,
  `headless-runner`, `acp`, `sdk-jsonrpc-server`) stays `fatal`. Older releases
  keep the `fatal` severity because they abort the whole boot (verified
  against 0.1.6-alpha.2 and 0.1.7-alpha.1 with an isolated corrupt-bundle
  profile).
- Rule 1 now resolves bundles through the same installation anchor as the
  generation (it previously used the profile anchors only).

## 0.10.0 — 2026-09-21

### Development watcher for plugin directories

- **New `dsh-ops dev <dir>` command**: watches one plugin directory
  (debounced; `node_modules`, `.git`, and the dsh fallback projection are
  ignored) and reruns the static publish checks after every change, so plugin
  authors see a broken entry, patch, or bundle shape without a manual scan.
  `--runtime` additionally boots the package in an isolated DSH home after
  each clean pass — nothing touches a running dsh, and the isolated home is
  removed afterwards. The command runs until interrupted.
- `runRuntimeVerify` is exported from the verify command so `dev` reuses the
  same isolated-boot path.

## 0.9.0 — 2026-09-20

### Session-container repair and gate session-audit integration

- **New `dsh-ops sessions` command**: repairs the two session-container
  corruption classes that abort a dsh boot — an artifact whose first frame
  cannot be decoded (Node's built-in zstd probes the header frame, so no
  external dependency is needed) and a session directory that does not match
  its header id. Read-only by default (a plan with exit 1 when anything needs
  attention); `--repair-paths` moves a renamed directory back to its header id
  (an existing target is refused), `--quarantine` moves unreadable session
  directories into `$DSH_HOME/cache/dsh-ops/quarantine` (never deleted). Deep
  event-level diagnostics (seq gaps, unknown types, empty text blocks, ...)
  stay with `@argszero/cordis-plugin-session-audit`, and the command points
  there for them.
- **Gate runs session-audit before launching dsh** when the tool is on PATH
  (config `sessionAudit: { enabled, command }`): exit 1 blocks the gate like a
  fatal finding (`--bypass` stays the escape hatch); a missing tool, a missing
  sessions root, a tool error, or a timeout skips the check without blocking.

## 0.8.2 — 2026-09-20

### Patch-layer override semantics, container-failure attribution, ecosystem cross-reference

- **Rule 5 honors patch-layer overrides**: patch layers apply in order (bundle
  patches first, the user layer last) and a later row with the same id
  overrides earlier rows — only the last occurrence of an id decides whether
  the row resolves. A user-layer guard or static disable now neutralizes a
  bundle-layer row instead of leaving a false-positive fatal behind. Rows
  without an id are judged individually, as before.
- **Gate attribution recognizes session-container failures**: when the official
  startup diagnostics name a corrupt session container (`corrupt session log` /
  `corrupt Zstandard session log`), the gate reports it as a workspace-registry
  failure (with the artifact path when present), points at
  `@argszero/cordis-plugin-session-audit` for a pre-boot audit of the sessions
  tree, and skips the changed-package diff that would misattribute the boot
  failure to plugins.
- README ecosystem section cross-references session-audit as the complementary
  surface (plugin tree vs session containers), aligning with the maintainer
  discussion in deepseek-harness discussions#7161.

## 0.8.1 — 2026-09-19

### Fix: selected bundles resolve through the installation anchor

- The runtime generation removed every selected bundle root from its package
  table, but the launcher resolves a bundle root through the installation
  anchor first (official `resolveBundleDir`: installation anchor, then the
  profile directory) — so a patch row referencing an in-box bundle
  (`@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`) reported a
  false-positive fatal on healthy profiles. Bundle roots are now recorded in
  their own layer and resolved through it; only profile-only bundle roots
  leave the fallback entries, matching the official
  `healProfileModuleFallback` (an installation-closure bundle keeps its
  installation entry).
- Verified against the real 0.1.6-alpha.2 web/headless profiles: 0 fatal after
  the fix. dsh-tui's remaining findings are genuine `package.json` corruption
  in the local tree, which the tool reports correctly.

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
