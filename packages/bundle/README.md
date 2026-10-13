# dsh-plugin-ops-bundle

**The dsh-ops health panel, embedded in DeepSeek Harness.** This package installs the
[dsh-plugin-ops](https://github.com/f-infinite-z/dsh-plugin-ops) engine into a profile and adds a
**dsh-ops** section to Settings: health cards, findings with their fixes, plugin-row management, an
upgrade-preview card, a fault timeline, and a diagnosis chat.

> The same engine is available as a terminal CLI — `npm i -g dsh-plugin-ops` gives you
> `dsh-ops check` / `preview` / `gate` / `serve` (and `verify` for plugin authors).

## Install

| You are | Install |
|---|---|
| Desktop app | Settings → Plugins → install `dsh-plugin-ops-bundle` (or just ask DSH to install it) |
| Web / CLI profile | `dsh plugin --profile web add dsh-plugin-ops-bundle` |

Restart the dsh process (desktop: reopen the app), then open **Settings → dsh-ops**.

## What it shows

- **Health** — one card per profile: fatal / warn / info counts from the 10 static rules.
- **Findings** — each one with the fix it recommends; executable fixes write a backup first.
- **Upgrade preview** — pick a target dsh release and see which installed plugins it would skip, each fix as a copy-ready command.
- **Plugin rows** — health badges, severity filter, paging, official-row protection, enable/disable.
- **Fault timeline** — what changed since the last successful boot (the attribution baseline).
- **Diagnosis chat** — troubleshooting experience is deposited as Markdown and retrieved into the chat (BM25 + optional embedding re-rank), zh/en switch.

## How it works

- **Host half** (`lib/index.js`): a cordis plugin that waits for the optional
  `webServer` service and serves the panel API under the `/dsh-ops` prefix,
  reusing the shared engine (`dsh-plugin-ops-core`). The diagnosis chat prefers
  the harness `ctx.llm` seam with the configured default model and falls back
  to a direct OpenAI-compatible channel when the tree exposes no llm service.
- **Browser half** (`lib/client.js`): registers a `settings.section` through
  `dsh.client` and fetches the same-origin `/dsh-ops/api/*` routes.
- Profiles without a Web server are unaffected: the host half activates but
  registers nothing.

## License

MIT
