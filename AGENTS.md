# OMP Web（dsh-omp 仓库 / @pgmi-builds/omp-web）— dsh 拓扑与 Dev/Test 约定

本文件是 agent 指引的一站式契约：仓库定位、prod 拓扑、dev/test 路径、以及当前 repo 状态与已知风险。（旧 `agents.md` 的 Prod/Dev/Test/Caddy 契约已并入本文件。）

---

## 〇、这个仓库是什么

- Repo: `~/workspaces/dsh-omp`，remote `git@github.com:pgmi-builds/omp-web.git`（2026-09-02 由 `omp-webui` 改名，旧 URL 自动重定向），branch `master`。
- 唯一在产包: `apps/omp-web` = **`@pgmi-builds/omp-web`**（v0.2.0 起，品牌统一为 **omp-web**——与 profile 名、systemd unit、DSH_HOME、域名一致，正如 dsh 的 `web`）。与 better-dsh 同一插件模型的 cordis/dsh 插件：在 `ctx.agents` 注册 AgentFactory，spawn `omp --mode rpc`（原生 OMP，`~/.local/bin/omp` Bun ELF，当前 18.0.11），把 OMP 的 RPC 面（prompt/follow_up/steer/abort/get_state/get_messages/set_model + resume）桥进 dsh Agent/Session 契约；OMP-backed LlmAdapter 按 OMP `config.yml` 的 `modelRoles` 提供模型选择。
- 插件形态: `dsh.bundle.patch` = 包内 `cordis.patch.yml`（随 npm tarball 分发）——mount `omp-provider`、禁用被 OMP 取代的原生组件（agent-loop、原生 llm routes）。profile 侧零文件改动，`dsh plugin add` 一条命令即装即挂。
- 依赖声明与 better-dsh 同构：8 个 `@deepseek-ai/*` harness 依赖全部是 **optional peerDependencies**，运行期由 host 提供；类型检查走仓内 vendored `types/@deepseek-ai/*`（tsconfig `paths` 指过去，portable，无需 dsh checkout）。构建 = 纯 `tsc -p tsconfig.json`（src → dist），无 tsdown、无 client 半边。包内 `.npmrc` 设 `auto-install-peers=false`（嵌套 peer 副本会破坏 harness 的 `scopeOf` 身份）。
- src 速览: `index.ts`（provider Service/AgentFactory）、`rpc.ts`（OmpRpcClient）、`agent.ts`/`adapter.ts`/`replay.ts`/`session-persistence-omp.ts`/`supervisor.ts`/`models.ts`/`knobs.ts`/`pairing.ts`/`permission.ts`、`store/`（SQLite bridge store）。
- 其余目录: `upstream/dsh`（gitignored，自带 git repo）、`docs/`（`plans/` 设计文档带 as-built 注记；`probe-*`/`smoke-*` 运行时探针脚本）、`openspec/` + 根部 `.omp/`（opsx-* 命令与 openspec skill，供 OMP agent 驱动 openspec 流程）、`archived/`（已废弃 app，只留盘不入库）、`.scratch/`。README 真身在 `apps/omp-web/README.md`（随 tarball 发布 + npm 页面），repo 根是对它的 symlink。

---

## 一、Prod 拓扑（DSH_HOME=~/.omp/omp-web，端口 3081）

### Core — 与 Dash Agent prod 共用同一份用户级全局 dsh

```
/home/u1/.local/bin/dsh
   └─ symlink → /home/u1/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
```

- 全局 `@deepseek-ai/dsh` = npm **v0.1.2-alpha.3**（vendored node_modules），与 `~/.dsh` 的 Dash Agent prod 同一份。
- systemd **user** unit `~/.config/systemd/user/omp-web.service`（前身 `omp-plus.service` 已退役）：
  - `ExecStart=/opt/node-v22.23.2/bin/node /home/u1/.local/bin/dsh --profile omp-web --no-open --trusted-host omp.pc.randomhash.app`
  - `WorkingDirectory=DSH_HOME=/home/u1/.omp/omp-web`，`OMP_HOME=/home/u1/.omp`
  - `OMP_IDLE_EXIT_MS=1800000`，`DSH_TELEMETRY_DISABLED=1`，`Restart=on-failure`

### Profile（`~/.omp/omp-web/profiles/omp-web`）

- `package.json`: deps `@pgmi-builds/omp-web 0.2.0`（精确锁）+ `dsh-better-sidebar 0.18.0-alpha.0`；`dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pgmi-builds/omp-web", "dsh-better-sidebar"]`。
- profile 自带 `pnpm-workspace.yaml`: `nodeLinker: hoisted`、`autoInstallPeers: false`（永不在 profile 树里嵌 `@deepseek-ai` 副本）、`minimumReleaseAgeExclude`（pnpm 11.7 供应链年龄门——新发布的包需进 exclude 才可装，`pnpm add` 会自动追加）。
- **registry distribution（v0.1.2 起）**：pnpm-lock 以 npm registry integrity 锁定。部署/升级流：bump 版本 → `npm publish`（在 `apps/omp-web`，见下）→ profile 目录 `pnpm add @pgmi-builds/omp-web@<ver>` → 重启 unit。
- `cordis.yml` 为空 `[]`；树按层组成：各 bundle patch（omp-web 包内 patch 负责 mount + 禁原生组件）→ 用户层 `cordis.patch.yml` 只放 profile 特有值：`settings.path` 指向 profile 内 `settings.yaml`、`webserver.port=3081`（端口来自这里，不在 unit 里）。`agent-default-model` 动态落在 settings.yaml（当前 deepseek/deepseek-v4-flash）。

### 依赖解析 — 两层，不是一棵树

