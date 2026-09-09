# dsh-plugin-ops 架构

> 拦截与修复的机制说明。项目路线与开发记录为私有文档，不随本仓库公开；本文件自包含。

## 1. 总览：树外医生

dsh-ops 的全部核心逻辑运行在 **dsh 插件树之外**（独立 wrapper 进程 + serve 面板进程），只通过磁盘文件与 dsh 交互：

```
┌────────────────────────────────────────────────────────────────────┐
│                       用户机器（同一用户）                            │
│                                                                    │
│  dsh-ops（独立进程，不进 dsh 插件树）                 dsh 本体         │
│  ┌──────────────────────────────┐        ┌─────────────────────┐  │
│  │ CLI wrapper（dsh-ops）        │        │ dsh --profile web    │  │
│  │  check/scan/fix/gate/explain │        │   (cordis 插件树)     │  │
│  │   └─ core/ 引擎              │        │  ├─ bundle 层         │  │
│  │      ├─ 7 条静态规则          │        │  ├─ 第三方 bundle 层  │  │
│  │      ├─ fix 写路径（白名单）  │        │  └─ 用户 patch 层 ◄───│  │
│  │      └─ 故障记忆 (JSONL)      │        │   (cordis.patch.yml  │  │
│  │ serve 面板 ── 复用同一 core   │        │     = 启用/禁用闸)    │  │
│  │   (panel-api 处理器共享)      │        └─────────▲────────────┘  │
│  └──────────────┬───────────────┘                  │ exec（gate）   │
│                 │ 只读：package.json / pnpm-lock   │                │
│                 │      / node_modules / patch YAML │                │
│                 ▼                                  ▼                │
│   $DSH_HOME/profiles/<name>/   ◄── 双方唯一共享的磁盘面              │
└────────────────────────────────────────────────────────────────────┘
```

为什么必须在树外（架构限制的来源）：dsh 无"加载前插件代码窗口"——静态补丁先全部应用、插件行并发激活、**任一失败即整树中止**（vendor/loader 事务回滚 + fail-loud）。要"在坏插件激活前拦截"，只能站在 dsh 进程外；插件树内不存在可抢占的早期钩子。

## 2. 拦截（gate）：占住启动序列的看门人

```
dsh-ops gate -- dsh web
  │
  ├─ ① scan（7 规则，读文件，零网络，~100ms）
  │     └─ 无 fatal → 放行（exec）
  ├─ ② 有 fatal → 分级处置（cli/src/gate-cmd.ts）
  │     ├─ 自动可修集（规则 2 漂移）→ pnpm 修复 → 复扫 → 放行
  │     └─ 复杂 fatal（规则 1/5/7）→ 阻断（exit 3）+ 修复指引
  │           └─ --bypass 逃生舱：放行但记入故障记忆，不静默
  ├─ ③ exec dsh（stdio 透传、信号转发）
  │     └─ 成功判定：退出码 0 或存活 ≥ boot-threshold（默认 20s）
  │           → 记 success 快照（各包版本）
  └─ ④ 秒退且非零 → 启动失败 → 归因闭环
       记忆 diff（自上次成功谁变了）→ 行映射 → 交互禁用 → 重试
```

- 平台分级：长驻型 profile（web/sdk/acp/自定义）走完整归因；**headless 一次性任务型**秒退非零 = 任务失败而非启动失败 → 退出码透传，不做归因（`--no-attribution` 显式关闭）。
- 归因的"差异包 → 可禁用行"映射：从 bundle patch + 用户 patch 的可见行（`insert` 指令已展开）按包名/子路径匹配 row id。
- 拦截能力的边界：能提前判定的必炸项 = 声明缺失/解析悬空/结构 CJS 等静态面；插件运行时行为（activate 抛错）无法静态判定——那部分由"启动失败归因 + 建议禁用重试"兜底。

## 3. 修复：两个白名单写通道

写操作收敛到两个通道，全部 plan→确认→执行→校验→备份（可逆）：

| 通道 | 修什么 | 动作 | 为什么 |
|---|---|---|---|
| A lockfile 对齐 | 规则 2 漂移（磁盘 ≠ 锁定） | `pnpm install --frozen-lockfile --force`（固定参数 spawn） | pnpm 看 modules.yaml 认为已同步；force 强制按锁重提。不碰 lockfile 与声明本身 |
| B disabled 行 | 某插件行导致失败 | 用户补丁层结构化 push `{id, disabled: true}`（先备份） | 层序 = bundle 层→用户层，后层同 id 覆盖前层 → 禁用生效；HMR 约 1s 热生效、跨重启保留；删行即恢复 |

- 目标文件只有两个面：profile 的 `pnpm-lock` 约束下的 node_modules、用户 `cordis.patch.yml`。
- 保护：官方 `@deepseek-ai/*` 来源的行拒绝禁用（403）；文件损坏拒绝写；面板 API 同源校验 + loopback。
- 关键实现细节：官方模板补丁层是 `注释 + []` 空占位——追加必须**结构化 push 节点**（文本拼接会破坏文档）；写坏的 YAML 一律拒绝继续。

## 4. 故障记忆（闭环数据面）

`$DSH_HOME/cache/dsh-ops/memory.jsonl`，per-profile 追加事件：

```
attempt → success(版本快照) | failure(详情) | bypass | fix(动作)
```

消费方：gate 归因（成功基线 diff）、check 的"自上次成功变化的包"、serve 面板时间线。JSONL 追加 + 每 profile 截断 2000 条，损坏行跳过。

## 5. 面板与内嵌形态（同一引擎两个壳）

- `serve`：本地 http（127.0.0.1 默认），同进程直调 core，静态单页 assets。
- 内嵌 bundle（v0.3 B1）：cordis 插件 host 半边复用同一 `panel-api` 处理器挂 `ctx.webServer` prefix 路由 + client 半边注册 settings section；浏览器内同源 fetch。
- 两者共享 `core/panel-api` 的路由白名单——不做第二套逻辑。

## 6. 自保（为什么能信任看门人）

- 拦截者不 import dsh 任何运行时（只读文件格式解析）→ dsh 崩了它照常诊断。
- 它自身 crash/超时 → gate **放行 dsh 原样启动** + 显著警告（fail-open 仅适用于 dsh-ops 自身故障；scan 判定的插件 fatal 是产品功能，按先阻断处置）。
- 发布物为 tsup 单文件，运行时零 node_modules——没有依赖树就没有依赖树可漂。
- 测试注入有 temp 沙箱路径断言 + 原子替换（pnpm `.pnpm` 与全局 store 是 hardlink，截断写会污染 store）。
