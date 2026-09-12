# Session Cache Unification — shadow/cache 合流、静态线 prompt 停发与持久化 session cache

## Why

桥接层在**同一个 dsh 宿主进程**内维护四份缓存（`transcriptSdkCache` / `logCache` / `systemPromptCache` / supervisor shadow）外加 live Session，对同一 transcript 文件存在两份互不知晓的解析副本。四个已确认的问题：

- **W1 双份解析副本**：`logCache`（冷读整文件重放）与 shadow（5s 增量 ingest 自产 events）各自为政；teardown 后下次冷读再付一次全量重解析。
- **W2 boot 后首开双解析**：boot 预热填 `logCache` 时不带 prompt，首次真实 `open` 因 key 混入 `systemPrompt` 而 miss，整文件重来。
- **W3 重启全量重解析**：三层缓存纯内存，每次重启 boot 预热重解析全部 indexed session。
- **W4 prompt 语义错位**：OMP JSONL 不记录任何 system prompt（2026-09-12 实测记录类型表证实），SDK `forFile` 渲染的是**当前 turn** 的 prompt（随 OMP 版本/模板变化），静态重放却把它摆在 seq 0 冒充 turn 1——历史不可恢复，展示即失真；且 shadow 物化路径为此付出 ~2s 的 sidecar 渲染停顿。

用户访问模式重尾偏近期（近期活跃 session 被再点开的概率高）。本 change 把两条路线（live RPC / 静态重放）的内存数据**逻辑上统一为一份**，并引入**有界的持久化 session cache**。

前置草案：`docs/plans/session-cache-unification.md`（2026-09-12，本 change 取代之；其 S4"尾部就位"方案被更强的"静态线停发"政策取代，S1/S2/S3 并入本 change）。

## What Changes

- **prompt 诚实化（前置，独立可先行）**：静态线彻底停发 system prompt——`renderSystemPromptForFile` 的全部静态路径调用点删除（persistence `systemPromptFor`/`systemPromptCache`、supervisor materialize 渲染、`replayOmpTranscript` 的 `systemPrompt` 参数与 `systemMessageEvent`、sidecar `session.systemPrompt.forFile` handler）。prompt 节点此后**唯一来源 = live RPC**：`#bootstrapSessionIdentity` 现有机制（spawn 后、首个 live turn 前 append；seed 已含 `system/message` 则跳过）——恢复会话自动落在时间线尾部（紧邻首条 live user message），fresh 新会话落在 node 0（此刻渲染即真 turn-1）。**JSONL 没有的不造。**
- **SessionCacheEntry 统一（S1）**：`transcriptSdkCache` + `logCache` 合并为每文件一 entry（L1 原始解析 `messages` → L2 重放校验 `events` 分级新鲜度），单一失效 key `(size, mtime, preset)`；`eventsOf` 的 `includeSystemPrompt` 参数删除，boot 预热与 `open` 收敛为同一填充路径（W2 随 prompt 停发自然消失）。
- **shadow 合流（S2）**：supervisor 5s 增量 ingest 改为**写 entry**（cursor 上移至 entry，增量 events 同时喂 entry 与宿主投影）；shadow 退化为 "entry + 宿主投影 + 定时器" 三件套而非第二份数据；**teardown 零动作**（增长早已入 entry，无物化步骤）；promotion 复用 entry 为 seed，消除 materialize 的重复解析与 ~2s 停顿。
- **持久化 session cache（S3，有界）**：磁盘 tier `~/.omp/omp-web/cache/replay/<dsh_id>.json`，指纹 `(size, mtime, ompVersion, preset)` 全等才信任，boot 预热与冷读 miss 先查磁盘；内存 LRU（entries/bytes 双上限，env 可调，`0`=不设限）。派生数据随时可重建，任何指纹不符/损坏 fail-soft 到重解析。

## Capabilities

### New Capabilities

- `omp-session-cache/unified`: 单一 SessionCacheEntry 语义——两路线共享一份解析产物（每个 `(size, mtime)` 状态全进程恰好解析一次）、incremental ingest 作为 entry 的写入者、teardown 零动作、静态线 prompt 停发（prompt SHALL 仅来自 live RPC）、磁盘指纹缓存与内存 LRU 的有界持久化。

## Impact

- 代码：`src/session-persistence-omp.ts`、`src/supervisor.ts`、`src/omp-store.ts`、`src/replay.ts`、`src/sdk-client.ts`、`sidecar/main.ts`、`src/agent.ts`（bootstrap 注释与冷重放解耦）、`src/knobs.ts`（LRU/cache 环境旋钮）。
- 测试：`replay.test.mjs`（system 节点断言移除/改写）、`sdk-client.test.mjs`（forFile 用例移除）、`omp-store.test.mjs`、新增 entry 单飞/LRU 驱逐/磁盘指纹回退用例。
- 运维：新增运行时缓存目录（DSH_HOME 下，随盘、可随时删除重建）；发布一个 patch/minor 版本走常规 3081 窗口。
- 不改动 OMP 上游与 dsh 上游；"OMP JSONL 是唯一 transcript of record" 不变式不变；宿主 `sessionProjectionCache`（titles/stats 投影）分层不重叠、不受影响。
- 已知行为变化（有意）：纯冷读（从未 resume）的会话不再显示 system prompt 行，直到该会话首次 live 化。
