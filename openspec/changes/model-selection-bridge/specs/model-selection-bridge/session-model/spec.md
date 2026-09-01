## Purpose

提取 OMP 会话的 last used model（剔除 fallback 模型），供 Web UI 呈现 resume 会话「下一个 user prompt 将使用的模型」，使呈现的模型与 OMP `--resume` 实际恢复的模型一致。

## ADDED Requirements

### Requirement: 剔除 fallback 的 last used model 提取

系统 SHALL 从 session transcript 的 `model_change` 记录中提取最后一个非 fallback（`role` 非 `"fallback"`，即非 EPHEMERAL）的模型，作为该会话的 last used model。系统 MUST NOT 把 fallback 触发的模型切换（`role:"fallback"`、`resolvedModelIsFallback:true`）当作 last used model。

#### Scenario: 会话发生过 fallback

- **WHEN** session transcript 的最后一个 `model_change` 是 fallback 切换（`role:"fallback"`，如 kimi 403 后切到 deepseek）
- **THEN** last used model 提取为该 fallback 之前的 primary 模型（如 kimi），而非 fallback 后的模型（deepseek）

#### Scenario: 会话无 fallback

- **WHEN** session transcript 的 `model_change` 记录均为非 fallback 切换
- **THEN** last used model 提取为最后一个 `model_change` 的模型

#### Scenario: 无 model_change 记录

- **WHEN** session transcript 中不存在任何 `model_change` 记录
- **THEN** last used model 为空，不写入任意硬编码值

### Requirement: 呈现 resume 会话的 next prompt 模型

系统 SHALL 把提取到的 last used model 作为独立字段提供给 Web UI，使 resume 会话呈现的「next prompt 模型」与 OMP `--resume` 实际恢复的模型一致，Web UI 无需重新扫描 session history。

#### Scenario: resume 会话呈现正确的模型

- **WHEN** 用户恢复一个 OMP 会话（包括曾发生过 fallback 的会话）
- **THEN** Web UI 呈现的 next prompt 模型等于该会话提取到的 last used model，与 OMP `--resume` 实际恢复的模型一致