1. **profile pnpm 树**（hoisted 物理树）：第三方依赖 + 两个插件。omp-web 部署副本只有 `dist + cordis.patch.yml + package.json + README.md`（tarball `files` 字段），**零嵌套 node_modules、零 runtime dependencies**。
2. **全局 dsh vendored 树**（`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`）：全部 `@deepseek-ai/*`——含 dsh-base/dsh-web-app 本体与 omp-web 的 8 个 optional peers，host 自供。profile 树内没有任何 `@deepseek-ai` 目录。

### User data

- `DSH_HOME=~/.omp/omp-web`: `profiles/`、`storages/`（workspace.json 等）、`attachments/`、`bridge-store.sqlite`（集中式 SQLite session index，v0.1.1 引入；固定路径，不随包名变）。
- `OMP_HOME=~/.omp` 与原生 OMP 共享：`agent/`（config.yml、mcp.json——cordis-a2a/zai-vision/web-reader 三个 MCP）、OMP 原生 session 目录（其内 `webui.json` 为数据文件名，与品牌无关，保持不动）。桥接层持久化边界与设计沿革见 `docs/plans/dev_0.0.3.md`（§9 为 as-built 修正）。

### Caddy

- live `/etc/caddy/Caddyfile`: `omp.pc.randomhash.app` → `127.0.0.1:3081`，dsh fence（`header_up Host` 重写 + 剥 `Origin`），无 gate（用户已批准）。**未经明确批准勿改**。
- repo 的 `Caddyfile.opengate` 是独立的 dev/test 用文件（untracked），与 live 无关。

---

## 二、Dev/Test：4999 手动实例（upstream 源码 checkout，按需拉起）

- harness 源码: `./upstream/dsh`，clean checkout @ tag **dsh-v0.1.2-alpha.3**（自带 git repo，此处 gitignored），run 入口 `npm run dsh` = `node --import tsx/esm apps/cli/src/bin.ts`。
- 当前盘上状态: **未安装**（无 node_modules）。pnpm 11.7.0 已知坑（dashr checkout 实测同款）: pnpm 11 不读 `.npmrc`，须先在 `pnpm-workspace.yaml` 重定向 `storeDir` 到可写 scratch + `verifyDepsBeforeRun: false` 再 `pnpm install`，否则对用户级只读 store 报 EROFS。**本 checkout 尚未加该 patch，下次 install 先验证/补上。**
- 测试约定（沿用 2026-09-01 契约）: profile `omp-web-test` 于 `$DSH_HOME/profiles/omp-web-test`（即 `~/.omp/omp-web/profiles/omp-web-test`——与 prod 共 DSH_HOME、分 profile；当前不在盘上，按需创建），OMP 侧仍指共享 `~/.omp`。插件本体用 link 指向 `~/workspaces/dsh-omp/apps/omp-web`（先 tsc 构建）。runtime 手动拉起在端口 **4999**；Caddy `test.pc.randomhash.app` → `127.0.0.1:4999` 已就位（dev/test 共用子域）。
- 测完: **把 4999 runtime 关停**；Caddy 不动。（当前 4999 无监听，test 实例未在跑。）
- 免 harness 的单元回路: `cd apps/omp-web && npm run build && node --test test/*.test.mjs`（node:test 套件 import `../dist`；注意本机 Node 22.22.1 下 `node --test test/` 会被当作模块路径，必须用 glob）。vendored types 使 tsc 无需 dsh checkout。

### npm 发布（从本机）

```bash
cd ~/workspaces/dsh-omp/apps/omp-web
npm run build
npm pack --dry-run        # 核对 tarball = dist + cordis.patch.yml + package.json + README
npm publish --access public --cache ~/workspaces/dsh-omp/.scratch/npm-cache
```

- `--cache` 重定向必需：沙箱内 `~/.npm` 只读（EROFS）。
- 凭据：`~/.npmrc` 的 `//registry.npmjs.org/:_authToken`（账户 pgmi-builds）。gh CLI 已登 mark1kwok（repo scope）。

---

## 三、Repo 状态与风险（2026-09-02 快照，v0.2.0 rebrand 后）

- **v0.2.0 rebrand 已全链路落地（2026-09-02）**: `omp-webui` → `omp-web` 统一品牌——GitHub repo 改名（旧 URL 重定向）、npm `@pgmi-builds/omp-web@0.2.0` 发布、prod profile 切换（lock integrity = 发布 tarball shasum）、`omp-web.service` 重启验证（active、3081 应答、bridge-store 正常打开）。v0.1.2 时代的未提交漂移（`RemoteError` preset fix）已随本次提交收敛入库。
- 旧的 `@pgmi-builds/omp-webui` npm 包保留在 registry（最后 0.1.2），不 unpublish、不再维护；无外部用户依赖（用户确认）。
- `master` 与 origin 同步；发布走 git tag（`v0.0.2`…`v0.2.0`）。
- Untracked/遗留: `Caddyfile.opengate`、`.dsh_better_edit/`（编辑工具产物，.gitignore 候选）；`~/.config/systemd/user/dsh-omp.service.d` 孤儿 drop-in（unit 已不存在，无害，可清理）；`omp-web-test` profile 已从盘上移除（按需重建）；profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里残留一条 `@pgmi-builds/omp-webui@0.1.2`（无害）。
- 版本线: v0.0.3 删集中化 omp-sessions.json → v0.1.0 收敛为 `apps/` 布局 + session supervisor → v0.1.1 以 SQLite（bridge-store.sqlite）重新引入集中 index、废弃 mobile/in-dsh apps（→ `archived/`）→ v0.1.2 registry 分发 + model-selection bridge → **v0.2.0 rebrand omp-web**。
