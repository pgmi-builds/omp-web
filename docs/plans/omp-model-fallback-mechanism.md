# OMP 模型 fallback 机制（源码级分析 + 实测）

> 日期：2026-09-01
> 源码：`can1357/oh-my-pi` @ `v18.0.11`（clone 于 `/tmp/oh-my-pi`，tag commit `b8ce33a5`）
> 实测：`omp --mode rpc --approval-mode yolo`，stdio NDJSON 事件 + session JSONL transcript 双证据交叉验证
> 关系：**推翻** `docs/plans/omp-model-resolution-fallback-gap.md` 的「configuredRole 门闩」前提

---

## 0. 结论速览

1. **fallback 门闩 = `retry.enabled && retry.modelFallback`**，与 `configuredRole` 无关。
2. **fallback 触发 = 当前模型被 `retry.fallbackChains` 覆盖**（exact key / provider wildcard / role-primary / default 兜底）。与 RPC/TUI、direct/role 都无关。
3. **`fallbackChains.default` 实际 = 「default role 的 primary 模型的专属链」**，不是 universal last resort（被「default role 必有 primary」短路）。
4. **RPC 面无法指定 role、无法注入 fallback chain**。
5. **resume 恢复 primary 模型**，fallback 是 EPHEMERAL（`role="fallback"`），resume 时被丢弃。

---

## 1. 模型引用三层（role / selector / direct）

- **role**：`config.yml` 的 `modelRoles` 键（`default`/`slow`/`smol`/`plan`/`advisor`/`vision`/`task`/`tiny`），映射到 selector。
- **model selector**：`provider/model[:variant]`（如 `deepseek/deepseek-v4-pro:high`、`kimi-plan/kimi-k3`）。
- **direct model**：裸 `provider/model`。

---

## 2. 两套 fallback 机制（关键区分）

旧文档把两套混为一谈，导致 `configuredRole` 误读。

### 2.1 启动期 initial fallback（`sdk.ts`）

`sdk.ts:2337-2382`：仅当 CLI `--model <role>`（或 deferred pattern）解析到 **role alias** 时，`resolved.configuredRole` 非空，才预计算 `InitialRetryFallbackState`。

```ts
// sdk.ts:2345
if (!resolved.configuredRole || !settings.get("retry.modelFallback")) {
    return primaryPatterns;   // ← configuredRole 门闩只在这里
}
```

**这只影响「启动时用 role 选模型」的 initial fallback 预计算，与运行期 turn 级 fallback 无关。**

### 2.2 运行期 turn 级 fallback（`session/turn-recovery.ts`）

这才是出错时真正切模型的逻辑。入口 `#handleRetryableError`（`turn-recovery.ts:2052`）→ `#tryRetryModelFallback`（`:1775`）。

```ts
// turn-recovery.ts:1775-1823
async #tryRetryModelFallback(currentSelector, failedMessage, options) {
    for (const role of this.retryFallbackChainKeys(currentSelector)) {   // ← 当前 selector 查 chain key
        for (const selector of this.findRetryFallbackCandidates(role, currentSelector)) {
            // resolve → find → getApiKey → applyRetryFallbackCandidate
        }
    }
    return false;
}
```

---

## 3. fallback 门闩（真实）

只有两个条件，出现在三处：

```ts
// turn-recovery.ts:1888（isHardErrorFallbackEligible）
if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
// turn-recovery.ts:2065（#handleRetryableError）
if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
// turn-recovery.ts:2188-2199（#handleRetryableError 内）
if (allowModelFallback && retrySettings.modelFallback && !thinkingLoop && …) {
    switchedModel = await this.#tryRetryModelFallback(currentSelector, message, …);
}
```

**❌ 无 `configuredRole`，❌ 不区分 direct/role。**

---

## 4. fallback chain keying：`resolveRetryFallbackChainKey` 四步

`session/retry-fallback-chains.ts:268-360`，按特异性：

```
1. exact model key        fallbackChains["kimi-plan/kimi-k3"]      ← 命中即用
2. provider wildcard      fallbackChains["kimi-plan/*"]            ← 最长前缀优先
3. role key 匹配          某 role 的 assigned model == 当前模型      ← roleHint 优先，default 优先
4. default 兜底           仅当 getModelRole("default") 无 primary   ← 见 §5
   ↓ 全不中 → undefined → 无候选 → 不 fallback
```

