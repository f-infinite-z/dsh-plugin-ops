# dsh-plugin-ops

> DeepSeek Harness plugin operations: one-command health check, pre-boot gate,
> failure attribution and recovery, dependency-tree governance — the "doctor"
> for the plugin ecosystem.

## Install

```sh
npm i -g dsh-plugin-ops
dsh-ops check                  # scan every profile (offline, seconds)
```

## Commands

| Command | Purpose |
|---|---|
| `dsh-ops check` | one-shot health check across all profiles |
| `dsh-ops scan --profile web` | single-profile deep scan (rules 1-7, `--json`) |
| `dsh-ops fix --profile web` | auto-fix set: lockfile realign (`--dry-run` / `--yes`) |
| `dsh-ops gate -- dsh web` | pre-boot gate: scan first, exec dsh, attribute boot failures |
| `dsh-ops serve` | local web panel at `http://127.0.0.1:8912` (zh/en) |
| `dsh-ops selftest` | engine self-check over built-in fault samples |

The gate runs the scan before boot; fatal findings are blocked (auto-fixable
ones are repaired first), and a failed boot is attributed to the packages that
changed since the last successful start.

## Embedded bundle

For the in-harness settings page, install `dsh-plugin-ops-bundle` into a
profile:

```sh
dsh plugin --profile web add dsh-plugin-ops-bundle
```

## Docs

- Repository and documentation: <https://github.com/f-infinite-z/dsh-plugin-ops>
- Architecture (interception, repair, memory): [docs/architecture.md](https://github.com/f-infinite-z/dsh-plugin-ops/blob/main/docs/architecture.md)

## License

MIT
