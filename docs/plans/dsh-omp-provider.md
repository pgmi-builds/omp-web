# dsh-omp-provider — OMP 作为 Dash 插件接入（设计 + 开发计划）

> 阶段：设计 + Phase 0 实测完成 · 日期：2026-08-21
> 目标：把本机已部署的 OMP 接入 Dash，复用原生 Web UI；OMP 保留 TUI 作第二入口。
> 前置：`dash-research.md`、`cordis-research.md`、`omp-research.md`。
> 范围边界：跨 session 会话共享 / Collab / A2A 不在范围，从 OMP 的 RPC 层开始。


---

## 1. 定位与最终场景

- **产物**：`dsh-omp-provider`（Dash 插件），注册 `AgentFactory`，桥接同机 OMP；前端走 Dash 原生 Web UI。
- **架构**：专用 **OMP Profile**（不 fork、不做路由 factory）。`dsh --profile omp`，3081 端口，
  单模式无选择器——profile 本身就是选择器。
- **接口**：实测后定 → **RPC**（`omp --mode rpc`）。

---

## 2. 术语核实

| 概念 | 规范名 |
|---|---|
| "Agent Provider" | `AgentFactory`（`createAgent`/`resume`）+ `Agent` + `AgentRegistry`（`ctx.agents`） |
| 注册 | `ctx.agents.setFactory(factory)`（**单槽**，重复注册 throw） |
| 默认 loop | `dsh-agent-loop`（构造时 effect-scoped 调 `setFactory`） |
| ACP | Agent Client Protocol（zed+JetBrains，v1 stable） |

---

## 3. Phase 0 实测结果（已跑）

本机 `omp/17.4.0` + `dsh/0.1.0-rc.7`，分别驱动 `omp acp` 与 `omp --mode rpc` 各一轮
"List files"，抓全量事件流（ACP 479 events，RPC 218 lines；原始数据 `/tmp/{acp,rpc}-raw.json`）。

### 决定性结论：RPC 自带 turn/message/tool 边界，ACP 扁平

**RPC 事件直方图**：`agent_start · turn_start · message_start(role=user/assistant/toolResult)
· message_update(thinking/text/toolcall delta) · message_end · tool_execution_start/end ·
turn_end · agent_end`。

**ACP** 只有扁平 `session/update`（thought_chunk/tool_call/tool_call_update/message_chunk），
无边界。

### 映射对照（实测）

| OMP RPC | Dash `SessionEventMap` |
|---|---|
| `agent_start`/`agent_end` | session/agent 生命周期 |
| `turn_start`/`turn_end` | `step/start`/`step/end`（≈ 一次 model call + 工具执行） |
| `message_start`(role=user)/`message_end` | `user/message` |
| `message_start`(role=assistant)/`message_end` | `assistant/message`（`usage` 取自 `message.usage`） |
| `message_update`(text_delta) | `assistant/chunk` |
| `message_update`(thinking_delta) | thinking → `ignorable` 自定义 或 折叠 |
| `tool_execution_start`/`tool_execution_end` | `tool/call`/`tool/result` |
| `message_start`(role=toolResult)/`message_end` | `tool/result`（另一路径） |

**控制面**：RPC `prompt/steer/follow_up/abort/new_session/get_state/get_messages/set_model`
≈ 1:1 对 Dash `Agent.send/followup/steer/inject/cancel/whenIdle/resume`。

**接口结论：RPC 优先**（数据形状 + 控制面双 1:1）；ACP 仅在"抽象成通用异构 provider"时升级。

---

## 4. 架构：host-plane vs agent-plane（dsh-web-app 源码）

`dsh-web-app/cordis.patch.yml` 首行 *"the browser surface over the dsh-base layer"*。

- **host-plane（丢不掉）**：`dsh-session`、`dsh-agent`、`dsh-storage`、`dsh-system-prompt`、
  `dsh-shell-env`、webserver/api-gateway/client-connection/client-runtime。
- **agent-plane（web profile 已 `disabled: true`，挪 preset 后）**：tools/llm/sandbox/
  compaction/subagent-tools/plan-mode。

---

## 5. 持久化：OMP 单一源（agent transcript），Dash 保留 host-plane 元数据持久化（实测修正）

先分清四个包，避免"两份 session storage"的误解（dsh-base `cordis.patch.yml` 取证）：

