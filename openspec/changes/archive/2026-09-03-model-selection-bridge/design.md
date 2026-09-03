## Context

桥接层（`apps/omp-web`）已把 OMP 会话经 `omp --mode rpc` 桥进 DSH，模型选择信息目前有三处缺口（详见 proposal.md - Why）。上游依赖 `@deepseek-ai/dsh-*` 已升到 `0.1.2-alpha.3`（本地 `apps/omp-web/node_modules` 已装）。OMP 源码参考 `/tmp/oh-my-pi`（v18.0.11）。

关键既有事实：
- `ctx.agentDefaultModel`（`@deepseek-ai/dsh-agent-default-model`）是「default for new session」的 transport-independent 官方 owner，`currentSelection()` / `saveSelection()`。
- OMP resume 的模型恢复走 `getRestorableSessionModels`（`session-context.ts:86`），其 `models` record 由 `buildSessionContext` 从 `model_change` entries 构建：`role ?? "default"` 作 key、`model` 作 value（`session-context.ts:254-262`）；`role:"fallback"` 写进 `"fallback"` key。
- 桥接层现有 `lastModelCall`（`omp-store.ts:104`）读「最后一个 assistant message 的 provider/model」，与 OMP resume 实际恢复的模型在 fallback 后不一致（见 `docs/plans/omp-model-fallback-mechanism.md` §7）。

## Goals / Non-Goals

**Goals**
- default model 与 OMP TUI 语义一致，new session 用 `modelRoles.default`。
- resume 会话呈现的 last used model = OMP `--resume` 实际恢复的模型（剔除 fallback）。
- error 经 `turn/end` reason 分类投递，分类 code 与 DSH harness taxonomy 一致。

**Non-Goals**
- 不复刻 OMP 的 fallback（那是 config 静态能力，RPC 无注入口）。
- 不参与 DSH 原生 `llm-retry`/`llm-fallbacks`。
- 不改 OMP 核心源码、不改 dsh 上游源码。

## Decisions

### D1: default model 存 `ui_state` 表（key-value），非 sessions 新列

`default_model` 是 app-level singleton（一个值，全局），不是 per-session。复用 `ui_state` 表（`key`/`value`，已有 sort_mode 先例），key=`"default_model"`，value=JSON `{provider, model}`。备选：sessions 表加列——错误，那会每行冗余存同一全局值。

### D2: config.yml 扫描复用 reconcile 节奏 + mtime 检测

`modelRoles.default` 的读取不做独立定时器，挂在桥接层既有 persistent-storage 扫描（`reconcile.ts` 的 `scanOmpSessions` 同周期）上，用 config.yml 的 mtime 作为变更检测，变化时才更新 store 并触发 `ctx.agentDefaultModel.saveSelection()`。备选：每次 new session 读 config.yml——被 spec 排除（`default-model` 的「扫描节奏更新」requirement），且徒增 IO。

### D3: `lastRestorableModel` 精确模拟 OMP 的 models record + 恢复规则

替换 `lastModelCall`，提取逻辑改为：读 transcript 的 `model_change` entries（非 message），按时间顺序构建 `models` record（`role ?? "default"` → `model`），取 `lastRole` = 最后一个 `model_change` 的原始 role；恢复候选 = `lastRole ∈ {undefined, "default", "fallback"}` 时取 `models["default"]`，否则取 `models[lastRole] ?? models["default"]`。这是 `getRestorableSessionModels` 第一个候选的等价简化。无任何 `model_change` entry 时保留 legacy 推断（最后一个 assistant message）。备选：继续读「最后一个 assistant message」——实测证明 fallback 后取错（T2/T4）。

### D4: peerDependencies 锚定 `0.1.2-alpha.3`

`apps/omp-web/package.json` 的 `@deepseek-ai/dsh-*` peerDeps 从 `0.1.2-alpha.1` 升到 `0.1.2-alpha.3`，与本地 node_modules 一致。破坏性小（alpha 系列），锚定后避免写码与上游声明漂移。

## Risks / Trade-offs

- [lastRestorableModel 与 OMP 恢复规则漂移] → 以 `getRestorableSessionModels` 源码为准写单测，覆盖 T1/T2/T4 三类实测 transcript（无 fallback、有 fallback、set_model 后 fallback）。
- [`role` 缺失的历史 transcript] → `role ?? "default"` 与 OMP 一致处理；无 `model_change` 的 legacy transcript 走 assistant-message 推断兜底。
- [default model 同步时机] → mtime 检测变化才 `saveSelection`，避免每次扫描都写 settings 触发 UI 抖动。
- [alpha.3 上游破坏性] → 本地 node_modules 已装 alpha.3，实现即用 alpha.3 类型声明编译验证；若遇 API 变更，回退锚定 alpha.1 的 diff 记录在 tasks 备注。

## Migration Plan

1. 升 peerDeps 到 alpha.3，`npm install` 对齐（node_modules 已就位）。
2. store 加 `ui_state` 写入路径（表已存在，无需 schema 迁移）。
3. `lastModelCall` → `lastRestorableModel`，改 `reconcile.ts`/`replay.ts` 两处消费点。
4. 起真实 OMP RPC 会话验证：default=kimi 时 new session 模型 = kimi；fallback 后 resume 呈现 kimi（非 deepseek）。

回滚：`lastRestorableModel` 改回 `lastModelCall` 即可（纯函数替换，无 schema 变更）；default model 同步停用 = 删 `ui_state` 行。

## Open Questions

（无——影响 spec/approach/task 拆分的未知均已在本 design 中决策。）
