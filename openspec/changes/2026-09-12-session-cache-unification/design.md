# Design — Session Cache Unification

## Context

架构不变式保持不动：**OMP JSONL 是唯一 transcript of record**，桥接 SQLite index 是唯一 list/id/metadata 权威，一切缓存皆派生、可丢弃。两条供给路线（live RPC / 静态重放）寄生在同一 dsh 宿主进程，进程内没有跨进程边界问题——"统一"是纯代码结构问题。前置事实（2026-09-12 实测）：OMP JSONL 记录类型 = title/session/model_change/thinking_level_change/message(user|assistant|toolResult)/custom/custom_message/title_change/ttsr_injection/compaction，**无 prompt 记录**；`session.systemPrompt.forFile` 以当前运行时现场渲染，产物随 OMP 版本漂移（18.0→18.1.x 模板微调），自证其非历史事实。

## Goals / Non-Goals

- Goals: 每个 `(size, mtime)` 状态全进程恰好解析一次，两路线共享；teardown 零动作；重启后近期会话首开不付全量重解析；内存/磁盘有界且 fail-soft；静态线输出诚实（JSONL 没有的不造）。
- Non-Goals: 不做跨进程共享缓存（单进程内统一即终态）；不持久化 live 会话的未落盘状态（OMP 每写即刷，无此需求）；不改宿主 projection cache；不做 per-turn prompt 历史重建（OMP 存储模型上限，明确放弃）。

## Decisions

### D1. prompt 诚实化：静态线停发，RPC 是唯一来源
`renderSystemPromptForFile` 全部静态调用点删除（persistence / supervisor materialize / replay 参数链 / sidecar `forFile` handler）。依据：渲染产物是"下一次 turn 会用的 prompt"，放在任何历史位置都是伪记录；DSH 原生语义是 re-assemble 的 prompt 在其 turn 边界按时间序呈现。`#bootstrapSessionIdentity` 成为唯一发射点：其现有守卫（seed 已含 `system/message` 则跳过）+ append 时机（ensureStarted 之后、`turn/start` 之前）使恢复会话的 prompt 节点自动落在**首个 live turn 紧前方**（时间线尾部语义），fresh 会话为 node 0（此刻渲染即真 turn-1，语义正确）。agent.ts:568-570 "与冷重放同形同位"注释解耦改写。代价（已接受）：纯冷读会话无 prompt 行，直到首次 live 化。

### D2. SessionCacheEntry：一 entry 两级新鲜度
```ts
interface SessionCacheEntry {
  size: number; mtimeMs: number; preset: string | null;
  messages: OmpMessage[];        // L1：SDK/fallback 原始解析
  events: SessionEvent[];        // L2：重放+validateStoredEvents+assertContiguous+冻结
  cursor?: { lastSeq; size; mtimeMs };  // S2：增量 ingest 游标
  lastViewedAt: number;          // LRU 依据（supervisor 已维护，上移合一）
}
```
L2 = f(index row, L1) 纯函数（prompt 移除后重放完全确定）；失效单 key `(size, mtime)`，preset 仅影响头部合成 permission 事件、随 entry 重建。填充单飞（in-flight promise map）杜绝并发 open 双解析。`validateStoredEvents` 失败仍 fail-soft 空日志、待下次变化重填（现行为不变）。

### D3. shadow = entry + 投影 + 定时器；teardown 零动作
supervisor `entries` 不再自持解析数据：5s tick 发现增长 → 增量重放 delta → **append 进 entry.events** → 同一 delta 喂宿主投影。materialize 从 entry 取 seed（entry 必已在：persistence open 先于 noteView；冷路径兜底走统一填充）。idle exit / avoidance teardown 拆投影与定时器，entry 原样留存——"teardown 物化"以"从不丢"实现。foreign-writer 内容检测（`knownUserTexts` 增量扫描）逻辑不动，仅数据源换 entry 增量。风险最高的一步，须 OMP_TRACE 实测回归。

### D4. 磁盘 tier：指纹缓存，信任前必验
`~/.omp/omp-web/cache/replay/<dsh_id>.json` = `{ fingerprint: {size, mtimeMs, ompVersion, preset}, events }`。读路径：冷读 miss / boot 预热 → stat → 指纹全等 → `validateStoredEvents` 复验 → 采纳；任一环节不符/抛错 → 常规解析并回写。`ompVersion` 每进程取一次（sidecar hello），升级即整体作废自愈。写入时机 = L2 填充完成（含增量 append 后防抖落盘）。与宿主 projection cache 分层不重叠（它管 titles/stats 投影）。

### D5. 内存 LRU：有界、驱逐安全
entries 按 `lastViewedAt` LRU，`OMP_CACHE_MAX_ENTRIES`（默认 512）/ `OMP_CACHE_MAX_BYTES`（默认 0=不限）双上限，`0` 关闭对应上限。驱逐安全：entry 为派生数据，open handle 持 frozen 数组自有引用、宿主 live Session 不持 entry——驱逐只影响下次冷读延迟。shadow 存续期间其 entry 不可驱逐（定时器活跃即"被使用"）。

### D6. 落盘格式即 wire 格式，无第二套序列化
磁盘缓存直接存 `SessionEvent[]`（与 `validateStoredEvents` 输入同形），不做自定义压缩/转码——复验即合法性检查，格式漂移由 SESSION_FORMAT_VERSION 升级时整体作废（指纹加 `formatVersion` 字段）兜底。

## Risks / Trade-offs

- **R1 supervisor 状态机回归**（D3）：foreign-writer 检测、avoidance、pendingNote 路径必须 OMP_TRACE 实测；回归即回退此期，其余期不受影响。
- **R2 磁盘占用翻倍**：历史事件日志落盘 ≈ JSONL 同量级；容量上限 + atime 惰性清理（实现期定参数），随时整目录删除自愈。
- **R3 冷读无 prompt 的 UX 变化**：有意为之（诚实数据）；若用户后续要求"冷读也显示"，正道是打开即 resume（RPC prompt），而非恢复静态渲染。
- **R4 测试面**：`replay.test.mjs` 的 system 节点断言、`sdk-client.test.mjs` 的 forFile 用例随删除改写；38 套件全绿为底线。

## Migration

一期一提交，顺序即依赖：P1 prompt 停发（独立可先行，直接消灭 W2 与 ~2s 停顿）→ P2 entry 统一 → P3 shadow 合流（R1 验收门）→ P4 磁盘 tier + LRU。每期 4999 冒烟（冷读/来回切换/resume/foreign-writer 围观）后进下一期。
