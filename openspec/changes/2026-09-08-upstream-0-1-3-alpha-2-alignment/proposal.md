# Upstream 0.1.3-alpha.2 Alignment — omp-web v2 Seam Migration

## Why

宿主（全局 `@deepseek-ai/dsh`）已于 2026-09-08 升级到 **0.1.3-alpha.2**（dashr 对齐轮顺带完成，与 omp-web prod 3081 共用同一份用户级安装）。omp-web 0.2.0 的 `OmpUnionSessionPersistence` 按旧 seam（`locate/listSnapshots/append/load/inspect/borrowSession/readFrom/prepare/readRaw`）实现，而新 seam 是 **handle-based + lifecycle-owned write path**（`create/open/flush/stat/list` + `SessionHandle`），叠加 session **格式 v2**（`assistant/message` 内嵌 `stream` 记录、`SessionSeq` brand、`isSeeded` 必填、`request/header` 必填 `reason`）。prod 3081 当前正跑旧构建 = persistence 契约全面违约状态（冷读、feedback、workspace list 均踩空），升级是紧急事项。

对齐轮（2026-09-08，见 `docs/upstream-dsh-0.1.3-alpha.2-local-test-report.md`）已完成插件迁移并全绿（tsc 0 错、单测 30/30、4999 全链路冒烟）。本 change 收敛**剩余工作**：peer 版本策略裁决、prod 发布升级窗口、以及两项遗留小修。

## What Changes

- **persistence seam v2 迁移（已完成）**：`OmpUnionSessionPersistence` 重写为五方法面 + `OmpSessionHandle`（读 handle = replay 切片 `shared-frozen`；写 handle = 内存 buffer，OMP 拥有物理持久化）；`headerOf` 补 `isSeeded:false`；resume 改 `open('read')`+`handle.read()`。
- **流式 v2（已完成）**：删除 `assistant/chunk` 逐 delta append；新增 `AssistantStreamBridge`（`agent/assistant-stream` 帧 + `assistant/message` 内嵌 `stream` 记录）；replay 产物补 `stream: []` / `reason:"resume"` / `SessionSeq` brand。
- **header 身份一致性（已完成，实测发现 F1/F2/F3）**：行 `created_at`/`cwd` 以 prepared session header 为单一事实源（createAgent 先 prepare 后 upsert；resume 侧 `syncSessionHeader`；reconcile 不再覆写桥接授权字段）；supervisor materialize 加幂等守卫（修 prod `already exists`）。
- **peer 版本策略（待裁决）**：7 个 peers 从精确 `0.1.2-alpha.3` 转 dashr 式区间 `>=0.1.2-alpha.1 <0.2.0-0`（推荐）或 bump 精确值。
- **prod 发布升级（待执行）**：版本 0.3.0（seam 重写），publish → 3081 profile 精确版本 add → 重启 unit → 冒烟。
- **vendored types 刷新程序化（已完成，惯例化）**：`types/@deepseek-ai/*` 以宿主 `lib/types/*.d.ts` 为源重灌，随每次对齐轮执行。

## Capabilities

### New Capabilities

- `omp-persistence/v2-seam`: OMP union persistence 在 handle-based seam 下的语义——读 handle 的 replay 切片与 `shared-frozen` 标注、写 handle 的内存 buffer 与 lease 不参与声明、`stat`/`list` 的行快照与 revision、header 身份一致性不变式（行镜像 prepared header；reconcile 不覆写桥接授权字段）。

## Impact

- 代码：`src/session-persistence-omp.ts`（重写）、`src/agent.ts`、`src/replay.ts`、`src/supervisor.ts`、`src/index.ts`、`src/store/reconcile.ts`、`types/@deepseek-ai/*`（重灌）、根 package.json peers（待定）。
- 运维：3081 升级窗口（需停机一次重启）；`upstream/dsh` checkout 三 patch（storeDir/unrun/resolveRepositoryRoot）随 tag 固化。
- 不改动 OMP 上游；不改动 dsh 上游源码（checkout 的两处构建 patch 属本地构建环境适配，已归档记录）。