| 包 | row id | 是什么 | 处置 |
|---|---|---|---|
| `dsh-session` | `session`（L27） | **内存** `ctx.sessions` 事件日志 | **留**：渲染基底，桥接层写入，非存储 |
| `dsh-storage` | web-app 插入（非 dsh-base） | **设置 KV**（主题/locale/model），`ctx.storage` | **留**：Dash 自有 UI 配置，与 OMP 无关，不桥 |
| `dsh-session-persistence` | —（抽象 seam） | `ctx.sessionPersistence` **接口** | 被 peerDep，无 provider 则不注册 |
| `dsh-session-persistence-jsonl` | `session-persistence-jsonl`（L98） | **JSONL 落盘 backend** | **留**：提供 `ctx.sessionPersistence`，被 message-feedback/workspace/session-projection-cache inject |
| `dsh-session-checkpoint-policy` | `session-checkpoint-policy`（L355） | 每 model request 前 checkpoint，inject `sessionPersistence` | **丢**：backend 没了它应一起下 |

**决议**：
- **留 `session-persistence-jsonl`**：3 个 host-plane 服务（message-feedback / workspace /
  session-projection-cache）inject `sessionPersistence`，`host-apiproxy` 经 `workspaceRegistry`
  传递依赖。**实测**：禁掉它 → boot 报 "4 entries did not activate"。
- **丢 `session-checkpoint-policy`**（可选 durability checkpoint，禁掉不伤 boot）。
- Dash jsonl 持久化的是 Dash 自己的 host-plane 元数据（feedback/workspace/projection），
  与 OMP 的 agent transcript 是两码事，不构成"两份 session storage"。
- OMP 默认持久化（`get_state` 返 `sessionFile`），是**唯一持久化源**。
- Dash 是 **ephemeral 渲染层**：`ctx.sessions` 纯内存，`resume` 走 RPC `get_messages` 回放。
- `session-query-sqlite` 已是 `:memory:` + `openAt: never`（L117），无需动。

---

## 6. 桥接层：profile 级换 loop（不是 preset）

- preset = agent-plane 组合，换不了 loop；loop = host-plane `AgentFactory` 单槽。
- OMP profile 的 `cordis.patch.yml`（**已验证的精确 row id**）：
  ```yaml
  - id: agent-loop
    disabled: true
  - id: session-checkpoint-policy
    disabled: true
  - insert:
      - id: omp-provider
        name: 'dsh-omp-provider'
  ```

---

## 7. 硬约束

1. `setFactory` 单槽 → 必须 `disabled: agent-loop`。
2. `KNOWN_SESSION_EVENT_TYPES` 只认仓内事件 → thinking 走 `ignorable` 自定义事件；
   `Session.append` 对 event 数据跑 `isJsonValue`。

---

## 8. 开发计划（详细）

### 决策已定
接口 RPC · 专用 OMP profile · OMP 单一持久化源 · profile 级换 loop。

### 8.0 依赖清单

**keep（host-plane）**：`dsh-agent`、`dsh-session`、`dsh-storage`+`-json`+`-domain`、
`dsh-system-prompt`、`dsh-shell-env`、`dsh-web-app`、`dsh-omp-provider`（自研）；
transitive：`cordis`、`cordis-plugin-loader`、`dsh-brand`、`dsh-llm`(types)、`dsh-scope`、
`dsh-invariants`、`schemastery`、`cosmokit`。

**drop（agent-plane + 持久化 + llm）**：`dsh-agent-loop`、`dsh-llm-deepseek`/`-pi-ai`、
`dsh-tools`+`tool-*`、`dsh-session-checkpoint-policy`、
`dsh-session-query-sqlite`（已 `:memory:`，无需动）、
`dsh-sandbox`/`bash-sandbox`/`fs-sandbox`、`dsh-subagent`+providers、`dsh-credentials`、
`dsh-telemetry`/`session-telemetry-*`、`dsh-compaction`/`compaction-basic`、approval/policy。

> 实现上不必逐包删：include `dsh-base`（web-app patch 已 disabled 大部分 agent-plane 行），
> OMP patch 只加 `disabled: agent-loop` + `disabled: session-checkpoint-policy` + insert provider。

### Phase 1 — Profile 骨架（1–2 天）
1. ✅ 已读 `dsh-base/cordis.patch.yml`，row id 已核实：`agent-loop`(L436)、
   `session-persistence-jsonl`(L98)、`session-checkpoint-policy`(L355)。
2. 建 `~/.dsh/profiles/omp/`：`package.json`（`bundles = [dsh-base, dsh-web-app, dsh-omp-provider]`）、
   `cordis.yml`、`cordis.patch.yml`（disabled 三行 + insert provider + webserver port 3081）。
3. `dsh --dump-config --profile omp` 验证合成树（agent-plane 全 disabled）。
4. `dsh-omp-provider` 包骨架（`package.json` + `src/index.ts`，空 `Service` 先 `setFactory`
   抛 not-implemented）。
