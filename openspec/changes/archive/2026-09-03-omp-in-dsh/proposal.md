## Why

omp-web（`apps/omp-web`）证明 OMP 可以桥接进 Dash Web UI，但它以独立 dsh 实例（`--profile omp`）运行：整机部署了第二个 dsh 服务，原生 DSH agent 与 OMP agent 无法在同一个 Web UI 中共存。现在要把 OMP core 作为一个 **DSH plugin**（agent provider + agent preset）安装进**用户已有的原生 dsh 实例**，让用户在同一个 Web UI 里通过切换模式（preset）运行原生 agent 或 OMP agent；OMP 运行时 v1 直接复用同机器上已安装的原生 OMP 实例（含其 TUI 与 `~/.omp` state），与原生安装互不妨碍。

## What Changes

- 新建 `apps/omp-in-dsh` plugin 包（`dsh-omp-in-dsh`）：在**共存**形态下把 OMP 接入 stock dsh 实例，而不是替换其运行面。
- **复合 agent factory 路由**：`ctx.agents.setFactory()` 是单槽（第二个 factory 抛错），plugin 不再独占该槽，而是安装一个路由 factory——preset 为 `omp` 的会话分流给 OMP 子进程 agent（复用 omp-web 桥接层），其余会话委托给子 fiber 内挂载的原生 AgentLoop。
- **贡献 agent preset**：以「贡献」而非「替换 roster」的方式注册一个 `omp` preset（原生 standard/minimal 等 preset 全部保留），与另一项目已验证的"4 内建 + 1 自定义"路径一致。
- **复用本机 OMP 运行时**：spawn 机器上已安装的原生 OMP（PATH `omp` 或配置路径），共享 `~/.omp` state 与会话 store——Web UI 与 TUI 会话互见、排他检查防交叉写入；握手阶段做版本校验。不携带 OMP binary；「可执行文件路径 + state 根」实现为配置参数，为后续可选的隔离式自带运行时（自带 binary + state 重定向）保留切换位。
- **复合 session persistence**：以 id 路由的 composite persistence 服务——OMP 会话由 OMP 原生 store（scan + replay，沿用 omp-web 的 `OmpUnionSessionPersistence` 模式）服务，原生会话落回 dsh 原生 JSONL 后端；单一 `sessionPersistence` 槽位下两库并存、互不污染。
- **活跃期动态 model catalog**：`omp/` 前缀命名空间的 provider 仅在存在存活 OMP 会话期间注册宿主 `ctx.llm`（首个会话注册、最后一个结束注销，经宿主 adapter 更新事件让已打开选择器自动收敛）；factory 原生分支对指向 `omp/` 的实例默认 seed 做消毒；OMP 会话生成永远由 OMP 自身模型栈完成，`stream()` 永不派发。
- 不改动 OMP 核心源码；不改动 dsh 上游源码（一切经 plugin/bundle-patch 机制完成）。

## Capabilities

### New Capabilities

- `omp-in-dsh/agent-provider`: OMP 作为共存型 agent provider 接入 stock dsh 实例——复合 factory 路由、preset 贡献、与原生 AgentLoop 的边界与故障隔离。
- `omp-in-dsh/runtime`: OMP 运行时来源（v1 复用本机已安装实例、版本握手、与原生 TUI 共享 state 且互不破坏；隔离式自带运行时保留为配置开关）。
- `omp-in-dsh/session-storage`: 复合 session storage——OMP 会话由 OMP 原生 store 回放服务、原生会话走原生后端，id 路由与配对规则。
- `omp-in-dsh/model-catalog`: `omp/` 命名空间 catalog 的活跃期动态注册、原生 seed 消毒、per-session 选择同步、生成路径永不跨界。

### Modified Capabilities

（无——本仓库尚无既有 specs；omp-web 的行为不在本 change 范围内。）

## Impact

- **新增代码**：`apps/omp-in-dsh/`（plugin 包，桥接层近乎原样复用 `apps/omp-web/src` 的 rpc/agent/replay/pairing/permission/omp-store/models 模块——共享模式与本机 state 完全同构）。
- **既有代码**：`apps/omp-web` 不动（独立 app 保留）；仓库目录已重组为 `apps/omp-web` + `apps/omp-in-dsh`。
- **部署面**：目标 dsh 实例（如 `~/.dsh` 的 `web` profile）通过 `dsh plugin add` 安装本包；`omp-plus`（omp-web 的独立服务）不受影响，可并存；**运行前提**：机器上装有版本兼容的原生 OMP。
- **依赖**：`@deepseek-ai/cordis` ^4、`dsh-*` 0.1.0-rc.7 peerDeps（与 omp-web 相同）；运行期外部依赖 `omp`（PATH 或配置路径）。
- **风险面**：单槽 factory 的路由正确性（ownerCtx/tracing 语义）为最大不确定点，design 中以 spike 任务前置；本机 OMP 独立升级带来的版本漂移以握手校验兜底。
