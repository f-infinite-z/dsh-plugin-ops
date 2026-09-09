# dsh-plugin-ops 开发进度（长期记忆）

> 本文档是会话间的纵向记忆：完成清单、卡点与解决、环境事实、未推送提交、后续计划。策略与决策见 [PLAN.md](PLAN.md)。新会话先读本文档再读 PLAN。

## 项目概况

- 定位：DeepSeek Harness（dsh）插件生态的启动生命周期防护——启动前预检拦截、失败归因与恢复、依赖树治理；长期收敛为插件管理增强一体化。
- 仓库：`github.com/f-infinite-z/dsh-plugin-ops`（private，v1.0 开源）；本地 `<workspace>\dsh-plugin-doctor`。
- 形态：monorepo `packages/cli`（dsh-ops CLI + serve 面板，npm 名 dsh-plugin-ops）+ `packages/core`（引擎，npm 名 dsh-plugin-ops-core）+ `packages/bundle`（内嵌 bundle，v0.3 B1 开发中）。
- 命令入口：`node <workspace>\dsh-plugin-doctor\packages\cli\lib\index.js <cmd>`；常用 `scan/fix/gate/serve/selftest`。
- 测试：core 单测 37 例（`pnpm test`）+ 真实 E2E `scripts/e2e/{scan-fix,gate,real-plugins}.e2e.mjs`（需网络装真实包）。
- 用户真实环境：dsh 0.1.2-rc.1，`~/.dsh` profiles = `web`（7 bundles）与 `dsh-tui`；pnpm 走 **npmmirror 镜像**；dsh web 进程偶发由用户手动启动（port 3080）。

## 里程碑时间线

| 版本 | 状态 | 内容 |
|---|---|---|
| v0.1 | ✅ 完成 | 规则 1/2/6、fix（lockfile 对齐+写 disabled）、gate 先阻断分级处置+归因、故障记忆 JSONL；web profile |
| v0.2 | ✅ 完成 | 规则 3（pnpm outdated，advisory）/4（peer 缺口+双实例 fatal）/5（patch 悬空）/7（结构+CJS fatal）；`$DSH_HOME/dsh-ops.yml` 配置；gate 平台分级（headless 透传）；规则 4 真实环境抓到 2 个真阳性（见下） |
| v0.3 part 1 | ✅ 完成 | selftest 6 样本；`core/panel-api` 共享 API（serve 与 bundle host 共用）；插件行管理端点 + serve UI toggle；patch insert 展开；`[]` 占位结构化写入修复 |
| v0.3 part 2 | 🔜 进行中 | **B1**：dsh 设置页内嵌 bundle（单包双端）；**B2**：explain（scan→DeepSeek 解读） |
| v1.0 | ⏳ 未开始 | A 线全部：npm 发布（包名核查/自包含单文件构建/CI/治理文件）、repo public、topic 打标、awesome 收录 |

## 环境事实与真实生态发现（重要）

- **peer 声明悬空是真实现象**：`@leetoners/dsh-ui-subagent-monitor`（web profile）与 `dsh-thinking-language`（dsh-tui profile）声明了官方闭包不发布的 peer（dsh-client-runtime / dsh-client-ui-slots / dsh-client-ui-primitives）；前者在全新 profile 根本无法 pnpm 安装（`ERR_PNPM_NO_MATCHING_VERSION`）。规则 4 warn 为真阳性，非 bug。
- 真实扫描基线：web 与 dsh-tui 均 0 fatal；仅上述 peer warn（用户可 `ignorePackages` 消音）。
- 官方模板 patch 层 = `注释 + []` 占位；第三方 bundle patch 普遍用 `- insert:` 包裹真实行（本工具的可见行视图必须展开 insert）。
- pnpm `.pnpm` 文件与全局 store 为 **hardlink**：截断写（writeFileSync 原路径）会污染全局 store，后续 install 从损坏 store 提取坏版本（真实 profile 曾被两次注入 `-drift-test` 污染，见卡点）。
- dsh 官方 client 契约（B1 依据，详见会话调研）：`dsh.client{platform:'web',inject[]}` + `exports["./client"]`；Settings tab 注册走 `ctx.slots.inject('settings.section'|'settings.plugins.tab', ...)`；client 打包 = CJS 单文件 + `window.__ModuleLoader__.load({id, factory})` 尾调用、react 等平台模块直接 import（外部化不打包）；host→client 官方一等通道是 Typert Remote（生成器重，第三方用 webServer prefix 属仅第三方实践）；`ctx.dshHomePath`/`ctx.baseUrl` 可用，无"当前 profile 目录"服务（需自推导 `resolveDshHome()+profiles/<名>`）。

## 卡点与解决（按时间）

