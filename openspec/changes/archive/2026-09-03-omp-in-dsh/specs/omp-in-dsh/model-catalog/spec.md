## Purpose

定义 OMP model catalog 在 stock dsh 实例中的注册生命周期与选择契约：活跃期动态注册（`omp/` 命名空间）、factory 原生分支的 seed 消毒、生成路径永不跨界。消费方是 Web UI 会话模型选择器（per-session 动态目录）与 OMP 会话的模型切换路径。

## ADDED Requirements

### Requirement: 活跃期动态注册

`omp/` 命名空间的 provider 条目 MUST 仅在存在存活 OMP 会话期间注册于宿主 LLM catalog：首个 OMP 会话创建/恢复成功时注册，最后一个 OMP 会话结束后注销。注册状态变化 MUST 经宿主的 adapter 更新事件广播，使已打开的会话选择器自动收敛。无存活 OMP 会话时，宿主 catalog 与 provider 目录 MUST NOT 出现任何 `omp/` 条目。注册条目 SHALL 仅服务目录/元数据查询。

#### Scenario: 无活跃会话时零暴露
- **WHEN** 没有任何存活的 OMP 会话
- **THEN** 宿主 catalog 与 provider 列表不含 `omp/` 条目，原生选择器与设置页照常呈现

#### Scenario: 会话存活期间可选中
- **WHEN** OMP 会话存活且用户打开该会话的模型选择器
- **THEN** 选择器呈现 `omp/` 分组并可选择，选择校验通过

#### Scenario: 会话结束后自动收敛
- **WHEN** 最后一个 OMP 会话结束
- **THEN** 已打开的各会话选择器经事件刷新后不再呈现 `omp/` 分组

#### Scenario: 与原生目录不撞名
- **WHEN** OMP 与原生目录都存在同名底层 provider（如 deepseek）
- **THEN** 两者以可区分的不同 id 并存，互不覆盖

### Requirement: 生成路径永不跨界

OMP 命名空间的模型 MUST NOT 被原生会话用于生成，原生模型 MUST NOT 被派发给 OMP 适配层的流式接口。OMP 会话的生成 MUST 全部由 OMP 运行时自身的模型栈完成。

#### Scenario: 原生会话选 OMP 模型
- **WHEN** 用户在原生 preset 会话中选择 `omp/` 命名空间模型（活跃期可见期间）
- **THEN** 该选择要么被拒绝，要么在生成前失败并给出可理解错误；系统 MUST NOT 将生成请求派发给 OMP 适配层的流式实现

### Requirement: 原生会话的 seed 消毒

经 factory 原生分支创建会话时，若种子模型选择（实例级默认）指向 `omp/` 命名空间，系统 MUST 在将其传入原生 agent 循环前替换为一个原生可用模型；该替换 MUST NOT 影响已存默认值的持久化内容。

#### Scenario: 过期默认不拖垮原生新会话
- **WHEN** 实例级默认模型曾被设为 `omp/` 模型且已无存活 OMP 会话，用户新建原生 preset 会话
- **THEN** 该会话以替换后的原生模型正常创建并运行，而非因未知 provider 失败

### Requirement: 会话内选择同步

用户在 OMP 会话中切换模型时，系统 SHALL 把所选 `omp/` 命名空间模型（含推理档位）同步给该会话的 OMP 运行时，并在后续回合生效；同步 MUST NOT 影响其他会话（含其他 OMP 会话）的模型选择。

#### Scenario: 会话内切换生效
- **WHEN** 用户在 OMP 会话中从模型选择器切换到另一 `omp/` 模型并发送消息
- **THEN** 后续回合由新选模型承接，会话内呈现的选择状态一致

#### Scenario: 不污染他 会话
- **WHEN** 在 OMP 会话 A 中切换模型
- **THEN** 原生会话与 OMP 会话 B 的模型选择保持原值
