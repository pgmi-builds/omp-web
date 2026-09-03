## Context

桥接层现状（均核对源码）：

- **OMP 原生 store**：`~/.omp/agent/sessions/<cwd-dashed>/<timestamp>_<uuid>.jsonl`，每文件一条 JSONL transcript。OMP session 必有 CWD（TUI 总有 starting point，session 头 `cwd` 字段恒在）。
- **扫描器**（`omp-store.ts`）：`scanOmpSessions()` 全量走目录 + `stat` 每个 `.jsonl` + 读 256KB 头（`HEAD_BUDGET_BYTES`），产出 `OmpNativeSession{ ompSessionId, ompSessionFile, cwd?, createdAt, title?, revision }`；内存 `entryCache` 按 (size, mtime) 记忆化，但每次调用仍做全量 readdir + stat walk。
- **配对与 preset**（`pairing.ts` / `permission.ts`）：目前配对与 preset 持久在每会话 `webui.json`（`{ dashSessionId, permissionPreset }`，原子写）；`resolveEntryById` 反向查找是 O(n) 全量扫描 + 逐个读 webui.json。
- **元数据消费面**（`session-persistence-omp.ts`）：list/history/resume 全经 `scanOmpSessions()` + 按需 `replayOmpTranscript`（读全文件）。
- **模型配置来源**：冷会话 = `replay.ts#lastModelCall`（transcript 尾部最后一条 assistant 的 provider/model，需读全文件）；live 会话 = `get_state().model` 经 `agent.ts#syncModelSelection` 推送。
- **上游 UI 事实**（dsh-alpha `workspace-controller`，均已核对）：Web UI 的 workspace 导航 = `create/rename/remove/insertBefore`（reorder workspaces）、`insertSessionBefore`（reorder sessions within workspace → 有序 `sessionIds`）、`archiveSession`（→ registry 级 `archivedSessionIds`）、`follow`（workspace 投影流）。fork = 新会话 meta `parentSession`；preset = `agentPreset`（projection，创建时指定且不可变）。
- **subagent 事实（核对 OMP store + dsh-alpha）**：
  - DSH 侧：subagent 会话是普通会话 + 头部 `origin: 'subagent'` + `parentSession`（父会话 id），transcript 可完整重放；Web UI 经 `subagents.list(parentSessionId)` 消费子会话目录（entry：`id`/`label`/`activity`），会话列表暴露 `parentSessionId`/`origin`/`cwd`/`depth`。fork 与 subagent 共用 `parentSession`，用 `origin` 区分。
  - OMP 侧：**subagent 持久在父会话文件内，不是独立文件**。实测 224 个 session 头 id 全 uuidv7、无独立 subagent 文件；subagent 以父 transcript 内的 `session_init` 记录形态存在——字段 `agent`（task/scout/reviewer/code-reviewer）、`task`（任务）、`id`（8 位 hex 记录 id，即"短 id"）、`parentId`（spawn 点，指向 model_change/thinking_level_change）、`spawns`（嵌套 spawn 标记）、`modelRole`/`resolvedModel`（subagent 用更便宜模型，如 scout→smol/deepseek-v4-flash）。subagent 的消息以 `message.parentId → session_init.id` 关联，混在父文件 message 流里。全 store 共 115 条 session_init。
- **运行时**：桥接层跑在 **Node 22**（`node dsh --profile omp-web`，pid 7437 监听 3081）；**Bun 未安装**。`node:sqlite` 实测可用（ExperimentalWarning）。`STORAGE_RECONCILE_INTERVAL_MS` 默认 30s。

## Goals / Non-Goals

**Goals:**

- 请求路径（list/history/resume/id 翻译）降为 O(1) 索引查询，不再全量 scan + 逐个读文件头。
- 三向映射（dsh ↔ omp ↔ file）与全部元数据**集中、由 DB 唯一持有**，不再依赖 webui.json。
- DB 字段**永远完整**：新会话入索引即全量提取（含模型），不留"未查看而 NULL"的字段。
- 承接 Web UI 的 UI 专属元数据：archive、fork 源、agent preset、workspace 归组与手动排序、last-visited。
- 不动 OMP 上游、不动 dsh 上游。

**Non-Goals:**

- 不把 transcript 或 DSH event log 落库（仍是 replay + 内存 memo；OMP store 是唯一 transcript 事实源）。
- 不做强一致 / 实时同步（保留 reconcile 语义，接受 ≤30s 窗口）。
- 不删除 webui.json（留盘，但不再读写，见 D3）。
- v1 不实现 subagent 桥接（解析父文件 session_init 并重放为 DSH subagent 会话）——不占 schema，解析/重放代码后续 change（见 D11）。
- 不做跨 profile / 多守护进程共享（单 profile 单进程内的本地索引）。

