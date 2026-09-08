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
