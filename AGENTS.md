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

- 全局 `@deepseek-ai/dsh` = npm **0.1.3-alpha.2**（2026-09-08 dashr 对齐轮升级；vendored node_modules），与 `~/.dsh` 的 Dash Agent prod、omp-web 3081 共用同一份。**omp-web 0.2.0 与该宿主的 persistence seam 不兼容（v2 handle-based seam）——升级包 0.3.0 见 openspec change 2026-09-08。**
- systemd **user** unit `~/.config/systemd/user/omp-web.service`（前身 `omp-plus.service` 已退役）：
  - `ExecStart=/opt/node-v22.23.2/bin/node /home/u1/.local/bin/dsh --profile omp-web --no-open --trusted-host omp.pc.randomhash.app`
  - `WorkingDirectory=DSH_HOME=/home/u1/.omp/omp-web`，`OMP_HOME=/home/u1/.omp`
  - `OMP_IDLE_EXIT_MS=1800000`，`DSH_TELEMETRY_DISABLED=1`，`Restart=on-failure`

### Profile（`~/.omp/omp-web/profiles/omp-web`）

- `package.json`: deps `@pgmi-builds/omp-web 0.2.0`（精确锁）+ `dsh-better-sidebar 0.18.0-alpha.0`；`dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pgmi-builds/omp-web", "dsh-better-sidebar"]`。
- profile 自带 `pnpm-workspace.yaml`: `nodeLinker: hoisted`、`autoInstallPeers: false`（永不在 profile 树里嵌 `@deepseek-ai` 副本）、`minimumReleaseAgeExclude`（pnpm 11.7 供应链年龄门——新发布的包需进 exclude 才可装，`pnpm add` 会自动追加）。**勿信 `@latest`**：刚发布版本会被年龄门静默挡回旧豁免版并覆盖部署位（dashr 实证 0.2.1-d←0.2.1-a），升级一律精确版本 add。
- **registry distribution（v0.1.2 起）**：pnpm-lock 以 npm registry integrity 锁定。部署/升级流：bump 版本 → `npm publish`（在 `apps/omp-web`，见下）→ profile 目录 `pnpm add @pgmi-builds/omp-web@<ver>` → 重启 unit。
- **生产部署原则（2026-09-02 裁决，与 dashr 同款）：user, just another user**——prod 只从 registry 精确版本安装，不做源码级/手工同步侵入；`file:` 依赖与手工同步仅限未发布的本地迭代，且只落 §二 test profile。dev/test 与 prod 两条线据此分离。
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

- harness 源码: `./upstream/dsh`，checkout @ tag **dsh-v0.1.3-alpha.2**（2026-09-08 对齐轮切至；自带 git repo，此处 gitignored），run 入口 `npm run dsh` = `node --import tsx/esm apps/cli/src/bin.ts`。**注意：`npm run dsh` 前必须 `pnpm run build`**（source-run 也要 `lib/` 产物，否则 MissingClientBundleError）。
- 本地 patch 三件套（checkout 工作树内，随 tag 重放）：① `pnpm-workspace.yaml` 加 `storeDir: .scratch 可写路径` + `verifyDepsBeforeRun: false`（pnpm 11 不读 .npmrc，用户级只读 store EROFS）；② 根 package.json devDeps 加 `"unrun": "^0.3.1"`（tsdown 0.22 config loader 需要，upstream 未声明）；③ `packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT` 用 `resolveRepositoryRoot()`（pnpm-workspace.yaml 锚定 + cwd 回退——unrun 把 config 编译进 `node_modules/.unrun/` 后 `import.meta.url` 失锚）。三条与 dashr 轮记录互证。
- 测试约定（沿用 2026-09-01 契约）: profile `omp-web-test` 于 `$DSH_HOME/profiles/omp-web-test`（与 prod 共 DSH_HOME、分 profile；**2026-09-08 已建**：bundles = dsh-base/dsh-web-app/omp-web，dep 用 `link:` 指向本仓 `apps/omp-web`，patch 层 `webserver.port=4999`），OMP 侧仍指共享 `~/.omp`。插件本体先 tsc 构建。runtime 拉起在端口 **4999**；**4999 与 dashr 的测试线共用**——拉起前 `ss -tlnp | grep 4999` 查占用（dashr 遗留 unit 名 `dsh-4999-test`），EADDRINUSE 启动竞态两轮实测均在。
- 测完: **把 4999 runtime 关停**（`systemctl --user stop omp-web-4999-test`，勿 kill）；Caddy 不动。（2026-09-08 状态：对齐轮冒烟全绿后 instance 留给用户手动验收中，token 每次重启轮换，从 journal 取。）
- 免 harness 的单元回路: `cd apps/omp-web && npm run build && node --test test/*.test.mjs`（node:test 套件 import `../dist`；注意本机 Node 22.22.1 下 `node --test test/` 会被当作模块路径，必须用 glob）。vendored types 使 tsc 无需 dsh checkout。

### 拉起 / 关停（sandbox-safe，2026-09-03 dashr 实证移植）

