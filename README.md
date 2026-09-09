# dsh-plugin-ops

> DeepSeek Harness 插件运维（Plugin Operations）：启动前预检拦截、失败归因与修复、依赖树治理——核心是"医生"，长期收敛为插件管理增强一体化。

**状态：v0.1 核心已实现（规则 1/2/6 + gate 分级处置），尚未发布 npm；规划见 [docs/PLAN.md](docs/PLAN.md)。**

## 为什么做

DeepSeek Harness 插件生态自 2026-08 起爆发式增长，但 dsh 的插件加载模型是：静态补丁全部应用 → 插件行并发激活 → **任一插件失败即整树中止启动**。用户装几个插件后，"昨天还能开、今天启动失败"成为常态。

现有生态工具（6+ 个市场/管理器）全部只做**变更时防护**（安装/更新/框架升级时 canary 试运行）与运行期观测；**没有任何项目做每次启动前的整体预检与失败后的自动归因恢复**。

## 形态

单仓库、将来多产物：

1. **packages/cli（dsh-ops CLI wrapper）**：在 dsh 进程之前以独立子进程运行——`scan`（静态预检）/ `fix`（可回滚修复）/ `gate`（预检通过才放行 dsh 启动，失败后自动归因建议）。零 dsh 本体改动、零 API key 依赖。
2. **packages/core**：扫描规则、profile 读取、故障记忆、patch 层写入（共享引擎）。
3. **packages/bundle（会话内 Cordis bundle，规划）**：健康看板 + 可选 LLM 解读。

## 用法（源码运行）

```sh
pnpm install && pnpm run build

# 扫描 web profile（默认 DSH_HOME；可 --home 指定）
node packages/cli/lib/index.js scan --profile web

# 修复（lockfile 对齐等自动可修项；--dry-run 预览 / --yes 免确认）
node packages/cli/lib/index.js fix --profile web --dry-run

# 启动门：预检通过才放行 dsh；fatal 先阻断，能自动修的先修后放行
node packages/cli/lib/index.js gate --profile web -- dsh web
```

退出码：`0` 通过（或 dsh 自身退出码）/ `1` 仍有 fatal / `2` 用法或 profile 缺失 / `3` gate 被需人工处置的 fatal 阻断 / `4` 归因后用户放弃 / `5` 归因需 TTY。

## v0.1 已实现

- 规则 1：bundle 声明完整性（不可解析 / bundle-less / patch 文件缺失）
- 规则 2：依赖三方漂移（package.json 声明 vs pnpm-lock.yaml 锁定 vs 磁盘实际）
- 规则 6：故障记忆（JSONL 事件日志、per-profile 保留、成功基线快照与 diff）
- `fix`：自动可修集 = 磁盘↔lockfile 对齐（`pnpm install --frozen-lockfile --force`）
- `gate`：先阻断分级处置（自动修→放行；复杂→醒目提示+建议；`--bypass` 逃生舱记录不静默）；启动失败归因（差异包→行映射→交互禁用→重试）
- 自保：核心在插件树外、只读文件格式不 import dsh 运行时、未知 lockfile schema 保守降级、扫描自身故障不误拦启动（§7 第 3 层语义）
- 测试：core 单测 19 例 + 两个真实 E2E（`scripts/e2e/scan-fix.e2e.mjs`、`scripts/e2e/gate.e2e.mjs`，后者含真实 pnpm 安装）

## 自身健康（自举）

我们也是装在用户机上的代码。自身的健康由四层机制保证：架构自保（树外运行 + 自包含构建 + 只读文件格式）、升级自保（selftest + canary-then-switch + last-known-good）、运行自保（fail-open 只适用于自身故障，产品判定按先阻断策略）、生态自保（engines 支持矩阵 + CI 跟随官方 rc）。详见 PLAN §7。

## 参考

- 调研与决策记录：[docs/PLAN.md](docs/PLAN.md)
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
