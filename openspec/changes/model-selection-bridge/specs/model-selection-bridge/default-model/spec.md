## Purpose

跟踪 OMP 配置（`config.yml` 的 `modelRoles.default`）中的默认模型，并同步到 DSH 的 agent default model（`ctx.agentDefaultModel`），作为 new session 的默认模型来源，使 Web UI 新建会话的初始模型与 OMP TUI 的「default for new session」语义一致。

## ADDED Requirements

### Requirement: default model 跟踪

系统 SHALL 从 OMP 配置（`~/.omp/agent/config.yml` 的 `modelRoles.default`）读取默认模型的 provider/model，并持久化到桥接层 store 的 `default_model` 字段。当 `modelRoles.default` 缺失时，`default_model` MUST 保持为空，不得回退到任意硬编码值。

#### Scenario: default role 已配置

- **WHEN** OMP 配置中 `modelRoles.default` 指向某个 provider/model（如 `kimi-plan/kimi-k3`）
- **THEN** 桥接层 store 的 `default_model` 字段记录该 provider/model

#### Scenario: default role 缺失

- **WHEN** OMP 配置中不存在 `modelRoles.default`
- **THEN** `default_model` 字段保持为空，不写入任何默认值

### Requirement: 同步到 agent default model

系统 SHALL 把跟踪到的 default model 同步到 DSH 的 `ctx.agentDefaultModel`（经 `saveSelection`），使 Web UI 经 `currentSelection()` 读取到的默认模型与 OMP 配置一致。同步 MUST NOT 影响已运行会话的模型选择。

#### Scenario: 新会话使用跟踪到的默认模型

- **WHEN** 用户创建新的 OMP 会话
- **THEN** 该会话的初始模型选择来自 `ctx.agentDefaultModel` 的当前默认值（即跟踪到的 `modelRoles.default`）

#### Scenario: 已运行会话不受默认同步影响

- **WHEN** default model 同步发生时存在已运行的 OMP 会话
- **THEN** 已运行会话的模型选择保持原值，不被同步动作覆盖

### Requirement: 扫描节奏更新

系统 SHALL 按桥接层既有 persistent-storage 扫描节奏更新 `default_model`，而非在每次 new session 时重新读取 config.yml。当检测到 `modelRoles.default` 变化时，系统 MUST 更新 store 字段并触发一次 `ctx.agentDefaultModel` 同步。

#### Scenario: default 变化后按节奏收敛

- **WHEN** OMP 配置的 `modelRoles.default` 发生变化
- **THEN** 下一个扫描周期内 `default_model` 与 `ctx.agentDefaultModel` 收敛到新值，之后创建的新会话使用新默认模型
