# SDK 数据面评估：app 层 + session 层数据段清单（RPC 对照）

- 日期：2026-09-09
- 性质：`docs/plans/sdk-direction.md` 的 M2 前置评估（文档级测算，未实测）
- 依据：`docs/reference/pi-and-omp/omp/sdk.md`（2026-09-06 快照）+ `pi/sdk.md`（pi.dev 同期快照）+ settings / providers / sessions / session-format / secrets 页
- ⚠️ 总前提：**omp SDK（`@oh-my-pi/pi-coding-agent`，Bun-only）是 pi SDK 的镜像，但两侧文档展示的导出面不一致**（pi 文档明显更宽）。下表标 [pi] 的条目来自 pi 文档，在 omp 包中的实际存在与形状必须以 M2 spike 实测为准——这正是 `sdk-direction.md` §3 已列的风险。

---

## 一、app 层（session 之外，OMP 整个 app 的配置与存储）

RPC 的思维模型里没有这一层：RPC 交互对象是一个 agent session，app 层我们目前只能靠 CLI 子进程（`omp models --json`、`omp config get/set`）侧门补齐。SDK 的对象模型天然从 app 根出发。

| # | 数据段 | SDK 通道 | RPC/CLI 桥现状 |
|---|---|---|---|
| A1 | **配置全量**（settings 树、modelRoles、compaction、tools 策略…全部 key） | `SettingsManager.create(cwd, agentDir?)` 读全局+项目合并结果；`applyOverrides()` / `Settings.isolated()`；setter 异步落盘 + `flush()` 持久化边界 [pi]；omp 侧 `Settings` 同名导出 | `omp config get/set`（整对象 roundtrip，无监听） |
| A2 | **凭据与登录态** | `discoverAuthStorage()`；`ModelRuntime.getProviders()` + `checkAuth(id)` 逐 provider 查状态；`login()/logout()/setRuntimeApiKey()` 可编程驱动登录流 [pi]；自定义 `authPath`/`CredentialStore` 注入 | ❌ 只能间接从 `omp models` 的 available 集合反推 |
| A3 | **模型注册表** | `new ModelRegistry(authStorage)` + `refresh()` + `getAvailable()`；网络刷新节流/超时/abort 可控；`resolveCliModel()` 对齐 CLI 语义 [pi] | `omp models --json` 子进程（~1.7s/次） |
| A4 | **资源目录**（extensions / skills / prompts(slash commands) / themes / context files(AGENTS.md)） | `DefaultResourceLoader`：`getExtensions/getSkills/getPrompts/getThemes/getAgentsFiles()` 枚举；`skillsOverride/promptsOverride/agentsFilesOverride` 逐段替换 [pi] | ❌ 完全不可见 |
| A5 | **session 存储索引**（全 profile 的会话库） | `SessionManager.list(cwd)` / `listAll(cwd)` / `open(path)` / `continueRecent` / fork helpers；tree API（`getEntries/getTree/getPath/getEntry/labels`） | 仅 `get_messages`/`resume` 作用于单会话 |
| A6 | **会话工件与 blob store** | SDK 即写者本人：JSONL journal + `~/.omp/agent/blobs/<sha256>` 图像外置（session-format 页） | 只读文件系统侧信道，无一致性保证 |
| A7 | **app 生命周期**（多 session 替换：new/resume/fork/import） | `AgentSessionRuntime.newSession()/switchSession()/fork()/importFromJsonl()`；每代可换 `sessionManager`；`AgentRegistry` 控制并发 Main 身份 [pi] | ❌ 桥自己在外面拼 |
| A8 | **运行模式复用** | `InteractiveMode` / `runPrintMode` / `runRpcMode` 就是官方 CLI 三模式的导出构件 [pi] | 我们手工拼的等价物 |

**A 层的关键语义**：SDK 拿到的 app 层是「你拥有并运行这个 app」的第一手 API——配置、凭据、注册表、资源、会话库全部进程内直接持有。一个 caveat：它不是「订阅另一个正在运行的 OMP 进程的实时状态」；settings 文件被外部进程改后运行中会话不热加载（settings 页明示）。对 omp-web 无损——我们本来就是宿主，TUI 与 Web 并存时的配置同步沿用现有 reconcile 周期即可。

## 二、session 层（数据流 + 介入面）

### 2.1 数据流（读）

