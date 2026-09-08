# 上游 dsh 0.1.2-alpha.5 → 0.1.2-rc.1 / 0.1.3-alpha.2 差异报告

- 调研日期：2026-09-08
- 方法：npm registry（dist-tags + time）+ 上游 git tag 纯源码 diff（`upstream/dsh` checkout `git fetch origin --tags` 后，对 `dsh-v0.1.2-alpha.5` / `dsh-v0.1.2-rc.1` / `dsh-v0.1.3-alpha.1` / `dsh-v0.1.3-alpha.2` 四个 tag 做 log/diff）。本报告为 `docs/upstream-dsh-0.1.2-alpha.5-report.md`（alpha.3→alpha.5）的续篇，回答"alpha.5 之后 npm 上有什么、值不值得升"。
- 本地 prod 基线：`@deepseek-ai/dsh` **0.1.2-alpha.5**（npm 2026-09-02 发布）。

---

## 〇、结论速览

1. **`latest`/`next`（0.1.2-rc.1）= alpha.5 纯版本号**：release commit `a66e470204` 一个 commit，252 个文件全部是 `package.json` 版本串 bump，**零代码变化**。升它只买标签语义（0.1.2 线转 RC），不买任何行为。
2. **唯一有实质内容的目标 = `alpha` 通道的 0.1.3-alpha.2**（npm 2026-09-07）：rc.1 之后 **417 commits**，源码量级 4866 文件 +103k/−40k（剔除 `.agents/notes`、`snapshots/`、`docs/` 后仍 2106 文件 +86k/−27k）。
3. **0.1.3-alpha.1 有 git tag、无 npm 发布**——registry 上 0.1.3 线直接从 alpha.2 开始（alpha.1 未发布或已撤）。对比上游源码时勿以 npm 版本号为准。
4. **对 omp-web 是 alignment-round 级别变更**：3 个 breaking `!` 全部落在 session 格式与 session-persistence seam——正是 `session-persistence-omp.ts` / `replay.ts` 桥接的契约面。**不可 drop-in 升级**，须走 AGENTS.md §四 upstream-alignment 流程（S1–S7 + 4999 冒烟）。

npm registry 快照（2026-09-08）：

| dist-tag | 版本 | 发布时间 |
|---|---|---|
| `alpha` | **0.1.3-alpha.2** | 2026-09-07 |
| `latest` / `next` | 0.1.2-rc.1 | 2026-09-03 |
| （本地 prod） | 0.1.2-alpha.5 | 2026-09-02 |

发布节奏：alpha.3（08-31）→ alpha.4（09-01）→ alpha.5（09-02）→ rc.1（09-03）→ 0.1.3-alpha.2（09-07）。0.1.2 线 4 天走完 alpha→RC，随即开 0.1.3 新线。

---

## 一、0.1.2-rc.1：release-only，无代码差异

```
git log --oneline dsh-v0.1.2-alpha.5..dsh-v0.1.2-rc.1
# a66e470204 release(dsh): 0.1.2-rc.1
git diff --stat 两者
# 252 files changed, 252 insertions(+), 252 deletions(-)  ← 全部 package.json 版本串
# 非 package.json 文件变化数：0
```

结论：0.1.2 线在 alpha.5 即已功能冻结，rc.1 只是走完发布流程。**对 prod 无升级动作价值**；若未来要对齐 0.1.2，直接以 alpha.5 为基线即可（等价）。

---

## 二、0.1.3-alpha.2 总量与构成

### 2.1 段位与类型分布

- rc.1..0.1.3-alpha.1：181 commits；alpha.1..alpha.2：236 commits（合计 417）。
- conventional type 计数：**fix 178、test 97、docs 53、refactor 26、feat 19、chore 13、ci 11、perf 9**、release 3、revert 2，另有 3 个 breaking `!`、1 条 feature revert、2 条非规范主题（telemetry 决策记录）。
- 剔除内部笔记/快照/文档后的源码 delta：2106 文件 **+85,811 / −26,696**。

