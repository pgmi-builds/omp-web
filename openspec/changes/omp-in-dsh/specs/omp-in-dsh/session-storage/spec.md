## Purpose

定义复合 session storage 的行为契约：单一 dsh `sessionPersistence` 槽位下，OMP 会话与原生会话各自的持久化归属、id 路由与列表合并。消费方是 dsh apiproxy 的 session.list/history/resume 路径与 Web UI 侧栏。

## ADDED Requirements

### Requirement: 按 id 路由的复合持久化

系统 SHALL 提供单一 `sessionPersistence` 服务，内部按会话 id 路由：OMP 会话的读取（列表、历史、恢复种子、导出）MUST 由扫描 OMP 原生会话 store 并按需回放得到；原生会话 MUST 落入 dsh 原生持久化后端。任一侧的持久化故障 MUST NOT 使另一侧的读写失败。

#### Scenario: 混合列表
- **WHEN** Web UI 请求会话列表且两侧都存在会话
- **THEN** 列表同时包含两类会话，各自以正确的标题、工作目录、时间戳呈现

#### Scenario: 原生后端故障不拖累 OMP 侧
- **WHEN** 原生持久化后端读取抛错
- **THEN** OMP 会话的列表与读取仍正常返回，故障仅以该侧的错误条目呈现

### Requirement: OMP 会话的唯一事实源

OMP 会话的 transcript MUST 以 OMP 原生 store 为唯一事实源；复合持久化 MUST NOT 为 OMP 会话另行维护一份可漂移的副本日志。对 OMP 会话的追加写入请求 SHALL 成为无操作（持久化由 OMP 自身完成）。

#### Scenario: 重启后历史一致
- **WHEN** dsh 实例重启后读取一个 OMP 会话
- **THEN** 呈现的历史与 OMP store 中的 transcript 完全一致，无重复、无丢失

### Requirement: 会话标识翻译

复合持久化对外呈现的 OMP 会话标识 MUST 为 Dash 会话 id；OMP 内部 id MUST NOT 泄漏到列表、历史、导出等对外面。入站 id 到 OMP 会话的翻译 MUST 与 agent-provider 的配对规则一致。

#### Scenario: 导出不泄漏内部 id
- **WHEN** 导出一个 OMP 会话
- **THEN** 导出内容中的会话标识为 Dash 会话 id，不包含 OMP 内部会话 id

### Requirement: 工作区归组

扫描发现的 OMP 会话 SHALL 依据其记录的工作目录归入对应 workspace；原生会话的归组行为 MUST 保持不变。

#### Scenario: 侧栏归组
- **WHEN** OMP 会话在 TUI 之外被创建（未经 Web UI create 路径）
- **THEN** 该会话最终出现在以其工作目录命名的 workspace 分组下，而非未分组桶
