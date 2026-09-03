## Purpose

定义 OMP 以共存型 agent provider 接入 stock dsh 实例的行为契约：复合 factory 路由、preset 贡献、与原生 agent 循环的边界与故障隔离。消费方是同一 dsh Web UI 里的终端用户与 apiproxy 会话创建/恢复路径。

## ADDED Requirements

### Requirement: 复合 agent factory 路由

系统 SHALL 在不替换原生 agent 循环的前提下，按会话的 preset 将 `ctx.agents` 的创建/恢复请求路由到对应运行时：preset 为 `omp` 的会话 MUST 由 OMP 运行时（spawn 独立 OMP 子进程并经 RPC 桥接）承接；其余 preset 的会话 MUST 由原生 agent 循环照常承接，行为与未安装本 plugin 的 dsh 实例一致。

#### Scenario: OMP preset 会话创建
- **WHEN** 用户在 Web UI 以 `omp` preset 新建会话并发送第一条消息
- **THEN** 该会话由 OMP 子进程 agent 承接，消息、工具事件、用量统计在 Web UI 中正常渲染

#### Scenario: 原生 preset 会话不受影响
- **WHEN** 用户以原生 preset（如 standard）在同一实例中新建并运行会话
- **THEN** 会话的创建、恢复、模型选择与工具执行行为与未安装本 plugin 时一致

#### Scenario: 路由失败不外溢
- **WHEN** OMP 运行时初始化失败（如 binary 缺失或 RPC 握手超时）
- **THEN** 仅该 OMP 会话创建请求失败并返回明确错误；原生 preset 会话的创建与运行 MUST 不受影响

### Requirement: 贡献式 agent preset

系统 SHALL 向 dsh 的 preset roster 贡献一个 `omp` preset，且 MUST NOT 移除、改名或改变任何原生内建 preset 的可见性与行为。Web UI 的新建会话模式列表 MUST 同时展示全部原生 preset 与 `omp` preset。

#### Scenario: preset 列表并列
- **WHEN** Web UI 请求 preset roster
- **THEN** 返回集合包含全部原生内建 preset 与 `omp` preset，且 `omp` preset 的名称/描述可被用户识别

#### Scenario: 会话 preset 不变性
- **WHEN** 用户尝试把既有会话切换到与创建时不同的 preset
- **THEN** 系统按 dsh 既有的 preset 切换约束处理；`omp` 会话与原生会话之间 MUST NOT 发生静默的运行时互换

### Requirement: OMP 会话身份与配对

OMP 会话 MUST 使用 Dash 会话 id 作为对外唯一标识；OMP 内部会话 id 与 Dash id 的配对关系 MUST 持久化在 OMP 会话 store 内的 per-session 工件中。恢复（resume）时系统 SHALL 依据该配对找回对应 OMP 会话文件；配对缺失时恢复请求 MUST 以明确错误失败，而非回退到错误会话。

#### Scenario: 按 Dash id 恢复 OMP 会话
- **WHEN** 用户在 Web UI 恢复一个 OMP 会话
- **THEN** 系统经配对定位 OMP 会话文件并继续该会话，历史消息完整呈现

#### Scenario: 未知 id 拒绝恢复
- **WHEN** 恢复请求携带的 Dash 会话 id 没有任何配对记录
- **THEN** 该请求失败并返回指示"无对应 OMP 会话"的错误

### Requirement: 排他与并发

当同一 OMP 会话文件已被其他 OMP 进程持有写句柄时，系统 MUST 拒绝对该会话的接入，并以持有进程信息明确报错；系统 MUST NOT 在两个进程间造成同一 transcript 的交叉写入。

#### Scenario: 外部进程占用
- **WHEN** OMP 会话文件被另一 OMP 进程打开写入时收到接入请求
- **THEN** 请求被拒绝并提示占用方进程，原有进程继续不受干扰
