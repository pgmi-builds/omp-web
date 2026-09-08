# omp-web-sdk（新线，0.0.1-alpha.0）

OMP Web 的 SDK 线：**衔接层（DSH 契约/术语/类形状）沿用 `apps/omp-web` 现行源码，内核从 `omp --mode rpc` 子进程换成 `@oh-my-pi/pi-coding-agent` SDK**。数据面目标 = `docs/plans/sdk-data-surface-assessment.md` 的 A1–A8 / S1–S10。

## 集成形态（承 sdk-direction §3 裁决 (a)）

```
dsh 宿主 (Node 22, 本包 dist/)            Bun sidecar (本包 sidecar/)
  omp-web 衔接层（agent/adapter/      ←→     createAgentSession / ModelRegistry /
  replay/store/supervisor 移植）            Settings / SessionManager / discover*
```

- dsh 进程树保持纯 Node；SDK 只活在 sidecar 进程（bun run）。
- 协议不再是 omp 的 rpc 面，而是**自有 sidecar 协议**：在数据流等价（prompt/steer/followUp/abort/事件流）之上，新增 app 层命令（settings 读写、auth/provider 状态、模型注册表、session list/open/fork、system prompt、custom message / messages 手术、compact）——即把 A/S 清单映射成方法表。

## Spike 实测记录（2026-09-09，SDK 18.1.14 + bun 1.4.2）

- 安装：`npm i @oh-my-pi/pi-coding-agent`（main 直指 `./src/index.ts`，无需构建步骤）+ devDep `bun`（node_modules 内二进制，不装全局）。
- 根 exports 619 个。桥关心的全部在位：`createAgentSession` `AgentSession` `SessionManager(.create/.open/.continueRecent/.inMemory/.list/.listAll/.forkFrom)` `Settings(.init/.isolated/.loadReadOnly)` `ModelRegistry` `AuthStorage` `discoverAuthStorage` `AgentRegistry` `createSessionManager` `listSessions` `listAllSessions` `loadSessionMessagesReadOnly` `discoverSkills/SlashCommands/Extensions/ContextFiles/PromptTemplates` `buildSystemPrompt` `createCustomMessage` `wrapSteeringForModel` `expandPromptTemplate`。
- **pi 文档 vs omp 实现**：`createAgentSessionRuntime`/`ModelRuntime`/`DefaultResourceLoader`/`SettingsManager`/`defineTool`/`createEventBus` 不在 omp 根 exports——对应能力由 `AgentSession` 实例面与 `Settings`/`discover*` 家族承担。评估文档中标 [pi] 的条目按此折算。
- **`AgentSession` 实例面远超 pi 文档**：`state{systemPrompt,model,thinkingLevel,tools,messages,isStreaming,streamMessage,pendingToolCalls,error}`、`messages`、`systemPrompt`、`prompt`/`promptCustomMessage`/`sendCustomMessage`/`sendUserMessage`、`steer`/`followUp`、`setModel`/`cycleModel`/`applyRoleModel`、`compact`/`abortCompaction`、`switchSession`/`branch`/`navigateTree`/`fork`/`handoff`、`newSession`/`moveSession`、`abort`、`beginDispose`/`dispose`。S1/S2/S3/S6/S7/S8/S10 均有一等 API；S5（messages 手术）通道结构性在位（`state` 暴露 messages/tools 键），赋值语义待 TS 类型面确认。
- **真机冒烟**：`OMP_HOME=~/.omp` 下 `discoverAuthStorage`+`ModelRegistry.refresh()` 得 50 模型 / 5 provider（deepseek,xai,bailian,kimi-plan,zai-plan）——与 `omp models --json` 完全一致；`SessionManager.inMemory()` 建会话成功、dispose 干净、零 LLM 调用。
- **沙箱注意**：SDK 以读写模式打开 `~/.omp/agent/agent.db`；agent 沙箱内跑 sidecar/spike 需要对该库的写权限（本轮以 danger-full-access 实测通过）。

## 下一步（M2 → M3 收敛）

1. sidecar 骨架：bun 入口 + 方法表协议（JSON lines over stdio）+ 生命周期（spawn/健康检查/退出）。
2. 移植衔接层：从 `apps/omp-web/src` 拷 `agent.ts`/`adapter.ts`/`replay.ts`/`session-persistence-omp.ts`/`store/`，把 `rpc.ts` 调用点逐个改打 sidecar 协议；`omp-cli.ts` 的 models/config 面改走 SDK（A1/A3）。
3. S5 spike：`state.messages` 注入 toolResult + 真 turn 验证 journal 落盘。
4. 会话所有权对齐：SDK 写 OMP session store 后与 bridge-store/supervisor/TUI 的三方避让（dev_0.0.3 §9 过一遍）。