5. systemd unit（`ExecStart=dsh --profile omp`，3081）。
- **验收**：`dsh --profile omp` boot，3081 Web UI 起来，agent-plane 已**桥接**（model 选择器 =
  OMP 模型目录；preset 选择器清空；tool 卡片 = OMP tool 执行事件），host-plane 未缺。

> **2026-08-22 redo（方向修正）**：原验收「无 model 选择器/tool 卡片」是错的——早期只禁了
> `agent-loop`，`llm-deepseek/llm-pi-ai/agent-presets/tools` 全留着，导致 3081 与原生 dsh（3080）
> 长相一模一样、无法区分（用户实测：5 个 preset 模式全在、原生会话串库）。redo 改为**桥接**
> 而非摘除，已验收通过（verifier PHASE1-REDO: ACCEPT，6/6）：
> - **model 选择器**：`OmpLlmAdapter` 注册到 `ctx.llm`（11 provider、845 模型，源自
>   `~/.omp/agent/models.db`+`models.yml`；`get_available_models` 超 1MiB RPC 帧限制故不可用）；
>   `session.selectModel` → `OmpAgent.#syncModelSelection()` 在 turn 前 `set_model`（带缓存）。
> - **preset 选择器**：`agent-presets` 整体禁用（上游 composeProfile 强制注入 shipped roots，
>   无法缩减为单条）→ roster 空、`session.create` 无 preset 仍可用。
> - **tool 卡片**：本就已桥（`tool_execution_start/end` → `tool/call`+`tool/result` 事件），
>   默认渲染；OMP 无 tool-list RPC 故不伪造 schema。
> - 关键架构事实：浏览器 UI 从不直读 `ctx.llm/ctx.tools`，全部经 `dsh-host-apiproxy` 这个
>   单一 seam（`session.models/selectModel`、`agentPreset.list`）。

> **2026-08-23 会话串库修复**（verifier ISOLATION: ACCEPT，6/6）：OMP profile 与原生 dsh 原本共享
> `~/.dsh/sessions/` 持久化根 → 3081 的 session.list 混入原生会话（base/dashr/agent-harness/tmp），
> 用户点开 dashr 会话还触发 OMP 跨工作区恢复（回 "dashr" 上下文）。修复：`session-persistence-jsonl`
> 的 `root` 覆盖到 `~/.dsh/profiles/omp/sessions/`（`dshHomePath`），并迁移 40 个 dsh-omp 会话；
> `src/index.ts` resume 加 fail-closed 守卫（id 不在本 profile 隔离持久化 → throw，阻断跨工作区恢复）；
> 清理 omp-sessions.json 的外来映射（备份 .bak）。结果：3081 只列 47 个自有会话、3080 无反向泄漏
> （ID 级 0 重叠）、hihi 回通用问候。遗留（非阻塞）：API `session.create({})` 无 cwd 时默认落到
> `~/.dsh` 桶（仅标签问题，仍隔离）。

### Phase 2 — RPC 桥核心（3–5 天）
1. RPC 客户端：spawn `omp --mode rpc`，`ready` 握手，命令封装（prompt/steer/follow_up/
   abort/new_session/get_state/get_messages）。
2. `AgentFactory.createAgent`：spawn omp，包 `Agent` shim（`id`=sessionId、`session`=
   新建 `Session`、`ctx`=scoped）。
3. `Agent` 方法映射：`send→prompt`、`followup→follow_up`、`steer/inject→steer`、
   `cancel→abort`、`whenIdle→get_state` 轮询 `isStreaming`、`resume→get_messages` 回放。
4. SessionEventMap 映射（§3 表落地）：RPC 流 → `session.append`；**Dash `turn`（user→final）
   跨多个 OMP turn，需粗粒度合成**；thinking → `ignorable`。
- **验收**：一个 OMP turn 在 Web UI 对话面 + trajectory 完整渲染。

