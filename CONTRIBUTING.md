# Contributing

Thanks for helping! dsh-plugin-ops is a small, focused project; before opening
a PR please read [README.md](README.md) (capabilities, rules, architecture
overview) and [docs/architecture.md](docs/architecture.md) (mechanisms) so we
agree on direction.

## Scope guidance

- The product is a pre-boot health gate and dependency governance tool for the
  DeepSeek Harness plugin ecosystem. Proposals that grow it into a full plugin
  manager are v2 territory — say so explicitly in the issue.
- Core logic stays outside the dsh plugin tree; rule messages stay in English
  (single source of truth for CLI and UI); UI copy is dictionary-driven with a
  zh/en switch.
- Write operations must follow the plan → confirm → execute → verify → backup
  discipline and stay on the whitelist.

## Local setup

```sh
pnpm install
pnpm run build        # tsc lib + tsup single-file dist
pnpm run typecheck
pnpm run test         # core unit tests
node packages/cli/lib/index.js selftest
node scripts/e2e/scan-fix.e2e.mjs     # needs network for real installs
```

## PR checklist

- Behavior change: update the owning rule/module tests (coverage is 100%-style
  per module in CI).
- User-visible change: update README and the panel dictionaries (zh/en).
- Every real bug deserves a regression test and a short explanation in the PR body.
- Commit messages summarize what and why; keep history linear via rebase.

## Editing files with non-ASCII content

Do not round-trip non-ASCII files through shell text tools (encoding
corruption). Use an editor or the agent file tools that preserve UTF-8.
