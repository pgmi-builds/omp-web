# dev_0.0.3 — 桥接层存储回退：删除 omp-sessions.json 中心化索引

> 阶段：**已实施（2026-08-24，as-built 注记随实施修订）** · 日期：2026-08-24
> 目标：恢复既定设计边界——**桥接层零中心化持久存储**，唯一例外为嵌在 OMP 原生
> session 目录内的 `webui.json`（v0.0.2 已确认范围；本版扩一个审计字段，见 §9）。
> 前置：`dsh-omp-provider.md`（Phase 0–5 与验收注记）、2026-08-24 incident
> `cannot find session ID`（session `01a03047-b4b5-77ab-b4b8-f6966b8fba5f`）。
> 原则回溯：`agent-harness/21_CLI-Agent/05_omp/dsh-omp-session-registry-bug.md`。
> **实施中发现原 P3 前提不成立**（Dash 与 OMP 的 id 从不同源；上游还有一道 resume
> 门禁），§2/§4/§6 按 as-built 修订，发现全记录在 §9。

---

## 1. 动机：v0.0.1 的自相矛盾

baseline commit `a65ff32` 的 message 声明：

> "No Dash-side session.jsonl: reads = scan + on-demand transcript replay, **writes = no-op**"

但同一 commit 里携带了：

| 机制 | 位置 | 违反点 |
|---|---|---|
| `OmpSessionIndex` → `~/.omp/dsh/omp-sessions.json` | `apps/src/session-index.ts` | 中心化 JSON 存储，**每次 createAgent / boot 都写** |
| `seedSessionIndex()` | `apps/src/session-persistence-omp.ts:71-82` | boot 时把 scan 结果**全量回填**进中心化索引 |
| `#reconcileWorkspaces()` + `attachSession()` | `apps/src/index.ts:105-147` | 写上游 `workspace.json`，制造 id 命名空间错位 |

"No Dash-side session.jsonl" 说的是不写 Dash 的 per-session 事件日志——它不等于、也不能推出
"可以有一个桥接层自己的中心化 JSON"。这是 Phase 3（2026-08-22，resume 实现）引入、随
baseline 快照封存的越界；`#reconcileWorkspaces` 则是给这个索引引发的命名空间错位打的补丁，
补丁又撞上上游 `sessionPath` 过滤（`dsh-workspace/lib/index.js:79`：`sessionPath(id)` 只认
Dash host 内存 Map 里登记过的 id），**静默丢弃** reconcile 挂载的原始 OMP id——最终产出
2026-08-24 的孤儿 session 事故。一层错补一层，全数拆除。

## 2. 设计原则（normative，本版本起固定）

- **P1 零中心化存储**：桥接层不拥有任何自己发起写入的持久文件。唯一例外：`webui.json`
  （per-session、嵌于 `<OMP-transcript-stem>/webui.json`、完全遵循 OMP 原生 session 目录
  约定，v0.0.2 确认范围）。
- **P2 reads = scan**：session 列表 / 冷历史 / resume 定位一律按请求扫描 OMP 原生存储
  （`scanOmpSessions()`，含 size+mtime revision 缓存），不引入第二事实源。
- **P3 单一 id 事实源**（as-built 修订）：**每个可 resume 的 id 都是 OMP id**。上游
  apiproxy 的冷 resume 路由（`dsh-api-remotes` `inspectApiRemoteSession`）只放行
  `sessionPersistence.list()` 列出的 id——即 scan 产出的 OMP id；Dash 侧自铸的
  `session-<uuid4>` id 在到达 factory 前就被 `session-not-found` 拒绝。因此 resume =
  `scanOmpSessions().get(id)` 命中或 fail-closed，不存在第二解析层。
  （原表述"Dash id ≡ OMP id 恒等"是误判，见 §9。）

## 3. 变更清单

| # | 文件 / 符号 | 动作（as-built） |
|---|---|---|
| 1 | `apps/src/session-index.ts` | **整文件删除**（`OmpSessionIndex`/`sessionIndex`/`withWriteLock`）✅ |
| 2 | `apps/src/index.ts` | 删 `sessionIndex` import；清理仅被 reconcile 使用的 `WorkspaceRegistry` import（`statSync` 另有 `validatedCwd` 使用，保留）✅ |
| 3 | `apps/src/index.ts` createAgent | 删 `sessionIndex.put(...)` 块；webui.json 写入改经 `writeWebuiArtifact(state.sessionFile, { dashSessionId: id, preset })`——preset + **dashSessionId 审计字段**（§9.3）✅ |
| 4 | `apps/src/index.ts` resume | `sessionIndex.get(id)` → `scanOmpSessions().get(id)` 单一解析；查无 → fail-closed throw（**无 legacy 代码回退**——上游门禁使其不可达，§9.2）✅ |
| 5 | `apps/src/index.ts` `#reconcileWorkspaces()` + 构造器调用点 | **整方法删除**。WebUI 工作区分组回归上游自身语义；桥接不碰 `workspaceRegistry` ✅ |
| 6 | `apps/src/session-persistence-omp.ts` | 删 `sessionIndex` import、`seedSessionIndex()` 调用与方法体（boot 回填写入点，P2 违规源头）✅ |
| 7 | `docs/smoke-resume.mjs` | 删 `omp-sessions.json` 读取。phase1 首条 prompt 带唯一 title 标记；phase2 按 `projections.values.title` 定位列表行（= 刷新后 WebUI 看到的 OMP id 行），以该 OMP id 冷读历史 + resume + follow-up；并断言 stale Dash id 被 `session-not-found` 干净拒绝 ✅ |
| 8 | `apps/src/permission.ts` | `writeWebuiPreset` → `writeWebuiArtifact`（多字段、原子写不变）；`readWebuiPreset` 语义不变 ✅。其余（`omp-store.ts`、`replay.ts`、`rpc.ts`、`agent.ts`）不动 |