### 2.2 变化热点（按前两级路径，rc.1→alpha.2 全量 diff）

| 区域 | 文件数 | 备注 |
|---|---|---|
| packages/client | 358 | web 客户端主体，最大热点 |
| packages/session | 168 | **格式 v2 + 迁移主战场** |
| packages/subagent | 75 | inbox/steer 对齐 |
| packages/core | 71 | |
| packages/experimental | 69 | |
| packages/llm | 68 | replay/流式相关 |
| packages/api | 64 | |
| packages/shell | 57 | |
| packages/subprocess | 52 | |
| apps/web | 95 | web 壳 |
| apps/cli | 45 | |
| packages/session-query / host / fs / context / bundle | 43/41/36/35/34 | |
| snapshots/session、snapshots/web | 176/109 | 快照重录（格式 v2 的伴生噪声） |
| .agents/notes | 2398 | 上游 as-built 笔记，调研金矿但非代码 |

---

## 三、破坏性变更（3 个 `!`，全部命中 omp-web 桥接面）

| commit | 内容 | omp-web 关联 |
|---|---|---|
| `f99b06eaed` | feat(session)!: **session 格式 v2**——assistant 流式帧内嵌进 session log | `replay.ts` 读的 log 形状变化 |
| `d1521ea783` | feat(session)!: **released v0→v2 迁移**——旧 log 打开时走 released migration | 老会话（含 prod 存量）首次打开路径改变 |
| `bec6805d6a` | refactor(session-persistence)!: **handle-based seam** + lifecycle-owned write path | `session-persistence-omp.ts` 所实现的持久化缝形态变化 |

紧邻的非 breaking 但强相关：`c58097a826` feat(session-persistence-jsonl): **跨进程写所有权 lease**（写路径独占化——对 omp-web 这类旁路写方是新的共存约束）。

---

## 四、主题簇

### 4.1 session 格式 v2 / 助手流式内嵌（最大主题）

- `30e045dfad` feat(agent): emit live assistant stream frames——助手流式帧成为一等公民。
- 回放链路重做：`165cc31eb8` perf(llm,host) 按 compact record 读内嵌 Assistant 流；`84c11c7243` perf(client) 不再重放已结算流；`7bab91d247` fix(llm) replay 时保留 Anthropic resolved model。
- 迁移管线流式化：`46196d6f95` perf(session-format) v0→v2 流式迁移；`ec2f63dbdb` perf(session-persistence) 流式发布+校验；`a3e5edbdbf` 历史读预先 prepare；`9b78f99dec` 冻结读转移进 restore；配 `5b91dbfba0` perf(session-query) 首读物化 live observation events。
- **同会话消息编辑**：`ef88756f13` feat(session,agent,web) 落地后又被整条 revert（"Revert feat(session, agent, web): support same-session message editing"）——alpha.2 上**不存在**该能力，勿按笔记误判。

### 4.2 附件/文件通道大改

`65d2015b09` feat(attachment) 通用文件 store+projection；`bafa6ae11d` feat(conversation) 文件走 submission lifecycle 流式；`8a0ff3aff8` feat(session-controller) 跨命令流收file；`a1144c4950` feat(ui-attachment) 混合附件统一呈现；`56ca8af0ee`/`a4d4404708` feat(ui-tool) `read_image` 结果渲染为图片卡（嵌套调用也有卡）。

### 4.3 agent / 子代理 / 系统提示词

- `48cc1cf1d6` feat(agent): **announce model switches**（切模型向会话广播）。
- `96ead6091d` feat(subagent): human inbox 控件对齐（#3223）；`040d73871b` feat(agent-team): steer 上消息统一；`754a65ab2d` fix(subagent): 消息前缀与正文分离。
- 系统提示词布局两连改：`e28862db57` 环境事实后置到可复用指令之后、`40792330c0` 保留 persona 前缀 + cwd 放后缀。
- `52475cbf50` spill 截断的 session-reference 捕获；`36a3a1188d` session-reference 默认预算按所选模型定尺寸。

