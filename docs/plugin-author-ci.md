# Plugin-author CI: verify + boot smoke

Give a plugin repository a publish gate that proves the package loads:

1. **`dsh-ops verify`** — static publish-time checks (bundle patch declaration
   and parse, patch-row resolution, dependency protocols, ESM entry + `apply`
   export, client export contract and bundle shape, `files` completeness).
2. **Boot smoke** — installs dsh, installs your plugin into an isolated
   profile, and boots `dsh web` once; if the plugin tree fails to load, the
   job fails and prints the boot log.

## Use the reusable workflow

Add one job to `.github/workflows/ci.yml` in your plugin repository:

```yaml
jobs:
  plugin-smoke:
    uses: f-infinite-z/dsh-plugin-ops/.github/workflows/plugin-smoke.yml@main
    with:
      plugin-dir: packages/my-plugin   # default "."
      build-command: npm run build     # optional; run before the checks
      dsh-version: latest              # optional; pin e.g. 0.1.5-alpha.1
```

## Run the same steps manually

```sh
# 1. Static verification (no dsh, no network needed)
npx -y dsh-plugin-ops@latest verify <plugin-dir>

# 2. Boot smoke with an isolated home
npm i -g @deepseek-ai/dsh pnpm@10
export DSH_HOME="$PWD/.dsh-smoke"          # PowerShell: $env:DSH_HOME
dsh plugin --profile web add "file:$PWD/<plugin-dir>"
dsh --profile web --no-open --port 39123   # then check the printed URL
```

## Notes

- `verify` fails on **errors**; warnings (for example `workspace:` specs in a
  monorepo) are informational. Add `--strict` yourself if warnings should
  fail too.
- The smoke uses the `web` profile template (base + web-app) and an isolated
  `DSH_HOME` under the runner temp directory, so nothing leaks between runs.
- The reusable workflow runs on Linux runners. dsh itself supports Windows and
  macOS; run the manual steps above locally there.
- If the boot fails, the job prints `boot.log` — the plugin tree's fail-loud
  output names the entry that did not load.
