## Why

桥接层（`apps/omp-web`）对「模型选择」信息向 DSH Web UI 的传递存在三处不准确或缺失，导致 Web UI 无法如实呈现 OMP 会话的模型状态：default 模型未跟踪（new session 无法取到与 OMP TUI 一致的默认模型）、resume 会话的 last used model 在 fallback 后取错（`lastModelCall` 返回 fallback 模型，而 OMP `--resume` 实际恢复 primary）、error 投递入口虽已打通但契约未固化。源码级 + 实测（`docs/plans/omp-model-fallback-mechanism.md`）已确认 OMP 的 fallback 是 config 静态能力、桥接层无法经 RPC 复刻，正确策略是「诚实透明传递」而非「复刻 fallback」。锚定上游 DSH `0.1.2-alpha.3`。

## What Changes

- **default_model 追踪**：新增 store 字段跟踪 `~/.omp/agent/config.yml` 的 `modelRoles.default`，按桥接层既有 persistent-storage 扫描节奏更新，同步到 `ctx.agentDefaultModel.saveSelection()`；Web UI 经 `currentSelection()` 读取，作为 new session 的默认模型（与 OMP TUI 的「default for new session」语义一致）。
- **last_used_model_id 修正**：`lastModelCall` 改为 `lastRestorableModel`——从 transcript 的 `model_change` entries 提取最后一个非 `role:"fallback"`（非 EPHEMERAL）的模型，而非「最后一个 assistant message 的 model」。修正 `reconcile.ts`（store 填充）与 `replay.ts`（`request/header`）两处消费点，使 Web UI 呈现的「next prompt 模型」= OMP `--resume` 实际恢复的模型。
- **error 投递契约固化**：确认并固化 `turn/end` reason 为 per-turn error 投递入口——`ompFailure` 把 OMP `stopReason:"error"` 分类为 `AUTH`/`RATE_LIMIT`/`QUOTA`/`SERVER`/`UNKNOWN`。桥接层不参与 DSH 原生 `llm-retry`/`llm-fallbacks`（那是原生 AgentLoop 的 step 级机制；桥接层经 RPC 只能观测 per-turn 颗粒度，无法侵入式干预 OMP 运行时）。
- **依赖升级**：`apps/omp-web/package.json` peerDependencies 从 `0.1.2-alpha.1` 升至 `0.1.2-alpha.3`（本地 node_modules 已装 alpha.3）。

## Capabilities

### New Capabilities

- `model-selection-bridge/default-model`: `modelRoles.default` 的跟踪、存储与 `ctx.agentDefaultModel` 同步，作为 new session 的默认模型来源。
- `model-selection-bridge/session-model`: session 的 last used model 提取（剔除 fallback），供 Web UI 呈现 resume 会话的「next prompt 模型」。
- `model-selection-bridge/error-delivery`: OMP completion failure 到 `turn/end` reason 的投递契约与分类（AUTH/RATE_LIMIT/QUOTA/SERVER），不参与原生 retry/fallback。

### Modified Capabilities

（无——本仓库尚无既有 specs；omp-in-dsh 的 model-catalog/runtime 行为不在本 change 范围内。）

## Impact

- **新增代码**：`default_model` store 字段 + config.yml 扫描；`lastRestorableModel`（替换 `lastModelCall`）。
- **既有代码**：`omp-store.ts`（`lastModelCall` → `lastRestorableModel`）、`reconcile.ts`、`replay.ts`（两处消费点）、`store/schema.ts` + `store/db.ts`（字段/迁移）、`package.json`（peerDeps 升 alpha.3）。
- **依赖**：上游 DSH `0.1.2-alpha.3`（本地 node_modules 已装）。
- **风险面**：`lastRestorableModel` 的提取逻辑需精确对齐 OMP 的 `getRestorableSessionModels`（`role:"fallback"` 视为 EPHEMERAL 丢弃）；default_model 扫描的触发时机需与桥接层既有 persistent-storage 扫描节奏对齐，避免每次 new session 都读 config.yml。
