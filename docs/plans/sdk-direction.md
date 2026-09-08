# OMP 接入方向：从 RPC 桥走向 SDK（规划稿）

- 日期：2026-09-08
- 状态：方向确认，两步推进（第一步 CLI 模式模型功能已落地，见 `openspec/changes/2026-09-08-model-selector-active-providers/`；第二步 SDK 试点未启动）
- 参考文档：`docs/reference/pi-and-omp/`（omp.sh 56 页 + pi.dev 30 页官方文档快照，2026-09-06 抓取）；重点 `omp/sdk.md`、`omp/rpc.md`、`omp/providers.md`、`omp/roles.md`、`omp/custom-models.md`、`omp/secrets.md`
- 相关前置研究：2026-09-05 异构 Agent 运行时 SDK 基础调研（OMP/DSH/Hermes/Claude Code/Codex/Antigravity 六家形态对照）；2026-09-05 OMP shipment 分析（SDK vs RPC 的 engine 归属与透明度取舍）

## 1. 现状：RPC 桥补齐了模型面，但只是第一步

本轮（2026-09-08）已把模型清单/切换切到 **CLI 模式**：

- 目录：`omp models --json`（凭据解析后的 available 集合，50 模型 / 5 provider，~1.7s / 15 KB）替代 `models.db` 全量注册表缓存（36 provider / 3483 模型的"认识但不可用"噪声）；
- default 读写：`omp config get/set modelRoles --json`（整对象 roundtrip），随 reconcile 周期做 **双向同步**（TUI 改 default → Web 新会话继承；Web 选择器切换 → 写回 OMP config，TUI 新会话继承）。

到这里为止，模型这块 Web UI 与 TUI 的体验已经对齐。但这只是"把 RPC 桥的周边配置面补齐"——**数据面与会话介入面仍是 RPC 形态**。

## 2. 为什么转向 SDK

### 2.1 数据流：等价，不是动机

`--mode rpc` 收到的流（prompt / message_update / tool 流帧）与 SDK 的 stream events（`message_update` 等，omp SDK 镜像 pi 的 API 面）信息量等价。**SDK 的价值不在这里。**

### 2.2 真正的增量：session 介入面

SDK 持有整个 agent loop 的 conversation，可以做到 RPC 桥今天做不到/做不自然的事：

- **系统级 system prompt**：直接设置/追加 system prompt（CLI 也有 `--system-prompt` / `--append-system-prompt`，SDK 是会话级一等公民）；
- **content injection**：向会话注入内容块；
- **tool call / tool call result 注入**：伪造一个 tool call result 直接扔进 conversation，随下一个大模型 turn 进入上下文。

### 2.3 为什么这比 prompt injection 好

向会话里塞"用户消息"（prompt injection）看似等价，实则把语义难题甩给了 agent 运行时：**turn 中间突发的 user prompt 到底是 interruptive（打断当前执行）还是 wait for next turn（排队）**，每个 agent 运行时的策略不同、且可能随版本变化——桥接层无法控制，只能赌。而走 tool result / system prompt 通道，注入物的"身份"是明确的（它是一条工具结果/一段系统注入），不依赖运行时对突发用户输入的调度策略，行为可预期。

### 2.4 现有 RPC 桥的对照缺口

| 能力 | RPC 桥现状 | SDK |
|---|---|---|
| 数据流（逐帧） | ✅ 最详细 | ✅ 等价 |
| slash command / 中间互动 | ⚠️ 部分（extension_ui_request） | ✅ 完整 |
| 会话历史读写 | ⚠️ get_messages / resume | ✅ conversation 级 |
| system prompt 设定 | ❌ 仅进程级 flag | ✅ 会话级 |
| content / tool result 注入 | ❌ | ✅ |
| 模型目录 / default | ✅ 本轮 CLI 化 | ✅ |

## 3. 已知前提与风险

- **SDK 是 Bun-only**（`@oh-my-pi/pi-coding-agent`），dsh 宿主是 Node 22。集成形态三选一：(a) SDK 作为独立 sidecar 进程、桥走其对外通道；(b) dsh 侧引入 Bun 运行时跑 SDK host；(c) 维持 RPC 桥、仅吸收 SDK 证明可行的介入语义（向上游提 feature）。**倾向 (a)**：不把 Bun 拖进 dsh 进程树，也不放弃现有 RPC 稳定性。
- 介入 API 的**实际暴露面**需 spike 验证：文档叙事 ≠ 分支实现，system prompt override / message injection / tool result injection 的具体调用形状以 `omp/sdk.md` + 实测为准。
- 会话所有权：SDK createAgentSession 后，session 目录、webui.json 配对、supervisor 独占/避让机制都要重新对齐（现有 `docs/plans/dev_0.0.3.md` 的持久化边界假设全部要过一遍）。

## 4. 里程碑草案

- **M1（本目录）**：官方文档落库 + 本方向稿。✅
- **M2 SDK spike**：独立探针脚本（Bun + `@oh-my-pi/pi-coding-agent`），验证三件事——数据流等价性（对照 RPC 帧）、system prompt 会话级设定、tool result 注入是否真实可达。产出对照记录，不接生产。
- **M3 设计评审**：依据 spike 结果定集成形态（sidecar / Bun host / 上游路线），更新本文与 openspec。
- **M4 迁移决策**：混合形态（模型/配置走 CLI、会话介入走 SDK、数据流维持其一）或全量迁移。

## 5. 第一步的落地记录（2026-09-08，已完成）

- `omp models --json` 目录（50/5，凭据解析）+ `omp config get/set modelRoles --json` default 双向同步（reconcile 周期 tick，shadow key 防回环）；
- 顺带确认 CLI 能力边界：`config set` 只收整对象（点号 key 拒绝）、`omp models` 需可写 cwd + `OMP_HOME`、无独立 "set default model" 子命令（default 即 `modelRoles.default`）。
