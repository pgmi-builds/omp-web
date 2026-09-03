## Purpose

定义守护进程对 OMP 会话文件的独占契约。OMP 上游无任何 session 锁（transcript 按写打开即关——omp 18 实证：TUI 与 RPC 均不持久持有写描述符；标题槽头部原地重写），且本仓库不 patch 上游；本 capability 界定单向天花板：桥 MUST 保证自己永远不成为第二个写者，并以外来写入内容为权威信号做到秒级发现——但不做内核级执法（不阻止 TUI 打开我方持有的文件）。进程表 fd 扫描仅作为辅助信号（通常为空）。

## ADDED Requirements

### Requirement: spawn 前拒绝活跃外来写入

桥 MUST 在为某个会话 spawn RPC 子进程之前执行双重前置检查并拒绝 spawn：（a）该会话文件被外来进程（非守护进程自身及其后代）以写方式持有（fd 扫描，强信号但通常为空）；（b）该会文件 mtime 距当前不足 2 秒（热点信号，指示存在活跃写者）。任一命中时 MUST 拒绝 spawn，错误 MUST 经由 WebUI 的 prompt 失败路径可见。空闲的外来 TUI（此刻未写文件）MUST 允许 spawn——其后续写入由持有期内容侦测兜底（见"持有期外来写入侦测"）。

#### Scenario: TUI 正在生成中
- **WHEN** 一个会话文件正被 TUI 持续写入（生成中），WebUI 用户对其发送 prompt
- **THEN** RPC 不被 spawn，用户收到指明文件近期被外部修改、建议稍后重试的错误提示

#### Scenario: 自家后代豁免
- **WHEN** 刚被 teardown 的桥子进程残留的描述符仍指向会话文件
- **THEN** 该残留不构成外来持有，同会话的再次 resume 不被拒绝

#### Scenario: 空闲 TUI 不被事前拒绝
- **WHEN** TUI 打开着会话但此刻未写入（mtime 冷）
- **THEN** WebUI prompt 正常 spawn；TUI 随后的写入在持有期内容侦测中被发现并触发避让

### Requirement: spawn 后复查收口 TOCTOU

spawn 完成后桥 MUST 复查一次外来 fd 持有；复查发现外来写者时 MUST 立即 teardown 新建的 RPC 并报错，MUST NOT 让双写继续。fd 复查在 omp 18 下通常为空（按写开关模型），其权威兜底为持有期内容侦测。

#### Scenario: 检查与 spawn 之间 TUI 恰好打开
- **WHEN** spawn 前检查干净，但 spawn 后复查发现 TUI 已持有写描述符
- **THEN** 新 RPC 立即被拆除，用户收到冲突错误，会话文件未被我方新增写入

### Requirement: 持有期外来写入侦测

会话处于热持有期间，守护进程 MUST 以 file-follow 节奏对其会话文件做增量内容侦测：越过持有基线游标新出现的 user 角色记录，其文本不在本守护进程已投递 prompt 集合（`knownUserTexts`）内，即为外来写入。发现时 MUST 触发避让（见 lifecycle）。基线 MUST 在进入持有时锚定于文件当前末尾，MUST NOT 将历史 user 记录误判为外来。

#### Scenario: TUI 接管我方持有的会话
- **WHEN** 桥的 RPC 正持有某会话，用户在终端以 TUI 打开同一会话并发送 prompt
- **THEN** 下一个 file-follow 周期内外来 user 记录被识别，会话进入避让

#### Scenario: 我方投递的 prompt 不误判
- **WHEN** WebUI 用户对我方持有的会话发送 prompt
- **THEN** 该 prompt 文本已记录于 `knownUserTexts`，不触发避让

### Requirement: 新鲜内容优先于缓存态

列表与 badge 中的外来写入态是建议性的（允许滞后于侦测周期）；增量内容判据（游标 + `knownUserTexts`）是权威判据。缓存态与新鲜侦测冲突时 MUST 以新鲜侦测为准，且结果 MUST 回写校正缓存态。

#### Scenario: badge 过期
- **WHEN** badge 显示外来写入，但后续侦测未再发现外来记录
- **THEN** 持有态不被扰动（避让不回退），badge 在下一回合重置

### Requirement: 侦测成本与规模解耦

辅助 fd 信号 MUST 以每个侦测周期一次的全局收集（单遍扫描系统进程表）计算并供全部会话共用，MUST NOT 随会话数量线性放大扫描次数。内容侦测 MUST 仅对文件发生增长（stat size/mtime 变化）的会话执行全量重放。

#### Scenario: 多会话并存
- **WHEN** store 内存在大量会话且多个处于 shadow/热持有态
- **THEN** 单个侦测周期的进程表扫描次数不随被监督会话数增长，重放仅发生在实际增长的文件上
