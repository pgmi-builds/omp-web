## 1. 存储基础（store 模块）

- [x] 1.1 新建 `apps/omp-webui/src/store/`：DB 访问接口（open/exec/prepare/run/get/all）+ 运行时检测适配器（Bun→`bun:sqlite` / Node→`node:sqlite`），验证内存库 CRUD 单测通过
- [x] 1.2 schema 建表：`sessions`（含 UI 字段列）、`workspaces`、`ui_state` + 全部索引，验证启动建表后 `PRAGMA integrity_check` 返回 ok
- [x] 1.3 查询接口：`list`/`byDshId`/`byOmpId`/`byFile`/`upsert`/`prune` + UI 字段 setter（`setArchived`/`setForkedFrom`/`setPreset`/`touchVisited`/`setWorkspaceOrder`/`getUiState`/`setUiState`），验证每个接口单测覆盖
- [x] 1.4 DB 生命周期：`OMP_BRIDGE_DB` 路径解析、WAL 模式、`integrity_check`、close，验证路径落在 OMP store 之内时拒绝、非法路径报错

## 2. 一次性迁移

- [x] 2.1 webui.json → DB 迁移（legacy `dashSessionId` + `permissionPreset` → 新 `dsh_session_id`/`permission_preset`），幂等，验证迁移后配对正确且二次启动不重复、不覆盖真实 DSH id

## 3. reconcile

- [x] 3.1 启动 warm pass：全量 scan + upsert，先于对外服务，验证冷启动首个列表即返回真实标题
- [x] 3.2 周期 reconcile：复用 30s 旋钮做 stat walk + diff + upsert/prune，验证 TUI 外建会话一个周期内入索引、删除文件被移除
- [x] 3.3 完整元数据提取：新会话/冷变更全量读（含 transcript 尾部模型），held/live 跳过，验证新会话 model 非空
- [x] 3.4 事件驱动增量：createAgent INSERT、模型切换 UPDATE `model_*`、teardown 最终 stat UPDATE，验证 live 模型切换即时反映（title 变更走 30s reconcile）

## 4. 消费方改造

- [x] 4.1 `pairing.ts` 改索引（`byDshId`/`byOmpId`），去掉 webui.json 读写，验证 `resolveEntryById` 不再触发 `scanOmpSessions()`
- [x] 4.2 `session-persistence-omp.ts` list/history/resume 冷读改索引，验证 list 请求不再触发全量 scan
- [x] 4.3 `permission.ts` preset 走 DB、webui.json 读写退役，验证冷读 preset 仍正确
- [x] 4.4 `supervisor.ts` reconcile 接索引（数据源换 DB），验证状态机与 file-follow 不回归
- [x] 4.5 `index.ts` 接线：boot warm pass + 迁移 + DB 生命周期挂载，验证启动无报错 + 冒烟通过

## 5. UI 字段与 workspace

- [x] 5.1 `archived` 字段 + `setArchived` + 默认列表过滤（触发端=上游 archive 事件，未接）
- [x] 5.2 `forked_from` 字段 + `setForkedFrom`（fork 本体被 createAgent 拒绝，字段先备）
- [x] 5.3 `agent_preset` 字段 + createAgent 写入（沿用 `agentPreset: "omp"`），验证 preset 落库
- [x] 5.4 `last_visited_at` + `touchVisited` + inspect/borrow 接线（refresh 优先服务 = 访问索引 + touchVisited）
- [x] 5.5 workspace 归组（按 cwd）+ `ungrouped` 哨兵 fallback（cwd NULL 不丢、上游归入 Ungrouped）
- [x] 5.6 `manual_order` + `sort_mode` 持久化 + list 排序（触发端=上游 reorder 事件，未接）

## 6. 回归与验证

- [ ] 6.1 `apps/omp-in-dsh` 回归其 list/resume 路径（桥接副本继承本实现），验证列表/续聊不回归
- [x] 6.2 端到端冒烟：冷启动 + TUI 外建会话入索引 + 模型完整 + preset 落库，逐项对照 specs 验证