## As-built：sidecar 骨架（2026-09-09，已完成 ✅）

- `sidecar/main.ts`（bun 入口）：ready 握手 + JSON-lines 请求/响应/事件三帧协议；app 级共享单例 `authStorage`/`modelRegistry`；session 池（create/dispose/事件转发）。
- `src/protocol.ts`：协议与方法表类型（sys.ping / models.list / settings.get / session.create|info|prompt|steer|followUp|abort|dispose / sessions.list）。
- `src/sidecar-client.ts`：Node 侧 spawn/关联/事件分发/优雅关停；`src/index.ts` 暂导出 client。
- 冒烟 `test/sidecar-smoke.test.mjs`：ready 0.9s，全链路（ping→50 模型→session create/info/dispose→sessions.list）2.4s，`npm test` 1.8s 绿。
- 坑已修：`ModelRegistry.refreshInBackground()` 此版本返回 void（非 Promise），可选链后接 `.catch` 会炸；ready-timeout 定时器必须 clear 否则 Node 进程挂 60s。

## As-built：衔接层移植（2026-09-09，已完成 ✅）

- `src/rpc-types.ts`：从 omp-web `rpc.ts` 提取的 OMP wire 类型（verbatim），两条线共用同一载荷形状。
- `src/sdk-client.ts`：**`OmpSdkClient`——与 `OmpRpcClient` 同公共面**（on/onFailure/sendRaw/send/getState/getMessages/getSessionStats/getSubagents/prompt/followUp/steer/setModel/abort/newSession/close），底层复用单个共享 sidecar（模块级单例 + 引用计数，refcount 归零自动关停）。spawn args 解析 `--approval-mode`（yolo→autoApprove）与 `--resume`；未知 flag fail-loud。
- 衔接层整体移植（与 omp-web 逐字节同源，仅换接缝）：`agent.ts` `adapter.ts` `index.ts` `models.ts` `knobs.ts` `pairing.ts` `permission.ts` `replay.ts` `session-persistence-omp.ts` `supervisor.ts` `omp-store.ts` `agent-preset-omp.ts` `omp-cli.ts` `store/`。
- sidecar 升级：session handle 化（`newSession` 换 OMP session id 但 handle 稳定）；补齐 `session.state/messages/stats/subagents/setModel/new`；`getSessionStats` 实测返回 contextUsage（contextWindow 1000000）。
- 测试：omp-web 单测四件（content-detection/omp-store/replay/store）+ sidecar 冒烟 + sdk-client 集成 = **20/20 绿，3.6s**；tsc 0 错。
- 本地 dev fixture：`node_modules/@deepseek-ai/*` symlink 至真实 dsh 安装（照 omp-web 惯例，node_modules 不入库）。

### 已知差异（SDK 线 vs RPC 线，待办）

- `extension_ui_response`（审批卡应答）在 SDK 线暂为 no-op：SDK 侧审批走 `autoApprove`/approval 事件，卡片化审批的等价通道待接。
- `getSubagents` 暂返回 `[]`（SDK 的 subagent registry 暴露面待查）。
- 未跑 4999 全链路（dsh 宿主内 provider 挂载）——下一步。

## As-built：4999 全链路冒烟（2026-09-09，PASS ✅）

- test profile `omp-web-test` 切换 dep 至 `link:…/apps/omp-web-sdk`（bundle 位同步换 `@pgmi-builds/omp-web-sdk`，patch 语义同 omp-web：mount omp-provider + 禁 agent-loop/llm 路由/agent-presets）。
- systemd-run `omp-web-4999-test`（DSH_HOME=~/.omp/omp-web、OMP_HOME=~/.omp、port 4999）拉起全局 dsh 0.1.3-alpha.2，unit active。
- 验证链：auth 200 → `session/create` ok → **dsh 进程树内 1 个共享 bun sidecar** → `session/prompt`（mode:queue + requestId，typert request 形状）accepted → `session/page`（`records[].event`，`throughSeq ≤ cursor`）回读：turn/start、user/message、2×step（reasoning + `think` 工具调用 + tool/result）、assistant/message（text "sdk-line-alive"，xai/grok-4.6，含 stream chunks）、turn/end。
- wire 备忘：`session/prompt` 必填 `requestId`/`mode`/`content`；`session/page` 用 `args.request`（非 `_request`），`address:{kind:"session",sessionId}` + `throughSeq` 超 cursor 直接报错并回吐当前 cursor。
