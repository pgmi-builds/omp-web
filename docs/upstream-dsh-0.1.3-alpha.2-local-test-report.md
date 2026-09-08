# 上游 dsh 0.1.3-alpha.2 对齐轮 — 本地实测报告（dsh-omp）

- 执行日期：2026-09-08（本轮，goal 驱动）
- 前置材料：`docs/upstream-dsh-0.1.3-alpha.2-report.md`（纯源码 diff 调研）
- 实测对象：`upstream/dsh` checkout @ **dsh-v0.1.3-alpha.2**（源码构建，tsx 运行）+ `apps/omp-web` 插件（tsc 构建，link 进 `omp-web-test` profile）
- 实测环境：4999 端口 systemd-run 实例（`omp-web-4999-test`），`DSH_HOME=~/.omp/omp-web`（与 prod 共享，契约拓扑）、`OMP_HOME=~/.omp`，OMP 18.0.11，模型 zai-plan/glm-5.3-flash
- 结论先行：**omp-web 0.2.0 在 0.1.3-alpha.2 宿主上不可用**（persistence seam 全面违约）；本轮完成插件迁移使其在新宿主上全绿（tsc 0 错、单测 30/30、4999 全链路冒烟通过）。**prod 3081 与 dashr 轮共用已升级到 0.1.3-alpha.2 的全局宿主，正跑着旧构建的 omp-web@0.2.0 —— 升级 omp-web 是 prod 的紧急事项。**

---

## 一、S1：patch 载体 diff + peer 清单

- 载体文件 `package.json`/`pnpm-workspace.yaml` tag 间 diff（alpha.3→alpha.2）实质变化：
  - `allowBuilds` 新增 **`fs-ext: true`**——**session 写锁是 flock(2)/LockFileEx，落地为原生依赖 fs-ext**（调研报告预测的 write lease 实锤）。
  - 新增 `benchmarks` workspace、`@yao-pkg/pkg` patchedDependency、pi-ai 0.85.1 + pi-telemetry exclude。
  - 新增 `verify-session-format-catalog` 脚本——**session 格式 v2 由生成的 catalog 正式化**（`known-event-types.ts` 为生成物，`gen-persistence-catalog` 校验入库 doc-sync）。
- omp-web 的 7 个 `@deepseek-ai/*` optional peers 在新 tag 全部存在，统一版本 0.1.3-alpha.2。
- **发现 P1**：omp-web peerDependencies 是**精确 pin `0.1.2-alpha.3`**（dashr 用区间 `>=0.1.2-alpha.1 <0.2.0-0`）。本轮未动（运行期由宿主 vendored 树供给，不生效），留 openspec change 决定 bump 或转区间。

## 二、S2/S4：checkout 更新 + 安装构建

- checkout 干净树直接 `git checkout dsh-v0.1.3-alpha.2`（原 pin dsh-v0.1.2-alpha.3，无本地脏文件需备份）。
- **补上欠账的 storeDir patch**：pnpm 11 不读 `.npmrc`，在 `upstream/dsh/pnpm-workspace.yaml` 写入 `storeDir: ~/.scratch 路径` + `verifyDepsBeforeRun: false`。install 20.9s 一次通过；upstream 自带的 `allowBuilds` 表已完整声明（fs-ext 等），**pnpm 11.7 的 allowBuilds 占位符坑未复现**。
- 构建三连坑（前两条与 dashr 轮记录完全互证）：
  1. **`unrun` devDep 缺失**：tsdown 0.22 的 config loader 动态 import `unrun`，upstream 自己没声明 → `Failed to import module "unrun"`。修法照抄 dashr：根 package.json devDeps 加 `"unrun": "^0.3.1"`。
  2. **`packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT`**：unrun 把 config 编译进 `node_modules/.unrun/*.mjs`，`import.meta.url` 被改写到缓存位置，`new URL('../..', import.meta.url)` 解析到 `node_modules/`，workspace glob 找不到任何包 → `no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-session-controller`。修法照抄 dashr：`resolveRepositoryRoot()` 用 `pnpm-workspace.yaml` 存在性锚定，回退 `process.cwd()`。
  3. 修后 `pnpm run build` 全绿（host+client，224 个 client artifact）。
- 交付时 checkout 工作树含三个本地 patch（storeDir、unrun、resolveRepositoryRoot），与 dashr 侧"三个必需项"清单一致。

## 三、S5：vendored types 刷新 + 迁移

