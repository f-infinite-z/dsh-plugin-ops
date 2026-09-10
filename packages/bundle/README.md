# dsh-plugin-ops-bundle

Embedded [dsh-plugin-ops](https://github.com/f-infinite-z/dsh-plugin-ops)
bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
installs a **dsh-ops** health-check section into the harness Web settings page
(scan, findings, plugin-row enable/disable, fault timeline, diagnosis chat).

## Install

```sh
dsh plugin --profile web add dsh-plugin-ops-bundle
```

Then restart the dsh web process. The section appears in Settings.

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