## Decisions

### D1: 存储引擎 = 运行时检测适配器（Bun → `bun:sqlite`，Node → `node:sqlite`）

**决策**：DB 访问隔离在一个小接口（open / exec / prepare / run / get / all）之后，运行时检测选择驱动：Bun 下用 `bun:sqlite`（`typeof globalThis.Bun !== "undefined"` 判定），Node 下用 `node:sqlite`。同一接口、零原生依赖、双运行时可用；将来桥接层编译/迁移到 Bun 二进制时 `bun:sqlite` 自动生效，无需改代码。
**核对结论（实测 + 官方文档）**：`bun:sqlite` 是 **Bun-only builtin**——`node --input-type=module -e "import {Database} from 'bun:sqlite'"` 直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'bun:'`（Node 的 ESM loader 只接受 file/data/node 三个 scheme）。所以"在 Node 运行时里用 bun:sqlite"不成立；成立的是"在 Bun 运行时里跑 TS/JS 项目，用 bun:sqlite"。当前桥接层跑 Node 22（pid 7437），故 Node 分支走 `node:sqlite`；若安装 Bun 并把桥接层（或整个 dsh 宿主）迁到 Bun 运行时，Bun 分支自动启用 `bun:sqlite`。二者 `prepare/run/get/all` API 形状高度一致，适配器极薄。
**备选**：better-sqlite3（原生二进制，Bun 下加载历史有坑，且与"将来 build to binary 用内置"的目标打架，否决）；JSON 索引文件（无索引查找、O(n) 加载，否决）。

### D2: 单表 `sessions`，映射 + 元数据 + UI 字段合一

**决策**：一张表同时承载配对列、元数据列、UI 专属列，不拆 `session_map` / `session_meta`。
**理由**：三者严格 1:1（每个 OMP 会话恰一个 dsh id + 一份元数据 + 一份 UI 标记），拆表徒增 join；list + resolve 一次 SELECT 全覆盖。

### D3: DB 是唯一权威；一次性迁移；webui.json 留盘不删

**决策**：DB 成为配对 + preset + 全部元数据的**唯一权威**。新读写不再碰 webui.json；启动时做**一次性迁移**：扫一遍现存 webui.json，把 legacy `dashSessionId`（旧字段名，只读）/ `permissionPreset` 灌入 DB 的新 `dsh_session_id` / `permission_preset` 列（迁移后 webui.json 不再读也不再写，仅留盘）。注意 `permission_preset`（审批预设：danger-full-access/workspace-write/read-only）与 `agent_preset`（DSH composition id，恒 `omp`）是**两列、两概念**，不可混用。
**理由**：用户决策——集中到 DB，去除 webui.json 依赖。真实 DSH id（`session-<uuid4>`）不可从 OMP 数据推导，故迁移必须覆盖历史会话，否则已有会话丢配对。
**代价与兜底**：DB 从"可丢弃缓存"变为"需持久"。WAL 模式 + 启动 `PRAGMA integrity_check` + 迁移幂等（重复启动不重复写）；DB 丢失时，TUI 派生会话（`session-<ompId>`）可重算，但 bridge 创建的历史真实 DSH id 无法恢复——这是接受"DB 唯一权威"的固有代价。
**备选（否决）**：继续依赖 webui.json——用户已明确"db only, no dependency on webui.json"。

### D4: schema 与查询接口

```sql
-- 会话索引：映射 + 元数据 + UI 字段
CREATE TABLE sessions (
  omp_session_id   TEXT PRIMARY KEY,          -- OMP uuidv7（session 头 `id`）
  dsh_session_id   TEXT NOT NULL UNIQUE,      -- DSH 侧 id（真实或派生，配对列）
  session_file     TEXT NOT NULL UNIQUE,      -- transcript 绝对路径
  cwd              TEXT,                      -- 工作目录（恒有；error/corrupt 时 NULL → ungrouped）
  title            TEXT,                      -- 展示标题（latest wins）
  created_at       INTEGER NOT NULL,          -- epoch ms
  last_modified_at INTEGER NOT NULL,          -- transcript mtime（默认排序键 = "last updated"）
  transcript_size  INTEGER NOT NULL,          -- 字节数（reconcile 变更检测）
  model_provider   TEXT,                      -- 最后模型 provider（永远完整，见 D6）
  model_id         TEXT,                      -- 最后模型 id
  agent_preset     TEXT,                      -- DSH agent preset（composition id；OMP 暂无，字段先备）
  permission_preset TEXT,                     -- 审批预设（danger-full-access/workspace-write/read-only），与 agent_preset 区分
  forked_from      TEXT,                      -- fork 源的 dsh_session_id（NULL = 非 fork）
  archived         INTEGER NOT NULL DEFAULT 0, -- archive 标记（Web UI 不再展示）
  last_visited_at  INTEGER                    -- 最后查看时刻（refresh 优先服务，见 D10）
);
CREATE INDEX sessions_cwd   ON sessions(cwd);
CREATE INDEX sessions_mtime ON sessions(last_modified_at DESC);
CREATE INDEX sessions_visit ON sessions(last_visited_at DESC);

