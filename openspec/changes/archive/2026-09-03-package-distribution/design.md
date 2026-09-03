## Context

`@pgmi-builds/omp-web` 的分发是「registry 包 + dsh profile bundle」双层机制：

1. **安装**：`dsh plugin --profile <name> add @pgmi-builds/omp-web` → 在 profile 目录跑 `pnpm add` → `reconcilePlugins` 检测包是否声明 `dsh.bundle.patch`，是则 append 到 `dsh.profile.bundles`（`apps/cli/src/plugin.ts:59-91`）。
2. **加载**：`loadProfile` 逐个 `resolveBundleDir` + 读 `dsh.bundle.patch` 文件 `loadOverlayPatches`，再叠加 profile 自己的 `cordis.patch.yml`（`packages/boot/app-boot/src/profile.ts:805-844`）。

当前 bundle patch 是空数组（mount NOTHING），所有实际配置都在手写 profile patch 里。registry 安装的用户拿不到这份手写配置，且存在名字/路径/peer 三个会让安装失效或报错的缺陷。

## Goals / Non-Goals

**Goals**

- 一条命令安装即挂载：`dsh plugin add @pgmi-builds/omp-web` 后启动即可用，无需手写 profile。
- 包身份一致：mount name、registry 名、`files`、`dsh.bundle.patch` 无漂移。
- 路径可移植：所有数据路径 env 驱动，无硬编码绝对路径。
- peer 依赖诚实：dsh 宿主提供 `dsh-*`/cordis，npm 不强制拉取。

**Non-Goals**

- 不改 dsh 上游（`PROFILE_TEMPLATES` 不加 `omp` 模板、不改 `apps/cli`）；本 change 只改 `apps/omp-web` 包 + 本地 profile。
- 不做「增量 provider」（让 omp-web 与原生 loop 共存）；本 change 保持「OMP-only 独占」语义。
- 不解决 dashr 的 fallback vendor 疑义（与分发无关）。

## Decisions

### D1 — bundle patch 自包含（独占挂载）

`cordis.patch.yml` 从 `[]` 改为真正 mount。omp-web 是 OMP-only provider，装入 profile 即替换原生 agent loop / model selector，因此 bundle patch 无条件执行以下 patch，等价于当前手写 profile 的「通用部分」：

```yaml
# insert omp-provider（name 对齐 registry 包名）
- insert:
    - id: omp-provider
      name: '@pgmi-builds/omp-web'
# OMP 替换原生 loop + model selector
- id: agent-loop
  disabled: true
- id: llm-deepseek
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: agent-presets
  disabled: true
# OMP union persistence 替换原生 jsonl
- id: session-persistence-jsonl
  disabled: true
# OMP 无运行时审批，默认 yolo 对齐 OMP 原生
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: danger-full-access
```

**不进 bundle patch**（profile 特定，留给 user 的 profile patch 层）：`webserver.port`（端口选择）、`agent-default-model`（由 model-selection-bridge 的 default_model 动态追踪，不硬编码）。settings 层完全不 patch（见 D6）。

### D2 — 名字统一为 `@pgmi-builds/omp-web`

保持 registry 名 `@pgmi-builds/omp-web` 不变，把 mount 行 `name: dsh-omp-provider` 改为 `name: '@pgmi-builds/omp-web'`。消除本地 pnpm alias（`dsh-omp-provider: file:...`）掩盖的名字漂移。cordis loader 按 entry `name` 经 node module resolution 解析模块（`createRequire(baseUrl).resolve(name)`，`packages/typert/loader/src/index.ts:292,320`），registry 安装后 `node_modules/@pgmi-builds/omp-web` 才能命中。

### D3 — 路径 env 驱动

`src/models.ts` 的 `OMP_AGENT_DIR` 从 `join(homedir(), ".omp", "agent")` 改为：

```ts
const OMP_AGENT_DIR = join(process.env.OMP_HOME ?? join(homedir(), ".omp"), "agent");
```

与 `omp-store.ts:38,168`（`OMP_HOME ?? ~/.omp`）和 `store/index.ts:28`（`DSH_HOME ?? ~/.omp/dsh`）一致。OMP/DSH 数据根由宿主进程的 env 决定，包不假设 `~/.omp`。

### D4 — peer 依赖 optional

