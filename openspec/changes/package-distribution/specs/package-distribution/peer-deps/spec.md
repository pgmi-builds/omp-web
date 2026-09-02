## Purpose

定义 peer 依赖契约：`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 是宿主 dsh 提供的模块，声明为 optional peerDependencies，使 npm 安装不强制拉取/冲突，运行时从宿主解析。

## ADDED Requirements

### Requirement: dsh-* 与 cordis 为 optional peer

`package.json` 的 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` peerDependencies SHALL 在 `peerDependenciesMeta` 中标记 `optional: true`。npm 安装本包时 MUST NOT 因这些 peer 缺失或版本不符而报错或强制安装副本。

#### Scenario: 宿主已装 dsh（任意 alpha 版本）

- **WHEN** user 已通过 dsh 安装器拥有 `@deepseek-ai/dsh-*`（如 alpha.1/alpha.2），再 `dsh plugin add @pgmi-builds/omp-web`
- **THEN** 安装成功，npm 不拉取 alpha.3 副本、不报 peer 版本冲突

#### Scenario: 运行时从宿主解析

- **WHEN** dsh 进程加载 omp-web provider
- **THEN** `@deepseek-ai/dsh-agent`/`dsh-llm`/`dsh-session` 等从 dsh 安装的 node_modules（或 profile fallback）解析，不依赖本包自带副本

### Requirement: peer 版本语义诚实

`@deepseek-ai/dsh-*` SHALL 使用精确 alpha 版本声明（`0.1.2-alpha.3`），`@deepseek-ai/cordis` SHALL 使用 `^4.0.1` 语义。两者均 optional，仅作类型/契约声明。

#### Scenario: 版本声明可读

- **WHEN** 阅读 `package.json` 的 peerDependencies + peerDependenciesMeta
- **THEN** 每个 `@deepseek-ai/dsh-*` 是精确版本且 optional，cordis 是 `^4.0.1` 且 optional