-- workspace 归组 + 手动排序
CREATE TABLE workspaces (
  workspace_id  TEXT PRIMARY KEY,             -- = cwd 路径；'ungrouped' 为 fallback 哨兵（见 D8）
  title         TEXT,
  manual_order  TEXT                          -- JSON array of dsh_session_id（manual 模式，见 D9）
);

-- 全局 UI 状态（单例）
CREATE TABLE ui_state (
  key   TEXT PRIMARY KEY,
  value TEXT                                  -- 如 sort_mode = 'last_updated' | 'manual'
);
```

- `revision` 不落列，由 `transcript_size` + `last_modified_at` 计算为 `omp:<size>:<mtime>`（延续现有 token 语义）。
- 查询接口（`apps/omp-web/src/store/` 导出）：`list()`（默认 `last_modified_at DESC`，manual 模式按 workspace 的 `manual_order`）、`byDshId`、`byOmpId`、`byFile`、`upsert(row)`、`prune(keepFiles)`、`setArchived`、`setForkedFrom`、`setPermissionPreset`、`touchVisited`、`setWorkspaceOrder`、`getUiState` / `setUiState`。
- 索引对应：UNIQUE `dsh_session_id`（DSH→OMP 翻译，替换 `resolveEntryById` 反向扫描）、UNIQUE `session_file`（file→row）、`cwd`（workspace 归组）、`mtime DESC`（默认排序）、`last_visited_at DESC`（refresh 优先服务）。

### D5: reconcile 三段式 + 完整元数据提取

**决策**：
1. **启动 warm pass**：全量 scan + upsert，接入现有 boot 序列（先于对外服务）。
2. **周期 reconcile（30s，`STORAGE_RECONCILE_INTERVAL_MS`）**：stat walk + 仅重读变更文件，diff 后 upsert 变更、`prune` 删除已消失文件。
3. **事件驱动增量**：createAgent 时 INSERT；live 模型切换（`syncModelSelection`）UPDATE `model_*`；supervisor file-follow 侦测 title 变更 UPDATE `title`；teardown/冷转以最终 stat UPDATE mtime/size。

**完整元数据提取（配合 D6）**：reconcile 对**新文件**做全量读（头 + 尾，提取 title/cwd/createdAt/模型等全部字段）；对**已存在的冷会话**变更也做全量读（刷新模型/title）；**held/live 会话**跳过全量读（事件增量已拥有其模型与新鲜度）。请求路径只读 DB，不触发扫描。

### D6: 模型元数据永远完整

**决策**：`model_provider` / `model_id` 在会话**入索引时即全量提取**（新会话全量读，含 transcript 尾部最后一条 assistant），不留"未查看而 NULL"；live 会话经 `get_state().model` / `syncModelSelection` 持续更新；冷会话外来变更经 reconcile 全量读刷新。NULL 仅发生在"会话尚无任何 assistant 消息"（本就没有模型可记）。
**理由**：用户否决了"未查看冷会话模型为 NULL"的惰性方案——完整字段是硬要求，代价是新会话/冷变更的一次全量读（按 D5 只发生在检测时，不在请求路径）。

### D7: DB 位置 = 桥接层自身 state 目录，不入 OMP store

**决策**：`OMP_BRIDGE_DB` 旋钮指定绝对路径，默认 `<profile-state>/bridge-store.sqlite`；启动 `PRAGMA journal_mode=WAL` + `PRAGMA integrity_check`。
**不变式**：MUST NOT 落在 `OMP_SESSIONS_ROOT`（`~/.omp/agent/sessions`）内——OMP 会扫描该目录并把 `.sqlite` 当外来会话文件。

### D8: workspace 归组 + `ungrouped` fallback

**决策**：会话按 `cwd` 归入 workspace（`workspace_id` = cwd 路径）。`ungrouped` 是一个**常驻哨兵 workspace**（fallback 组）：当某会话 error/corrupt 导致 cwd 缺失或不可解析时，归入 `ungrouped`，保证任何会话都有归属、不被丢弃。
**理由**：OMP JSONL 恒有 cwd（正常路径），但 corrupt/foreign 文件可能读不出——fallback 组把这类会话整合而非丢失，对应 Web UI 的 default/ungrouped 语义。
**实现要点**：`sessions.cwd` 为 NULL 的会话在查询时映射到 `ungrouped`；`workspaces` 表常驻 `ungrouped` 行。

### D9: 手动排序持久化 + 全局 sort_mode

**决策**：`ui_state.sort_mode` = `'last_updated'`（默认）| `'manual'`（全局单选，对应侧栏 presentation 选项）；manual 模式下每 workspace 的拖拽顺序持久化在 `workspaces.manual_order`（JSON array of dsh_session_id）。
**理由**：用户要求持久化 manual drag-drop 顺序；manual_order 是 per-workspace（拖拽发生在分组内），sort_mode 是全局单选。列表默认序 = `last_modified_at DESC`；manual 模式按 `manual_order`，不在数组内的会话按 `last_modified_at` 兜底排在末尾。
**备注**：上游 workspace-controller 已有 `insertSessionBefore`/`insertBefore` 的原生重排语义；本 DB 的 manual_order 是其 OMP 会话侧的对等持久化。sort_mode 是否纯客户端（localStorage）待实现时定，但 schema 先备（成本为零）。

### D10: last-visited 标记 + refresh 优先服务

**决策**：会话被查看（open/resume）时 UPDATE `last_visited_at`；Web UI refresh（列表/落地请求）时，桥接层以 `last_visited_at DESC` 取最近会话，优先服务其**单个会话全量 replay**（DB 命中其元数据 + 读该 transcript 重放），再补其余列表。
**理由**：用户要求——Web UI 请求由 DB（列表/元数据）+ 单会话全量 replay（打开的具体会话）服务；标记 last-visited 使 refresh 起点即回到上次所在会话，避免冷启动空屏。

### D11: subagent 是父会话 replay 的派生物，不占 schema（代码后续 change）

**决策**：OMP subagent **持久在父会话 transcript 内**（`session_init` 记录 + 交错 message），桥接**不为其单独建表或列**——subagent 清单是父会话 replay 的**派生物**：父 transcript 被重放时顺带解析 `session_init` 记录，清单随父会话打开一次性产出下发；sub-transcript 在 Web UI 请求时从父文件按 `message.parentId → session_init.id` lineage 切出重放。二者都不落库（延续"transcript 不落库"不变式），也无需独立 subagent 身份列——DSH 侧身份 `SubagentAddress{ parentSessionId: parent_dsh_id, childSessionId: session_init_id }` 由父 transcript 内的记录天然给出、跨重启稳定。

**理由**：用户纠正——subagent 属于父会话 replay 的一部分，不是独立的会话索引；为它建 `subagents` 表/`origin` 列是过度设计（清单小、随父打开即得、sub-transcript 本就从父文件切）。schema 只保留 fork 的 `forked_from`（fork 是真正的独立新会话，需落库记父链）；subagent 桥接的解析/重放代码留给后续 change，届时在 replay 路径内实现，不动 schema。

## Risks / Trade-offs

- [`bun:sqlite` 是 Bun-only] → 运行时检测适配器：Node 分支 `node:sqlite`（现在跑），Bun 分支 `bun:sqlite`（迁移后自动生效）。若坚持现在就跑 `bun:sqlite`，须先安装 Bun 并把桥接层（或 dsh 宿主）迁到 Bun 运行时——更大工程，未列入本 change。
- [DB 唯一权威后，DB 丢失 = bridge 创建的真实 DSH id 无法恢复] → WAL + integrity_check + 迁移幂等；这是"db only"决策的固有代价（TUI 派生会话仍可重算）。
- [索引 freshness 非强一致（≤30s 窗口）] → 事件增量把 live 会话压到近实时；TUI 外建会话沿用已接受的 30s reconcile 语义。
- [完整元数据要求 = 新会话/冷变更全量读] → 仅发生在检测时（不在请求路径），且 held/live 会话跳过（事件增量持有）；冷会话变更低频。
- [`node:sqlite` 实验性] → 只用稳定 API 子集 + 接口隔离。
- [周期 reconcile 仍是 O(files) stat walk] → 只 stat + 只重读变更文件，且移到后台；请求路径 O(1) 索引查询。
- [`apps/omp-in-dsh` 继承] → 其桥接副本复用本实现，apply 阶段回归其 list/resume 路径。
