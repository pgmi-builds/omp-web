# Design — omp-web v2 Seam Migration

## Context

宿主 0.1.3-alpha.2 引入 session 格式 v2（`SESSION_FORMAT_VERSION = 2`）与 handle-based persistence seam。omp-web 的架构不变式保持不动：**OMP 原生存储是唯一 transcript of record**，桥接层 SQLite index 是唯一 list/id/metadata 权威，Dash 侧从不写 OMP 的转录文件。v2 的写路径所有权（lifecycle-owned + fs-ext flock lease）因此对 omp-web 天然无害——桥本来就是纯读方；本轮的实质工作是**把读路径和流式呈现翻译到新词表**。

## Goals / Non-Goals

- Goals: 冷读/列表/统计在新 seam 下与宿主服务（session-query、feedback、workspace、projection cache）互通；live 流式在 WebUI 无回退；header 身份三路观察一致。
- Non-Goals: 不实现 Dash 侧持久化（内存写 handle 是终态而非妥协）；不引入 fs-ext lease 参与声明；不做 fileMention 修复（独立小修）。

## Decisions

### D1. 写 handle = 内存 buffer（终态设计，非过渡 shim）
`create`/`open('write')` 返回内存 handle：`append` 校验连续性后入 buffer、`flush` 是 materialize no-op（OMP 拥有持久化）、读自己的 buffer 满足 freshness 契约。依据：agent-loop（唯一 `create`/`open('write')` 生产者）在 omp-web 组合里被 patch 禁用；写路径实际消费者只有 feedback 类旁路写入，进程内可见即可，跨进程持久化本就归 OMP 转录。

### D2. 读 handle 的验证与冻结
`eventsOf` 填充时过 `validateStoredEvents` + `assertContiguous` 并冻结，交付标 `shared-frozen`（与 jsonl 后端同约定）。验证失败 fail-soft 为空日志 + logger.warn（与 warm pass 的 per-session fail-soft 对齐），下一次 (size,mtime) 变化重填。

### D3. header 身份一致性（实测 F1/F2/F3 的根）
v2 `assertSessionHeadersCompatible` 把 live/listed/loaded 三路观察折叠到同一 header 身份。规则落为：**prepared session header 是单一事实源，行是它的镜像**。
- createAgent：先 `sessions.prepare` 后 `upsertCreated`，行 `created_at`/`cwd` 取自 `header`（原实现两个独立 `Date.now()` 的毫秒差即 SOURCE_CONFLICT，一行毒行令整个 list 失败）。
- resume：prepare 后 `syncSessionHeader` 镜像回行（扫描 epoch 与行插入时刻可漂移）。
- reconcile：`rowFromEntry` 对已存在行**保留** `created_at`/`cwd`（桥接授权字段），扫描值只落 TUI-born 新行；否则周期扫描在创建几十秒后把身份打回冲突。
- 守卫：supervisor materialize 前 `sessions.get(id)` 幂等检查（`prepare` 对重复 id 抛错 = prod journal `already exists` 的根因）。

### D4. 流式：帧协议镜像 agent-loop，durable 记录用 raw chunk
`AssistantStreamBridge`（agent.ts 内联类）复刻 `AssistantStreamAttempt` 的对外协议（start / 密集零基 chunk / end settle-or-abandon；revision 每 Agent 生命周期单调），帧经本 agent 的 `agent/assistant-stream` dispatch 发布，session-controller 折叠进重连基线。durable 侧不做 compaction，直接累积 `{type:'chunk',time,chunk}` 原始记录（`AssistantStreamRecord` 的兜底变体，controller 可折叠）——OMP 的 text_delta 密度不需要 join 优化。`settle(seq)` 在 `assistant/message` append 后以已提交 seq 收束。

### D5. replay 的 v2 产物最小正确化
replay 合成的 `assistant/message` 带 `stream: []`（OMP 转录无 timed delta，如实为空；字段缺失会被 session seed 校验拒绝——`validateStoredEvents` 放行但下游不放行，校验深度不同的坑）；`request/header` 补 `reason: "resume"`；`sourceEventSeqs` 在 assistant/message 上为 v2 禁止项，全部摘除。

### D6. vendored types 刷新程序
对齐轮固定动作：对每个 `types/@deepseek-ai/<pkg>`，从全局树 `<pkg>/lib/types/*.d.ts`（npm 安装态 = 运行宿主同版本）整目录重灌，删增对应；tsconfig `paths` 只映射裸 specifier 与 `dsh-session/types`（内部 `.ts` 后缀相对导入在 `skipLibCheck`+bundler resolution 下可解析）。

## Risks / Trade-offs

- 内存写 handle 的 appends 进程死即失（feedback 类写入不落盘）——与 v0.2.0 行为持平（旧 append 是 no-op），无回归；若未来要持久化 feedback，需 OMP 侧载体，另立 change。
- reconcile 保留 `cwd` 意味着 OMP 侧搬家后行 cwd 不自动跟移（标题/模型/大小仍更新）——工作区分组由 `#attachScannedSessions` 的 cwd 群组逻辑兜底；如需跟移另立规则。
- `assistant/message` 的 `sourceEventSeqs` 摘除后 provenance 断链——v2 语义下 provenance 由内嵌 stream 承担，属预期。

## Migration Plan

1. 本轮：代码迁移 + 4999 冒烟（已完成，全绿）。
2. 后续任务 T4–T6：peer 裁决 → publish 0.3.0 → 3081 升级窗口 + prod 冒烟（冷读旧会话 + 新会话 round-trip + feedback 写路径）。
3. 用户验收 4999 后停 unit；冒烟测试会话清理。

## Open Questions

- ~~peers 转区间 vs 精确 bump~~ 已裁决（2026-09-08）：精确 bump `0.1.3-alpha.2`，已落 package.json。
- 旧 `fileMention` 未处理角色的映射目标（T7；新宿主是否有对应 v2 词表需查 attachment 通道）。
