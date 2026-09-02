# OMP 模型选择 / fallback 机制分析 + 桥接层 gap（事故存档）

> 日期：2026-08-30
> 性质：OMP 源码（二进制逆向）关于「模型 ID resolution + retry fallback」机制的分析，
>       以及 dsh-omp-provider（桥接层）在这些机制上的 gap。
> 目标：作为桥接层，完全吃透底层逻辑，提供一个「逻辑 + UI 自洽」的行为。
> 事故摘要：Web UI 会话 `Fix omp profile dsh-alpha migration` 在 `kimi-plan/kimi-k3`
>       命中 403 `access_terminated_error`（5-hour usage limit）后**不 fallback 到 deepseek**，
>       而同一模型在 OMP TUI 下会 fallback。

---

## 1. 事故 Session 档案

| 字段 | 值 |
|---|---|
| Title | `Fix omp profile dsh-alpha migration` |
| Session ID | `01a04ebb-3d39-7287-9bb7-2880a1ff9c27` |
| 存储介质（JSONL） | `/home/u1/.omp/agent/sessions/-workspaces-dsh-omp/2026-08-29T18-14-48-889Z_01a04ebb-3d39-7287-9bb7-2880a1ff9c27.jsonl` |
| cwd | `/home/u1/workspaces/dsh-omp` |
| 事故时间（首个 403） | 2026-08-30 15:33:44 +0800 |
| 错误 | `errorStatus=403`, `errorId=17436672`, `type=access_terminated_error` |
| 错误信息 | `403 You've reached your 5-hour usage limit … kimi.com/membership/subscription?tab=quota` |
| 出错模型 | `provider=kimi-plan`, `model=kimi-k3`（直接 provider/model，非 role） |
| 事故时进程 | `omp --mode rpc --approval-mode yolo --resume <上述 jsonl>`（当时 pid 18088） |

### 1.1 关键 transcript 记录（行号 1320–1331，UTC 时间戳）

| 行 | UTC | type | 内容 |
|---|---|---|---|
| 1316 | 07:33:05 | user | `you were interrupted, now back. continue` |
| 1317 | 07:33:41 | assistant | kimi-k3 `stopReason=toolUse`（write `xd://browser` 开 mobile viewport） |
| 1319 | 07:33:43 | toolResult | `Opened tab "dsh"… http://127.0.0.1:3080/?token=…` |
| 1320 | 07:33:44 | assistant | kimi-k3 `stopReason=error` 403（**首个 403**，`content:[]`，零 token） |
| 1321 | 07:56:24 | model_change | `model=deepseek/deepseek-v4-pro`, `role=default`, `resolvedModelIsFallback=false` |
| 1322 | 07:56:30 | model_change | 同上（重复） |
| 1323 | 07:56:38 | session_exit | `reason=dispose`, `kind=normal` |
| 1324 | 07:56:48 | user | `.` |
| 1325 | 07:56:49 | assistant | kimi-k3 403（**第二个 403**，仍 kimi） |
| 1326–1331 | 08:00:24–08:01:40 | user/assistant | 反复 `.` → kimi-k3 403（×4） |

**关键观察**：`model_change` 已把 `default` role 切到 deepseek，但随后每次 completion **仍走 `kimi-plan/kimi-k3`** 并 403。deepseek 从未真正跑过一轮 completion。

### 1.2 模型使用史（该 transcript 内 `message` 记录的 provider/model 统计）

```
217 × provider=deepseek, model=deepseek-v4-pro   （会话早期）
184 × provider=kimi-plan, model=kimi-k3           （会话中段切换后）
  3 × model=deepseek/deepseek-v4-pro（全限定）
  2 × model=kimi-plan/kimi-k3（全限定）
```

- 会话从 deepseek 起始，中段切换到 kimi-k3。
- transcript 内**无** `/model` 斜杠命令记录 → 切换来自 Web UI 模型选择器（per-turn 注入 model），
  或 OMP 侧会话状态，而非斜杠命令。

---

## 2. OMP 模型 ID resolution 机制（源码级理解）

> 来源：`/home/u1/.local/bin/omp`（ELF, not stripped）字符串逆向；源码库 `can1357/oh-my-pi`
> （`packages/coding-agent/src/…`）。

### 2.1 三个层次：role / selector / direct model

OMP 的模型引用不是单一字符串，而是分层的：

