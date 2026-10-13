# dsh-plugin-ops

[English](README.md) | 中文

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ff-infinite-z__dsh-plugin-ops.json)](https://unstone.github.io/dsh-xray/registry.html#f-infinite-z__dsh-plugin-ops)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome-dsh--plugin-listed-blue)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

> **插件把 dsh profile 弄坏了？** `dsh-ops` 点名是哪一个、告诉你官方启动器会不会跳过它、并把修法给成一条可直接执行的命令——**在启动失败之前**，且不碰你正在运行的实例。

## 三步，不猜

1. **体检** —— `dsh-ops check` 秒级离线扫全部 profile。10 条静态规则跟随**启动器的运行时解析**而非磁盘布局，每条结果自带修法。
2. **预演** —— `dsh-ops preview` 拿**下一个** dsh 版本对已装插件跑一遍，用启动器同款兼容语义给出：**哪些会被跳过**，以及每一项的修法。
3. **隔离复验** —— 安装、修复、适配都**先在第二个隔离实例**里复验（独立 DSH home + user-data-dir），只有那一次启动存活才写入真实 profile。

拿 dsh `0.2.1-alpha.2` 跑本项目自己的 web profile：`dsh-lsp-actions@0.4.5` 与 `dsh-mcp-connector@0.2.37` 会被跳过，能活下来的是 `dsh-lsp-actions@0.5.12` / `dsh-mcp-connector@0.2.70`。

安装：桌面端 → **设置 → 插件 → `dsh-plugin-ops-bundle`**；web profile → `dsh plugin --profile web add dsh-plugin-ops-bundle`；终端 → `npm i -g dsh-plugin-ops`。

**状态：v0.20.1 — 升级存活预演：对目标 dsh 版本预演每个已装插件的去向（"哪些会被跳过——每项修法都是可执行命令"），`--updates` 从 registry 解析最新发布；两个面板都加了预演卡片。新增规则 10 检测同一安装树内的同版本重复物理副本（现场案例：被 loader 吞掉的错误掩盖了 koffi 类型冲突）。拦截/修复/记忆的机制见 [docs/architecture.md](docs/architecture.md)。**

## 命名

| 层 | 名称 | 说明 |
|---|---|---|
| GitHub 仓库 / npm 包 | `dsh-plugin-ops`（CLI）/ `dsh-plugin-ops-core`（引擎）/ `dsh-plugin-ops-bundle`（内嵌 bundle） | 对外名统一 |
| 命令 | `dsh-ops` | 安装后提供的 bin |

## 为什么做

DeepSeek Harness（dsh）插件生态自 2026-08 起爆发式增长，但 dsh 的加载模型并不宽容：静态补丁经**必需**的 bootstrap Include 应用，**一行补丁无法导入即整树中止启动**。0.1.6 起，已导入插件若激活失败只产生一条警告——功能静默缺失而非响亮失败。同一版本还把启动器切换为**运行时解析**：包表在进程内从安装依赖图与所选 bundle 构建，只看磁盘布局的检查会与实际解析结果漂移。

现有生态工具（多个市场/管理器）只做**变更时防护**（安装/更新时试运行）与运行期观测；**没有项目做每次启动前的整体预检、跟随启动器的运行时解析表、并在启动失败时读取官方诊断做归因**。dsh-plugin-ops 补上这环。

## 快速开始

```sh
npm i -g dsh-plugin-ops
dsh-ops check                  # 一条命令扫全部 profile（无网络，秒级）
dsh-ops scan --profile web     # 单 profile 深扫（--json 机器可读；--version-view latest 只看最新语义）
dsh-ops fix --profile web      # 修复：lockfile 对齐（--dry-run 预览 / --yes 免确认）
dsh-ops gate -- dsh web        # 启动门：预检通过才放行 dsh；失败自动归因
dsh-ops adapt <pkg>            # 安装适配：官方门禁拒绝的插件（canary 验证 + 豁免）
dsh-ops preview --profile web  # 升级预演：目标版本会跳过哪些插件 + 每项修法（--updates 查 registry）
dsh-ops verify <pkg> --runtime # 作者门禁：静态检查 + 隔离启动（--report 输出兼容性矩阵）
dsh-ops serve                  # 本地 Web 面板 http://127.0.0.1:8912（中英可切）
dsh-ops selftest               # 自检：内置故障样本跑全规则
```

`check` 输出每个 profile 一行总评 + 逐条 fatal 修复提示；`--json` 适合交给对话里的模型解读。

## 扫描规则（10 条，全部静态确定性）

| # | 规则 | 严重度 | 作用 |
|---|---|---|---|
| 1 | bundle 声明完整性 | fatal | 层列表里的包不可解析 / 无 `dsh.bundle.patch` / patch 文件缺失（bundle 可声明有序多 patch 文件，0.1.7+） |
| 2 | 依赖三方漂移 | fatal/自动修 | package.json 声明 vs pnpm-lock.yaml 锁定 vs 磁盘实际 |
| 3 | registry 版本对比 | warn | 经 `pnpm outdated`，有更新提示；advisory 不阻断 |
| 4 | peer 缺口/双实例 | 双实例 fatal | 声明了无法解析的 peer——且豁免可信/合法的缺失：client bundle 的 shell 模块（`react`/`react-dom`）、`peerDependenciesMeta.optional` 标记的 peer、桌面 profile 上的官方包（在打包 asar 内），以及定位不到安装锚点时的官方 peer；框架核心出现两份物理副本仍为 fatal |
| 5 | patch 行解析（合并语义） | fatal/info | insert 行引用的包不可解析即中止启动（必需 entry / 版本语义）；扁平行是配置补丁（其 `name` 仅为匹配断言），无可见层引入其 id 时报 info"不生效"；同 id 以最后一条 insert 为生效行（对照 0.1.7-rc.2 与 0.2.1-alpha.1 源码 + `--dump-config` 实测） |
| 6 | 故障记忆 | info/warn | 自上次成功启动后变化的包清单（归因基础） |
| 7 | 结构完整性 | fatal/warn | 缺默认入口 / CJS 入口（Loader 需 ESM 命名导出）/ 缺 types/client |
| 8 | 插件版本兼容性 | fatal / info（已豁免） | `@deepseek-ai/dsh*` peer 范围拒绝当前 dsh 版本——dsh 0.1.7-rc.1+ 会跳过该 bundle，功能静默缺失，除非授予 exact-version 豁免 |
| 9 | 嫩包豁免条目卫生 | warn | `minimumReleaseAgeExclude` 中同一包出现两条带版本条目会让 pnpm 11 的锁文件豁免失效，此后该 profile 的每次安装都失败（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，已在 pnpm 11.7 复现）；推荐改写为裸包名 |
| 10 | 重复物理副本 | fatal / warn | 同一安装树内 `@deepseek-ai/*` 与框架核心包出现**同版本**的多个物理副本（pnpm store 实体经符号链接只有一份物理路径，自动去重；不同版本的嵌套解析属 npm 常态，不报；0.1.5 遗留的共享闭包镜像树不扫——0.1.6+ 启动器不读它）。多次安装/升级会累积同版本残留，而模块求值期做进程级全局登记的包（原生绑定、koffi 类型）在第二份副本加载时失败、且错误被 loader 吞掉；官方静态闸可通过（2026-10-13 现场：四份 `@deepseek-ai/dsh-win32-process`，`Duplicate type name 'DSH_STARTUPINFOW'`） |

解析跟随启动器的运行时 generation（0.1.6+）：profile 自身依赖树原生优先，其次是从安装清单与所选 bundle 重建的包表——冻结的磁盘镜像不再参与判定。Node 解析只沿锚点的物理祖先链；环境注入路径（NODE_PATH、全局路径、加载器链）一律不参与，与启动器自身的包表一致。

真实生态验证：peer 声明悬空（作者引用官方未发布的包）已在多个第三方插件上检出。

## 命令与形态

| 面 | 说明 |
|---|---|
| `check` | 全 profile 一键体检（默认无网络），人类与模型双友好 |
| `scan` | 单 profile 深扫：规则 1-9 + 可选更新检查；`--version-view all\|latest` 选择版本口径（all 默认：全版本并集并标注版本区间；latest 仅最新语义；严重度始终锚定实际安装版本） |
| `fix` | 自动可修集：磁盘↔lockfile 对齐（`pnpm install --frozen-lockfile --force`）；plan→确认→执行→备份 |
| `gate` | 先阻断分级处置：fatal 先拦（自动修→放行；复杂→醒目指引；`--bypass` 逃生舱记录不静默）；dsh 启动秒退 → 读取官方启动诊断（`$DSH_HOME/logs/startup-*.log`）→ 归因差异包与启动器报告的失败插件 → 交互禁用重试（**先在 profile 的隔离副本中复验**：web 用临时 DSH home 启动副本，桌面用复用沙箱并从最新 crash report 归因；只有复验启动存活才写入真实 profile，沙箱不可用时如实降级为直接应用）；headless 一次性 profile 退出码透传不归因 |
| `serve` | 本地 Web 面板：健康卡/结果列表/修复执行/**升级预演**（目标版本彩排 + 可复制修法命令）/**插件行管理**（健康徽标、致命/警告/正常筛选、每页 10 行分页、官方行保护、启停开关）/故障时间线/**诊断对话（带增强检索 RAG 开关）**——排障经验沉淀为 Markdown，开启后自动检索命中条目注入对话（BM25 + 可选向量重排），zh/en 切换 |
| `selftest` | 引擎自检（6 内置故障样本），验证安装健康 |
| `verify` | 面向插件作者的发布前校验：支持本地目录或 **npm 包名**（`dsh-ops verify <name\|@scope/name\|name@version>`，从 registry 下载发布物校验）；检查 bundle patch 声明与解析、patch 行可解析性、依赖协议（`file:`/`workspace:`）、peer 契约（peer 名必须是包名、range 必须是 semver）、**dsh peer 全版本覆盖**（声明了 `@deepseek-ai/dsh*` peer 时须覆盖全部已知版本边界，标注缺口版本——市场上架兼容性矩阵要求）、ESM 入口与导出、client 导出契约与产物形状、files 完整性（`--json`、CI 用 `--strict`）；**`--runtime`** 追加隔离启动验证——在独立 DSH home 中经官方命令安装并启动；**`--desktop`** 在隔离桌面沙箱中启动官方桌面端验证——临时 `DSH_HOME`（自带 desktop profile）+ 独立 Electron user-data-dir + 沙箱专属 webserver 端口，经桌面自带 CLI（0.2.0-rc.1+）安装，观察崩溃报告/进程/端口判定，只回收沙箱自己的进程树，不触碰真实实例与数据；**`--runtime` 与 `--desktop` 可同时给**，一次运行检查两端（JSON 输出 `runtimes: { web, desktop }` 矩阵）；**`--report <file.md>`** 把本次运行写成市场风格兼容性矩阵（静态检查、dsh peer 声明对已知版本边界的覆盖、实测目标及版本、生命周期覆盖并明示未覆盖环节），`--json` 在 `matrix` 字段携带同一模型 |
| `adapt` | 安装适配：对官方门禁因 `@deepseek-ai/dsh*` peer 范围拒绝的插件，诊断冲突的 peer、分级风险（窄范围 vs 跨 breaking 边界），**先在隔离 canary 启动中授予官方 exact-version 豁免**（web profile 用独立 DSH home；desktop profile 用真实隔离桌面沙箱），只有该启动存活才写入真实 profile；canary 或安装失败即回滚豁免；**desktop profile** 在应用自带 CLI（0.2.0-rc.1+，单测覆盖、待实机验证）可用时，完全退出应用后直接经它安装/卸载，无 CLI 时回退为只写豁免并指引到桌面端 Plugins 页；`--remove` 一步完成卸载 + 清理豁免 |
| `preview` | **升级存活预演**：对目标 dsh 版本（`--target <version>`，默认最新已知；`--updates` 从 registry 解析最新版为目标并逐插件查其最新发布），用启动器同款兼容语义判定每个已装第三方 bundle 是否会被跳过，并为每个被跳过项给出**可直接执行的修法命令**——更新（`dsh plugin --profile <p> add <name>@<新版>`，仅当新版接受目标版本）、官方 exact-version 豁免（`dsh plugin --profile <p> allow-version ... --accept-risk`）或禁用；官方 bundle 与 retired 条目只记录不判定；只读；`--json`；`--report <file.md>` 输出 profile 级 Markdown 矩阵（与 `verify --report` 配套）；退出码 1 = 至少一个插件会被跳过（非失败） |
| `sessions` | 会话容器修复：扫描 `$DSH_HOME/sessions` 中两类会阻断启动的损坏（首帧无法解码的产物；目录名与 header id 不匹配的会话目录）；`--repair-paths` 把被改名的目录移回其 header id，`--quarantine` 把不可读会话目录移入 `$DSH_HOME/cache/dsh-ops/quarantine`（永不删除）；默认只读计划，深层事件级诊断仍由 `@argszero/cordis-plugin-session-audit` 覆盖 |
| `dev` | 单插件目录的开发监视器：每次变更后（防抖）跑静态检查（带序号、标注包名@版本），`--runtime` 在每次通过后追加隔离 DSH home 启动冒烟、静态仍有 error 时明确提示跳过；**`--desktop`** 在每次通过后追加隔离桌面沙箱启动冒烟（两者可同时给）；停止时打印检查/失败/耗时汇总；全程不触碰正在运行的 dsh |
| 内嵌 bundle（`dsh-plugin-ops-bundle`） | 装进 profile 后在 dsh Web 设置页出现"dsh-ops"健康页（扫描/行管理/**升级预演**/安装适配——经官方 `pluginManager` 服务的豁免安装，含豁免清单与撤销/卸载并清理/时间线/带 RAG 知识库的诊断对话），外加**沙箱控制台**：左栏底部入口打开右栏面板，启动隔离的"2 号 dsh"——web 宿主用临时 home，桌面宿主则是**第二个桌面窗口**（独立 `--user-data-dir` + 临时 DSH home，经已安装应用自身的可执行文件启动）——实时查看日志与官方启动诊断、扫描、**安装/卸载插件（回读校验注册，半注册残留自动 remove→add 修复）、就地解决构建门（`allowBuilds`）、留存会话报告**、保留现场重启、并执行禁行修复（以重启结果为准——`fix` 经运行安装的闭包解析行可见性，桌面形态下官方 bundle 位于打包 asar 内、其行被拒绝；"无法解析"与"无此行"分开报告）；十个 AI 工具（`dsh_ops_sandbox_start`/`_stop`/`_restart`/`_status`/`_scan`/`_install`/`_uninstall`/`_approve_builds`/`_report`/`_fix`）把同一面交给运行中的 agent。所有 `/dsh-ops` 路由经过官方 connection 准入（信任围栏 + launch-token/cookie 浏览器鉴权——与官方 API 同一道闸门，缺失时 fail-closed）。host 半边与 `serve` 复用同一引擎；诊断对话优先走官方 `ctx.llm`、无 llm 时降级直连 |

退出码：`0` 通过（或 dsh 自身码）/ `1` 仍有 fatal（`preview`：至少一个插件会被跳过）/ `2` 用法或 profile 缺失 / `3` gate 被需人工处置的 fatal 阻断 / `4-5` gate 归因相关。

## 配置（`$DSH_HOME/dsh-ops.yml`）

```yaml
rules:
  registry-version:
    enabled: false          # 关闭某规则
  peer-gap:
    severity: info          # 严重度只能降不能升
versionView: all            # 版本口径：all（默认，全版本并集+版本区间标注）/ latest（仅最新语义）
ignorePackages:
  - some-noisy-plugin
registry: https://registry.npmmirror.com   # 沙箱安装 / 桌面 scaffold / 预演 registry 检查；环境变量兜底；内嵌宿主激活时读取一次——改后需重启 dsh
```

## 架构与自保

- **核心逻辑在 dsh 插件树之外**（独立 wrapper 进程 + 只读文件解析），dsh 崩溃不影响诊断，诊断失败不拦 dsh（fail-open 只适用于自身故障）。
- **自包含构建**：core 与 CLI 发布物均为自包含打包（依赖全部内联，运行时零 node_modules）——没有依赖树就没有依赖树可漂；树内 bundle 的 host 半边因此不会把依赖缺口带进 dsh 插件树。
- 规则消息单语英文（CLI/JSON/面板单一事实）；面板 UI 词典化中英切换。dsh-ops serve 面板含诊断对话（ModelChannel 通道：显式 DSH_OPS_LLM_API_KEY/_BASE_URL/_MODEL 覆盖，或探测 DEEPSEEK/ARK/DASHSCOPE/OPENAI 的 env/.env/.credentials.yaml 凭据；内嵌形态优先复用官方 ctx.llm seam，无 llm 服务时降级直连）。
- 写操作白名单 + 自动备份；故障注入测试有 temp 沙箱路径断言。内嵌面的每条路由都经过官方 connection 准入；沙箱管理器只从外部观察其子进程（文件、诊断、输出）。

## 权限与数据访问

dsh-ops 按设计会触达敏感面；下面说明具体触达什么、何时触达、有何护栏。所有动作都由用户显式触发。

| 面 | 访问内容 | 用途 | 护栏 |
|---|---|---|---|
| profile 文件 | `package.json`、`pnpm-lock.yaml`、`node_modules` 元数据、patch YAML | 诊断本身（`check`/`scan`） | 只读；写操作只走下方两条白名单修复通道 |
| 补丁层 | 向 profile 用户补丁层 `cordis.patch.yml` 结构化写入 `disabled` 行 | 禁用导致启动失败的插件行 | plan→确认→备份→校验写入；删行即恢复；官方 `@deepseek-ai/*` 行拒绝禁用（403） |
| 会话容器 | 读取 `$DSH_HOME/sessions` 目录树；`--repair-paths` 把会话目录改名为其 header id，`--quarantine` 把会话目录移入 dsh-ops 缓存 | `sessions` 修复命令 | 仅显式 flag；永不删除；先跑只读计划并报告每一步移动 |
| 命令执行 | `pnpm install --frozen-lockfile --force`（固定参数）；`gate` 中传入的 `dsh` 命令；存在时调用 `session-audit` | lockfile 对齐；预检通过后启动 dsh；会话容器预检 | 绝不执行任意命令；仅在显式确认或用户自己输入的命令上执行 |
| 沙箱进程 | 经**运行安装自带的 CLI 入口**在临时 DSH home 中启动第二个 `dsh`（cwd 为沙箱 home）；桌面宿主则启动已安装应用自身的第二个窗口（独立 `--user-data-dir` + 临时 home） | 沙箱控制台（面板与 `dsh_ops_sandbox_*` 工具） | 仅在显式操作时启动；以当前用户身份继承环境运行——面向插件配置的隔离，非安全边界（UI 中已明示：用户级凭据如 `~/.npmrc` 的 auth token、git 凭据库在沙箱内可读）；停止即完全清理 |
| 本地 HTTP 服务 | 回环 `127.0.0.1:8912`（`serve` 面板）；内嵌 bundle 复用 dsh 自带 web 服务 | Web 面板 | 仅回环、路由白名单；内嵌面额外经过官方 connection 浏览器准入（launch-token/cookie），无凭据请求一律拒绝 |
| LLM 凭据 | `DSH_OPS_LLM_*`，或 env / `.env` / `.credentials.yaml` 中的 provider key | 仅可选的诊断对话 | 只在对话使用时读取；全部静态功能无 key 可用 |
| 网络 | `pnpm outdated`（`--updates` 可选）；配置的 LLM API | 更新提示；诊断对话 | `check`/`fix`/`gate` 与默认 `scan` 完全离线 |

dsh-xray 给本项目的评级为 C3（衡量能力面而非意图）；上表是该能力卡的人类可读版本。

## 后续方向

- **常驻沙箱与终端端（更晚）**：跨重启保留的沙箱，以及终端类 profile（`tui`/`headless`/`acp`）的验证目标——等插件工作流需要时再加。
- **对接市场门禁（按需）**：`verify --report` 已能输出兼容性矩阵；与具体市场上架格式对齐，等该格式出现后进行。
- **一体化插件管理（v2）**：把生态"变更时防护"（canary 试运行、启停、更新检查、市场）按自有架构吸收进启动生命周期防护，以启动门为统一入口。

## 开发

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test      # 333 单测（core 257 + bundle 39 + cli 37；Windows 跳过 1 个 POSIX 专属用例）
node packages/cli/lib/index.js selftest  # 引擎自检
node scripts/e2e/scan-fix.e2e.mjs        # 离线 E2E（真实 pnpm 修复）
node scripts/e2e/gate.e2e.mjs            # gate 场景（放行/阻断/旁路/归因/headless）
node scripts/e2e/real-plugins.e2e.mjs    # 真实第三方插件沙箱（需网络）
```

发布：core → cli → bundle（顺序见 CI release workflow）。

## 生态定位

不是第 N 个市场/管理器，而是启动生命周期防护：补全生态"变更时防护"缺失的**每次启动**环；沙箱控制台把同一理念延伸到有风险的插件工作——一个完全从外部驱动的隔离 2 号 dsh，面板与运行中的 agent 共享同一观测面。后续版本将按自有架构吸收市场/启停/升级防护等功能，收敛为一体化插件管理增强。

互补面：存储的会话容器由 [@argszero/cordis-plugin-session-audit](https://github.com/argszero/cordis-plugin-session-audit) 审计——面向 `$DSH_HOME/sessions` 目录树的启动前检查，带可供启动门消费的退出码；当启动失败来自 workspace 注册表而非插件树时，`gate` 会指向它。

## 平台支持

Windows / macOS / Linux（Node `^22.19 || >=24`，与 dsh 相同）；CI 在三平台跑构建、类型检查、单测与离线 e2e。

## 反馈

- **面板内一键反馈**：`serve` 面板与内嵌 bundle 都有 **反馈** 按钮，自动预填环境信息（版本/形态/OS/profile/scan 计数）打开 issue——不用手工收集诊断信息。
- **插件兼容性问题**（插件安装/启动失败，或被 dsh-ops 判为异常）：提 [兼容性问题](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=compatibility.yml)，附上 `dsh-ops scan --json` 输出。
- **dsh-ops 自身行为异常**：提 [Bug 报告](https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=bug.yml)。
- **提问与讨论**：[GitHub Discussions](https://github.com/f-infinite-z/dsh-plugin-ops/discussions)。
- **插件作者？** 给你的仓库加上发布门禁：[插件作者 CI](docs/plugin-author-ci.md)（`dsh-ops verify` + 启动冒烟，可复用 workflow）。
- 欢迎提供真实故障样本——它们会成为 selftest 样本与知识库条目。

## 参考

- [docs/architecture.md](docs/architecture.md) 拦截/修复/记忆机制说明
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 许可证：MIT（见 [LICENSE](LICENSE)）