- vendored `types/@deepseek-ai/*` 全部 10 包用全局树（0.1.3-alpha.2 npm 安装态）`lib/types/*.d.ts` 重灌。包级 delta 本身就是 drift 地图：
  - `dsh-session-persistence`：`coordinator/preparations/write-behind` 消失 → **`handle/storage-contract`**（handle-based seam + 存储契约物化函数）。
  - `dsh-session`：`chunk-rows/json` 消失（v2）；`SESSION_FORMAT_VERSION = 2`。
  - `dsh-llm`：新增 `assistant-stream`（`AssistantStreamRecord`/`AssistantStreamAccumulator`），删 `never`。
- tsc 首轮 19 错，全部落在预测面。逐文件迁移：

| 文件 | 迁移内容 |
|---|---|
| `replay.ts` | `seq: index` → `SessionSeq(index)`（brand）；`request/header` 补 v2 必填 `reason:"resume"`；replay 出的 `assistant/message` 补 `stream: []` 并去掉 `sourceEventSeqs`（v2 禁止 + 下游 seed 校验要求 stream 字段存在） |
| `agent.ts` | `session.events` → `session.snapshotEvents()`；删除 v1 `assistant/chunk` 逐 delta append；新增 `AssistantStreamBridge`（镜像 agent-loop `AssistantStreamAttempt` 的帧协议：start/密集 chunk/end，经 `agent/assistant-stream` dispatch 发出），文本 delta 进桥，settle 时以 `event.seq` 收束；`assistant/message` 携带 `stream` 记录、去 `sourceEventSeqs` |
| `session-persistence-omp.ts` | **按 v2 五方法面重写**：`create`（内存写 handle）、`open(id,'read'|'write')`（读 handle 走 replay；写 handle 内存 buffer + `SessionReadOnlyError`/`assertContiguous`）、`flush`（OMP 拥有持久化，no-op barrier）、`stat`、`list(options)`；`headerOf` 补 `isSeeded:false`；replay 填充时过 `validateStoredEvents`+`assertContiguous`，冻结后以 `shared-frozen` 交付；删除 v1 面（`locate/listSnapshots/append/load/inspect/borrowSession/readFrom/prepare/supportsRawArtifacts`） |
| `supervisor.ts` | `sourceEventSeqs` 过 `SessionSeq()` brand；`SessionsSlice` 加 `get()`；**materialize 幂等守卫**（`prepare` 在 id 已 live 时抛 already-exists——prod journal 里 `materialize … already exists` 的根因） |
| `index.ts` | resume 弃用已删除的 `load/prepare` slice，改 `open('read')`+`handle.read()`（`readStoredEvents` helper）；resume seed 用 `record.createdAt`；新增 header 同步（见 §四 F1/F2） |

- tsc 0 错；`node --test` 30/30 通过。

## 四、S6/S7：4999 实测——三个实测发现（均已修复）+ 全绿矩阵

端口插曲：4999 被上一轮 dashr 的遗留实例（`dsh-4999-test.service`）占用，短暂用 4998 后按指示停掉 dashr 实例、回归 4999。**EADDRINUSE 启动竞态再次实锤**（dashr 轮已记录，需 interval 重试）。

### F1（高危，已修）：v2 header 身份一致性与 `Date.now()` 双写
v2 的 `assertSessionHeadersCompatible`（session-query）跨 live/listed/loaded 三路观察折叠**同一 header 身份**（id/createdAt/cwd/parentSession/isSeeded/delegationDepth）。omp-web 原来 `upsertCreated` 用独立 `Date.now()` 写行，与 prepare 时宿主盖的 `createdAt` 差毫秒 → **一行毒行让整个 `session/list` 抛 SOURCE_CONFLICT（0 会话可用）**。修复：createAgent 先 prepare 后 upsert，行 `created_at`/`cwd` 取自 `preparation.session.header`；resume 侧加 `syncSessionHeader` 把 prepare 后的 header 镜像回行。

### F2（高危，已修）：reconcile 扫描回写覆写桥接授权字段
`rowFromEntry` 无条件 `created_at: entry.createdAt` / `cwd: entry.cwd`（OMP 文件头 epoch）——周期 reconcile 在会话创建几十秒后把 F1 修好的行又打回冲突状态。修复：行已存在时**保留桥接授权的 created_at/cwd**（`existing?.created_at ?? entry.createdAt`），扫描值只用于 TUI-born 新行首次落库；preset/archived 等字段原本就走 existing 保留模式。

### F3（中危，已修）：replay 的 assistant/message 不满足 v2 seed 校验
冷读（`open('read')` → replay → `session-query` seed 校验）报 `seed assistant/message at index 8 has invalid …`——replay 产物缺 `stream` 字段（v2 必填，`validateStoredEvents` 放行但 session seed 校验拒绝）。修复：replay 补 `stream: []`（OMP 转录本无 timed delta，如实为空）。