> **2026-08-22 定稿（含当日返工）**：multi-turn 走 **pass-through**——忙时 follow-up 直接转发 OMP
> 专用 `follow_up` 命令（`docs/smoke-multiturn.mjs` 6/6 验证）。关键事实：`resumeIfIdle` 是 API 调用
> 选项而非配置，OMP 对两条 RPC 命令**写死相反语义**——`prompt`+`streamingBehavior:"followUp"` 为
> false（只投递不生成，昨晚根因即此路径），`follow_up` 命令在连接层强制 true（排队→当前 turn 结束
> →**自动生成下一轮**，`docs/probe-omp-followup.mjs` 实证）。桥接层职责仅剩：idle→本地开 turn+`prompt`；
> busy→转发 `follow_up`（忙判定用本地态 `#turnOpen||#streaming`，防 `agent_start` 滞后 ~2s 的冷启动
> 空窗）；OMP echo `message_start(role=user)` 到达时关旧 turn 开新 turn。曾实现的桥接侧缓冲
> （#followupBuffer/#replayFollowups）已删除——桥接层不做运行时行为介入。
> 审批卡（`approval/asked`）已进 Dash 事件流；无头测试需 `OMP_APPROVAL_MODE=yolo`（审批应答需常连接，
> 纯 HTTP 收不到服务端请求帧）。
>
> **接口裁决（2026-08-22，与上游对缝后）**：Dash Web UI = HTTP POST `/api/*`（命令）+ WS ×2
> （`/api/events.mux` `.host`，事件下行）；逐条缝隙对接结论——事件流=立即 pass-through（现状）；
> **排队输入可见/可编辑（session/queue+updateQueue）不做**：UI 有 facility、OMP 无对端 API，按
> "能衔接就衔接、衔接不上不做"原则放弃（用户 education 代替）；**重连恢复尽力而为**：上游
> `get_messages` 能恢复什么就恢复什么，桥接不额外持久化（未投递消息接受丢失）。模型选择
> （set_model/get_available_models）、token 面板（get_session_stats）、fork/分支为后续可衔接项。

### Phase 3 — resume/持久化（2–3 天）
1. 已丢 `session-persistence-jsonl` + `session-checkpoint-policy`（Phase 1）。
2. `resume`：`get_messages` 回放 OMP sessionFile → 重建 SessionEvent log → `Agent.resume`。
3. session 列表：查 RPC 有无 list 命令；无则扫 OMP session 目录，或 fork UI 的 session 列表。
- **验收**：重启 Dash 后从 OMP 恢复历史 session。


> **2026-08-22 验收通过**（Ralph：doer 19m31s → verifier ACCEPT → 主验收修补）。实现要点：冷 resume
> 走 Dash 自带 `sessionPersistence.prepare(id)`（有 Dash 持久日志时逐字恢复，镜像 dsh-agent-loop；
> OMP `get_messages` 回放仅作无持久化 fallback）；`setupAndPublish` 失败全回滚 + finally 无条件释放
> preparation 预留。关键接口事实：**listing 根本不经过插件**（AgentFactory 契约只有
> createAgent/resume；session.list = 活跃 ∪ persistence 冷列表，冷 history 直接由持久层服务）；
> Dash 自己持久化渲染事件日志（~/.dsh/sessions/--cwd--/<id>/session.jsonl.zstd），插件只存
> ~/.dsh/omp-sessions.json 的 id↔OMP-session 映射。冒烟：docs/smoke-resume.mjs（两阶段 12 断言，
> 含二次重启稳定性）。

### Phase 4 — 权限（2 天）
1. 验证 `--mode rpc-ui` 的审批面（卡片/选择器）。
2. 映射到 Dash approval/policy 缝隙。
- **验收**：破坏性工具在 Web UI 弹审批。

### Phase 5 — 收尾（2 天）
- teardown：`AgentHandle.dispose()` 逆序 kill omp 子进程，防孤儿。
- `whenIdle`/`runMaintenance` 语义。
- Web UI 缺口源码定制（若 `client-ui-*` inject `ctx.llm`/`ctx.tools` 导致 INACTIVE）。

---

## 9. 关键未知 / 风险

| 风险 | 影响 | 触发点 |
|---|---|---|
| RPC 有无 `list_sessions` 命令 | resume 的 session 列表 | Phase 3 |
| `client-ui-*` 隐式依赖 `ctx.llm/tools` | 丢 agent-plane 后 UI 部分 INACTIVE → 源码定制 | Phase 1 dump-config + boot |
| Dash `turn`（user→final）粗粒度合成 | 最可能返工 | Phase 2 |
| thinking 在 UI 是否渲染 | `ignorable` 事件是否够 | Phase 2 |
| RPC 权限面（`--mode rpc-ui`）是否够 Web UI | 审批缝合 | Phase 4 |
| dsh rc.7 API 不稳 | `AgentFactory`/`SessionEventMap` 会变 | 全期（锁 rc、薄适配） |

---

## 10. 来源与双向 link

- `dash-research.md`、`cordis-research.md`、`omp-research.md`。
- 源码：`dsh-agent/lib/types/{index,runtime-types}.d.ts`、`dsh-session/lib/types/types.d.ts`、
  `dsh-web-app/{package.json,cordis.patch.yml}`、`dsh-agent-presets/lib/types/*.d.ts`。
- 实测：`/tmp/acp-raw.json`、`/tmp/rpc-raw.json`。
- 协议：pi-mono `packages/coding-agent/docs/rpc.md`、agentclientprotocol.com。
