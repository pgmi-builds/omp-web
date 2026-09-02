## Context

- 仓库已重组：`apps/omp-web`（现行生产桥接层，独立 `--profile omp` 实例，保持不动）+ `apps/omp-in-dsh`（本 change，共存型 plugin）。
- 桥接层经验全部来自 omp-web：`OmpRpcClient.spawn()`（spawn `omp --mode rpc` 子进程）、`OmpAgent`（Dash `Agent` shim）、`replay`/`pairing`/`permission`/`omp-store`/`models`（store 扫描 + id 配对 + 审批映射 + /proc 排他 + 本机模型注册读取）。
- 上游源码事实（决策依据，均已核对源码）：
  - **OMP core 与 Bun 运行时强耦合**：`Bun.env/Bun.sleep/Bun.hash` 直接出现在 oh-my-pi `packages/agent/src/agent.ts`、`agent-loop.ts`、compaction 等；发行物为 Bun 编译 ELF。宿主 dsh 实例运行在官方 Node 22（systemd drop-in `10-node-official.conf`）。→ 进程内 import 不可行，子进程 RPC 是唯一形态。
  - **`ctx.agents.setFactory()` 单槽**：deepseek-harness `core/agent/src/index.ts:372-381`，第二个 factory 抛 `an agent factory is already registered`；槽位随 context effect 生命周期。测试 `agent.spec.ts:397-401` 表明**子 context 可持有自己的槽**（内层注册与根槽并存）。
  - **原生 AgentLoop 自注册**：`core/agent-loop/src/index.ts:350` 构造时 `ctx.effect(() => ctx.agents.setFactory(this))`。
  - **模型面不经过 factory**：模型 RPC 由 apiproxy 直达 `ctx.llm`——`session.models`（`api-proxy.ts:2212-2220`）与 `llm.models`（`:3337-3339`）共用 `buildModelCatalog(ctx)`（`:297-346`，宿主 `listProviders()` 全量并集）；`session.selectModel`（`:2222-2271`）经 `resolveCallConfig` 校验（**要求 provider 已注册 adapter 路由**），成功后写 per-session 内存选择（WeakMap）并经 `saveDefaultModelSelection` 持久化为**实例级默认**。选择优先级：进程内 `picked` → 会话 `requestHeader().config` → 宿主默认（`selectionFor` `:1123-1150`）。
  - **Web UI 消费面**（`packages/client/ui-model-selection`）：模型选择是 **per-session 动态目录**（`ModelDirectory`，打开即 load）；**New Session 无草稿期选模器**（上游 README："No create-time … selection … there is no draft-phase model choice"），新会话模型 = 已存默认；**每个 resident 目录订阅 `llm/adapters-updated` 事件并 refetch**，而 `registerAdapter`/`handle.replace()` 每次都发该事件（`llm/src/index.ts:405-413`）。
  - **LlmRuntime 注册表进程级扁平**：`llm/src/index.ts:338-421` 单一 `adapters` map；`registerAdapter` 返回带 `replace(next: string[])` 的 handle，按 fiber 释放，注册结果全实例可见。无 per-session catalog 作用域。
  - **`sessionPersistence` 单槽**：`agent-loop/src/index.ts:653-657` resume 硬依赖；omp-web 的 `OmpUnionSessionPersistence` 以整服务替换方式占用该槽（仅适合单用途 profile）。
  - **OMP state 可官方重定向**：`PI_CODING_AGENT_DIR`（"Session storage directory"，oh-my-pi `help-extra.ts:57`）。v1 不启用，留作隔离模式开关。
  - **preset 可贡献**：DSH 原生支持自定义 preset（用户另一项目已验证 4 内建 + 1 自定义）；omp-web 的 `SingleOmpPresetRoster` 是替换式 roster，不适用于共存场景。

## Goals / Non-Goals

