## Purpose

定义守护进程对每个会话的监督状态机（cold / shadow / held / avoiding）及其全部转移契约：冷热投影的单一所有权、懒 resume 晋升、静默退出的五重重验、外来写入内容触发语义（omp 18：写者按写开关文件，无持久 fd 可侦，外来 user 记录为唯一权威触发信号）、避让 hand-off 与影子 TTL。消费方是 WebUI 前端（经 mux 推送感知状态）与守护进程自身的进程编排。

## ADDED Requirements

### Requirement: 状态机与投影唯一性

每个会话在任一时刻 MUST 处于且仅处于一个监督状态。热持有期间 RPC 事件流 MUST 是会话投影的唯一事件源；持有期间文件侧仅运行只读内容侦测（不向投影追加）；降级后 file-follow MUST 接管同一投影对象，身份与事件序号保持连续。

#### Scenario: 冷热切换无身份漂移
- **WHEN** 会话从影子晋升为热持有、后再降级为影子
- **THEN** 会话的对外标识不变，前端事件流无重基线断档

### Requirement: 懒 resume 晋升

影子/冷态会话收到用户 prompt 且无外来持有时，守护进程 MUST spawn RPC 并将其挂接到既有会话投影上（不重复进入注册表）；存在外来持有时 MUST 拒绝并经既有 prompt 失败路径反馈。

#### Scenario: prompt 触发懒 spawn
- **WHEN** 用户对影子态会话发送 prompt 且扫描无外来写者
- **THEN** RPC 被 spawn 并接管同一会话投影，前端无感切换为实时流

### Requirement: 静默退出五重重验

idle teardown 计时器触发时，守护进程 MUST 重验本地流态（非 streaming、无未发队列、无挂起审批）与 OMP 自证信号（`get_state` 的 isStreaming/isCompacting/queuedMessageCount、存活子代理）后才能 teardown；任一忙碌信号 MUST 重新武装计时器而非处决。发出用户 prompt 的路径 MUST 同步清除已武装的计时器。

#### Scenario: 后台子代理在飞
- **WHEN** 计时器触发时会话仍存在存活子代理或 OMP 自证忙碌
- **THEN** 不执行 teardown，计时器重新武装，进程组存活

#### Scenario: prompt 抢在计时边界
- **WHEN** 计时器即将到期时用户发出 prompt（RPC 尚未回报 agent_start）
- **THEN** 计时器被清除，该 prompt 不会被误杀

### Requirement: 外来写入内容触发语义

持有期间文件侧持续运行只读内容侦测，本身 MUST NOT 中断我方在途工作（RPC 与 WebUI 照常）；检测到外来 user prompt 记录（文本不在 `knownUserTexts` 内的增量 user 记录）时 MUST 直接触发避让，MUST NOT 依赖任何 fd 信号作为前置。

#### Scenario: TUI 只看未写
- **WHEN** TUI 打开着会话文件但从未输入
- **THEN** 我方 RPC 的在途工作不被打断，会话保持普通热持有

#### Scenario: TUI 输入触发避让
- **WHEN** 我方热持有期间文件中出现非我方发出的 user 消息记录
- **THEN** 避让程序在下一个 file-follow 周期内启动

### Requirement: 避让 hand-off

避让 MUST 依次执行：在途 turn 则 abort（空闲则跳过）、有限宽限内等待静默（复用五重判据）、宽限超时 MUST 强制 teardown。teardown 完成后会话 MUST 降级为外来持有的冷围观态。避让进行期间到达的用户 prompt MUST 被监督状态提前拒绝，MUST NOT 投递给垂死的 RPC。

#### Scenario: 宽限内干净退出
- **WHEN** 避让启动后在途 turn 被 abort 并到达静默点
- **THEN** RPC 被拆除，会话降级为围观态，文件侧增量继续推送给前端

#### Scenario: 宽限超时强杀
- **WHEN** 后台任务使会话在宽限期内无法到达静默点
- **THEN** 宽限期满后强制 teardown，接受丢失在途工具输出

#### Scenario: 避让期 prompt 被拒
- **WHEN** 避让进行中用户在 WebUI 发送 prompt
- **THEN** 立即收到指明 hand-off 进行中的错误，消息不进入 RPC

### Requirement: 影子物化与 TTL 逐出

影子 MUST 在会话被查看时物化、在超过 TTL 无查看消费时逐出；逐出与再物化 MUST 保持会话对外标识稳定（持久配对），投影可丢弃重建。

#### Scenario: 无人查看后逐出
- **WHEN** 影子态会话超过 TTL 未收到任何查看请求
- **THEN** 投影被拆除，会话回到冷态；再次查看时以同一标识重建

### Requirement: teardown 落点

干净 teardown（静默退出）完成后，会话 MUST 落到影子态（存在查看消费者）或冷态（无消费者）。

#### Scenario: 退出后仍被围观
- **WHEN** 静默退出完成时 WebUI 仍打开着该会话
- **THEN** 会话立即以影子态恢复 file-follow，前端持续收到推送
