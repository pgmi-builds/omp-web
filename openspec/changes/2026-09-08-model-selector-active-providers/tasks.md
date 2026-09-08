# Tasks — Model Selector Active Providers

## 1. 实现（src/models.ts）

- [x] T1 `ompModelsJson()`: 子进程调用 `omp models --json`（`OMP_HOME` 继承、cwd=OMP_HOME、10s 超时、UTF-8 解析），返回 `{models: OmpModel[]}`；normalizeModel 直接复用（JSON 为 OMP 原生形状）——落在 `src/omp-cli.ts`
- [x] T2 `loadOmpModels()` 重写: 首选 T1 结果（memoize + boot 同步/execFileSync）；失败回退 `loadModelsDb() ∪ loadModelsYml()` + stderr note
- [x] T3 `ompProviderIds()`: 顺序改为 modelRoles 命名优先（`omp config get modelRoles --json`），删除 `PREFERRED_PROVIDERS` 硬编码
- [ ] T4 单测（mock 子进程链路；当前以 4999 实测代替，产物级 mock 测试待补）: mock 子进程（成功/非零退出/超时/畸形 JSON）断言主备链与 memoize；产物目录字段断言

## 2. 验证与收尾

- [x] T5 4999 实测（2026-09-09）：`session/modelCatalog` = 5 provider（deepseek 3 / bailian 5 / zai-plan 4 / kimi-plan 1 / xai 37），defaultSelection=zai-plan/glm-5.3-flash。另：本 change 实现扩展为 **CLI 模式模型功能闭环**——新增 `src/omp-cli.ts`（models --json / config get·set modelRoles），`src/index.ts` 双向 default 同步 tick（OMP↔DSH shadow key 差分，防回环）。**xai 模型实际发起一轮对话验证凭据链待做**
- [ ] T6 prod 3081 随 0.3.0 升级窗口验证（daemon 上下文 cwd/OMP_HOME 满足子进程写库前提）
- [ ] T7 上游帧限跟进记录：`get_available_models` 超 1 MiB 的上游 issue/旋钮线索（若解除，可评估 RPC 直读替代子进程）
