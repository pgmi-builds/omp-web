## 1. Spikes（实现前打掉设计风险）

- [x] 1.1 S1 无 agent 的 entered session 的 mux 行为：本地起桥，`sessions.enter+announce` 一个无 agent 的影子并 append 事件，用 wscat/脚本连 `events.mux` 验证基线帧与增量帧到达；结论（含哑 agent 退路是否需要）记入 `docs/` 并回填 design.md 风险项
- [x] 1.2 S2 影子重建的 seq 收敛：物化影子→逐出→文件增长→重建，验证前端既有修复路径（序号缺口触发 history 重拉）收敛无重复渲染；结论记入 `docs/`
- [x] 1.3 S3 后台任务可见性：用 probe 脚本（参照 `docs/probe-omp-followup.mjs`）发起一个长时后台 async task，验证空闲期 `get_state`/`get_subagents` 能否反映其存活；结论记入 `docs/`

## 2. 侦测基建

- [x] 2.1 实现单遍 /proc 写 fd 收集器（一次扫描产出 全局外来持有文件→pid 映射，自家后代豁免沿用 `isDescendantOf`），以单元测试验证：外来持有、自家后代豁免、只读 fd 不计入 三类用例通过
- [x] 2.2 四个节奏旋钮（`OMP_STORAGE_RECONCILE_INTERVAL_MS`=30s / `OMP_FILE_FOLLOW_INTERVAL_MS`=5s / `OMP_TRANSITION_FOLLOW_INTERVAL_MS`=1s / `OMP_SHADOW_TTL_MS`=15min）解析与默认值，验证 `0` 关闭语义（TTL 除外）与非法值回退

## 3. 监督状态机与冷投影

- [x] 3.1 `src/supervisor.ts` 状态机骨架（cold/shadow/held/dual-hold/avoiding + 转移表），以状态转换单元测试覆盖 spec `lifecycle` 全部 Scenario
- [x] 3.2 影子物化/TTL：history 请求驱动 materialize、TTL 逐出、再物化标识稳定（配对复用 `pairing.ts`），验证：逐出后再查看 id 不变、投影可丢弃重建
- [x] 3.3 file-follow：stat (size,mtime) + fromByte 增量读 + 增量回放 append 到影子投影，验证：文件静默期零读取、增长后下周期推送、标题槽原地重写（size 不变）不误触
- [x] 3.4 转录内系统注记：进入外来持有时 append 合成注记事件、materialize 时按监督状态确定性重放、不写 OMP 文件；验证重开守护进程后注记复现
- [x] 3.5 badge 数据面：外来持有集合随 list 元数据与 reconcile/follow tick 输出，验证缓存态被新鲜扫描校正（badge 过期场景）

## 4. 热持有改造

- [x] 4.1 晋升复用对象：`resume()` 增加分支——存在影子时不再 `persistence.prepare` 重建，直接把 RPC 桥接到同一 session 对象并暂停 file-follow；验证晋升/降级往返后 seq 连续、无二次 `enter`
- [x] 4.2 teardown 落点：静默退出后按消费者落 shadow/cold；验证退出时 WebUI 仍打开的会话立即恢复推送
- [x] 4.3 五重静默重验：计时器 fire 时依次查本地三信号 + `get_state` + `get_subagents`（fail-soft），忙碌则重武装；`send()` 路径同步清表；验证 spec `lifecycle` 后台子代理在飞、prompt 抢边界 两个 Scenario

## 5. 独占三层门

- [x] 5.1 L1：avoiding 态 prompt 在 `resume()` 开头被监督状态提前拒绝（错误指明 hand-off 进行中）；验证消息不投递给 RPC
- [x] 5.2 L2/L3：spawn 前新鲜扫描（复用收集器，权威判据+缓存回写）与 spawn 后复查（发现即拆+报错）；验证 spec `exclusivity` 全部 Scenario，含 TOCTOU 收口用例
- [ ] 5.3 外来持有 prompt 守卫回归：围观态 prompt 走既有 promptError→toast 链且输入不置灰；浏览器手验 3081 端口前端表现

## 6. 双持有与避让

- [x] 6.1 双持有：外来 fd → 挂 1s 检测（复用增量读，判据=非我方发出的 user 记录），RPC/WebUI 照旧；外来 fd 消失 → 解除；验证"只看未写"与"解除回 held"两 Scenario
- [x] 6.2 避让 hand-off：外来 user 记录 → abort（空闲跳过）→ 五重/宽限 → 超时强杀 → 降级围观 + 注记 + badge；transition 节奏进出；验证 spec `lifecycle` 避让三 Scenario（干净退出、宽限强杀、避让期 prompt 拒绝）

## 6A. 内容侦测重构（omp 18 实证修订）

- [x] 6A.1 fd 前提失效取证：`docs/probe-fd-holder{,-resume}.mjs` 实测 TUI 与 RPC 均无持久写 fd；D5/D7/spec 三处工件同步修订
- [x] 6A.2 统一内容游标：`Entry.cursor {lastSeq,size,mtimeMs}`，onHeld/onHeldDisposed 锚定基线（历史 user 记录免疫），`#ingest` 单次重放同时驱动 shadow 增量推送与 held 只读侦测；去 dual-hold 角色与转移
- [x] 6A.3 内容触发：held 增量外来 user 记录 → 直接避让（≤ file-follow 间隔）；shadow 外部写入 → 一次性转录注记 + `diverged` badge（回合内去重）
- [x] 6A.4 L2 mtime 热点：spawn 前文件 mtime <2s 拒绝（活跃写者 best-effort），空闲 TUI 明示由内容侦测兜底
- [x] 6A.5 单测：`test/content-detection.test.mjs`（自家文本豁免/外来触发/历史免疫/标题槽重写重基线/无增长空转）5 用例通过

## 7. 回归与验证

- [ ] 7.1 `apps/omp-in-dsh` 回归：桥接层同源继承后，其会话创建/续聊/冷读路径全量回归通过（复用其既有测试入口）
- [ ] 7.2 端到端手验清单：TUI 占有拒绝、双持有围观、避让降级、断线重连全量 resync、影子 TTL 逐出，逐项在 3081 前端 + 终端双面操作确认
- [x] 7.3 `openspec validate session-supervisor` 通过，S1–S3 结论回填 design.md 风险项后定稿