## 4. Legacy 兼容（49 条 `session-` 前缀旧映射）

现状：49 条历史 Dash id（`session-` uuid4 格式 ≠ OMP id），28 条 OMP transcript 在盘、
21 条悬空。**as-built：冻结文件保留在盘、无任何代码读取**（原方案 A 的"resume 回退读
legacy"被上游门禁判死——dash id 根本到不了 factory.resume，§9.2；且 v0.0.1/v0.0.2 的
dash-id resume 同样从未通过，无回归）。legacy 会话照常以 **OMP id** 出现在列表并可
resume（实测 01a02e0f 以 OMP id 追加对话成功）。

- 一次性 `mv ~/.omp/dsh/omp-sessions.json ~/.omp/dsh/omp-sessions.legacy.json`（已执行，
  备份 /tmp）
- 文件语义 = 冻结的历史审计数据；上游 prune 掉对应会话后可整文件删除
- `webui.json.dashSessionId`（§9.3）接棒成为今后唯一的 Dash↔OMP 配对审计记录

## 5. 一次性数据清理（已执行，均有备份于 /tmp）

1. `omp-sessions.json` → `omp-sessions.legacy.json`；旧 `.bak-*` 移出 `DSH_HOME`
2. `workspace.json`：按"scan 可解析性"剪除 8 条死绑定（5 条 legacy dash id、2 条悬空
   transcript、1 条 `01a03047` 事故 append），保留 24 条活绑定，dashr 空行删除——
   **并同步剪除 `global.workspaceIds` 注册序**（漏剪会 `workspace domain is inconsistent`
   拒启，已踩平）
3. `~/.omp/dsh/` 面收敛核验：`profiles/`、`storages/`（上游）、`sessions/`（冻结 legacy
   jsonl，无写入者）、`omp-sessions.legacy.json`（冻结）；`omp-sessions.json` 未复活

## 6. 验收（acceptance，2026-08-24 全绿）

1. **incident 回放** ✅：浏览器驱动真实 WebUI——New Session → 一轮（INCIDENT-REPLAY-OK）
   → 刷新页面 → 会话仍在侧栏、历史完整回放（时间戳/统计/权限徽章）→ 继续 prompt 得
   INCIDENT-RESUME-OK，2 turns，无 toast
2. **冷 resume** ✅：smoke phase1（两轮）→ `systemctl --user restart omp-plus` → phase2
   13/13 PASS；`find -newer` 断言 `DSH_HOME` 无任何桥接自有文件新增/修改（storages/ 的
   upstream projection cache 写入除外）
3. **legacy** ✅：在盘 `session-` 会话（01a02e0f）以 OMP id prompt → resume + follow-up
   完成（7 轮全绿）；其 dash id 被上游干净拒绝（与 v0.0.2 行为一致）
4. **回归** ✅：模型选择器（llm.models 服务 OMP 组）、preset roster（"OMP" 单条目 +
   行内 `agentPreset:"omp"`）、权限面（webui.json preset 合成 → "Full access" 徽章）
   均正常；本版未触碰 tool 卡片代码路径
5. smoke ✅：`docs/smoke-resume.mjs` phase1+phase2 PASS（13 断言）

## 7. 风险

| 风险 | 处置 |
|---|---|
| OMP TUI 原生会话在 WebUI 失去工作区分组 | 实测**未失去**：boot 时上游以 `sessionPersistence.list()`（= scan）建 header 索引，workspace.json 里 24 条活绑定照常分组；只有 scan 覆盖不到的 cwd 才落 Ungrouped |
| 长开标签页持 stale Dash id 跨重启继续 prompt | 上游 `session-not-found` 干净拒绝（v0.0.1/0.0.2 同行为，非回归）；刷新一次即恢复 |
| legacy 28 条会话 | 以 OMP id 照常列出/resume（§4）；dash id 视图本就从未工作 |
| 上游 dsh rc API 漂移 | 既有风险，不变；本版把桥接对上游写入面收缩为零，漂移面减小 |

## 8. Out of scope

- TUI 原生会话的 WebUI 分组 feature（上游自有语义已够用，见 §7）
- `webui.json` 进一步内容扩展（`dashSessionId` 审计字段除外，§9.3）
- 上游 `sessionPath` 过滤器 / `inspectApiRemoteSession` 门禁的语义（那是 dsh-workspace /
  dsh-api-remotes 的事）

