## Purpose

定义冷态会话的推送契约：被查看的冷会话必须像热会话一样经 mux WebSocket 获得增量（前端无轮询通道），包括外来持有时的围观模式、状态变化的通知形态与节奏旋钮。

## ADDED Requirements

### Requirement: 冷投影经 mux 推送

被查看的冷会话 MUST 由 file-follow（按 follow 间隔对文件做 stat + 增量读取 + 增量回放）驱动，经既有 mux 推送面向前端投递增量；文件未变化时单周期成本 MUST 不超过一次元数据检查。前端 MUST NOT 需要新增任何轮询行为。

#### Scenario: TUI 写入实时围观
- **WHEN** 影子态会话的文件被外来进程追加内容
- **THEN** 下一个 follow 周期内增量被推送，前端视图更新

#### Scenario: 文件静默
- **WHEN** 会话文件在多个周期内无变化
- **THEN** 不产生任何读取回放，仅元数据检查

### Requirement: 外部写入的围观契约

会话检测到外部写入（增量外来 user 记录）时，视图 MUST 展示分歧 badge（`diverged`）；输入 MUST 保持可用，prompt 尝试 MUST 由既有 prompt 失败路径应答（含 toast 呈现），MUST NOT 引入新的输入禁用状态。

#### Scenario: 围观态输入
- **WHEN** 用户在外部写入中的会话里发送 prompt
- **THEN** 收到指明冲突或近期外部修改的错误提示（toast），输入框不置灰

### Requirement: 状态变化通知为转录内系统注记

检测到外部写入（围观态发现外来增量、或持有态触发避让）时，投影 MUST 携带一条转录内系统注记说明状态与原因；同一回合 MUST NOT 重复追加；注记 MUST NOT 写入 OMP 会话文件。

#### Scenario: 注记出现
- **WHEN** 围观态会话的文件被外部进程追加 user 记录
- **THEN** 投影在增量推送的同时出现一条指明外部写入、只读围观的系统注记

#### Scenario: 回合内不重复
- **WHEN** 同一围观回合内外部进程继续追加多条记录
- **THEN** 系统注记不再重复追加

### Requirement: 节奏旋钮解耦

storage reconcile（默认 30s）、file-follow（默认 5s，shadow 与 held 共用）、transition 模式 follow（默认 1s，避让期）、影子 TTL（默认 15 分钟）MUST 为相互独立的可配置项。transition 模式 MUST 在避让启动时进入，在 teardown 完成且经过一个稳定周期后退出。

#### Scenario: transition 模式升降
- **WHEN** 持有态会话检测到外来 user 记录触发避让
- **THEN** 该会话的 follow/检测节奏提升至 transition 档；teardown 完成一个稳定周期后回落默认档

### Requirement: 晋升与重建的序号连续性

晋升/降级 MUST 复用同一投影对象以保持事件序号连续；影子因 TTL 或重启重建时 MUST 以同一回放源重导出序号基线，使前端既有修复路径（序号缺口触发的历史重拉）可收敛。

#### Scenario: 重建后收敛
- **WHEN** 影子被逐出后重建，且文件在此期间增长
- **THEN** 前端检测到序号缺口并按既有机制重拉历史，视图收敛无重复渲染