1. **无"加载前插件代码窗口"**（决定形态）：dsh = 静态补丁先行→行并发激活→任一失败整树中止。→ 预检只能树外（wrapper/静态）或改本体；产品形态定为独立 wrapper + 面板，不进 dsh 插件树的关键路径。
2. **pnpm outdated 冷查超 90s**（当前网络）：→ 45s 杀树超时 + 5min 缓存 + 失败降级 info；库内 scan 默认不联网（`updateCheck` opt-in），gate/fix/单测全部关闭。
3. **store hardlink 污染**（真实 profile 两度被 `-drift-test` 污染）：根因 = E2E 注入截断写穿 symlink 改 store。→ 注入改"原子替换"（写 tmp+删+rename）；清理 = `pnpm cache delete <pkg>` + 删 `.pnpm` 损坏目录 + frozen 重装；E2E 加 temp 沙箱路径断言。
4. **PowerShell 文件事故（当天 3 次）**：a) `Get-Content -Raw` 失败后 `WriteAllText` 仍执行 → 文件清空；b) `\r\n`/`\u0022` 字面替换不命中；c) **GBK 误解码重写含中文 HTML → 面板乱码**。教训（全局规则）：含中文/新文件一律用 write/edit 工具，禁止 PowerShell Get-Content/Set-Content/Replace 处理项目文件。
5. **patch 层写坏 YAML**：文本追加到 `注释+[]` 模板破坏文档 → append 改结构化 push（`doc.createNode`）；remove 遍历根 items 而非展开索引；yaml 2.9 节点级 `toJS()` 必须走 Document 级（`doc.toJS()`）。
6. **rowViews 状态错乱**：同 id 跨 source（bundle 层 + 用户层）→ 用户层行优先（applyEntries 覆盖顺序）。
7. **GitHub 网络长期不通**（移动热点）：本地 commit 持续积压，网络恢复后 `git push` 一次补齐。
8. **pnpm Windows spawn**：`.cmd` 不能直接 spawn → `cmd.exe /c` 常量串；杀进程树用 `taskkill /T`。
9. **浏览器自动翻译机翻正文**：`meta notranslate` + 合法 BCP47 lang。

## 本地未推送 commit（2026-09-09 会话末，网络恢复后 `git push`）

- `85a97bb` serve 面板（本地 Web UI + API，白名单写操作 + 同源校验）
- `547bc80` 面板 zh/en i18n + 切换
- `916d9e8` 防浏览器自动翻译
- `371d7af` v0.3 part1（selftest、panel-api 共享、插件行管理、insert 展开、[] 占位修复）
- （本次会话新增）乱码重写 + 本文档 → 待 commit

## v0.3 剩余（下次会话起点）

**B1 dsh 设置页内嵌 bundle**（最大块，方法已调研完毕）：
- `packages/bundle` 单包双端：`dsh.bundle.patch`（cordis.patch.yml 声明自身 host 行）+ `dsh.client` + `exports "./client"`；host 半边 = cordis 插件复用 `handlePanelApi`（`ctx.webServer.register` prefix `/dsh-ops`，home 从 `resolveDshHome`+profile 推导）；client 半边 = 注册 `settings.section`（独立"健康检查"页），fetch 同源 `/dsh-ops/api/*` 渲染（双语文案复用 serve 面板字典思路）；client 用 esbuild 打包（CJS + `__ModuleLoader__.load` 尾调用、react 外部化）。
- 冒烟：`dsh plugin --profile web add file:<本地路径>` 装进真实 web profile → 重启 dsh web → 设置页看新 section。
- 依赖：core 需作为 bundle 的 dependency（本地 file:/workspace 先顶着，A1 npm 发布后自然化）。

**B2 explain（LLM 解读）**：
- 入口 `dsh-ops explain --profile web` + 面板按钮；读取 key：`DEEPSEEK_API_KEY` 环境 → `~/.dsh/.env`；POST chat/completions（`DEEPSEEK_BASE_URL` 可覆盖，默认 api.deepseek.com）；输入 = scan findings 精简 JSON + 规则上下文；输出 = 诊断总结 + 逐条修复建议；无 key → 静态提示。调用面只在用户显式触发（不进 scan/gate 关键路径）。

## v1.0 A 线（全部未开始）

A1 npm 包整理（去 private、files 校验、cli 需含 assets、名称核查 `dsh-plugin-ops`/`-core`/`-bundle`）→ A2 自包含单文件构建（自保 §7 承诺：esbuild bundle 进 core+deps，运行时零外部 require）→ A3 CI（typecheck/test/build/E2E/发布流水线）→ A4 治理文件 → A5 命名核查 → A6 开源切换（public + topic `dsh-plugin` + awesome 收录）。

## 约定与提醒（给未来会话）

- 决策记录权威在 PLAN.md（§10 已决清单 + §7 自保四层 + §4.5 依赖借鉴四档 + §9 生态策略）。
- **所有消息正文引擎英文、UI 词典化**（面板 zh/en 可切）；勿给引擎消息做第二套翻译。
- 写操作原则：plan→确认→执行→校验→备份；只允许白名单（align-lockfile、写/删 disabled 行）。
- 改文件用 write/edit 工具（见卡点 4）。commit 信息沿用仓库风格（feat/fix/docs/test: 描述）。
- 自保层（PLAN §7）：核心不进 dsh 插件树；fail-open 只对 dsh-ops 自身故障；scan 判定 fatal 走先阻断。