- **role**：`config.yml` 的 `modelRoles` 键（`default`/`slow`/`smol`/`plan`/`advisor`/`vision`/`task`/`tiny`）。
  一个 role 映射到一个 model selector（如 `default → deepseek/deepseek-v4-pro:high`）。
- **model selector**：`provider/model[:variant]`（如 `deepseek/deepseek-v4-pro`、`kimi-plan/kimi-k3`），
  可含通配（`deepseek/*`）。
- **direct model**：裸 `provider/model`，不经过 role。

### 2.2 `configuredRole` 是 fallback 的关键标志位

模型 resolution 的关键逻辑（二进制反汇编，逻辑等价伪码）：

```js
// 解析 selector 字符串 p
const E = d0(p) !== undefined              // p 含 "/" → direct model（如 kimi-plan/kimi-k3）
        ? p
        : o?.getModelRole(C) !== undefined // p 是 role 名（如 default）→ 取 role 引用的 selector
          ? `${EL(C)}${R ? `:${R}` : ""}`
          : undefined;

if (E) {
  const v = vtt(S, o);          // ← configuredRole：仅当 E 解析到一个 ROLE 时才被赋非空
  return { model: O.model, selector: Js(O.model), configuredRole: v, ... };
}
// 否则走 direct-model 分支：configuredRole = undefined
```

**结论**：`configuredRole` 只有在 selector 解析到 **role** 时才被设置。裸 `provider/model`
（direct model）→ `configuredRole: undefined`。

### 2.3 fallback 门闩（gate）——`configuredRole && retry.modelFallback`

```js
if (kr.configuredPatterns && kr.configuredPatterns.length > 0) {
  const wy = kr.configuredPatterns.map(...);
  if (!kr.configuredRole || !r.get("retry.modelFallback")) {
    return wy;          // ← 无 fallback chains，直接返回
  }
  const Bg = { chains: dCt(r.get("retry.fallbackChains"),
    [...Object.keys(r.getModelRoles()), kr.configuredRole]) };
  // …
}
```

**结论**：模型切换式 fallback（`recovery=model`）必须同时满足：
1. `configuredRole` 非空（模型经 role 解析）；
2. `retry.modelFallback == true`（默认 true）。

两者缺一 → 无 fallback，错误成为终态（`stopReason=error`，`agent turn ended with provider error`）。

### 2.4 `retry.fallbackChains` 的 keying 与 default 语义

- 类型：`"a mapping of role names or model selectors to selector arrays"`。
- 当前配置：
  ```yaml
  retry:
    fallbackChains:
      default:
        - deepseek/deepseek-v4-pro
        - deepseek/*
    fallbackRevertPolicy: cooldown-expiry
  ```
- **`default` 是兜底链（universal fallback）**，不是「仅 default role 专属」。链解析逻辑：
  ```js
  const o = (s !== undefined ? n?.[s] : undefined) ?? n?.default;
  ```
  即 `fallbackChains[<role-or-selector>] ?? fallbackChains.default`。
  → kimi-k3 虽无专属 key，也会落到 `default → [deepseek/deepseek-v4-pro, deepseek/*]`。

### 2.5 `retry.*` 完整设置键与默认值

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `retry.enabled` | boolean | true | 重试总开关 |
| `retry.modelFallback` | boolean | **true** | 允许 retry 切换到配置的 fallback 模型 |
| `retry.fallbackChains` | mapping | （见上） | role/selector → selector 数组 |
| `retry.fallbackRevertPolicy` | string | — | 如 `cooldown-expiry` |
| `retry.baseDelayMs` / `retry.maxDelayMs` | number | — | 退避 |
| `retry.maxRetries` | number | — | 最大重试次数 |
| `retry.usageAwareFallback` | boolean | — | 用量感知 fallback |
| `retry.usageReservePct` / `retry.usageReservePolicy` | — | — | 用量保留策略 |

---

## 3. RPC direct call 机制

### 3.1 `omp --mode rpc` 是独立 mode

- 入口：`if (r === "rpc" || r === "rpc-ui") { … runRpcMode(…) }`。
- 源码模块：`packages/coding-agent/src/modes/rpc/rpc-mode.ts`（及 `rpc-input.ts` / `rpc-client.ts`
  / `rpc-subagents.ts` / `host-tools.ts` 等）。
- 二进制有明确的 headless-vs-interactive 区分：
  > "Headless hosts (print/RPC/ACP/eval/SDK) … interactive hosts keep the 5s timeout."