`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 是宿主 dsh 提供的模块（dsh 进程加载本包时它们已在解析链上），不是本包需要 npm 拉取的运行时依赖。加 `peerDependenciesMeta`：

```json
"peerDependenciesMeta": {
  "@deepseek-ai/cordis": { "optional": true },
  "@deepseek-ai/dsh-agent": { "optional": true },
  "...其余 dsh-*": { "optional": true }
}
```

理由：`@deepseek-ai/dsh-*@0.1.2-alpha.3` 已在 `alpha` dist-tag 下 publish（`latest` 仍指向 rc；7 个 peer 包均解析得到 alpha.3）。非 optional 时 `npm install` 会拉 alpha.3 副本，与 user 已有的 dsh 版本（alpha.1/alpha.2，或第三方 plugin 锁定的版本）产生 peer conflict / 版本并存，干扰 user 的 dsh 安装实例；optional 让 npm 完全不碰 dsh-*，peer 只作「类型/契约声明」，运行时从宿主解析。`@deepseek-ai/cordis` 用 `^4.0.1` 语义，同样 optional。`dsh plugin add` 路径（pnpm `autoInstallPeers:false`）下 peer 本就不自动安装，optional 与否无差异。

### D5 — 本地两套 profile（生产验证 vs 开发测试）

用户要求「本地生产环境用 registry 安装、与 user 一致」。但开发（改 src）仍需要 file: 依赖做快速迭代。因此：

- **生产 profile `omp-web`**：改为 registry spec（`dsh plugin --profile omp-web add @pgmi-builds/omp-web`），实测 user 视角的安装/挂载/路径行为。
- **开发测试基地**：保留/新建一个 file: 依赖的 profile（或直接 `npm run build` + 重启），改 src 快速验证。

两者用不同 profile 名隔离，`DSH_HOME`/`OMP_HOME` 分别指向各自 home，避免互相污染。开发测试基地的启动方式是「另一条线」（本 change 不展开）。

### D6 — settings 层不 patch（fallback 到 dsh 默认）

本包不读 `settings.yaml`（那是 dsh 上游的 settings 服务，存 `agent-default-model`/presets）；本包的数据源是 bridge-store（`DSH_HOME/bridge-store.sqlite`）与 OMP 数据（`OMP_HOME/agent/...`），均不经 settings 层。因此本包**不 patch settings 服务、也不读它**。

`DSH_HOME` 与 `settings.path` 的分离是**有意的**（用户澄清）：dsh 原生为 `web` profile 建 `.dsh/profiles/web`，但 omp 无原生 profile 概念，把 omp-web 的 profile 建在 `.omp/omp-web/profiles/omp-web` 更直观——若 `DSH_HOME=.omp` 会得到 `.omp/profiles/omp-web`，那个 `profiles` 目录会误导成 omp 原生 profile。因此两者都保留：

- `DSH_HOME = ~/.omp/omp-web`：让 profile 落在 `.omp/omp-web/profiles/omp-web`，且 settings 默认（`$DSH_HOME/settings.yaml`）与 native `~/.dsh/settings.yaml` 天然隔离。
- `settings.path = ~/.omp/omp-web/profiles/omp-web/settings.yaml`：把 settings 文档从 home 根移到 profile 目录下，实现「settings under profile」的直觉。保留，不删。

这两个都是 profile 层（systemd env + profile `cordis.patch.yml`）的配置，不属于 bundle patch；bundle patch 不 hardcode 任何 settings/DSH_HOME 路径。

代码注释：在 `omp-store.ts` / `store/index.ts` 的路径解析处注明「上游 dsh 的 settings 是 home 级全局单例（`$DSH_HOME/settings.yaml`），profile 支持 per-profile bundle 组合但不自带 settings 隔离；本包不读 settings.yaml，隔离由独立 `DSH_HOME` 保证」。

## Open Questions

- **settings 隔离**（已解决，见 D6）：本包不 patch settings 服务；`DSH_HOME` 与 `settings.path` 的分离保留（profile 路径直观 + settings under profile），`agent-default-model` 污染由 model-selection-bridge 的 default_model 追踪兜底。

## Risks

- **独占语义副作用**：把 omp-web 装进已有 `web`/`headless` profile 会把该 profile 变 OMP-only（disable agent-loop/llm-*）。这是预期行为，但需在 README/docs 明示。
- **name 对齐后 loader 解析**：需实测 cordis loader 能按 `@pgmi-builds/omp-web`（scoped 名）解析模块；scoped 名带 `/`，loader 的 `require.resolve` 需正确处理。
- **peer optional 后模块缺失**：若 user 的 dsh 版本 < alpha.3（缺某 `dsh-*` 包），optional peer 不拉取会导致 import 失败——需在安装/启动诊断里给可读报错，而非静默崩。
