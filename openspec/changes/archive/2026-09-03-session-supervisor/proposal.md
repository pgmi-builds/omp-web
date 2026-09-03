## Why

桥接守护进程（omp-web，3081 端口）对 session 生命周期的管理仍是原始形态：idle teardown 只看单一 PID 视角、可能在 agent 仍有存活工作时处决 RPC 进程组（连同全部子 agent）；冷会话被 WebUI 查看后无任何推送通道，视图随即陈旧；独占只有一个 spawn 时点的单向检查（TOCTOU 敞口，持有期不设防）。OMP 上游已验证**无任何 session 锁机制**（transcript 为 plain `openSync(path,"a")`，标题槽头部原地重写），且约定不 patch 上游——TUI 与 WebUI 共享同一 session store 的前提下，守护进程必须自己成为生命周期与数据流的监督者。

## What Changes

- **session supervisor 状态机**：为 store 内每个会话引入 `cold → shadow → held →（dual-hold → avoiding）` 的监督状态机。shadow（冷投影）在被查看时物化并以 file-follow 驱动 mux 推送；held 由 RPC 事件流驱动；晋升（prompt → spawn → 复用同一 session 对象）与降级（teardown → file-follow 接管）零身份漂移。
- **五重静默重验**：idle teardown 触发时以本地流态 + `get_state`（isStreaming/isCompacting/queuedMessageCount）+ `get_subagents` 重验静默，不满足则重新武装而非处决；`send()` 路径同步清表。
- **双持有与避让**：持有期发现外来写 fd → 双持有（RPC 照旧 + 1s 检测扫描盯外来 user 记录）；外来 user 记录出现 → 避让（abort → 五重/宽限 → 强杀 → 降级围观），宽限超时强制退出。
- **三层 prompt 门**：supervisor 状态机（avoiding 提前拒绝）→ spawn 前新鲜 /proc 扫描（权威）→ spawn 后复查（TOCTOU 收口）。
- **独占侦测基建**：单遍 /proc 写 fd 收集器（一次扫描服务所有会话的 badge 与检查），杜绝按文件逐个全扫。
- **冷态新鲜度与通知**：5s file-follow（transition 模式 1s）+ 30s storage reconcile 解耦为独立旋钮；外来持有 badge + 转录内系统注记；输入框不置灰，沿用既有 promptError toast 守卫。
- 不改动 OMP 上游源码；不改动 dsh 上游源码（全部经既有 plugin 公共原语 `sessions.enter/announce/append` 与 mux 推送面完成）。

## Capabilities

### New Capabilities

- `session-supervisor/exclusivity`: 会话文件独占的全部侦测机制——单遍 /proc 收集器、spawn 前拒绝、spawn 后复查、持有期外来写者侦测、TUI 持有 badge 数据；明确"单向天花板"边界（保证自己不作第二写者 + 秒级发现外来写者，不做内核级执法）。
- `session-supervisor/lifecycle`: 监督状态机与全部转移——shadow 物化/TTL 逐出、懒 resume 晋升、五重静默退出的重验与重武装、双持有检测、避让 hand-off（abort/宽限/强杀）、三层 prompt 门的编排。
- `session-supervisor/cold-freshness`: 冷投影的推送契约——file-follow 增量回放经 mux 推送、seq 连续性、外来围观模式（badge + 系统注记）、节奏旋钮（30s/5s/1s/TTL）。

### Modified Capabilities

（无——`openspec/specs/` 尚无主规格；`omp-in-dsh` change 内的 `session-storage` capability 描述 id 配对与冷读，本 change 在其上叠加监督层，不修改其已定需求。）

## Impact

- **修改代码**：`apps/omp-web/src/`——`index.ts`（resume/create 的三层门与晋升分支）、`agent.ts`（idle 退出五重重验、send 清表）、`omp-store.ts`（单遍收集器）、`session-persistence-omp.ts`（memo 协同）；新增 supervisor 模块（状态机、file-follow、检测扫描、通知合成）。
- **波及**：`apps/omp-in-dsh` 近乎原样复用 omp-web 桥接层源码，本 change 的实现将同步被其继承——apply 阶段需回归其会话创建/续聊路径。
- **运行面**：四个新节奏旋钮（`OMP_STORAGE_RECONCILE_INTERVAL_MS` / `OMP_FILE_FOLLOW_INTERVAL_MS` / `OMP_TRANSITION_FOLLOW_INTERVAL_MS` / `OMP_SHADOW_TTL_MS`），默认 30s/5s/1s/15min，全部可被 `0` 关闭（除 TTL 外）。
- **风险**：影子投影复用上游公共原语，两个行为（无 agent session 的 mux 基线、seq 重建后前端收敛）未经实测——已列为 spike task，在实现前打掉。