- **`runRpcMode` 不覆盖任何 `retry.*` 设置**（二进制内对 `runRpcMode` 函数体搜 retry/model/fallback
  无命中）。→ RPC 模式下 `retry.modelFallback` 保持默认 `true`，`retry.fallbackChains` 保持配置值。

### 3.2 唯一会关闭 fallback 的覆盖点是 subagent 路径，非主会话

二进制中唯一 `override("retry.modelFallback", false)` 出现在 `Xma(e)`：

```js
async function Xma(e) {
  const t = await e.host.settings.cloneForCwd(e.executionRoot);
  const s = `${e.model.provider}/${e.model.id}`;
  t.override("retry.modelFallback", false);
  t.override("retry.usageAwareFallback", false);
  t.override("retry.fallbackChains", {});
  t.override("task.agentModelOverrides", { ..., "security-reviewer": s });
  t.override("task.agentPrewalk", { ... });
  // …
}
```

这是 **security-reviewer subagent** 的 settings clone（`cloneForCwd`），不是主 RPC 会话。
→ 主会话的 no-fallback **不是** `retry.modelFallback` 被关掉，而是下面 §4 的 `configuredRole` 缺失。

### 3.3 RPC 控制面命令（rpc.ts 已封装）

`prompt` / `follow_up` / `steer` / `abort` / `new_session` / `get_state` / `get_messages` /
`get_session_stats` / `set_model`。

`set_model` 签名：

```ts
setModel(provider: string, modelId: string): Promise<RpcResponse> {
  return this.send({ type: "set_model", provider, modelId });
}
```

**注意**：`set_model` 传的是裸 `provider/model`，是 **direct model** 设置，不经过 role 解析，
因此**不会设置 `configuredRole`**。

---

## 4. 桥接层（dsh-omp-provider）gap

> 源码：`apps/omp-web/src/agent.ts`（`OmpAgent`）。

### 4.1 模型选择 waterfall —— tier-1 persisted header 永远压过 UI picker

```ts
#baseModelSelection(): { provider: string; model: string } {
  const persisted = this.session.requestHeader()?.config;      // TIER-1
  if (persisted?.provider && persisted?.model) return persisted; // 会话最后一次 model → kimi
  const service = this.ctx.get("agentDefaultModel");            // TIER-2（UI picker）
  const selection = service?.currentSelection();
  if (selection?.provider && selection?.model) return selection; // → deepseek（model_change 写这）
  return { provider: this.options.provider, model: this.options.model }; // TIER-3
}
```

- `requestHeader().config` 是「会话已记录的最后一次 model」，由 transcript 回放合成 →
  **resume 后会话保持它自己上次的 model（kimi-k3）**。
- UI picker 的 `model_change`（`role=default`）写的是 TIER-2 `agentDefaultModel`。
- **TIER-1 永远压过 TIER-2** → 有效模型仍是 kimi-k3。

### 4.2 `#syncModelSelection` 短路 —— `set_model` 永不触发

```ts
async #syncModelSelection(): Promise<void> {
  const target = await this.#effectiveModelSelection();  // = kimi-k3（TIER-1 胜出）
  const key = `${target.provider}/${target.model}`;
  if (key === this.#lastSyncedModel) return;
  const state = await this.#rpc.getState().catch(() => null);
  const ompModel = state?.model;
  if (ompModel?.provider === target.provider && ompModel?.id === target.model) {
    this.#lastSyncedModel = key;   // kimi == kimi → 短路，不 set_model
    return;
  }
  await this.#rpc.setModel(target.provider, target.model);  // 永不执行
  this.#lastSyncedModel = key;
}
```

- `#effectiveModelSelection()` 解析到 kimi-k3（TIER-1），而 OMP live model（`--resume` 恢复）也是 kimi-k3。
- 两者相等 → 短路，**`set_model` 从不被调用** → 用户「webUI 里点 default」这个动作**从未传到 OMP**。

### 4.3 两层 gap 叠加后的净效果

1. **模型停留在 kimi**：TIER-1 persisted header 压过 UI picker，`set_model` 短路 →
   用户在 Web UI 切 deepseek 无效，会话继续跑 kimi-k3。
2. **kimi 无法 fallback**：即使模型是 kimi，且 `fallbackChains.default` 覆盖 kimi、
   `retry.modelFallback=true`，但因模型是 direct model（无 `configuredRole`），
   fallback 门闩 `!configuredRole` 直接返回 → 403 成为终态。