- `session.subscribe()` 事件面与 RPC 帧基本等价（`message_update` 的 text/thinking/toolcall delta、`message_start/end`、`tool_execution_*`、`turn_/agent_` 括号、compaction、auto_retry、notice）；pi 侧另有 `queue_update`（steer/followUp 队列可见）[pi]——RPC 侧无对应。
- **状态直读**：`session.messages`（完整 `AgentMessage[]`）、`model`、`thinkingLevel`、`isStreaming`、`sessionId/sessionFile`；`agent.state.systemPrompt`（当前渲染后的系统提示词）、`streamingMessage`、`errorMessage` [pi]。RPC 的 `get_state` 只是它的一个投影。

### 2.2 介入面（写）——RPC 做不到的部分

| # | 介入动作 | SDK 通道 | 备注 |
|---|---|---|---|
| S1 | system prompt 会话级设定 | `systemPrompt` / `appendSystemPrompt` 选项；`systemPromptOverride()`（loader，每次渲染调用）[pi] | CLI 仅有进程级 flag |
| S2 | prompt in（像真用户） | `session.prompt(text, {images, streamingBehavior, expandPromptTemplates, source})`；扩展命令（slash command）即使 streaming 中也立即执行，返回 `false` 表示被 local command 消费 | prompt templates/slash 天然走同一入口 |
| S3 | steer / followUp 显式排队 | `steer()` / `followUp()` 或 `streamingBehavior` 显式选择 | 不再赌运行时的 interruptive-vs-queue 策略（sdk-direction §2.3 的痛点） |
| S4 | **会话历史手术** | `session.agent.state.messages = messages`（顶层数组直接替换，文档明示用于 branch/restore）[pi]；`navigateTree()` 就地换 active path | conversation 级读写，`get_messages`/`resume` 不可比 |
| S5 | **tool_use / tool_result 注入** | S4 的推论：向 `state.messages` 追加伪造的 `toolResult`（JSONL 角色形状：`toolCallId/toolName/content/isError`）或 dangling `toolCall`，随下个 turn 进上下文 | ⚠️ 文档未把「inject tool result」列为一等 API，实际形状 = M2 spike 验证点之一 |
| S6 | content 注入（非 user 通道） | session-format 的 `custom_message` entry（`attribution: "user"\|"agent"`，进 model context、`display` 控制 UI）为扩展所有；SDK 内等价通道待 spike | developer role 亦在格式内 |
| S7 | 模型/thinking 运行中切换 | `setModel()` / `setThinkingLevel()` / `cycleModel()`；`model_change` entry 落 journal | RPC 有 set_model，但 SDK 连 cycling/诊断一起拿 |
| S8 | compaction 主动触发 | `compact(instructions?)` / `abortCompaction()` | RPC 无 |
| S9 | host-owned tools | `customTools`（z schema + execute 回调 + AbortSignal）；`restrictToolNames` 白名单语义 | RPC 完全没有的形态：桥可以给 agent 供工具 |
| S10 | 会话完成/资源回收 | `beginDispose()` + `dispose()`；`agent_end.isTerminal===false` 标记异步续命 | 桥可主动闭环 session 生命周期 |

## 三、测算与结论

1. **广度**：RPC 可达面 ≈ 上表 2.1 + S2/S3/S7 的受限子集 + A 层靠 CLI 侧门。SDK 补齐 A1–A8、S1、S4–S6、S8–S10——即 app 层从 0 到全量、session 介入面从「prompt 入口」扩到「conversation 对象本身」。
2. **深度本质**：RPC 的调用方是消费者（请求-响应）；SDK 的宿主是 owner——`state.messages`/`state.tools` 可写意味着注入不再经过「突发 user prompt 的调度策略」这个不可控点，与 sdk-direction §2.3 的论证一致，且 pi 文档已给出明示锚点（不再是纯推断）。
3. **主要风险不变且集中**：(a) omp 包实际导出面 ⊆ pi 文档（A4/A7、S4/S5/S6 全部待实测）；(b) Bun-only，集成形态仍按 sdk-direction §3 的 (a) sidecar 倾向；(c) 会话所有权——SDK 直接写 OMP session store 后，bridge-store / supervisor / TUI 三方避让要按 dev_0.0.3 §9 边界重过一遍。
4. **对 M2 spike 的清单化**：① 枚举 `@oh-my-pi/pi-coding-agent` 的真实 exports 对照本文 A/S 编号；② S5 实测（state.messages 追加 toolResult 后 prompt 一个 turn，看是否进上下文且 journal 正确落盘）；③ S1 会话级 system prompt 与 TUI 并存行为；④ A5 `SessionManager.listAll` 与我们 bridge-store 索引的映射；⑤ 数据流帧对拍（RPC vs SDK 同 prompt）。
