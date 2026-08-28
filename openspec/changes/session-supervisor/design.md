## Context

桥接层现状（见 proposal.md - Why）：`index.ts` 的 `resume()` 已有 spawn 前 `foreignWriterPid` 拒绝；`agent.ts` 的 idle 退出为单计时器、fire 时仅查本地 `#streaming`；冷读走 `session-persistence-omp.ts` 的 (size, mtime) 记忆化回放，无推送。上游事实（已核实）：OMP transcript 为 `openSync(path,"a")` 无锁、写后错误降级不退出、RPC 协议提供 `get_state`（isStreaming/isCompacting/queuedMessageCount）与 `get_subagents`；dsh 的 `sessions.enter/announce` 是公共跨包原语，mux 推送由 session 事件总线驱动、与 agent 存在与否无关（agent 参数可选）；前端为纯 WS push、断线全量 resync、prompt 失败已自动 toast；同 id 二次 `enter` 抛错。ID 配对（`pairing.ts`）持久且 1:1，uuid 版本位防碰撞，丢失可再生。

## Goals / Non-Goals

**Goals:**

- 每会话一个监督状态机，冷热投影共用一个 session 对象与一条事件序号
- 误杀归零：teardown 前以 OMP 自证信号重验，避让止损有界
- 冷会话获得与热会话同构的 mux 推送，零前端轮询、零上游改动
- 全部侦测共享单遍 /proc 收集器，成本与会话数解耦

**Non-Goals:**

- 阻止 TUI 打开我方持有的会话（单向天花板；不做 fanotify/内核执法、不 patch OMP）
- 双写发生后的转录修复（检测即止损，修复交给人工/上游工具）
- 前端 UI 改动（badge 渲染、toast 均走既有数据面与失败路径）
- `omp-in-dsh` 侧的专门适配（桥接层同源，自然继承，回归即可）

## Decisions

### D1: 监督状态机放桥内新模块，状态挂到会话而非注册表

`src/supervisor.ts` 持有 per-session 状态（cold/shadow/held/dual-hold/avoiding）与全部转移逻辑；上游 `ctx.sessions`/`ctx.agents` 注册表保持原语义不动。理由：上游 `enter()` 同 id 抛错是既有冲突边界，扩展注册表需改上游；而状态机的全部输入（RPC 流事件、/proc 收集器、follow tick）都在桥内。替代方案（扩展上游注册表记录冷/热角色）被否：违反"改动只在本仓"的边界，且状态机的输入源不在注册表所在层。

### D2: 晋升/降级复用同一 Session 对象（影子常驻投影）

shadow 物化时 `enter + announce` 一次；晋升 = 暂停 file-follow、把 RPC 桥接到**同一**对象；降级 = dispose agent、file-follow 从当前文件偏移续读。不再在 resume 里 `persistence.prepare` 重建。理由：同 id 二次 `enter` 抛错（上游已核）；复用对象使 seq 天然连续，前端无感。替代方案（每次冷热切换重建对象+重基线）被否：seq 重启依赖前端修复路径收敛，把常态路径建在未实测行为上。

### D3: file-follow 与外来侦测共用一个 tick 循环，节奏分档

每会话一个 follower：stat 检查 (size, mtime)，增长则增量读取 + 增量回放 append 到投影；外来 user 记录检测（双持有期）复用同一增量读，判据为"非我方发出的 role:user 记录"。节奏三档：默认 5s / transition 1s / 全局 reconcile 30s，独立旋钮。理由：检测与新鲜度读的是同一批字节，分两个循环会双倍 IO；/proc 收集器是独立单遍（供 badge 与 spawn 门共用），不与文件 tick 耦合。备选 fs.watch（inotify）即时唤醒留作后续优化，v1 纯轮询（防丢事件、实现面小），检测延迟 ≤1s 可接受。

### D4: teardown 重验 = 本地三信号 + OMP 自证两组

计时器 fire 时依次查：本地（!streaming、无未发队列、无挂起审批）→ `get_state`（isStreaming/isCompacting/queuedMessageCount）→ `get_subagents`（存活子代理；总线不可用则跳过，fail-soft）。任一忙碌 → 重新武装。`send()`/`#beginActivity` 路径同步清表。理由：进程内活动（线程态的后台任务、compaction）在 /proc 进程树里不可见，OMP 自证是唯一权威；本地信号先查可省一次 RPC 往返。避让复用同一判据但语义不同：静默退出耐心（无限重武装），避让止损（宽限超时强杀）。

### D5: 避让触发判据 = 增量外来 user 记录（omp 18 实证修订）