- **勿从 agent 沙箱化 bash 直接拉 daemon**：沙箱内启动的进程继承嵌套沙箱，bwrap 探测失败（`No permissions to create a new namespace`）→ `SANDBOX_UNAVAILABLE`。用 `systemd-run --user` 在沙箱外启动（沙箱内连 user bus 会被拒，单命令 `danger-full-access` 升级）；配方照 dashr 同款：`WorkingDirectory`=upstream checkout、`Environment=DSH_HOME=~/.omp/omp-web`+`OMP_HOME=~/.omp`、日志 append 到 `.scratch/omp-web-4999.log`、unit 名 `omp-web-4999-test`。ExecStart 形态 = prod unit（§一）换 `--profile omp-web-test`；4999 端口沿用 prod 机制（test profile patch 的 `webserver.port`，或 dashr 实测可用的 CLI `--port 4999`），profile 重建时定稿并回填本节。
- token 每次启动轮换：从日志取 `?token=…` URL；curl 冒烟需 cookie jar：`curl -c jar -L '<token-url>'`（303 重定向靠 cookie 保认证）。
- 关停：`systemctl --user stop omp-web-4999-test`（勿用 kill）；Caddy 不动。

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

## 三、Repo 状态与风险

**2026-09-08 快照（upstream 0.1.3-alpha.2 对齐轮）**：checkout @ dsh-v0.1.3-alpha.2（三 patch，见 §二）构建全绿；omp-web 迁移到 v2 seam（persistence handle 面、session v2 流式/词表、header 身份一致性），tsc 0 错 + 单测 30/30 + 4999 全链路冒烟通过——实测报告 `docs/upstream-dsh-0.1.3-alpha.2-local-test-report.md`，openspec change `openspec/changes/2026-09-08-upstream-0-1-3-alpha-2-alignment/`。**prod 3081 = 旧 omp-web 0.2.0 跑在已升级宿主上（seam 违约态），发布 0.3.0 + 重启 3081 是下一步（T5/T6）**；peer 精确 pin 待裁决（T4）。新增未入库：`docs/upstream-dsh-0.1.3-alpha.2-report.md`（调研）+ `-local-test-report.md`（本轮实测）、openspec change 目录。

（以下为 2026-09-03 历史快照）

- **v0.2.0 rebrand 已全链路落地（2026-09-02）**: `omp-webui` → `omp-web` 统一品牌——GitHub repo 改名（旧 URL 重定向）、npm `@pgmi-builds/omp-web@0.2.0` 发布、prod profile 切换（lock integrity = 发布 tarball shasum）、`omp-web.service` 重启验证（active、3081 应答、bridge-store 正常打开）。v0.1.2 时代的未提交漂移（`RemoteError` preset fix）已随本次提交收敛入库。
- 旧的 `@pgmi-builds/omp-webui` npm 包保留在 registry（最后 0.1.2），不 unpublish、不再维护；无外部用户依赖（用户确认）。
- `master` 与 origin 同步；发布走 git tag（`v0.0.2`…`v0.2.0`）。
- Untracked/遗留: `Caddyfile.opengate`、`.dsh_better_edit/`（编辑工具产物，.gitignore 候选）；`docs/upstream-dsh-0.1.2-alpha.5-report.md`、`docs/upstream-dsh-community-survey.md`（2026-09-02/03 上游调研产物——alpha.3→alpha.5 改进报告 + 社区生态调研，核心结论：市场 1000 条目中零 OMP 桥接、omp-web 独一份；harness 升级决策的前置材料，未入库）；`~/.config/systemd/user/dsh-omp.service.d` 孤儿 drop-in（unit 已不存在，无害，可清理）；`omp-web-test` profile 已从盘上移除（按需重建）；profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里残留一条 `@pgmi-builds/omp-webui@0.1.2`（无害）。
- 版本线: v0.0.3 删集中化 omp-sessions.json → v0.1.0 收敛为 `apps/` 布局 + session supervisor → v0.1.1 以 SQLite（bridge-store.sqlite）重新引入集中 index、废弃 mobile/in-dsh apps（→ `archived/`）→ v0.1.2 registry 分发 + model-selection bridge → **v0.2.0 rebrand omp-web**。

---

## 四、dsh 插件开发面速查（host 半）— 2026-09-03 自 dashr 蒸馏

机制层知识原沉淀于 dashr 仓 `.agents/skills/dsh-plugin-development` 与 `upstream-alignment`（**2026-09-08 起该目录已重组不存在**；对齐轮实操记录转见 dashr `openspec/changes/archive/2026-09-08-upstream-0-1-3-alpha-2-alignment` 与本文件本节 + §二）。只留对本仓——host 半、无 client 半的 OMP wrapper 插件——load-bearing 的裁决：