**根因一句话**：桥接层用「direct model 恢复」而非「role 声明」来驱动模型，导致 OMP 侧
`configuredRole` 永远为空，fallback 机制对整个桥接会话失效。

---

## 5. 事故时序还原（完整）

| 时刻 +0800 | 事件 |
|---|---|
| 15:05 | `omp --mode rpc --resume …9c27.jsonl` 启动，恢复会话（模型 = kimi-k3，transcript 回放） |
| 15:33:05 | 用户发 `you were interrupted, now back. continue` |
| 15:33:41–43 | kimi-k3 调用 browser `write` 工具，返回 `Opened tab dsh…` |
| 15:33:44 | kimi-k3 续写时被 quota 门闩拒（403，零 token），turn 终态 error；**无 fallback** |
| 15:56:24/30 | Web UI 选 default（deepseek）→ `model_change(role=default)` 写 TIER-2 |
| 15:56:38 | `session_exit reason=dispose`（dsh 侧会话 dispose；**RPC 进程未死**） |
| 15:56:48 → 08:01:40 | 用户反复发 `.` → 每次仍 `kimi-plan/kimi-k3` 403（模型未变、fallback 未触发） |

---

## 6. 已确认事实 vs 推断

### 已确认（直接取证）

- [x] `retry.fallbackChains` 是「role name 或 model selector → selector 数组」的映射。
- [x] `default` 是兜底链（`n?.[s] ?? n?.default`），覆盖 kimi。
- [x] `retry.modelFallback` 默认 `true`；`retry.enabled` 默认 `true`。
- [x] fallback 门闩 = `configuredRole && retry.modelFallback`。
- [x] `configuredRole` 仅当 selector 解析到 **role** 时设置；direct model 无。
- [x] `runRpcMode` 不覆盖 `retry.*`；唯一 `override(retry.modelFallback, false)` 是 security-reviewer
      subagent 路径（`cloneForCwd`）。
- [x] 桥接层 TIER-1 `requestHeader().config`（persisted）压过 TIER-2 `agentDefaultModel`（UI picker）。
- [x] `#syncModelSelection` 在「target == OMP live model」时短路，不 `set_model`。
- [x] 事故 transcript 末尾：反复 `.` → 仍 kimi-k3 403，deepseek 从未跑 completion。
- [x] 同模型在 TUI 下 fallback 成功（`cordis_orchestra` workspace 记忆：
      `kind=auto-retry, recovery=model, note='rate-limited; switched model; retried'`，Aug 26 多次）。

### 推断（需 OMP 源码 `packages/coding-agent/src/…` 最终确认）

- [ ] RPC `--resume` 恢复的模型是否**必然**走 direct-model 分支（`configuredRole=undefined`），
      还是存在经 role 恢复的路径。
- [ ] 事故里 kimi 的 fallback 实际命中的是哪个 resolution 函数（`retryFallbackChainKeys` /
      `Yba` / `fCt` / `configuredPatterns` 分支）——二进制有多条 fallback 解析路径，未能
      100% 锁定单一入口。
- [ ] `set_model` 若传 `deepseek/deepseek-v4-pro`（恰好匹配 `default` role），OMP 是否会给它
      赋 `configuredRole="default"`（即 direct `set_model` 能否“撞上” role）。

---

## 7. 下一步 / 开放问题

1. **拉 `can1357/oh-my-pi` 源码**（`packages/coding-agent/src/`），定位：
   - fallback 门闩的精确函数与调用链；
   - RPC `--resume` 的模型恢复路径是否设 `configuredRole`；
   - `set_model` 是否/如何影响 `configuredRole`。
2. **桥接层修复方向（候选，待定）**：
   - a) 让 `#effectiveModelSelection()` 在 TIER-2（UI picker）变化时压过 TIER-1，或
      显式把 UI picker 的选择声明为 role；
   - b) 让 `#syncModelSelection` 用 role 语义（而非裸 `set_model(provider, id)`）驱动模型；
   - c) 或在 OMP 侧 fallback 门闩放宽（`configuredRole` 非空 OR direct model 也可走 `default` 链）。
3. **复现**：TUI 下用 direct model `kimi-plan/kimi-k3` 触发 403，确认 TUI 是否真的 fallback
   （排除「TUI fallback 是因为走 role 而非 direct」这一反例）。
