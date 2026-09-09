# dsh-plugin-ops 计划（规划中）

> 定位：DeepSeek Harness（dsh）插件生态的**启动生命周期防护**。计划以独立仓库形式开源。
> 状态：本文件是规划文档，不是实现描述。所有对 dsh 源码的引用均为调研依据，实现前需按实际发布版本复核。

## 1. 问题定义

### 1.1 生态现状（调研时间 2026-09）

- dsh 插件生态 2026-08 中旬起爆发：`dsh-plugin` GitHub topic、awesome 列表、多套桌面壳、20+ 第三方插件包在数周内出现；生态目录收录 500+ 插件仓库。
- 插件分发依赖 npm bundle（`package.json` 的 `dsh.bundle.patch` 声明）+ profile（`$DSH_HOME/profiles/<name>` pnpm 项目）。
- 用户侧安装命令：`dsh plugin --profile <name> add <pkg>`（pnpm 薄转发），版本范围默认 `^`，锁定委托 pnpm-lock.yaml。

### 1.2 核心痛点：启动 = 脆弱点

dsh 启动模型（源码依据，见主仓库 vendor/loader 与 packages/boot/app-boot）：

1. 静态补丁（bundle 层 + 用户 patch）先于一切**一次性应用**；
2. 所有插件行**并发** import/激活，顺序不保证；
3. **任一插件失败 → 事务回滚 + 整树中止**（`dsh: plugin tree failed to load`），不存在"禁掉坏的继续跑"的启动路径；
4. 唯一的事前降级原语是行级 `disabled`（静态写入 patch 或 `!!js` 条件）。

推论：**没有可供插件代码占用的"加载前窗口"**。要在坏插件激活前拦截它，只能在 dsh 进程之外（wrapper/静态期）或改本体 boot。这是本项目的形态基石。

生态中常见的失败原因（待 v0.1 以规则实证）：
- 上游悄悄发布坏版本，`^` 范围下次启动自动带入（版本漂移）；
- peer 缺口：profile `autoInstallPeers: false`，缺 peer 直接 import 失败；
- 插件把自己的 `@deepseek-ai/cordis`/依赖装成副本（模块身份分裂）；
- bundle 声明与安装状态不一致（更新后丢 `dsh.bundle`、对账滞后）；
- patch 行引用的包未声明为依赖（解析悬空）；
- 插件间 ctx 服务/事件冲突（isolate 缺失）。

## 2. 竞品调研结论

### 2.1 竞品盘点（2026-09-09 时点，star 数均为该时点）

| 项目 | ★ | 活跃度 | 覆盖能力 | 判断 |
|---|---|---|---|---|
| dshplugin/dsh-plugin-hub | 97 | 08-20 创建，迭代中 | 社区市场（4000+ 条目）、安装 | 最热市场，纯目录+安装 |
| Noob-stupid/dsh-plugin-hub | 81 | 08-14 创建，26 天 32 版 | 启停/市场/框架升级+适配门/启用前 import 探测/AI 部署计划 | 功能最全面板；变更时防护 |
| AlexYin-Tongji/dsh-plugin-console | 1 | 08-17 创建，持续 | 隔离 canary 试运行、供应链校验、事务 plan、框架升级回滚 | 工程最正规但 1★ |
| oxlyn/dsh-plugin-mgr | 1 | 08-22→09-02 停更 | 启停/卸载/更新检查/错误归因展示 | 朴素，已停更 |
| CMSKL/dsh-plugin-observatory | 2 | 08-17→08-22 停更 | "兼容性审计+生命周期观测"（0.1.0 单版） | demo 级，已放弃 |
| deepseek-ai/deepseek-harness（官方） | 216.8k | — | 本体 | 无插件生态治理能力（有意如此，Everything is a Plugin） |

### 2.2 空白矩阵：护城河所在

