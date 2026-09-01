## Why

`@pgmi-builds/omp-webui@0.1.1` 已 publish 到 npm registry，但「分发渠道与安装方式」仍是开发基地形态：本地 `omp-web` profile 通过 pnpm `file:` 依赖 hardlink 到 `/home/u1/workspaces/dsh-omp/apps/omp-webui` 源码，且所有 mount/disable 配置都写死在手写的 profile `cordis.patch.yml` 里。其他 user 从 registry 用 `dsh plugin add @pgmi-builds/omp-webui` 安装后，**无法得到可用的 OMP web UI**——必须自行手写一整份 profile 配置，还要绕过若干会让安装失效的缺陷。

安装/分发本身是 app 呈现给 user 的 feature，是 user experience 的一部分，不应让 user 自己管理分发。本 change 把「registry 分发正确性」立为正式能力：一条命令安装即挂载，路径全部 env 驱动，包身份一致，peer 依赖声明诚实。

源码级 + 实测确认了 5 个 gap（详见 design.md）：

1. **bundle patch 空数组**：`cordis.patch.yml` 是 `[]`（mount NOTHING），`dsh plugin add` 装包后 reconcile 会把包加入 `dsh.profile.bundles`，但加载时 mount 0 个 entry，`omp-provider` 不会挂载。
2. **包名不一致**：registry 包名是 `@pgmi-builds/omp-webui`，而 mount 行 `name: dsh-omp-provider`（及 bundle 注释）用的是旧名；本地靠 pnpm alias（`dsh-omp-provider: file:...`）掩盖，registry 安装后 `node_modules` 里只有 `@pgmi-builds/omp-webui`，`name: dsh-omp-provider` 解析失败。
3. **路径硬编码**：`src/models.ts` 的 `OMP_AGENT_DIR = join(homedir(), ".omp", "agent")` 不尊重 `OMP_HOME`，与 `omp-store.ts` 的 `OMP_HOME ?? ~/.omp` 不一致。
4. **peer 依赖非 optional**：`@deepseek-ai/dsh-*` 是强制 peerDependencies，无 `peerDependenciesMeta`；但 dsh 是宿主（dsh 进程加载本包），应从宿主解析而非被 npm 强制拉取。
5. **profile 配置无法复现**：手写 profile 里的 `settings.path` 硬编码 `/home/u1/.omp/omp-web/...`、`webserver.port: 3081` 等 profile 特定值，且 OMP profile 无 shipped 模板（`PROFILE_TEMPLATES` 无 `omp`），user 无法通过安装获得。

## What Changes

- **bundle patch 自包含挂载**：`cordis.patch.yml` 从 `[]` 改为真正 mount——`insert` `omp-provider`（`name` 对齐 registry 包名）+ 禁用与 OMP 冲突的原生组件（`agent-loop`、`llm-deepseek`、`llm-pi-ai`、`agent-presets`、`session-persistence-jsonl`）+ `permission` 默认 `danger-full-access`。使 `dsh plugin add @pgmi-builds/omp-webui` 一条命令安装即挂载、启动即 OMP-only。
- **包身份一致**：统一 mount 名为 `@pgmi-builds/omp-webui`（与 registry 包名一致），消除 pnpm alias 掩盖的名字漂移；`files` 保留 `dist` + `cordis.patch.yml`。
- **路径 env 驱动**：`src/models.ts` 的 `OMP_AGENT_DIR` 改用 `OMP_HOME ?? ~/.omp`，与 `omp-store.ts` / `store/index.ts` 一致，消除硬编码 `~/.omp`。
- **peer 依赖 optional**：`package.json` 加 `peerDependenciesMeta`，把 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 标记 `optional: true`（宿主 dsh 提供），避免 npm 强制拉取/冲突。
- **本地改用 registry 安装验证**：本地 `omp-web` profile 从 `file:` 依赖改为 `dsh plugin add @pgmi-builds/omp-webui`（registry 版），以与其他 user 一致的安装路径实测行为；profile 特定值（`settings.path`、`webserver.port`）从 bundle patch 中剥离，留给 user 的 profile patch 层（默认值语义记录在 design.md）。

## Capabilities

### New Capabilities

- `package-distribution/bundle-install`: 一条 `dsh plugin add @pgmi-builds/omp-webui` 命令安装即挂载 `omp-provider` 并禁用冲突原生组件的 bundle patch 契约。
- `package-distribution/package-identity`: registry 包名、mount name、`files`、`dsh.bundle.patch` 声明的身份一致契约。
- `package-distribution/portable-paths`: 所有 OMP/DSH 数据路径由 `OMP_HOME`/`DSH_HOME` env 驱动、无硬编码绝对路径的可移植契约。
- `package-distribution/peer-deps`: `@deepseek-ai/dsh-*` / cordis 作为 optional peerDependencies（宿主提供）的依赖契约。

### Modified Capabilities

（无——本仓库尚无既有 specs 覆盖分发；omp-in-dsh 的 runtime/model-catalog 行为不在本 change 范围内。）

## Impact

- **改动文件**：`apps/omp-webui/cordis.patch.yml`（空 → mount）、`apps/omp-webui/src/models.ts`（OMP_HOME）、`apps/omp-webui/package.json`（peerDependenciesMeta + name 对齐）。
- **本地部署改动**：`~/.omp/omp-web/profiles/omp-web/package.json`（`file:` → registry spec）+ 手写 profile patch 的 mount/disable 行移交到 bundle patch。
- **依赖**：无新增依赖；peer 依赖语义收紧为 optional。
- **风险面**：bundle patch 禁用原生组件是「独占 profile」语义（装到已有 web/headless profile 会把该 profile 变 OMP-only）；`name` 对齐后需验证 cordis loader 能按 `@pgmi-builds/omp-webui` 解析模块；peer optional 后需验证 dsh 宿主确能提供这些模块（本地实测）。
