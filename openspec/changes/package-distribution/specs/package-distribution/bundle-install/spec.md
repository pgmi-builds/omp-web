## Purpose

定义 `dsh plugin add @pgmi-builds/omp-web` 的「安装即挂载」契约：bundle patch 自包含地挂载 OMP provider 并禁用与 OMP 冲突的原生组件，使一条命令安装后启动即可用，无需手写 profile 配置。

## ADDED Requirements

### Requirement: bundle patch 挂载 omp-provider

包的 `dsh.bundle.patch` 层 SHALL 声明一个 `insert` 挂载 `omp-provider` entry，其 `name` 等于 registry 包名（`@pgmi-builds/omp-web`）。`dsh plugin add` reconcile 后，该 entry MUST 出现在 profile 的有效 entry 列表中。

#### Scenario: registry 安装后自动挂载

- **WHEN** user 在 profile 上执行 `dsh plugin --profile <name> add @pgmi-builds/omp-web`
- **THEN** 启动该 profile 时 `omp-provider` 被挂载，OMP provider 注册到 `ctx.agents`，无需 user 手写任何 `insert` 行

### Requirement: bundle patch 禁用冲突原生组件

bundle patch 层 SHALL 禁用 OMP provider 替换掉的原生组件：`agent-loop`、`llm-deepseek`、`llm-pi-ai`、`agent-presets`、`session-persistence-jsonl`。安装后启动，这些原生组件 MUST NOT 与 OMP provider 同时挂载（避免原生 loop 与 OMP 双跑、原生 model 与 OMP 模型目录混排）。

#### Scenario: 禁用原生 loop 与 model selector

- **WHEN** omp-web bundle patch 被应用
- **THEN** `agent-loop`、`llm-deepseek`、`llm-pi-ai`、`agent-presets` 均 disabled，profile 呈现 OMP-only 语义

#### Scenario: 权限默认对齐 OMP 原生

- **WHEN** omp-web bundle patch 被应用且 user 未覆盖 `permission`
- **THEN** `permission.defaultPreset` 为 `danger-full-access`（对齐 OMP 原生 yolo 默认），且 3-preset 表完整保留

### Requirement: profile 特定配置不进 bundle patch

bundle patch 层 SHALL NOT 硬编码 profile 特定值（`webserver.port`、`settings.path`、`agent-default-model`）。这些值 MUST 由 user 的 profile patch 层或运行时 env 决定，bundle patch 不为其写死绝对值。

#### Scenario: 端口与 settings 不硬编码

- **WHEN** omp-web bundle patch 被应用
- **THEN** bundle patch 不含 `webserver.port` 字面量、不含任何绝对文件系统路径、不含 `agent-default-model` 的静态 provider/model 值