| 场景 | 竞品 | 本项目 |
|---|---|---|
| 安装/更新插件时防护 | ✅ canary 试运行+回滚（AlexYin）、import 探测（Noob） | 不做（已有好方案） |
| 框架升级时防护 | ✅ 适配门禁用不兼容插件（Noob） | 不做 |
| **每次启动前预检** | ❌ 无人做 | ✅ `dsh-ops gate/scan` |
| **启动失败后归因-恢复闭环** | ❌（仅显示错误） | ✅ 归因 → 建议禁用/回滚 → 重试 |
| 依赖树治理（裁剪/精确锁定/lockfile 对齐） | ❌ | ✅ 后续版本 |
| 模型解读诊断 | ❌（Noob AI 只做安装计划） | ✅ 可选层（后续版本） |

结论：**生态窗口期、竞品全为 <1 个月龄、市场面已红海、可靠性面无人做**。值得以"启动生命周期防护"为差异化定位进入。

### 2.3 对竞品的战略判断（先深度后广度）

竞品的共性：**广度优先、降级兜底**——先把启停开关、更新检查、市场目录等"操作便利"铺满（多数靠运行时写 `disabled` 降级 + 事后显示错误），对"每次启动为什么炸、怎么在炸之前拦住"没有系统解法；星数也印证了这一点（头部 81-97★，多数 1-2★）。

本项目的顺序反过来：**先用核心亮点（启动前预检拦截 + 失败归因恢复）建立不可替代的深度，再把竞品已验证的思路吸收为广度，最终收敛成完整的插件管理增强一体化产品**。竞品功能是后续阶段的借鉴清单与集成对象，不是 v0.1 的负担；其工程经验（事务 plan、canary 试运行、供应链校验）写入我们的安全写入原则。

## 3. 定位与产品形态

### 3.1 价值主张

让"装插件的 dsh"像"没装插件的 dsh"一样**可预期地启动**：启动前告诉用户会炸什么、为什么、怎么修；炸了之后告诉用户是谁、上次好的状态是什么、怎么恢复。

### 3.2 形态：单仓库双产物

```
dsh-plugin-ops/            ← 本仓库（独立，MIT，dsh-plugin topic）
├── packages/cli/          ← dsh-ops CLI（wrapper bin，MVP 主体；npm 名 dsh-plugin-ops）
├── packages/core/         ← 共享核心（扫描规则/修复引擎/报告格式；npm 名 dsh-plugin-ops-core）
└── packages/bundle/       ← 会话内 Cordis bundle（v1 后置；npm 名 dsh-plugin-ops-bundle）
```

- wrapper bin 依赖本机已安装的 `dsh`（`gate` 最终 `exec` 它），不改 dsh 本体、不要求 key、不触碰官方代码。
- bundle 产物只做会话内面：状态看板、规则触发后的 UI 提示、可选 LLM 解读（复用 dsh 已配置凭据；无 key 退化为静态文案）。

## 4. v0.1 范围（MVP）

### 4.1 CLI 命令

| 命令 | 行为 |
|---|---|
| `dsh-ops scan --profile <name> [--json]` | 静态扫描，输出分级报告（fatal/warn/info），退出码按最高严重度 |
| `dsh-ops fix --profile <name> [--dry-run]` | 对可自动修复项生成 plan → 用户确认 → 执行 → 校验 → 可回滚（写操作全部留备份） |
| `dsh-ops gate --profile <name> -- <dsh 启动命令...>` | 先 scan：fatal 阻断并打印修复指引；通过则 exec dsh；**dsh 启动失败（退出码/日志特征）时进入归因流程** |

### 4.2 扫描规则集（分块路线）

静态确定性规则，全部可离线解释。

**v0.1 实现（核心 1/2/6）：**

1. **bundle 声明完整性**：`dsh.profile.bundles` 中每个包可解析、package.json 存在、`dsh.bundle.patch` 指向存在的文件（对齐官方启动期 fail-loud 语义，但提前到启动前）。
2. **依赖漂移**：profile package.json 声明的 range vs pnpm-lock.yaml 锁定 vs 磁盘实际安装版本 三方不一致（lockfile 读取用 `@pnpm/lockfile-file`，见 §4.5）。
6. **上次会话故障记忆**：记录每次启动结果（成功/失败 + 失败 entry + 当时各包版本快照），下次 scan 输出"自上次成功后变化的包"清单——归因的基础数据。

