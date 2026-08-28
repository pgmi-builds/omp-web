## 1. Spikes（风险前置，任一失败即回到 design 修订）

- [x] 1.1 Spike-1 路由 factory：最小 PoC——根 context 注册 RouterFactory，子 fiber 程序化挂载原生 AgentLoop，经 apiproxy `session.create` 创建一个原生 preset 会话并跑一轮对话；验证 create/resume/ownerCtx tracing 与未打补丁的行为一致（对比日志无 ownership 异常），产物为 `apps/omp-in-dsh/spikes/routing.md` 结论记录
- [x] 1.2 Spike-1b 复合 persistence 占槽：patch `disable` 原生 session-persistence 配置式挂载后，子 fiber 挂载原生 JSONL 后端 + 根槽 Composite 占位（list 原生侧透传），验证原生会话持久化/恢复不回归；结论并入 `spikes/routing.md`
- [x] 1.3 Spike-2 bundle config 复刻清单：读取目标 profile 的 dsh-base bundle 中 agent-loop 与 session-persistence 的默认 config，列出子 fiber 挂载需复刻的每一项；结论记录到 `spikes/routing.md`
- [x] 1.4 Spike-3 版本握手面：确认 OMP RPC 握手（ready/getState）可取得的版本信息形态；若无直接版本字段，确定替代来源（`omp --version` 子调用或 state 元数据）；结论记录到 `spikes/routing.md`

## 2. 包骨架与桥接层

- [x] 2.1 创建 `apps/omp-in-dsh` package（`dsh-omp-in-dsh`：package.json + tsconfig + `dsh.bundle.patch` 声明，peerDeps 对齐 omp-webui），`pnpm install` + `tsc` 空构建通过
- [x] 2.2 桥接层拷贝：omp-webui 的 rpc/agent/replay/pairing/permission/omp-store/models 原样拷入 `src/bridge/`（共享模式无参数化改动），`tsc` 通过；spawn 目标保留 PATH `omp` 并加 `OMP_BIN` 覆盖
- [x] 2.3 版本握手：按 Spike-3 结论在 RPC 握手后校验版本兼容范围（默认 18.x，`OMP_VERSION_RANGE` 可放宽），超范围拒绝创建并报实际版本；单测覆盖拒绝路径与放宽路径

## 3. 共存接线（factory / preset / persistence）

- [ ] 3.1 RouterFactory：实现 preset/meta 判定 + OMP 分支（调 bridge 的 OmpProvider 逻辑）+ 原生分支（委托子 fiber AgentLoop，含 seed 消毒：seed provider 带 `omp/` 前缀时替换为原生模型）；集成测试覆盖 spec `agent-provider` 三场景（omp 创建、原生不受影响、OMP 故障不外溢——用坏 `OMP_BIN` 路径注入故障）+ `model-catalog` seed 消毒场景
- [ ] 3.2 preset 贡献：按用户另一项目验证的自定义 preset 路径向原生 roster 注册 `omp` preset；验证 roster 列表同时含全部原生 preset 与 `omp`，且移除 plugin 后原生 preset 完整（spec 场景验收）
- [ ] 3.3 CompositeSessionPersistence：list 并集 + id 路由（OMP 配对集 → OMP 分支 no-op 写；其余 → 原生后端）；集成测试覆盖混合列表、原生后端故障不拖累 OMP 侧、OMP 会话重启后历史与 store 一致（spec `session-storage` 场景）
- [ ] 3.4 会话身份与排他：pairing 工件写入本机 OMP store、未知 id 拒绝恢复、`foreignWriterPid` 排他（omp-webui 语义原样）；用户级冒烟：TUI 打开同一文件时 Web UI 接入被明确拒绝、结束的 Web UI 会话可被 TUI 恢复（spec `runtime` 共享场景）
- [ ] 3.5 workspace reconcile：30s 归组 + warm pass 沿用 omp-webui（扫描 `~/.omp/agent/sessions`、排除 OMP/DSH home）；验证 TUI 创建的会话落入正确 workspace、原生会话归组不变

## 4. 模型目录与选择

- [ ] 4.1 动态注册生命周期：`omp/` adapter 注册 handle 由 OMP 会话计数驱动（首个创建/恢复成功注册、最后一个结束 `replace([])`）；`stream()` 抛 `UNSUPPORTED_STREAM`；测试覆盖三个注册场景（零暴露/存活可选中/结束收敛，断言 `llm/adapters-updated` 事件随变化发出）
- [ ] 4.2 选择同步：OMP 分支忽略 seed agentOptions；会话内切换仅当 `omp/` id 时翻译推给 RPC 子进程；测试覆盖"切换生效"与"不污染他 会话"
- [ ] 4.3 原生会话选 OMP 模型的失败路径：`omp/` 选择在原生会话生成前以明确错误失败（指引切回原生模型）；验收 spec `model-catalog` 全部场景

## 5. 部署与验收

- [ ] 5.1 部署配方：目标 profile 的 `file:` 依赖 + `cordis.patch.yml`（两条 disable + insert）+ `dsh plugin` reconcile + 前提检查（本机 `omp --version` 在范围内）写成 `apps/omp-in-dsh/DEPLOY.md`
- [ ] 5.2 端到端冒烟（按 spec 全场景清单执行）：原生/OMP 会话各建跑一轮、混合列表、两侧恢复、动态 catalog 三态（无会话/存活/结束）、模型切换隔离、TUI 互见与排他；结果记录到 `apps/omp-in-dsh/spikes/e2e-signoff.md`
- [ ] 5.3 回滚演练：按 DEPLOY.md 反向操作后实例恢复纯原生形态（原生 loop/persistence 重新挂载、`omp` preset 与 catalog 条目消失、`~/.omp` 共享数据完好）；验证后写入 e2e-signoff.md