### 修复后全绿矩阵

| # | 验证项 | 结果 |
|---|---|---|
| 1 | fence：无 token / 错 token → 401 | ✅ |
| 2 | auth：303→200，WebUI shell + `__ModuleLoader__` + 224 client bundles | ✅ |
| 3 | `session/list`（v2 persistence.list + projection 富化） | ✅ 140–142 会话 |
| 4 | 冷读：跨重启会话 page（omp-web replay handle → validateStoredEvents → shared-frozen → session-query） | ✅ 11 records，v1-chunk=false，stream=[] |
| 5 | live round-trip：create（v2 seed + preset 合成）→ prompt → OMP RPC → `assistant/message` **内嵌 stream records** → `turn/end` completed | ✅ 应答 "OK"，usage 就位 |
| 6 | 事件词表：全程无 `assistant/chunk`（v1 残留=0） | ✅ |
| 7 | header 一致性：round-trip 后 list 再无 SOURCE_CONFLICT（F1+F2 修复验证） | ✅ |
| 8 | journal：boot 后无插件错误、无 "no OMP models" 告警（OMP 模型发现正常） | ✅ |

单测：`node --test test/*.test.mjs` 30/30。tsc：0 错。

## 五、S0 侧写：prod 3081 的状态（本轮最紧迫输出）

全局宿主在 dashr 轮（2026-09-08 15:33 重启）已升到 0.1.3-alpha.2，omp-web prod(3081) 仍在跑**旧构建的 omp-web@0.2.0**：
- 旧 `OmpUnionSessionPersistence` 挂在新宿主上 = `create` 返回 void、`list(signal)` 收到 options 对象、无 `stat/open/flush` —— session-query 冷读、feedback、workspace list 全部踩空（本轮在 4999 复现前的理论推断被 journal 佐证：重启后尚无会话打开，故尚未爆）。
- 旧 journal 已有的两类错误（host 升级前就在）：`omp rpc: unhandled message_end role "fileMention"`、`materialize … already exists`（后者根因本轮已修）。
- **行动项：将本轮迁移后的 omp-web 发布（版本建议 0.3.0，v2 seam 重写为 minor 级变更）并重启 3081。** 发布前把 peer pin 决策（P1）一并落掉。

## 六、开放项

1. **P1 peer pin**：精确 0.1.2-alpha.3 → bump 0.1.3-alpha.2 或转 dashr 式区间（openspec change 裁决）。
2. **prod 3081 升级窗口**（§五）。
3. 用户手动验收 4999（token 每次重启轮换，最新：`6FIbTtCnzt2JQA83BQffcMA88HmnubkzdvEqZR4Bcis`）；验收后 `systemctl --user stop omp-web-4999-test`。
4. 冒烟产生的两个测试会话（`session-697bb1e3…`、`session-bad59e5e…`、`session-7dc9e379…`）留在共享 bridge store，可后续清理。
5. `fileMention` 未处理角色（旧 journal 遗留）——独立小修，未入本轮。
6. `session-persistence-jsonl` 的写 lease（fs-ext flock）与 OMP 旁路写的共存语义——omp-web 是纯读方 + 内存写 handle，本轮未触发；深设计进 openspec change。

## 七、复现

```bash
# 构建
cd ~/workspaces/dsh-omp/upstream/dsh && pnpm install && pnpm run build
cd ~/workspaces/dsh-omp/apps/omp-web && npm run build && node --test test/*.test.mjs
# 拉起（§二配方；token 从 journal 取）
systemd-run --user --unit=omp-web-4999-test \
  --working-directory=$HOME/workspaces/dsh-omp/upstream/dsh \
  --setenv=DSH_HOME=$HOME/.omp/omp-web --setenv=OMP_HOME=$HOME/.omp \
  --setenv=DSH_TELEMETRY_DISABLED=1 --setenv=OMP_IDLE_EXIT_MS=1800000 \
  /opt/node-v22.23.2/bin/node --import tsx/esm \
  $HOME/workspaces/dsh-omp/upstream/dsh/apps/cli/src/bin.ts --profile omp-web-test --port 4999 --no-open
# 冒烟（v2 线格式：POST /api/<ns>/<method>，envelope {type:"client-request",rpcId,method:"<ns>/<method>",payload:{args:{request|_request}}}
#   list 用 _request，其余用 request；page 的 throughSeq ≤ cursor，超界报错会回吐当前 cursor）
node ~/workspaces/dsh-omp/.scratch/smoke-full.mjs
```