**v0.2 及以后（规则 3/4/5/7，先留档）：**

3. **registry 版本对比**：npm registry 最新版 vs 安装版（有网才查；advisory 级，缓存，不阻断）。npm 相关一律后置到 V1 正式开源后再做。
4. **peer 缺口**：每个包的 peerDependencies 在解析序（profile node_modules → `$DSH_HOME/profiles/node_modules` fallback 闭包）中是否可命中；重点盯 `@deepseek-ai/cordis` 与 `cordis` 的**双实例风险**。
5. **patch 解析悬空**：补丁 YAML 行引用的裸包名在该 profile 的解析链中不可达（对齐官方 `verify-cordis-config` 语义的运行时版）。
7. **结构完整性**：exports/main/types 指向文件存在、ESM 合规（dsh 要求 ESM-only；CJS-only 出口直接判 fatal）。

### 4.5 实现策略：依赖、调用与借鉴（减少重复工作量）

原则：**核心规则逻辑（差异化诊断本身）自研且保持小；工程外壳（profile 定位、CLI、registry 通信、patch 写盘、事务回滚）全部依赖/调用/借结构，不自己造**。分四档：

**A 档 · 直接依赖（成熟库）**
- `semver`（范围匹配/比较；规则 2/3/4）；`yaml`（patch 解析含 `!!js` 容错，官方 loader 同款；规则 5 + fix 写补丁层）；`@pnpm/lockfile-file`（pnpm-lock v9 读取；规则 2）；CLI 用 Node 内置 `util.parseArgs`（零依赖）；构建用 esbuild/tsup（自包含打包，自保 §7 第 1 层）。

**B 档 · 直接调用（白嫖现成能力，不写逻辑）**
- 规则 3（registry 版本对比）= profile cwd 下 spawn `pnpm outdated --format json`：`.npmrc`/镜像/代理/认证/缓存/超时/限流全套由 pnpm 承担——这是诊断工具约 60% 代码与 90% 网络鲁棒性 bug 的来源，全部省掉；
- 依赖树辅助信息用 `pnpm ls --json`（省依赖闭包 BFS 自实现）。

**C 档 · 同生态官方参考（行为对齐，不 import）**
- `scripts/verify-cordis-config.ts` 的 `validateAppResolution` = 官方"patch 行引用必须可解析"门禁，规则 5 直接对齐其语义；
- `app-boot/src/profile.ts` 的 `packageDirFromAnchor`（`resolve.paths` 探测 = Node 解析序）、`readProfileManifest`、双锚点语义 = 规则 1/4/5 的解析顺序手法（~20 行，不值得依赖整个包）；
- 注意：遵守自保原则，解析全部走**文件格式**，不 import `@deepseek-ai/dsh-app-boot` 等运行时发布包。

**D 档 · 竞品代码借鉴（MIT；抄片段需 THIRD_PARTY_NOTICES 声明）**
- oxlyn/dsh-plugin-mgr：`registry.ts`（npm 查询栈/缓存，与 B 档二选一）、`patch-layer.ts`（补丁层串行写、空 `[]` 占位防 profile 启动失败、非法 YAML 拒绝写入）——fix 写 disabled 直接用其思路；
- AlexYin console：`operations.ts`（plan→执行→校验→恢复的事务骨架）、`canary.ts`（隔离试运行）——v0.1 fix 事务 + v2 canary 参照；
- Noob hub：import probe、patch auto-heal、depsOutdated（subpackage 版本同步警告）——v2 一体化参照。

预期效果：v0.1 自研量集中在 7 条规则的判定核心 + 故障记忆 + 报告模型 + plan/fix 事务外壳；每条规则核心几十行。

### 4.3 fix 可写操作（v0.1 只做"容易修复"面；全部先 plan 后执行、留备份、可回滚）

