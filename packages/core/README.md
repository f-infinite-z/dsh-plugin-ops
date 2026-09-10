# dsh-plugin-ops-core

Shared engine for [dsh-plugin-ops](https://github.com/f-infinite-z/dsh-plugin-ops),
the startup-lifecycle guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins: profile readers, the seven static scan rules, fault memory, the fix
planner, the panel API, and the chat protocol shared by both panels.

Published as a self-contained single file (`dist/index.js`): every runtime
dependency is inlined, so importing it inside the harness plugin tree carries
no dependency-tree risk (a missing transitive peer would otherwise abort the
whole tree).

## Install

```sh
npm i dsh-plugin-ops-core
```

Most users want the CLI (`dsh-plugin-ops`) or the embedded bundle
(`dsh-plugin-ops-bundle`) instead of the engine directly.

## API

`resolveDshPaths`, `scanProfile`, `handlePanelApi`, `readOpsConfig`,
`alignToLockfile`, `appendDisabledRow`, `readPatchFile`, `recentEvents`,
`resolveModelConfig`, `buildSystemPrompt`, `buildChatContext`, `ModelChannel`, …
See `lib/index.d.ts` and the main repository documentation.

## License

MIT