**Goals:**
- 单个 stock dsh 实例内，原生 agent 与 OMP agent 经 preset 切换共存共用同一 Web UI。
- v1 复用本机已安装 OMP（PATH `omp`）：共享 `~/.omp` state、TUI 会话互见、排他防交叉写入；部署与测试成本最小化。
- 不改 OMP 核心源码；不改 dsh 上游源码（仅经 plugin + bundle patch）。
- omp-web 与其 `omp-plus` 服务零改动、可并存。
- `omp/` catalog 仅在 OMP 被消费（存活会话）期间出现在宿主目录。

**Non-Goals:**
- 不做 OMP 源码级/进程内集成（Bun 耦合，已排除）。
- 不把 OMP 会话接入 dsh 原生 LLM provider 的生成路径；不做 OMP→DSH LlmAdapter 的流式实现。
- v1 不做隔离式自带运行体（vendored binary + state 重定向）——仅保留参数位，后续按需启用。
- 不做 per-session catalog 过滤的 Web UI 上游改造（活跃期动态注册已满足暴露目标；见 D4 残余）。
- 不动 omp-web 生产形态；不做两 app 的共享库重构（见 D6）。

## Decisions

### D1: 子进程 RPC 承载 OMP core（沿用 omp-web 形态）
**决策**：OMP core 以 `--mode rpc` 子进程运行，桥接层复用 omp-web 的 rpc/agent/replay/pairing/permission/omp-store/models 模块（拷贝进 `apps/omp-in-dsh/src/bridge/`）。
**理由**：Bun 运行时耦合使进程内集成不可行；共享模式下桥接层与本机 state 完全同构于 omp-web 生产形态，复用度 ~99%。
**备选**：重写为 Node 直调 OMP 内部库——被 Bun API 耦合否决。

### D2: 路由型复合 factory 占根槽，原生 AgentLoop 降为子 fiber 组件
**决策**：bundle patch 层 `disable` 原生 `dsh-agent-loop` 的配置式挂载；omp-in-dsh plugin 在根 context 注册 **RouterFactory**（唯一根槽占用者）：
- preset/meta 判定为 `omp` → 走 OMP 分支（现 omp-web `OmpProvider.createAgent/resume` 逻辑）；
- 其余 → 委托给 plugin 在**子 fiber** 上程序化挂载的原生 AgentLoop 实例（直接调其 `createAgent/resume`），子 fiber 的槽位语义由 `agent.spec.ts:397-401` 的先例背书。
- 原生分支在委托前做 **seed 消毒**（见 D4）。
**理由**：单槽 + 原生自注册的组合下，"多 provider 并列注册"不存在官方入口；路由器是唯一不动上游代码的占槽方式。factory 是 `agentOptions`（含默认模型 seed，apiproxy `:1081-1084`）的必经之路——这是 factory 对模型面的**唯一**真实介入点。
**备选**：替换 apiproxy / fork web bundle——改动面大，违背 plugin 原则，否决；OMP 会话绕开 `ctx.agents` 自建通道——apiproxy 固定走 `ctx.agents`，否决。
**风险前置**：子 fiber AgentLoop 与 apiproxy 的 `ownerCtx`/tracing 语义是最大不确定点，列为 Spike-1（tasks 首项）。

### D3: preset 走原生 roster 的贡献路径，废弃替换式 roster
**决策**：omp-in-dsh **不**注册 `SingleOmpPresetRoster`（那是单用途 profile 的整服务替换）；改为向原生 `agentPresets` roster 贡献一个 `omp` preset（与用户另一项目验证过的自定义 preset 路径一致），preset 组合为空——运行面由 RouterFactory 的 OMP 分支持有。
**理由**：共存场景必须保留全部原生 preset；替换 roster 会清空 standard/minimal 等。
**备选**：继续整服务替换并内置原生 preset 清单——需复制上游 preset 定义，随上游演进漂移，否决。