**v0.1 自动可修集（本地、可逆、无网络）**：
- 规则 2 的"磁盘与 lockfile 失配"：以 lockfile 锁定为准，`pnpm install`（或 `--frozen-lockfile` 校验）对齐磁盘；
- gate 失败归因后的"禁用差异包"：预写 `disabled` 行到 profile 用户补丁层（竞品已验证的写盘通道，见 §4.5 D 档），随时可删行恢复。

**v0.1 不做自动修复（复杂 → 醒目提示 + 建议行动）**：
- bundle 声明缺失/不可解析（建议 `dsh plugin remove` 或按提示处置，需用户决策）；
- 精确锁定 range、恢复历史快照等 → v0.2 起。

### 4.4 gate 策略：先阻断，分级处置（v0.1 定稿）

```
dsh-ops gate --profile web -- dsh --profile web
  ① scan（规则 1/2/6）→ 无 fatal → 放行 exec dsh
  ② 有 fatal：
     ├─ 属于自动可修集（§4.3）→ 自动修复（记录到故障记忆）→ 复扫
     │    └─ 复扫无 fatal → 放行 exec dsh
     │    └─ 仍 fatal → ③
     ├─ 复杂错误 → ③
  ③ 阻断 + 醒目提示：
     - 原因（哪条规则、哪个包、三方状态差异）
     - 建议行动：提示用户处置（如建议暂时卸载该插件或禁用其报错功能）
     - 用户处置后重跑 gate；或显式 --bypass 逃生舱放行（记入故障记忆，不静默）
  ④ dsh 启动失败（退出码/日志特征）→ 读故障记忆归因：
     - 列出"自上次成功后变化/新启用"的包（按差异 + 日志 entry id 排序）
     - 交互式确认 → 自动写 disabled（§4.3 自动可修集）→ 重跑 dsh（保持原参数）
```

- v0.1 无后台静默跳过：fatal 一律先阻断（显式处置或 `--bypass` 才放行）；
- `--bypass` 非逃生暗门：打印醒目告警并记录到故障记忆；
- headless/sdk/acp 等非交互 profile 暂不支持（v0.1 只做 web，见 §8）。

### 4.6 近期不做（后续一体化阶段纳入，见 §8 路线图）

核心亮点立住之前，不为广度分心。以下功能竞品已验证思路，属一体化阶段的借鉴/集成清单：

- 市场/目录/安装 UI（Noob/dshplugin 等已做且迭代快；届时评估集成 vs 吸收）；
- 启停开关面板、卸载（`dsh-plugin-mgr`、Noob 面板已做）；
- 更新检查/一键更新 UI（多家有现成方案）；
- 安装/更新/框架升级时的 canary 试运行与适配门（AlexYin/Noob 的思路）；
- 把插件透明迁到子进程/容器（dsh 架构无此 seam，属新架构研究，仅研究笔记）；
- 不改 dsh 本体 boot 时序；不要求提前 key 引导（预检纯静态，LLM 层后置）。

## 5. 架构约束与依据（实现前复核）

| 约束 | 依据（主仓库源码位置，调研时点） |
|---|---|
| 无加载前插件代码窗口：静态补丁先行、插件并发激活、失败整树中止 | `vendor/loader/src/config/group.ts`（并发 + 回滚）、`packages/boot/app-boot/src/index.ts`（fail-loud） |
| profile 是 pnpm 项目；安装状态 = package.json + pnpm-lock.yaml + node_modules | `packages/boot/app-boot/src/profile.ts`（resolveProfileDir、initProfile） |
| 裸包解析 = 两锚点 Node 解析（profile node_modules 优先 + 安装闭包 fallback），peer 缺口 = 真实 import 风险 | `profile.ts`（packageDirFromAnchor、healProfileModuleFallback、`autoInstallPeers: false`） |
| 补丁行 `!!js` 表达式无法静态求值 → 扫描按"结构可读、求值不可知"分级 | `vendor/loader`（entry ctx 求值） |
| 模块真实可 import 性只能近似（exports 存在性），最终保真在启动 import | `profile.ts`（packageProxySource 等） |
| 热改动刻意不写回磁盘（防烧录）→ fix 的写盘必须走"用户 patch 层 + 备份"通道 | `apps/cli/src/profile-boot.ts`（启动重写空根 cordis.yml） |
| 依赖闭包遍历需含 peer（loader 可见插件直接 import peer） | `profile.ts`（profileDependencyNames） |

