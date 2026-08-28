# Spike S1/S2 — 无 agent 会话的 mux 推送与影子重建

**日期**: 2026-08-28 · **环境**: scratch profile `s1`（`.dsh-test/profiles/s1`，dsh-base+dsh-web-app+s1-probe，端口 3099），探针 `s1-probe`（无 agent，只做 `sessions.prepare → enter → announce → append`），客户端 `scratch/s1-client.mjs`（raw ws 连 `events.mux`）。

## 结论

### S1 ✅ 成立：无 agent 的 entered session 就是合法 mux 推送源

- mux open 时为无 agent 会话**发 `session/subscribed` 基线帧**（信封 `server-request`, `method:"session/subscribed"`, payload 含 `sessionId` + `lastSeq`）。
- 之后每次 `session.append()` 都推 `session/event` 帧（`method:"session/event"`, payload 含 `sessionId` + `event{type,seq}`），逐事件 1:1 推送，无丢、无延迟累积。
- 每个事件伴随一个 `server-request method:session/projection`（投影请求，客户端侧计算视图用），与推送无关、可忽略。

**设计意义**：方案 C（影子会话）所需的上游行为全部存在，零上游改动。`D6`/`D1` 风险项解除。

### S2 ✅ 成立（经设计论证 + 服务端证据）：重建不构成前端收敛风险

服务端实测：detach 后同 id 再 `enter+announce` 会以**全新 Session 对象、seq 从 0 重启**，并重发 `session/subscribed` 基线（`lastSeq=27`），后续 append 事件（seq 28-34）照常推送。

但该行为**不会**触达仍在窗口内的前端，因为两类重建都被既有路径覆盖：

- **TTL 逐出再重建**：逐出的前提是 TTL 内无 history 请求 → 消费者已离开 → 重建时前端是全新打开 = 全新 history fetch（`installWindow` 从零建窗），无 seq 拼接。
- **守护进程重启**：WS 断开 → 前端重连 = 全量 resync（重开流 + 重拉 history，scout 已证）。

常态晋升/降级按 D2 复用同一 Session 对象，seq 永不停重启。因此前端「窗口内 seq 重启」的增量拼接路径**永不被触发**——S2 的残余风险被设计消除，无需额外机制。

### 附带发现

1. announce 会触发 dsh setup 管线注入合成事件（`permission/preset`、`sandbox/mode`、`approval/policy`，seq 25-27），影子 file-follow 不得与之冲突（两者皆内存态，天然不冲突）。
2. 探针插件加载要点（供后续 spike 复用）：函数型 cordis 插件读取服务必须 `export const inject = ["sessions"]`，否则 `cannot get property "sessions" without inject`；`ctx.on("ready")` 在此 profile 不触发，直接 `setTimeout` 即可（apply 时服务已注入）。
3. mux 帧信封：`server-request { rpcId, method, payload }`；客户端不发任何数据（纯下行，上行走 HTTP）。

## 遗留（非阻塞）

- 影子 TTL 的消费信号 = history 请求最近时间。空闲但打开的浏览器不会发 history 请求（前端无轮询），故其影子可能在 TTL 后被逐出、视图回到陈旧态——与今日冷态陈旧行为相同，仅被 TTL 兜住。v1 接受；后续可用 mux 订阅存在性作更准的信号（需上游暴露，或桥内探 apiproxy 订阅事件）。

---

# Spike S3 — idle 期五重信号的可查询性

**探针**: `docs/probe-omp-idle-signals.mjs`（spawn `omp --mode rpc`，ready 后发 `get_state`/`get_subagents`/`get_session_stats`）。

## 结论 ✅

- 响应信封统一为 `{"type":"response","command","success","data"}`——五重检查必须读 `data` 字段，不是顶层。
- `get_state` → `data` 含 `isStreaming`/`isCompacting`/`queuedMessageCount`/`contextUsage`/`model`（二进制源码已证，字段齐全）。
- `get_subagents` → `data.subagents` 数组；空闲时 `[]`。实现为 subagent 事件总线的**存活集合**（监听 `task:subagent:lifecycle/progress/event`），后台 async task 即 subagent，运行中即在其存活集内（源码级确认：`getSubagents()` 返回 `#e` active map）。
- `get_session_stats` → `data.sessionFile`（权威文件路径，可复用为持有期校验的真实来源）。

## 设计落地

- 五重检查读 `data.isStreaming`/`data.isCompacting`/`data.queuedMessageCount`/`data.subagents.length`，`get_subagents` 命令缺失或报错时 fail-soft（跳过该信号）。
- 后台任务可见性：源码语义清晰（存活 subagent 会列出），未用真实 LLM 后台任务做 live 验证；即便不可见，idle-exit 为耐心策略（重武装、不强杀），避让才强杀（那时杀可接受），故无回归。