**omp 18 实证（2026-08-28）**：会话写入器按写打开即关（`docs/probe-fd-holder{,-resume}.mjs` 实测：TUI 与 `--mode rpc` 均不持久持有写 fd），17.4 时代"持久 `openSync("a")` 描述符"的前提消失——fd 扫描对空闲与运行中的 TUI 均无信号。修订：外来检测的主判据改为**内容增量**——越过持有基线游标新出现的 user 记录，文本不在 `knownUserTexts`（我方投递集合）内即外来，直接触发避让（≤ file-follow 间隔，无 dual-hold 中间态）。fd 扫描保留为辅助 badge 信号与 L2 强信号（omp 若回退持久 fd 即自动生效）。基线在 onHeld/onHeldDisposed 锚定文件末尾，杜绝历史 user 记录误判。判据可靠：我方发出的每条 user 消息（含远端排队回投）都在投递前记入 `knownUserTexts`。空闲态触发时跳过 abort 直杀——其内存上下文已与文件未来分叉，保留只会以陈旧上下文应答后续 prompt。

### D6: 通知走转录内系统注记，不新增前端通道

状态切换（进入外来持有）向投影 append 一条合成系统注记事件；materialize 时按监督状态确定性重放（不写 OMP 文件）。交互守卫复用既有 promptError→toast 链。理由：服务端→toast 无既有接线（`notify()` 为客户端内部驱动）；注记留痕优于 toast 蒸发；零上游改动。badge 数据随 list 元数据由 30s reconcile 与 5s 收集器喂。

### D7: 三层 prompt 门收敛在 resume() 开头

L1 supervisor 状态（avoiding → 提前拒绝）；L2 spawn 前新鲜 /proc 扫描（fd 强信号）+ 文件 mtime 热点（<2s，活跃写者 best-effort 拒绝）；L3 spawn 后 fd 复查（TOCTOU 收口，发现即拆）。空闲 TUI 无法事前拒绝（无任何可观测信号）——其首条写入由持有期内容侦测在 ≤ file-follow 间隔内发现并避让，这是单向天花板的诚实边界。上游 resolver 先短路 live agent，故 held 态 prompt 不进工厂，门天然只在冷路径生效。

## Risks / Trade-offs

- [无 agent session 的 mux 基线/推送行为未实测] → spike S1 先行打掉；若上游对 agent-less session 不发基线，退路是 materialize 时同时挂一个无循环的哑 agent 句柄（仍在本仓内）。
- [影子重建后前端 seq 收敛未实测] → spike S2；D2 已把常态路径（晋升/降级）做成不重建，重建仅 TTL/重启后发生，且前端有既有修复路径兜底。
- [后台任务在 get_subagents 的可见性未验证] → spike S3；若不可见，误杀窗口收窄至"纯线程态后台任务静默期"，由宽限重武装兜底（永不强杀于静默退出路径）。
- [编辑器（vim 等）以写模式追加 jsonl 触发内容避让] → 接受（频率低）；判据只认 user 记录文本，编辑器写坏行不会被 replay 解析为 user 记录，天然免疫。
- [空闲 TUI 无法事前拒绝，首条外来写入前存在双写窗口] → 刻意接受的权衡：无内核执法下不存在无信号检测；窗口被内容侦测限制在 ≤ file-follow 间隔（默认 5s）。
- [相同文本双发（WebUI 与 TUI 发同一句）不可分辨] → 文本键判据的已知盲区，频率低，接受。
- [omp-in-dsh 同源继承引入回归] → apply 阶段对其会话创建/续聊路径做回归，单独任务覆盖。

## Migration Plan

纯增量：新模块 + 既有文件内改造，无数据迁移（配对身份不变）。部署 = 更新 systemd 服务的 bundle 并重启守护进程；回滚 = 上一版本 bundle + 默认旋钮清零（follow=0 时退化为现行为，冷态无推送但不报错）。OMP_IDLE_EXIT_MS 既有语义不变，五重重验只收紧其 fire 条件。

## Open Questions

- 影子 TTL 与 idle-exit 的数值关系（默认 15min vs 30min）——实测后微调，不影响结构。
- transition 模式"稳定周期"的界定（一个 follow tick 还是 N 秒）——实现时定，规格语义不变。

## Spike 结论（已回填）

| 风险 | 结论 | 证据 |
|---|---|---|
| S1 无 agent session 的 mux 推送 | ✅ 基线帧 + 逐事件 `session/event` 帧均推送，零上游改动 | `docs/s1-s2-mux-shadow.md` |
| S2 影子重建 seq 收敛 | ✅ 重建重发基线，客户端按 lastSeq 落后即重拉收敛；D2 使常态路径不重建 | 同上 |
| S3 后台任务可见性 | ✅ `get_subagents` 返回 subagent 事件总线存活集（含后台 task）；命令契约经 live 探针确认 | `docs/probe-omp-idle-signals.mjs` |