外部依赖原则：能 npm 发布依赖（`semver`、`@deepseek-ai/dsh-*` 已发布包、pnpm lockfile 解析库）就依赖；不 fork 官方源码。官方 workspace 内代码仅作行为参照，实现需对发布版本 API 复核。

## 6. 安全与写入原则

- 写操作 = plan（5 分钟有效）→ 用户确认 → 执行 → 校验 → 失败自动恢复；同一时间单变更。
- 只写 profile 用户补丁层与（经确认的）package.json/lockfile；不删插件数据目录、不动基础设施 bundle。
- 供应链：读取远程仅限 npm registry 元数据（版本对比）；不执行 feed 内容、`--ignore-scripts` 哲学对齐。
- 模型解读为只读附加层，标注模型生成；不把模型输出当执行依据。

## 7. 自身健康与自举（元层）

我们也是装在用户机上的代码：同样会被升级、被破坏、与 dsh 演进失配。如果自己先漂移/先崩，整个产品失去意义。与普通插件的本质区别是**核心逻辑天生在 dsh 插件树之外**——解法按失效半径分四层：

### 第 1 层 · 架构自保（v0.1 即生效，最根本）

- **树外运行**：wrapper 是独立进程，cordis 树崩溃物理上伤不到它；坏 node_modules、双实例、peer 缺口不会传染。
- **自包含构建**：发布物为 esbuild 打包单文件 + 声明式规则数据，运行时零外部 require——没有依赖树，就没有依赖树可漂。
- **只读不 import**：解析 dsh 状态只走文件格式（package.json / patch YAML / pnpm-lock），不 import dsh 运行时 API；文件格式演进 = 以"未知 schema 保守降级"应对，不崩不误判。

### 第 2 层 · 升级自保

- **dogfooding**：registry 版本对比机制把自己也列为扫描对象（self-check），与检查别人共用代码路径。
- **selftest**：包内内置故障样本库，发布 CI 与用户侧随时可跑"规则对样本全检出"验证安装健康。
- **canary-then-switch**：检测到自身新版 → 下载到缓存 → selftest + scan 冒烟通过 → 才切换默认；保留 last-known-good 一键回退。
- 发布与开发均 exact 版本，lockfile 入库。

### 第 3 层 · 运行自保

- **自保故障与产品判定的边界**：本层的 fail-open 只适用于"**dsh-ops 自身** crash/超时/不可解析"——此时 gate 放行 dsh 原样启动并显著警告（"医生挂了，病人照常进门"），因为医生出错不能阻止病人进医院；**scan 判定出的插件 fatal 是产品功能，按 §4.4 先阻断**，不属 fail-open 范畴。
- 护栏：扫描超时、输出上限；错误不吞，但绝不误导启动决策。

### 第 4 层 · 生态自保（对 dsh 官方演进）

- engines + 支持矩阵声明；CI 跟随官方 rc 通道，官方发版即跑真实 dsh e2e（建议生态作者做的"发布冒烟"，自己先做）。
- 将来进插件树的 bundle 部分：peerDependencies 锁官方 cordis/dsh 范围，load 期版本不符即拒绝注册（VS Code engines 哲学）；关键路径始终在树外。

对照竞品：Noob 的"框架适配门"只处理框架升级时禁用不兼容插件；**生态内没有任何项目有自举层**——此元层本身就是生态治理示范，也是 PLAN §8 路线图 v2.0 一体化时"框架升级防护"的自身先验。

