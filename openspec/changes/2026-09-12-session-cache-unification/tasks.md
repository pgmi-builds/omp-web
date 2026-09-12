# Tasks — Session Cache Unification

## 1. P1 — prompt 诚实化（静态线停发，独立可先行）

- [x] T1 `session-persistence-omp.ts`：删 `systemPromptFor`/`systemPromptCache`；`eventsOf` 删 `includeSystemPrompt` 参数，`logCache` key 去掉 `systemPrompt` 分量（预热与 open 收敛为同一填充路径）
- [x] T2 `supervisor.ts`：materialize 删 `renderSystemPromptForFile` 调用与 seed 的 systemPrompt 实参（~2s 物化停顿随之消失）
- [x] T3 `replay.ts`：`replayOmpTranscript` 删 `systemPrompt` 参数与 `systemMessageEvent`；头部分支（title/request/header）相应化简
- [x] T4 `sdk-client.ts` 删 `renderSystemPromptForFile`；`sidecar/main.ts` 删 `session.systemPrompt.forFile` handler（`session.systemPrompt` live handler 与 `sessions.messagesReadOnly` 保留）
- [x] T5 `agent.ts`：`#bootstrapSessionIdentity` 注释与"冷重放同形同位"解耦改写（唯一发射点语义：恢复=首个 live turn 前，fresh=node 0）；逻辑本身不动
- [x] T6 测试改写：`replay.test.mjs` system 节点断言移除；`sdk-client.test.mjs`/`sidecar-smoke.test.mjs` forFile 用例移除；新增恢复会话 prompt 落位（尾部、紧邻 turn/start）断言
- [x] T7 4999 冒烟：冷读（无 prompt 行）→ resume（prompt 出现在首个 live turn 前）→ 新会话（node 0）三态验证；tsc 0 错 + 套件全绿

## 2. P2 — SessionCacheEntry 统一（消灭 W1 的前置）

- [x] T8 `omp-store.ts` + `session-persistence-omp.ts`：三 Map 合一为 `SessionCacheEntry`（L1 messages / L2 events 分级新鲜度、单 key `(size,mtime)`、preset 随 entry）；填充单飞（in-flight promise map）
- [x] T9 boot 预热走同一 entry 路径；验证同一 `(size,mtime)` 状态下冷读仅解析一次（trace/计数断言）
- [x] T10 单测：单飞并发去重、失效重填、validate 失败 fail-soft 空日志保留现行为

## 3. P3 — shadow 合流（R1 验收门）

- [x] T11 supervisor `entries` 去解析数据化：cursor 上移至 entry；5s 增量 ingest 改写 entry.events 并同 delta 喂宿主投影
- [x] T12 materialize 从 entry 取 seed（冷路径兜底统一填充）；promotion（resume）复用 entry
- [x] T13 teardown 零动作验证：idle exit / avoidance 后 entry 留存、下次冷读零解析命中（trace 断言：解析次数 = 文件变化次数）
- [x] T14 OMP_TRACE=1 实测回归：foreign-writer 检测（TUI 外部写入围观）、avoidance、pendingNote 全路径；任何回归即回退本期
- [x] T15 4999 冒烟：live→teardown→来回切换旧会话 全链路，点击次数与解析次数解耦验证

## 4. P4 — 持久化 session cache + LRU（有界）

- [x] T16 `knobs.ts` 新旋钮：`OMP_CACHE_MAX_ENTRIES`（默认 512）/`OMP_CACHE_MAX_BYTES`（默认 0=不限）/缓存目录开关；`0` 语义 = 关闭对应机制
- [x] T17 磁盘 tier：`~/.omp/omp-web/cache/replay/<dsh_id>.json`（指纹 `{size,mtimeMs,ompVersion,preset,formatVersion}` + `SessionEvent[]`）；读路径 指纹全等→`validateStoredEvents` 复验→采纳，否则解析并回写；L2 填充与增量 append 后防抖落盘
- [x] T18 内存 LRU：`lastViewedAt` 驱逐、双上限、shadow 存续期 entry 不可驱逐、驱逐后重填正确性
- [x] T19 磁盘清理：容量上限 + atime 惰性清理；整目录删除自愈验证
- [x] T20 单测：指纹不符回退、损坏文件 fail-soft、OMP 版本变更整体作废、LRU 驱逐/重填
- [x] T21 重启实测：boot 预热近期会话走磁盘（不触 JSONL 解析）、远期/升级后回退解析

## 5. 发布与收尾

- [x] T22 changelog + 版本 bump（patch 或 minor 按当期其它在途变更合并裁决）→ `npm pack --dry-run` 核对 → publish → 3081 精确版本 add → 重启 `omp-web.service` → prod 冒烟
- [ ] T23 `docs/plans/session-cache-unification.md` 加 as-built 注记指向本 change；AGENTS.md §三状态回写
- [x] T24 (controller first-person gate on 4997 replaced user manual acceptance per user instruction) 用户 4999 手动验收后 `systemctl --user stop omp-web-4999-test`（勿 kill；Caddy 不动）
