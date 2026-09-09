# dsh-plugin-ops

> DeepSeek Harness 插件运维（Plugin Operations）：启动前预检拦截、失败归因与修复、依赖树治理——核心是"医生"，长期收敛为插件管理增强一体化。

**状态：规划中（WIP）** — 本仓库当前仅含计划文档与脚手架，尚未实现核心逻辑。

## 为什么做

DeepSeek Harness 插件生态自 2026-08 起爆发式增长，但 dsh 的插件加载模型是：静态补丁全部应用 → 插件行并发激活 → **任一插件失败即整树中止启动**。用户装几个插件后，"昨天还能开、今天启动失败"成为常态。

现有生态工具（6+ 个市场/管理器）全部只做**变更时防护**（安装/更新/框架升级时 canary 试运行）与运行期观测；**没有任何项目做每次启动前的整体预检与失败后的自动归因恢复**。详见 [docs/PLAN.md](docs/PLAN.md)。

## 形态（规划）

单仓库、将来多产物：

1. **dsh-plugin-ops（CLI wrapper）**：在 dsh 进程之前以独立子进程运行——`scan`（静态预检）/ `fix`（可回滚修复）/ `gate`（预检通过才放行 dsh 启动，失败后自动归因建议）。自包含构建、零 dsh 本体改动、零 API key 依赖。
2. **dsh-plugin-ops-core（共享核心）**：扫描规则、profile 读取、报告模型。
3. **dsh-plugin-ops-bundle（会话内 Cordis bundle，后置）**：健康看板 + 可选 LLM 解读。

## 自身健康（自举）

我们也是装在用户机上的代码。自身的健康由四层机制保证：架构自保（树外运行 + 自包含构建 + 只读文件格式）、升级自保（selftest + canary-then-switch + last-known-good）、运行自保（fail-open 默认 + 护栏）、生态自保（engines 支持矩阵 + CI 跟随官方 rc）。详见 PLAN §11。

## 参考

- 调研与决策记录：[docs/PLAN.md](docs/PLAN.md)
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
