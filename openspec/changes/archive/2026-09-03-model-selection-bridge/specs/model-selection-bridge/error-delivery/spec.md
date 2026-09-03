## Purpose

把 OMP 的 LLM completion failure 分类并投递到 DSH 的 per-turn error 入口（`turn/end` reason），使 Web UI 渲染可读的错误提示；桥接层不参与 DSH 原生的 step 级 retry/fallback 机制。

## ADDED Requirements

### Requirement: failure 分类

系统 SHALL 把 OMP `stopReason:"error"` 的 assistant 消息分类为 `AUTH`/`RATE_LIMIT`/`QUOTA`/`SERVER`/`UNKNOWN` 中的一种 code，并携带可读 message。usage/quota/billing 措辞 MUST 优先于通用 HTTP 状态映射。

#### Scenario: 配额/用量耗尽

- **WHEN** OMP 返回含 usage limit / quota / billing 措辞的错误（如 kimi 的 403 weekly usage limit）
- **THEN** 分类 code 为 `QUOTA`（配额超限），message 保留 OMP 原始措辞

#### Scenario: 认证/权限失败

- **WHEN** OMP 返回 HTTP 401 或 403 且不含 quota/usage 措辞
- **THEN** 分类 code 为 `AUTH`

#### Scenario: 限流

- **WHEN** OMP 返回 HTTP 429
- **THEN** 分类 code 为 `RATE_LIMIT`

#### Scenario: 服务端错误

- **WHEN** OMP 返回 HTTP 5xx
- **THEN** 分类 code 为 `SERVER`

### Requirement: 投递到 turn/end reason

系统 SHALL 把分类后的 failure 投递到该 turn 的 `turn/end` 事件 reason（`{kind:"error", error:{message, code}}`），使 Web UI 经其自有错误路径渲染（红色错误提示），而非渲染空 assistant bubble。

#### Scenario: completion 失败在 turn 内呈现

- **WHEN** OMP 的某个 turn 以 completion failure 结束
- **THEN** 该 turn 的 `turn/end` reason 为 error 且携带分类后的 message/code，Web UI 渲染可读错误

### Requirement: 不参与原生 retry/fallback

桥接层 SHALL NOT 参与 DSH 原生的 `llm-retry`/`llm-fallbacks` 机制（那是原生 AgentLoop 的 step 级重试/降级；桥接层经 RPC 只能观测 per-turn 颗粒度，无法侵入式干预 OMP 运行时）。

#### Scenario: completion 失败不触发原生降级

- **WHEN** OMP 的 completion 失败（如 403）
- **THEN** 桥接层不触发 DSH 的 `llm-retry`/`llm-fallbacks`，直接把 failure 投递到 `turn/end`，由用户在 Web UI 看到错误后自行切换模型重试