### D4: 模型面 = 活跃期动态注册 + factory seed 消毒 + 生成永不跨界
**决策**（对应源码结论"catalog wire 宿主全局、无 per-session 作用域；selection per-session；client 订阅 adapters-updated"）：
- **动态注册**：plugin 持有 `omp/` 前缀 adapter 的注册 handle；首个 OMP 会话创建/恢复成功时 `registerAdapter(ompIds…)`，最后一个 OMP 会话结束时 `handle.replace([])`。每次变化宿主广播 `llm/adapters-updated`，client 的 resident `ModelDirectory` 自动 refetch——UI 收敛无需任何客户端改动。OMP 会话存活期内 `selectModel` 的 `resolveCallConfig` 校验天然通过。
- **残余暴露**（明确接受）：OMP 会话存活期间，其他会话的选择器与 Settings 页同样能看到 `omp/` 分组（宿主目录全局并集）；窗口外零暴露。彻底 per-session 过滤需上游改造 `buildModelCatalog`，越出 plugin 边界，列为后续上游提案。
- **seed 消毒**：apiproxy 以 `defaultModelSelection()` 作 seed 经 `ctx.agents.create` 流入 factory；原生分支检测 seed provider 带 `omp/` 前缀时替换为原生可用模型再委托 AgentLoop（防"omp 默认被持久化后，原生新会话因未知 provider 失败"）。OMP 分支忽略 seed（初始模型由 OMP 侧配置决定，沿用 omp-web）。
- adapter 仅实现 `providerInfo/listModels/resolveModel`（读本机 `~/.omp/agent` 模型注册，omp-web `models.ts` 原样）；`stream()` 抛 `UNSUPPORTED_STREAM`——OMP 生成永远发生在 OMP 子进程内。
- 已知限制继承 omp-web：OMP 会话的 `current` 回显依赖 Dash 侧 `requestHeader().config`，OMP 内部模型与选择器显示可能不同步（记忆中的 v0.0.3 已知问题），首版沿用。
**备选**：静态常驻注册——暴露面更大，被否决；替换 llm 服务为包装器——需影响 apiproxy 的服务解析且仍无 per-session 上下文，否决。

### D5: v1 复用本机 OMP；隔离模式保留为参数开关
**决策**：
- spawn 目标 = PATH `omp`（或部署配置 `OMP_BIN` 绝对路径），state 共享本机 `~/.omp`——桥接层 `OMP_SESSIONS_ROOT`/`OMP_AGENT_DIR` 常量保持 omp-web 原值，零参数化改动。
- **版本握手**：RPC ready 握手后校验 OMP 版本落在桥接层声明的兼容范围（当前 18.x），超范围拒绝创建并报实际版本；可用配置放宽（测试用）。
- 「可执行文件路径 + state 根」保留为参数：后续隔离模式 = 自带 binary + `PI_CODING_AGENT_DIR` 重定向（官方支持），仅改这两个参数即可启用，不动其余组件。
**理由**：用户决策——复用本机实例使实现/测试最简、TUI 保留、桥接复用 ~99%；"完全独立于原生安装"的原目标降级为后续可选模式。omp-web 生产已验证共享模式（/proc 排他、TUI 会话互见）。
**代价**：本机 OMP 独立升级会漂移 plugin 兼容性——版本握手兜底；Web UI 会话写入 `~/.omp`（共享即有意为之，非泄漏）。

### D6: 代码组织 = omp-in-dsh 内嵌桥接副本，不做共享库
**决策**：`apps/omp-in-dsh/src/bridge/` 拷贝 omp-web 桥接模块（共享模式下近原样，仅补版本握手）；omp-web 零改动。
**理由**：omp-plus 是在跑的生产服务，抽共享库会把两个演进节奏不同的 app 耦合进一次重构；桥接层体量小（~11 文件），副本成本低于回归风险。若后续漂移痛感明显，再抽 `apps/bridge-core`。

### D7: 复合 sessionPersistence——同一占槽模式
**决策**：与 D2 同构：patch 层 `disable` 原生 dsh-session-persistence 的配置式挂载；plugin 在根槽注册 **CompositeSessionPersistence**：
- list = 原生后端列表 ∪ OMP store 扫描（Dash id 化）；
- append/inspect/load/locate 按 id 路由：在 OMP 配对集内 → OMP 分支（现 `OmpUnionSessionPersistence` 语义，写路径 no-op）；否则 → 子 fiber 挂载的原生 JSONL 后端；
- 原生后端实例同样程序化挂载于子 fiber。
**理由**：`sessionPersistence` 与 factory 同为单槽；"沿用 DSH 基底 + OMP 自持"经复合路由同时满足。OMP 会话事实源仍是 OMP store（无副本日志），延续 omp-web Phase C 结论。

