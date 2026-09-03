## Purpose

定义 plugin 的 OMP 运行时来源契约（v1）：复用同机器上已安装的原生 OMP 实例（PATH `omp`、共享 `~/.omp` state），与原生 TUI 共存共用同一会话 store；隔离式自带运行时作为后续可选模式保留。消费方是 plugin 安装器、dsh 实例运维者与原生 OMP 用户。

## ADDED Requirements

### Requirement: 复用本机已安装 OMP

plugin MUST 以机器上已安装的 OMP 可执行文件（PATH `omp`，或部署配置指定的绝对路径）spawn OMP 子进程，MUST NOT 要求 plugin 包自带 OMP 可执行文件或其构建链。当指定路径的 OMP 不存在或不可执行时，OMP 会话创建 MUST 以明确的错误失败并指明缺失的依赖。

#### Scenario: 依赖原生安装
- **WHEN** 机器上装有原生 OMP 且 plugin 配置指向它
- **THEN** OMP 会话正常创建运行，全程不读取 plugin 包内的任何 OMP 产物

#### Scenario: 原生安装缺失
- **WHEN** 配置指向的 OMP 可执行文件不存在
- **THEN** OMP 会话创建失败并返回指明"缺少本机 OMP 安装"的错误，原生 dsh 会话不受影响

### Requirement: 版本握手

plugin SHALL 在 OMP 子进程 RPC 握手阶段校验其运行时版本与桥接层声明的兼容范围；版本超出范围时 MUST 拒绝创建会话并报出实际版本与期望范围，MUST NOT 以未验证版本静默运行。

#### Scenario: 版本不匹配拒绝
- **WHEN** 本机 OMP 升级到桥接层未验证的大版本
- **THEN** OMP 会话创建被拒绝，错误信息包含实际版本与兼容范围，用户可自行决定是否放宽配置

### Requirement: 与原生 OMP 共享 state 且互不破坏

OMP 会话（Web UI 创建）与原生 OMP（TUI）MUST 共享同一 state 根（`~/.omp`）与会话 store；两者对同一会话文件的并发写入 MUST 被排他检查阻止（见 agent-provider 的排他要求）。plugin MUST NOT 修改原生 OMP 的全局配置语义（模型角色、审批默认等配置文件的既有含义保持不变）。

#### Scenario: TUI 与 Web UI 会话互见
- **WHEN** 经 Web UI 创建并结束的 OMP 会话
- **THEN** 原生 TUI 的会话列表可见并可恢复该会话，反之亦然

#### Scenario: 配置共享
- **WHEN** 用户经任一途径调整 `~/.omp` 配置（如模型角色）
- **THEN** 另一途径的后续会话按新配置运行，无隐藏副本

### Requirement: 隔离模式保留为配置开关

plugin SHALL 将「OMP 可执行文件路径」与「state 根」实现为部署配置参数；后续引入隔离式运行时（自带 binary + state 重定向）MUST NOT改变桥接层与 factory/persistence/catalog 等其余组件的结构。

#### Scenario: 切换到隔离运行时
- **WHEN** 部署配置将可执行文件指向 plugin 自带 binary 并重定向 state 根
- **THEN** 其余组件无需修改即可按隔离模式运行（该模式的首版验收不在本 change 范围）
