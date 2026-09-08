# Model Selector: serve ACTIVE-usable providers, not the registry cache

## Why

WebUI 模型选择器当前展示 **36 个 provider / 3483 个模型**（nanogpt 979、kilo 550、openrouter 472、amazon-bedrock 151……），但本部署根本没有这些 provider 的凭据。根因：`src/models.ts` 的 `loadOmpModels()` 把 `agent/models.db` 的 `model_cache`（**OMP 全量模型注册表的本地缓存**——注册表"认识"的一切，与部署凭据无关）并进了选择器目录；权威的 `get_available_models` RPC 又因响应超出 1 MiD 传输帧上限被弃用（模块注释自记）。

**"可用"只有 OMP 自己能判定**（2026-09-08 官方文档 `providers.md` 实证）：模型可选 ⇔ provider 不在生效 `disabledProviders` 且（keyless 或有可解析凭据），而凭据是 **7 级 precedence**（runtime `--api-key` → `models.yml` apiKey → 存储 OAuth → `/login` 存储 key → provider 环境变量含 `.env` → broker 迁移 key → 自定义 provider 兜底 resolver），其中 OAuth/登录凭据存在 `agent.db`——**读任何配置文件（models.yml/config.yml/.env）都无法复原这个判定**。初版方案（读 models.yml ∪ modelRoles）因此不可靠，已废弃。

## Explored alternatives（2026-09-08 探讨结论）

| 方案 | 实测 | 结论 |
|---|---|---|
| A. 读 models.yml ∪ config.yml modelRoles | 声明集合 = bailian/kimi-plan/zai-plan + deepseek | ❌ 不可靠：漏 OAuth/agent.db 存储凭据、漏 keyless、无视 disabledProviders；仅作降级保留 |
| B. RPC `get_available_models` | 响应 ~兆级，超 1 MiB 帧 | ❌ 上游帧限解除前不可用；保留为未来切换项 |
| C. RPC `get_login_providers` | `{id,name,available,authenticated}` 紧凑 | ⚠️ 语义偏 login 能力而非模型可用性；仅模型级信息缺失 |
| D. **CLI `omp models --json`** | **1.7s / 15 KB / 50 模型 5 provider**（xai:37, bailian:5, zai-plan:4, deepseek:3, kimi-plan:1） | ✅ **采用**：与文档"selectable 判据"同源，凭据全解析，天然排除 registry 缓存噪声 |

实测对照：`models.db` 36/3483 vs `omp models --json` 5/50 —— 差距就是"注册表认识"与"实际可用"的距离。

## What Changes

- **目录来源换成 `omp models --json`**：`src/models.ts` 的 `loadOmpModels()` 改为一次性子进程调用（`OMP_HOME` 环境继承、可写 cwd、~2s、15 KB），解析 JSON 构建选择器目录，结果 memoize；`normalizeModel`/`toModelInfo`/`toResolvedModelInfo` 等下游映射保持不变（JSON 字段为 OMP 原生形状，超集兼容）。
- **降级链**：子进程失败（非零退出/超时 10s）→ 回退现行 db∪overlay 行为 + `logger.warn`（fail-open，与插件既有降级规范一致），选择器不空转。
- **刷新策略**：boot 一次 + 按需（`STORAGE_RECONCILE_INTERVAL_MS` 同周期或首次选择器请求时）重跑；`omp models refresh` 不主动调用（在线发现，避免选择器路径上引入网络依赖）。
- 删除 `loadModelsDb`/`loadModelsYml` 主路径地位（降级链内保留）。

## Capabilities

### Modified Capabilities

- `model-selection/catalog-source`（omp-provider 的 OMP 目录来源）: 目录 = `omp models --json`（凭据解析后的 available 集合）；文件源（models.db/models.yml/config.yml）降级为 fallback；记录 1 MiB RPC 帧限与 `get_available_models` 的切换条件。

## Impact

- 代码：仅 `src/models.ts`（来源替换 + 子进程适配 + 降级链）。
- 行为：选择器从 36 provider/3483 模型收敛到 **5 provider/50 模型**（随 OMP 凭据增删自动跟随）；xai 全目录因 `XAI_API_KEY` 首次可见（37 个模型此前被 3483 个噪声淹没）。
- 已保存的自定义模型选择按 provider+id 匹配，不受影响。
- 风险：子进程启动 ~1.7s 只发生在 boot/刷新路径；`omp models` 会写自己的状态 db，必须以可写 cwd + `OMP_HOME` 运行（daemon 上下文天然满足）。