### D8: workspace 归组与会话发现
**决策**：沿用 omp-web 的 30s 周期 reconcile（`#reconcileWorkspaces`）+ 启动 warm pass，扫描根 = 本机 OMP store（`~/.omp/agent/sessions`），排除 OMP/DSH home 自身目录——与 omp-web 完全一致（共享模式下无隔离根，原语义直接成立）。
**理由**：Web UI 之外创建的 OMP 会话（TUI）不经 apiproxy create 路径，需周期归组；omp-web 生产已验证该机制。

## Risks / Trade-offs

- [子 fiber AgentLoop 的 ownerCtx/tracing/ownership 语义未验证] → Spike-1 首项：最小 PoC（RouterFactory + 子 fiber AgentLoop + apiproxy 创建原生会话）不通过则回退方案：fork dsh-base bundle 层（仍不动上游源码，代价是补丁面变大）。
- [patch `disable` agent-loop / session-persistence 后，需在子 fiber 复刻其 bundle config] → Spike 中逐项比对 bundle 默认 config（`agents: []` 等）；把复刻清单写进实现任务，缺项 = 原生会话行为漂移。
- [动态注册的窗口期暴露：OMP 存活期其他会话/Settings 可见 `omp/` 分组] → spec 已定残余接受；错误文案指引；后续上游提案 `buildModelCatalog` preset 感知过滤。
- [`omp/` 选择被存为实例默认后、OMP 会话已全部结束] → factory seed 消毒兜底（原生新会话不受影响）；默认值本身不改写（尊重用户选择，窗口期外该默认只影响回显）。
- [本机 OMP 独立升级 → RPC 协议/行为漂移] → 握手版本校验拒绝 + 明确报错；桥接层声明兼容范围随 plugin 发版更新。
- [OMP 会话 fork 不支持] → 沿用 omp-web 边界：factory 边界明确拒绝（`parentSession` 检查已有）。
- [OMP 会话 `current` 回显依赖 Dash requestHeader，与 OMP 内部模型可能不同步] → 首版沿用 omp-web 已知限制，文档标注。

## Migration Plan

1. 前提：目标机器装有兼容版本原生 OMP（`omp --version` 在声明范围内）。
2. 部署：目标实例 profile 的 `package.json` 加 `file:` 依赖 + `cordis.patch.yml` 加两条 `disable`（agent-loop、session-persistence 的配置式挂载）与 plugin insert；`dsh plugin` reconcile。
3. 验收冒烟：原生 preset 建会话跑一轮；`omp` preset 建会话跑一轮；无 OMP 会话时选择器零 `omp/` 分组、OMP 会话存活期间出现且收敛正确；TUI 与 Web UI 会话互见、排他生效。
4. 回滚：删除 patch 条目与依赖，重启实例——原生 loop/persistence 按 bundle 配置重新挂载；`omp` preset 消失；`~/.omp` 中共享会话数据天然保留（原生 OMP 资产）。

## Open Questions

- 动态注册的收紧粒度（实例级活跃期 → 是否按"当前会话是否 OMP"进一步收紧）——受宿主目录全局性限制，仅上游改造可解，不阻塞首版。
- 原生会话选择器隐藏 `omp/` 分组的上游化提案（`buildModelCatalog` preset 感知过滤）——独立后续项。
- OMP 子进程内部的 subagent/后台任务与 dsh 侧 jobs 面板的呈现深度——首版按 omp-web 现状（不呈现）。
- 隔离模式（vendored binary + `PI_CODING_AGENT_DIR`）的启用时点与打包方案（183MB 体量处理）——按需另立 change。