## 8. 路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| v0.1 | wrapper CLI（web profile）：scan 规则 1/2/6、fix 自动可修集（lockfile 对齐 + 写 disabled）、gate 先阻断分级处置 + 失败归因闭环、故障记忆 JSONL；仅本地开发运行，不发 npm | 人为制造的故障样本（声明缺失、三方漂移、装后损坏）被 scan 检出；gate 阻断→自动修→放行、复杂→醒目提示、`--bypass` 逃生舱均生效；无 key、无 dsh 本体改动 |
| v0.2 | 规则 3/4/5/7（registry 对比经 `pnpm outdated`、peer 缺口与双 cordis 实例、patch 悬空、结构完整性）、headless/sdk/acp profile 适配、规则可配置化（Config 文件）、报告离线缓存与 diff | 覆盖竞品空白矩阵的"依赖治理"行；全 profile 支持 |
| v1.0 | npm 发布 + 正式开源 + bundle 产物（设置页健康看板、模型解读可选） | 产品用户可见闭环；npm 相关全部在此里程碑起做 |
| v2.0 | **一体化整合**：把竞品已验证的功能按我们的架构吸收为完整插件管理增强——启停/卸载/更新检查与一键更新（事务化、并入故障记忆）、市场/目录接入、安装/升级 canary 与适配门（站在 AlexYin/Noob 思路之上，但以 dsh-ops 的启动防护为核心入口） | 单入口覆盖"启动前-启动失败-日常变更-生态发现"全生命周期 |
| 后续研究 | 插件子进程/容器隔离运行可行性（dsh 无现成 seam，需独立设计 IPC+ctx 代理或等官方演进）；作者侧发布冒烟 CI/兼容矩阵模板 | 研究笔记 + 原型 |

## 9. 开源与生态策略（待定项）

- 命名风险：`dsh-plugin-ops` npm 名可能已被占（生态内抢名严重）；GitHub 用 `awesome-dsh-plugin`/topic `dsh-plugin` 收录需要 topic 打标。
- 差异化叙事：**"不是第 7 个市场，是第一个医生"**——启动前防护 + 失败归因，补全生态"变更时防护"（canary/适配门）缺失的"每次启动"环；核心深度立住后逐步吸收竞品广度功能，收敛为一体化插件管理增强产品。
- 验证路径：真实故障样本库（test fixtures）公开，作为生态诊断正确性的可信度来源。
- 与官方关系：不依赖官方 PR；若 `--preflight` hook 进官方路线，保持 wrapper 兼容（wrapper 是超集）。

## 10. 决策记录与开放问题

### 已决（2026-09-09 范围定稿）

1. 命名：**dsh-plugin-ops**（仓库/npm 包名统一；GitHub topic `dsh-plugin` 待开源时打标）。npm 占用核查推迟到 v1.0 发布前。
2. v0.1 规则取舍：只做 **1/2/6**（bundle 声明完整性 / 依赖漂移 / 故障记忆）；3/4/5/7 进 v0.2。
3. `gate` 策略：**先阻断、分级处置**——自动可修集（lockfile 对齐、写 disabled）自动修复后放行；复杂错误阻断 + 醒目提示 + 建议行动（如建议暂时卸载该插件或禁用其报错功能）；显式 `--bypass` 逃生舱（记录，不静默）。dsh-ops 自身故障仍按 §7 第 3 层 fail-open。
4. npm：**v1.0 正式开源后才做发布与 registry 相关**；v0.2 的 registry 对比走 `pnpm outdated`（网络策略由 pnpm 承担，细节 v0.2 再定）。
5. 平台矩阵：**v0.1 只做 web profile**；headless/sdk/acp 适配（无交互面、故障特征不同）放 v0.2。

### 待议

6. 语言：仓库文档是否中英双语（对标生态头部项目，开源前定稿）。
7. dsh-ops 自身升级通道（§7 第 2 层 canary-then-switch）的具体触发形态：随 gate 每次跑 vs 独立 `self-update` 子命令（v1.0 前定）。
8. `fix` 自动执行 vs 交互确认的边界细化：v0.1 哪些写操作可以无确认直接做（如 lockfile 对齐 vs 写 disabled）。