## 9. 实施记录：两个前提级发现

### 9.1 P3 原前提不成立：Dash 与 OMP 的 id 从不同源

原计划断言"Dash session id ≡ OMP session id（uuidv7 同源）"，佐证是索引里 38 条 identity
条目——但那些**全部**是 `seedSessionIndex()` 按 scan id 回填的 key，没有一条来自
createAgent 路径。实测（smoke phase1）：apiproxy `session.create` 一律自铸
`session-<uuid4>`（`dsh-host-apiproxy/lib/index.js:2496`，client 不带 id 时），OMP 子进程
另有自己的 uuidv7。**bridge 创建的会话从来就是双 id**，中心化索引是真实承重墙——但它
承的只是"dash id → OMP 文件"这一层，而这一层被 9.2 的门禁整个架空。

### 9.2 上游 resume 门禁：dash id 到不了 factory

`dsh-api-remotes` `createApiRemoteAgentResolver` → `agentFor(sessionId)` → 冷路径先
`inspectApiRemoteSession`：`persistence.list().find(id)` 未命中即抛
`ApiRemoteSessionNotFound`（wire 上即 `session-not-found`）。persistence list = scan =
OMP id 全集 ⇒ **任何 dash id（旧 49 条、新 bridge 条、fork 子 id）在 Phase B 之后从未
到达过 `factory.resume`**。原计划的 legacy 回退、以及实施中途尝试的 webui.json 配对
resume，都死在同一门禁上——已全部拆除，resume 收敛为 scan 命中或 fail-closed。

### 9.3 保留物：`webui.json.dashSessionId` 审计字段

createAgent 仍写 per-session `webui.json`（P1 例外文件），内容从 `{permissionPreset}`
扩为 `{dashSessionId, permissionPreset?}`。**同日修订**：§10.2 的 live-twin 去重成为
dashSessionId 的第一个读取方（resume 语义仍只认 preset 字段）；它同时仍是盘上唯一的
Dash↔OMP 配对取证记录。

## 10. 同日修订（实施后复审，2026-08-24 下午）

用户复审提出的两项修正 + 随之暴露的一个新事实，均已实施/验证：

### 10.1 warmProjectionCache 全量拆除（boot + 60s）

上游 WebUI 本就自愈：无 title 的行以 cwd basename 兜底显示（如 `.dsh`），用户点开后
cold-read ladder（cached row → readFrom tail → restore → **durable write-back**）回填
projection 行，下次列表即带真 title——3080 原生与 3081 桥接行为一致（实测确认）。
预热的全部价值（未点开会话的侧栏 title 预填）不值得它的成本（每 60s 对变化会话全量
replay transcript）。拆除后 smoke 发现机制同步改为 **transcript store 直查 marker**
（store 即事实源，不再依赖 projection title）。

### 10.2 list() live-twin 去重

拆除预热后暴露的次生问题：bridge 会话 live 期间**同一会话出现两行**——live dash-id 行
（上游 live registry）+ scan OMP-id 行（transcript 落盘即入列）。修正：`list()` 对
webui.json 记录了 dashSessionId 且该 Dash 会话仍 live 的 scan 条目**隐藏**，agent
disposal 后自动回归（OMP id 行）。list 仍为纯 scan 读 + 每条目一次 webui.json 读取，
无新增持久状态。

### 10.3 新事实：workspace 持久 attach 存的是短命 dash id

原生 attach 流程在 apiproxy `create` 内（L2539 `workspace.attachSession(sessionId)`），
存入 `workspace.json` 的是 **dash id**。agent 死亡（10min idle teardown，
`OMP_IDLE_EXIT_MS` 默认 600_000）后该绑定随 live registry 一起失效——
`sessionPath(dashId)` 无从解析 → 会话的 scan 行失去分组 → 落入 **Ungrouped（无 title，
cwd basename 兜底）**。v0.0.2 的 boot-reconcile 一直在掩盖此点（它在重启时按 OMP id
重挂）。v0.0.3 接受此形态：行仍可发现、可续聊（实测：Ungrouped 点击 → 历史回放 +
title 自愈 + follow-up 完成），durable attach 应键持久 id 属上游语义，非桥接层职责——
与 §7 第一行风险处置一致。

### 10.4 用户原始 bug（"Cannot find Session ID"）终审

机制链完整坐实：WebUI 新建会话 → apiproxy 铸 dash id → live 期间一切正常（live row +
原生 workspace attach）→ **10min idle** 桥接层拆除 omp 子进程（资源必要性：每个 idle
agent 钉死一个完整 `omp --mode rpc` 进程；上游注释"tearing down costs nothing
observable"对 dash id 不成立）→ SPA 仍持 dash id → prompt → 上游门禁（§9.2）拒绝 →
`session-not-found`。**桥接层无法修复**（dash id 到不了 factory）；自愈路径：刷新或经
侧栏行（OMP id）重进，均实测通过。窗口可经 `OMP_IDLE_EXIT_MS` 调大，根因修复属上游
（create 采纳 factory 注册 id，见 §9.1/§9.2）。