配套：
- `#liveRetryRoleHint`（`turn-recovery.ts:1504-1511`）：`getModelRole(role)` 解析出的模型 == 当前模型时才返回 role，否则 undefined。
- `expandDefaultRetryFallbackChains`（`retry-fallback-chains.ts:136-147`）：把 default chain 复制给每个无专属 chain 的 role。

---

## 5. `fallbackChains.default` 的双身份（关键陷阱）

`default` 这个 key 复用两个机制，`getRetryFallbackPrimarySelector`（`retry-fallback-chains.ts:240-248`）决定：

```ts
function getRetryFallbackPrimarySelector(context, chainKey) {
    if (isRetryFallbackWildcardKey(chainKey)) return undefined;
    if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, …);
    const configuredSelector = context.getModelRole(chainKey);   // "default" 走这里
    return configuredSelector ? parseRetryFallbackSelector(configuredSelector, …) : undefined;
}
```

步骤 4（`retry-fallback-chains.ts:350-358`）：

```ts
// 4. The default chain, when default has no explicit role primary.
if (Array.isArray(defaultChain) && defaultChain.length > 0 &&
    getRetryFallbackPrimarySelector(context, "default") === undefined) {
    return "default";
}
```

**结论**：
- 步骤 3：`default` 当 **role key**，命中条件 = `modelRoles.default` 的 primary == 当前模型。
- 步骤 4：`default` 当 **universal last resort**，但条件 `getModelRole("default") === undefined` 在「default role 必有 primary」下**永远不满足**。

→ **实际行为：`fallbackChains.default` 只覆盖「default role 的 primary 模型」，不覆盖游离 designated model。**

两种解释的裁决（用户提问）：
- 解释 i「RPC role 恒=default，fallback 沿 default」→ **证伪**（T4 实测：default=glm 时 set_model(kimi) 不 fallback）。
- 解释 ii「default = global last resort」→ **是设计意图（步骤 4 注释），但实现被短路**。
- **最贴代码 = 第三种：default 链 = default role 专属链。**

---

## 6. RPC 面（无 role、无 fallback 注入）

- `set_model`（`rpc-types.ts:52`）只有 `provider + modelId`，无 role。
- `prompt`（`rpc-mode.ts:1020-1073`）只读 `message/images/streamingBehavior`，无 role。
- 命令全集（`rpc-types.ts:28-93`）**无任何 settings/fallback 读写命令**，只有 `set_model`/`cycle_model`/`get_available_models`/`set_auto_retry`/`abort_retry`。
- 实测：`set_model`/`prompt` 带 `role:"default"` 字段 → **静默忽略**（response ok=true）。

但 `set_model` 内部 `session.setModel(model)` 默认 `role="default"`（`agent-session.ts:7398` → `model-controls.ts:215` → `appendModelChange(…, "default")`）。所以：

> **`set_model` 天然等价于「把模型记为 default role」**，但 fallback 是否沿 default 走，取决于 `modelRoles.default` 是否 == 该模型（§4 步骤 3 / §5）。

---

## 7. resume 恢复 primary（fallback 是 EPHEMERAL）

- `EPHEMERAL_MODEL_CHANGE_ROLE = "fallback"`（`session-entries.ts:26`）。
- fallback 切模型：`appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE, true)`（`turn-recovery.ts:1751`）→ transcript 里 `{"role":"fallback","resolvedModelIsFallback":true}`。
- `appendModelChange` 只 `#recordEntry`，**不改 session 的 models record**（`session-manager.ts:2331-2341`）。
- resume 恢复：`getRestorableSessionModels`（`session-context.ts:86-103`）：

```ts
const defaultModel = models.default;
if (!lastModelChangeRole || lastModelChangeRole === "default" ||
    lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE) {   // "fallback" 走这里
    return defaultModel ? [defaultModel] : [];               // 回退 primary
}
```

→ **resume 时 fallback 的临时切换被丢弃，恢复 `models.default`（primary）。**

---

## 8. 实测案例（stdio + transcript 双证据）

配置演变：`modelRoles.default` 依次为 `kimi-plan/kimi-k3:high` → `zai/glm-4.7:high` → `deepseek/deepseek-v4-flash:high`；`retry.fallbackChains.default = [deepseek/deepseek-v4-pro, deepseek/*]` 全程不变。kimi 全程命中 weekly 7-day usage limit（403）。

### T1 — default=kimi，不传 model/role → **fallback ✅**

