## Why

桥接层（omp-web）当前没有自己的集中式存储：会话列表、id 配对、元数据全部依赖每次请求实时全量扫描 OMP 原生 session store（`~/.omp/agent/sessions`）。随着本地 OMP 会话越来越多，每次 fresh 请求的全量扫描带来线性增长的延迟。需要给桥接层建一个中央索引库（DB 唯一权威），承接会话映射、元数据与 Web UI 的 UI 专属数据（archive / fork / preset / workspace 排序 / last-visited），把请求路径从「全量扫描」降为「索引查询」。

## What Changes

- 新建集中式存储（SQLite 单文件，DB 访问隔离在接口后，运行时检测：Bun → `bun:sqlite`、Node → `node:sqlite`），作为桥接层**唯一权威**：一张 `sessions` 表承载会话映射 + 元数据 + UI 字段，外加 `workspaces`、`ui_state` 两张表。
- **会话映射集中化且去 webui.json 依赖**：`dsh-session-id ↔ omp-session-id ↔ 文件路径` 三向映射进 DB，替换 `pairing.ts#resolveEntryById` 的 O(n) 反向扫描；一次性迁移把历史 webui.json 的 legacy `dashSessionId` / `permissionPreset` 灌入 DB 的新 `dsh_session_id` / `permission_preset` 列，之后不再读写 webui.json（留盘不删）。
- **元数据集中化且永远完整**：`cwd`、`title`、`created_at`、`last_modified_at`、`transcript_size`、`model_provider/model_id`、`agent_preset` 等字段集中缓存；新会话入索引即全量提取（含模型），不留"未查看而 NULL"。
- **UI 专属字段**：`archived`（archive 标记）、`forked_from`（fork 源 DSH id）、`agent_preset`（composition id，OMP 暂无、字段先备）、`last_visited_at`（refresh 优先服务）。
- **workspace 归组与排序**：会话按 `cwd` 归组，`ungrouped` 哨兵作为 error/corrupt 会话的 fallback 组；全局 `sort_mode`（last_updated / manual）+ per-workspace `manual_order`（拖拽顺序持久化）。
- **reconcile 机制**：复用现有 30s 旋钮 + 启动 warm pass + 事件驱动增量，扫描成本移出请求路径；请求路径改 DB 索引 SELECT。
- **服务模型**：Web UI 请求由 DB（列表/元数据）+ 单个会话全量 replay（打开的具体会话）服务；标记 last-visited，refresh 起点优先服务最近会话。
- **不变式**：OMP 原生 store 仍是 transcript 唯一事实源（索引不复制 transcript）。

## Capabilities

### New Capabilities

- `centralized-store/session-index`: 会话映射 + 元数据 + UI 字段的集中索引——schema、查询接口、DB 唯一权威、与 OMP store 的一致性规则。
- `centralized-store/reconcile`: 索引与 OMP 原生 store 的对账机制——启动 warm pass、周期 reconcile、事件驱动增量、删除回收、完整元数据提取、一次性 webui.json 迁移。

### Modified Capabilities

（无——`openspec/specs/` 尚无主规格；本 change 在 `omp-in-dsh` 的 `session-storage` capability 之上叠加索引层，不修改其已定需求。注意：`apps/omp-in-dsh` 近乎原样复用 omp-web 桥接源码，本 change 的实现将同步被其继承，apply 阶段需回归其会话列表/续聊路径。）

## Impact

- **新增代码**：`apps/omp-web/src/store/`（DB 接口、SQLite 索引模块、reconcile、查询接口）。DB 访问隔离在接口后，运行时检测：Bun 用 `bun:sqlite`、Node 用 `node:sqlite`（均零原生依赖）。
- **既有代码**：`omp-store.ts`（扫描器保留，降级为 reconcile 数据源）、`pairing.ts`（反向查找改索引、去 webui.json）、`permission.ts`（preset 改走 DB；webui.json 读写退役）、`session-persistence-omp.ts`（list/history 改索引读取）、`supervisor.ts`（reconcile 接索引）、`index.ts`（启动 warm pass + 迁移 + DB 生命周期）。
- **运行面**：新旋钮 `OMP_BRIDGE_DB`（DB 文件路径）；复用现有 `OMP_STORAGE_RECONCILE_INTERVAL_MS`（默认 30s）。
- **部署面**：DB 文件落在桥接层自己的 state 目录，**绝不落入 `OMP_SESSIONS_ROOT`**。
- **风险面**：DB 唯一权威后 DB 丢失 = bridge 创建的真实 DSH id 无法恢复（WAL + 迁移幂等兜底）；`node:sqlite` 实验性（接口隔离，Bun 迁移时 `bun:sqlite` 自动生效）；索引 freshness 非强一致（≤30s + 事件增量）。
