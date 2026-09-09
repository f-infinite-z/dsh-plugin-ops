# dsh-plugin-ops

> DeepSeek Harness 插件运维（Plugin Operations）：一条命令全量体检、启动前预检拦截、失败归因与恢复、依赖树治理——插件生态的"医生"，长期收敛为插件管理增强一体化。

**状态：v0.3 开发中（v1.0 发布就绪）；拦截/修复/记忆的机制见 [docs/architecture.md](docs/architecture.md)。**

## 命名（三层关系）

| 层 | 名称 | 说明 |
|---|---|---|
| 仓库目录 | `dsh-plugin-doctor`（早期名遗留，本地路径） | 仅本地目录名，计划保持 |
| npm 包 | `dsh-plugin-ops`（CLI）/ `dsh-plugin-ops-core`（引擎） | 对外发布名（GitHub 仓库同名 `dsh-plugin-ops`） |
| 命令 | `dsh-ops` | 安装后提供的 bin |

## 为什么做

DeepSeek Harness（dsh）插件生态自 2026-08 起爆发式增长，但 dsh 的加载模型是：静态补丁全部应用 → 插件行并发激活 → **任一插件失败即整树中止启动**。装几个插件后，"昨天还能开、今天启动失败"成为常态。

现有生态工具（多个市场/管理器）只做**变更时防护**（安装/更新时试运行）与运行期观测；**没有项目做每次启动前的整体预检与失败后的自动归因恢复**。dsh-plugin-ops 补上这环。

## 快速开始

```sh
npm i -g dsh-plugin-ops        # npm 发布后；仓库内开发用源码（见下）
dsh-ops check                  # 一条命令扫全部 profile（无网络，秒级）
dsh-ops scan --profile web     # 单 profile 深扫（--json 机器可读；--skip-update-check 免网络）
dsh-ops fix --profile web      # 修复：lockfile 对齐（--dry-run 预览 / --yes 免确认）
dsh-ops gate -- dsh web        # 启动门：预检通过才放行 dsh；失败自动归因
dsh-ops serve                  # 本地 Web 面板 http://127.0.0.1:8912（中英可切）
dsh-ops selftest               # 自检：内置故障样本跑全规则
```

`check` 输出每个 profile 一行总评 + 逐条 fatal 修复提示；`--json` 适合交给对话里的模型解读。

## 扫描规则（7 条，全部静态确定性）

| # | 规则 | 严重度 | 作用 |
|---|---|---|---|
| 1 | bundle 声明完整性 | fatal | 层列表里的包不可解析 / 无 `dsh.bundle.patch` / patch 文件缺失 |
| 2 | 依赖三方漂移 | fatal/自动修 | package.json 声明 vs pnpm-lock.yaml 锁定 vs 磁盘实际 |
| 3 | registry 版本对比 | warn | 经 `pnpm outdated`，有更新提示；advisory 不阻断 |
| 4 | peer 缺口/双实例 | 双实例 fatal | 声明了不存在的 peer；框架核心出现两份物理副本 |
| 5 | patch 行解析悬空 | fatal | 补丁引用的包（含子路径）不可解析 |
| 6 | 故障记忆 | info/warn | 自上次成功启动后变化的包清单（归因基础） |
| 7 | 结构完整性 | fatal/warn | 缺默认入口 / CJS 入口（Loader 需 ESM 命名导出）/ 缺 types/client |

真实生态验证：peer 声明悬空（作者引用官方未发布的包）已在多个第三方插件上检出。

## 命令与形态

| 面 | 说明 |
|---|---|
| `check` | 全 profile 一键体检（默认无网络），人类与模型双友好 |
| `scan` | 单 profile 深扫：规则 1-7 + 可选更新检查 |
| `fix` | 自动可修集：磁盘↔lockfile 对齐（`pnpm install --frozen-lockfile --force`）；plan→确认→执行→备份 |
| `gate` | 先阻断分级处置：fatal 先拦（自动修→放行；复杂→醒目指引；`--bypass` 逃生舱记录不静默）；dsh 启动秒退 → 归因差异包 → 交互禁用重试；headless 一次性 profile 退出码透传不归因 |
| `serve` | 本地 Web 面板：健康卡/结果列表/修复执行/插件行启用禁用（官方行保护）/故障时间线，zh/en 切换 |
| `selftest` | 引擎自检（6 内置故障样本），验证安装健康 |

退出码：`0` 通过（或 dsh 自身码）/ `1` 仍有 fatal / `2` 用法或 profile 缺失 / `3` gate 被需人工处置的 fatal 阻断 / `4-5` gate 归因相关。

## 配置（`$DSH_HOME/dsh-ops.yml`）

```yaml
rules:
  registry-version:
    enabled: false          # 关闭某规则
  peer-gap:
    severity: info          # 严重度只能降不能升
ignorePackages:
  - some-noisy-plugin
```

## 架构与自保

- **核心逻辑在 dsh 插件树之外**（独立 wrapper 进程 + 只读文件解析），dsh 崩溃不影响诊断，诊断失败不拦 dsh（fail-open 只适用于自身故障）。
- **自包含构建**：发布物为 tsup 单文件，运行时零 node_modules —— 没有依赖树就没有依赖树可漂。
- 规则消息单语英文（CLI/JSON/面板单一事实）；面板 UI 词典化中英切换。
- 写操作白名单 + 同源校验 + 自动备份；故障注入测试有 temp 沙箱路径断言。

## 开发

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test      # 48 单测（core 38 + cli 10；以实测为准）
node packages/cli/lib/index.js selftest  # 引擎自检
node scripts/e2e/scan-fix.e2e.mjs        # 离线 E2E（真实 pnpm 修复）
node scripts/e2e/gate.e2e.mjs            # gate 场景（放行/阻断/旁路/归因/headless）
node scripts/e2e/real-plugins.e2e.mjs    # 真实第三方插件沙箱（需网络）
```

发布：core 先 cli 后（pnpm publish，顺序见 CI release workflow）。

## 生态定位

不是第 N 个市场/管理器，而是启动生命周期防护：补全生态"变更时防护"缺失的**每次启动**环；后续版本将按自有架构吸收市场/启停/升级防护等功能，收敛为一体化插件管理增强。

## 参考

- [docs/architecture.md](docs/architecture.md) 拦截/修复/记忆机制说明
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 许可证：MIT（见 [LICENSE](LICENSE)）