stdio：
```
retry_fallback_applied {from:"kimi-plan/kimi-k3:high", to:"deepseek/deepseek-v4-pro", role:"default"}
auto_retry_start {attempt:1, errorMessage:"403 … weekly (7-day) usage limit"}
agent_end {provider:"deepseek", model:"deepseek-v4-pro", text:"OK"}
auto_retry_end {success:true, note:"rate-limited; switched model; retried"}
```

transcript `model_change`：
```json
{"model":"kimi-plan/kimi-k3","resolvedModelIsFallback":false}                      // 初始（无 role 字段）
{"model":"deepseek/deepseek-v4-pro","role":"fallback","resolvedModelIsFallback":true}  // fallback
```

### T2 — default=kimi，`set_model(kimi)` → **fallback ✅**

transcript `model_change`：
```json
{"model":"kimi-plan/kimi-k3","resolvedModelIsFallback":false}                       // 初始
{"model":"kimi-plan/kimi-k3","role":"default","resolvedModelIsFallback":false}      // set_model（role=default）
{"model":"deepseek/deepseek-v4-pro","role":"fallback","resolvedModelIsFallback":true} // fallback
```

### T3 — default=kimi，`set_model`+`prompt` 带 `role:"default"` 字段 → **字段忽略，fallback ✅**

`set_model`/`prompt` response 均 ok=true（字段被静默忽略）。行为同 T1/T2。

### T4 — default=glm，`set_model(kimi)` → **不 fallback ❌（精确复现事故）**

stdio：
```
auto_retry_end {success:false, finalError:"… 1800000ms wait > retry.maxDelayMs(300000ms) … 403 weekly limit"}
agent_end {provider:"kimi-plan", model:"kimi-k3", content:[], 零 token 终态 error}
```

transcript `model_change`（**无 deepseek 行**）：
```json
{"model":"zai/glm-4.7","resolvedModelIsFallback":false}                    // 初始
{"model":"kimi-plan/kimi-k3","role":"default","resolvedModelIsFallback":false}  // set_model
```

### 对照结论

| | T2（default=kimi） | T4（default=glm） |
|---|---|---|
| 初始 model_change | kimi, 无 role | glm, 无 role |
| set_model | kimi, role=default | kimi, role=default |
| fallback | **deepseek, role=fallback, isFallback=true** | **（无）** |
| message 尾 | kimi(error 403) → deepseek(stop) | kimi(error 403) → 终态 |

**唯一变量 = `modelRoles.default`，`set_model(kimi)` 动作完全相同，结果相反。** 直接证伪「RPC role 恒=default 且 fallback 沿 default」。

### Resume 测试 — default=deepseek-flash，resume T1~T4 → **全部恢复 kimi，403，不 fallback**

```
T1: restored=kimi-plan/kimi-k3  → auto_retry_end false, agent_end kimi stop=error
T2: restored=kimi-plan/kimi-k3  → 同上
T3: restored=kimi-plan/kimi-k3  → 同上
T4: restored=kimi-plan/kimi-k3  → 同上
```

四个 session（含 T1/T2/T3 已 fallback 到 deepseek 的）resume 后**都恢复 primary kimi**（非 fallback 的 deepseek），然后 403 且不 fallback（kimi 游离，default=deepseek-flash 不是 kimi）。机制见 §7。

---

## 9. 桥接层启示

1. **fallback 是 OMP 的 config 静态能力**，桥接层无法通过 RPC 动态注入 fallback chain 或指定 role。
2. 要让「用户选的任意 designated model」能 fallback，只有两条 config 路：
   - a) 给它配 exact/wildcard key：`fallbackChains["kimi-plan/*"] = [deepseek/...]`
   - b) 让它成为某 role 的 primary：`modelRoles.<role> = kimi-plan/kimi-k3`
3. **`fallbackChains.default` 兜底链救不了游离模型。**
4. 唯一入口 = 「启动 OMP 前改 profile config.yml」——静态、全局污染、每次切模型要改 YAML + 重启 RPC 进程，代价重。
5. 产品决策前置：**多模型 Web UI 里，静默 fallback 要不要？**
   - 要 → config 注入（重、脏、违背多模型选择器语义）。
   - 不要 → 桥只做 GAP A（显式切换生效 + 403 干净暴露），轻、纯 in-repo。

---

## 10. 后续测试（持续补充）

_（待续）_
