## 1. 依赖对齐

- [x] 1.1 将 `apps/omp-web/package.json` 的 `@deepseek-ai/dsh-*` peerDependencies 从 `0.1.2-alpha.1` 升到 `0.1.2-alpha.3`，运行 `npm install` 并执行 `npm run build`，验证 tsc 编译通过（本地 node_modules 已装 alpha.3）。

## 2. default model 追踪

- [x] 2.1 在 `store/db.ts` 增加 `ui_state` 表 key=`default_model` 的读写方法（value=JSON `{provider, model}`），并暴露经 `store/index.ts`；验证：写入后读回一致，空值返回 `undefined` 不抛错。
- [x] 2.2 在 `omp-store.ts` 增加读取 `~/.omp/agent/config.yml` 的 `modelRoles.default` 的函数（返回 `{provider, model}` 或 `undefined`），并接入 provider 的扫描周期（值变化才更新 store）；验证：改动 config.yml 的 default 后，下一个扫描周期 store 的 `default_model` 收敛到新值，未变化时无写。
- [x] 2.3 在 provider 初始化处读取 config 的 default 并调用 `ctx.agentDefaultModel.saveSelection({provider, model})`，使 Web UI 经 `currentSelection()` 读到；验证：新建 OMP 会话的初始模型选择来自该默认值，且已有运行会话的模型不被同步动作覆盖。

## 3. last used model 修正（`lastRestorableModel`）

- [x] 3.1 在 `omp-store.ts` 增加读取 transcript `model_change` entries 的函数（按时间顺序返回 `{model, role?}` 列表），合并进 `readOmpTranscript` 的单次读取；验证：对 T2 transcript 能读到 3 条 model_change（kimi/role 缺失、kimi/role=default、deepseek/role=fallback）。
- [x] 3.2 实现 `lastRestorableModel` 替换 `lastModelCall`：构建 `models` record（`role ?? "default"` → `model`），取 `lastRole`，`lastRole ∈ {undefined, "default", "fallback"}` 时取 `models.default`，否则取 `models[lastRole] ?? models.default`；无 `model_change` 时回退最后一个 assistant message。验证：单测覆盖 T1（fallback 后取 kimi）、T2（fallback 后取 kimi）、T4（set_model 后取 kimi）三类 transcript，断言均返回 kimi 而非 deepseek。
- [x] 3.3 将 `reconcile.ts` 与 `replay.ts`（及其 `session-persistence-omp.ts`/`supervisor.ts` 调用方）的 `lastModelCall` 调用替换为 `lastRestorableModel`；验证：对 T2 会话 reconcile 后 store 的 `model_provider`/`model_id` 为 kimi，replay 生成的 `request/header` 也是 kimi（而非 deepseek）。

## 4. 集成验证

- [x] 4.1 起真实 OMP RPC 会话验证：新建会话 `get_state.model` = config `modelRoles.default`（实测 default=deepseek-v4-pro 时 new session 为 deepseek-v4-pro）；`lastRestorableModel` 对 T1/T2/T4 真实 transcript 均返回 kimi（剔除 fallback）。
- [x] 4.2 运行 `openspec validate model-selection-bridge --strict` 通过，且 `apps/omp-web` 构建无回归（`npm run build`）。