- **patch 行模型**：行 schema `{id, name, config, inject, disabled, group}`；层序 = bundles（列序）→ profile patch → home patch → `--patch`，后层按 id **整行重述**（全键重写，非 merge），用户层恒胜。改 `name` 触发重新 import——整插件替换的正规入口 = patch 行 id 覆盖 + `name` 重指。`!!js` 表达式 boot 期求值，可读 `process.env` 与 loader 上下文服务（先例 `trustedHosts: !!js ctx.webRuntime.trustedHosts`）。
- **硬边界（组合面 fail-loud，无 last-wins）**：同 scope 重复 `ctx.provide` = 加载期硬错；**兄弟插件之间不存在 service 遮蔽**（closest-wins 仅沿 fiber.parent 祖先链，跨 isolate 即停）；同名包遮蔽原生模块也不可行。omp-web 替换原生行为的唯一正道 = patch `disabled` + 自供（现状即此），不能同名 provide 抢注。
- **host 半范式**：`apply(ctx)` + `inject` 声明式依赖（服务到位才加载、服务替换自动重跑）；HTTP 面 `ctx.webServer.register({kind:'prefix', path, handler})`；config schema 用 schemastery（default 即文档）。**fail-open 不阻断宿主**：对 omp 二进制/外部态的探测与供给失败要优雅降级，勿让宿主 dsh 起不来（dashr kernel 三级供给是范本）。
- **浏览器侧信任缺口（omp-web 待验证风险）**：原生 ui-settings 的 describe mirror 在非 loopback 页面 = memory = terminally unavailable（"settings are unavailable in this browser"，Settings/Models 页瘫；上游设计笔记定性为实现产物而非设计决策）。`omp.pc.randomhash.app` 页面权威非 loopback，而 omp-web **无 client 半**、无 ownsHost 补偿——dashr 的 B 机制 = host 半监听 `webserver/index-inject` push head 内联脚本设 `window.__DSH_TRANSPORT__={ownsHost:true}`（head 先于一切 bundle，无时序竞争；ownsHost 属 off-label，对齐轮盯其消费点）。域名上若需 Settings/Models 页需评估补 client 半；loopback 直连 127.0.0.1:3081 不受影响。
- **上游对齐轮（harness 新 tag 时）**：S1 先查 patch 载体文件（`package.json`/`pnpm-workspace.yaml`）tag 间 diff + 插件引用的 `@deepseek-ai/*` 名在新 tag 包集合是否齐全；S2 备份 → stash → checkout → pop 重放本地 patch（本仓 = §二 三件套：storeDir/unrun/resolveRepositoryRoot）；S4 `set -o pipefail`、install/build 错误读全文勿只看尾部；S6/7 用 §二 systemd-run 配方拉 4999 + 冒烟；差异报告落 `docs/upstream-dsh-<version>-report.md`（调研）+ `-local-test-report.md`（实测）；发现 → openspec change，坑/约定回写本文件。
- **session v2 速查（0.1.3-alpha.2 实测沉淀，2026-09-08）**：① persistence seam = handle-based 五方法 `create/open/flush/stat/list` + `SessionHandle`（read/write、`read(offset,length)`、append/flush/close、`SessionReadOnlyError`/`SessionHandleClosedError`），v1 的 `load/inspect/prepare/borrowSession/readRaw/locate` 全删；宿主里唯一 `create`/`open('write')` 生产者是 agent-loop——被 patch 禁用的插件（omp-web）写路径天然闲置，纯读方即可。② **header 身份三路折叠**：`assertSessionHeadersCompatible` 跨 live/listed/loaded 比对 id/createdAt/cwd/parentSession/isSeeded/delegationDepth——插件行数据与 prepare 时宿主盖的 header 必须逐字段相等（Date.now() 双写 = 毫秒差 = 一行毒行令整个 list SOURCE_CONFLICT）；行镜像 header 是唯一稳态，reconcile 扫描不得覆写桥接授权字段。③ 流式：`assistant/chunk` 词表已删，`assistant/message` 必带内嵌 `stream: AssistantStreamRecord[]`（v1 兼容 view：`sourceEventSeqs` 在 assistant/message 上为 never），live 走 `agent/assistant-stream` 帧（start/密集 chunk/end，revision 单调）由 session-controller 折叠重连基线。④ `SessionEventMap` 核心词表 = turn/step 括号 + user/message + assistant/message + assistant/attempt + tool/call + tool/result + request/header(必填 reason) + request/context + session/end-seed；`KNOWN_SESSION_EVENT_TYPES` 是**生成的静态 catalog**（无运行时注册机制，downstream 插件事件靠 `ignorable` 标记），omp-web 合成的 session/title、permission/*、agent-preset/selected 均在 catalog 内。⑤ seed 校验深度分层：`validateStoredEvents`（类型+envelope）放行 ≠ session seed 校验放行（assistant/message 缺 `stream` 即拒）——replay 产物要按 v2 data 完整形状造。⑥ `SessionHeader` v2 必填 `isSeeded`；`SessionSeq`/`SessionLogOffset` 是 brand，构造侧用 `SessionSeq(n)`/`SessionLogOffset(n)`；resumed 会话 seed 校验走 RestoredSessionOptions（全 header + inheritedEventCount + eventState）。⑦ wire：HTTP API = typert RPC `POST /api/<ns>/<method>`，envelope `{type:"client-request",rpcId,method:"<ns>/<method>",payload:{args:{request|_request}}}`（list 类用 `_request`，命令类用 `request`）；`session/page` 的 `throughSeq > cursor` 直接报错并回吐当前 cursor。
