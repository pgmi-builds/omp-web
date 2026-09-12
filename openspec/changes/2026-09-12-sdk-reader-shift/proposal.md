# SDK Reader Shift — 冷启动重放与 OMP 格式接缝继续向 SDK 收敛

- 状态：**draft**（未批准、未实施；2026-09-12 由 session-cache-unification 交付后的实测推导）
- 前置：`2026-09-12-session-cache-unification`（已实施，v0.2.2-a）——单 entry store、单 reader 血统（`defaultReader`）、单填充管线已就位，本 change 是接缝层面的继续收敛。

## Why

桥接层仍持有 OMP JSONL 解析知识：`readOmpTranscript` 兜底解析、记录类型表、`replayLenient` 的记录级形状假设。每向上游对齐一轮，这些都要重验。而 omp SDK 18.1 已实测（2026-09-12，bun 直连）提供**冷启动重放入口**：

```ts
const sm = await SessionManager.open(file);                    // 18.1 起 async
const ctx = await sm.buildSessionContext({ transcript: true }); // OMP 自己的冷重放
// ctx.messages = 展示转录（compaction 感知、leaf 分支解析）
// ctx.thinkingLevel / models / injectedTtsrRules / serviceTier = 会话元数据
```

实测：hihi（4 条）与大文件（2233 条展示转录）均正确；sidecar 共享常驻，Bun 冷启成本已摊销。上游 JSONL 结构变更应只打到一个文件（sidecar）。

## Candidate Integrations（下一步可整合的东西，按优先序）

1. **L1 reader 换芯（本 change 核心）**：`defaultReader` 的 SDK 首选链从 `loadSessionMessagesReadOnly` 升级为 `SessionManager.open + buildSessionContext({transcript:true})`。收益：compaction 感知的展示转录（对齐 TUI 所见，替代原始消息近似重放）；`models` 元数据可校准 `request/header`；`thinkingLevel`/`injectedTtsrRules` 为后续 UI 呈现候选。`replay.ts` 的 Dash 翻译层保持不动（输入形态接近，适配为中等改动）。**翻译层永不 SDK 化——它是与宿主的契约面。**
2. **Sidecar 成为唯一 OMP 格式接缝**：`readOmpTranscript` 兜底移入 sidecar（`sessions.messagesReadOnly` 的 fallback 分支）或在新 reader 稳定后删除；桥接进程内零 OMP 格式知识。
3. **分支塌缩加固**（实测发现，2026-09-12）：SDK reader 是分支感知的（`(id,parentId)` 树 + leaf 指针）；`parentId=null` 的外来记录会使 SDK 视角塌缩到外来分支 → `lenient.length < cursor.lastSeq` → delta 空、静默重基线。加固：塌缩视为异常信号（记 warn + 触发 fallback 读），替代静默。
4. **空读取语义收紧**：SDK reader 返回空 ≠ 失败（undefined）——非零文件 + 空结果应触发 fallback/异常信号而非信任空（reader-flip 盲区根源）。
5. **增量 ingest 流式化**：`visitEntriesFromFileStream` / `loadEntriesFromFileStream`（SDK 流式读侧，`readRpcSubagentTranscript(sessionFile, fromByte)` 的 byte-cursor 先例）替代 growth 时的整文件重读。
6. **读侧 API 收敛清点**：`parseSessionEntries`（已用于 model_changes）、`loadSessionFile`（storage/blob 解析）等 SDK 读侧导出逐个评估，替换桥接内剩余手搓解析。

## Non-Goals

- **resume-RPC 兼职冷重放**：拒绝。子进程秒级 spawn、每 child 全量内存、idle-exit/avoidance/锁交互副作用；cache 前置后冷重放瓶颈是"每 (size,mtime) 恰好解析一次"，与后端无关。resume 只属于真实打开（现状即如此）。
- Dash SessionEvent v2 翻译层迁移（契约面，永驻桥接）。

## 成本与风险

- `buildSessionContext` 单次比 `loadSessionMessagesReadOnly` 重（树 + blob 组装）；cache 摊销后仅影响 miss 路径。
- leaf 路径选择 = 分支感知（与现状同）；compaction'd 会话将重放**后**压缩视图——对 UI 是保真度提升，但对"原始记录数"断言类测试是行为变化。
- SDK async 面（18.1 起 `SessionManager.*` 返回 promise）已在 `73ef9e0` 兼容。