### 4.4 工具默认面收窄

`36a4665144` feat(base) + `965adbb5cf` feat(sdk)：**str_replace_editor 移出默认工具**（base/SDK 默认不再挂载）。对依赖默认工具面的下游 preset 是行为变化（omp-web 的 patch 若显式列工具则需自查）。

### 4.5 网络与遥测

- `545e2ad914` feat(net): **所有出站请求走配置的 proxy**——对 prod 代理/防火墙环境是新的配置面。
- 遥测：`02a029e679` feedback 记入 session log 并回传 DeepSeek、`9ffe85a512` OTel 显式 feedback 默认全量上传；随后 `13daefe073` revert(session-telemetry-otel) 让遥测回到独立 transport、`b518286735` 修 fetch transport gzip。**prod unit 已设 `DSH_TELEMETRY_DISABLED=1`，新默认被兜住，但 alignment 时应验证该开关仍覆盖新 feedback 路径。**

### 4.6 其余

- `9292dd8a2d` feat(workspace): web UI 打开本地 app 的工作区（#3409）。
- `73edce1ae7` perf(agent-loop): 按 agent 复用已验证 message freeze。
- 大量 web 细节修复（queued submission 发送态、skill chips、terminal cards、session reveal 等）与测试/CI/benchmark 校准 churn（test 97 + ci 11 + perf 9）。

---

## 五、对 omp-web 的影响与建议

1. **升级决策**：rc.1 无意义；0.1.3-alpha.2 = 大版本级对齐对象。在 0.1.3 转 RC 前不必抢跑，但 persistence seam 的形态现在已定（handle-based + write lease），值得先读源码。
2. **alignment round 前置阅读**（S0）：`f99b06eaed`/`d1521ea783`/`bec6805d6a`/`c58097a826` 四个 commit + `.agents/notes/implemented/` 里 session v2 与 persistence 相关 as-built 笔记；对照本仓 `session-persistence-omp.ts`、`replay.ts`、`store/`（bridge-store.sqlite）逐点核对契约。
3. **风险清单**：(a) 格式 v2 迁移对存量会话的首次打开成本与失败路径；(b) JSONL write lease 与 omp-web 旁路写的共存；(c) read_image 渲染/附件通道变化对 OMP 桥接消息形状映射的冲击；(d) str_replace_editor 默认移除对 patch 工具面假设的冲击；(e) proxy/遥测新默认在 prod 环境的语义。
4. **流程**：照 AGENTS.md §四——S1 查 patch 载体文件 tag 间 diff；S2 stash/replay 本地 patch（storeDir patch 仍欠）；S4 `set -o pipefail`；S6/S7 systemd-run 拉 4999 冒烟；差异落 `docs/upstream-dsh-0.1.3-alpha.2-local-test-report.md`。发现走 openspec change。

---

## 附录：复现命令

```bash
cd ~/workspaces/dsh-omp/upstream/dsh
git fetch origin --tags
git log --oneline --no-merges dsh-v0.1.2-alpha.5..dsh-v0.1.2-rc.1        # 1 commit, release-only
git diff --stat dsh-v0.1.2-alpha.5 dsh-v0.1.2-rc.1                       # 252 文件, 全 package.json
git log --oneline --no-merges dsh-v0.1.2-rc.1..dsh-v0.1.3-alpha.2 | wc -l  # 417
git diff --shortstat dsh-v0.1.2-rc.1 dsh-v0.1.3-alpha.2
git log --no-merges --format='%h %s' dsh-v0.1.2-rc.1..dsh-v0.1.3-alpha.2 | grep -E '!:'   # breaking
# npm 侧
curl -s https://registry.npmjs.org/@deepseek-ai/dsh | jq '.["dist-tags"], .time'
```
