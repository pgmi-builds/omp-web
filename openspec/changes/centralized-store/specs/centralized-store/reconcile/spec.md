## Purpose

定义中央索引与 OMP 原生 store 之间的对账机制：启动 warm pass、周期 reconcile、事件驱动增量、完整元数据提取与一次性 webui.json 迁移，保证索引保持新鲜且字段完整。

## ADDED Requirements

### Requirement: 启动 warm pass 先于对外服务

桥接层 SHALL 在对外服务前完成一次全量对账，将 OMP store 内所有会话灌入索引；启动阶段索引 MUST 覆盖全部现存会话后再接受请求。

#### Scenario: 冷启动列表真实
- **WHEN** 桥接层进程启动
- **THEN** 首个 Web UI 落地请求即返回完整的会话列表与真实标题，而非 cwd 兜底或空列表

### Requirement: 周期对账

桥接层 SHALL 以可配置周期（默认 30s，复用 `OMP_STORAGE_RECONCILE_INTERVAL_MS`）对 OMP store 做 stat walk：变更/新增的会话 upsert 进索引，已消失的文件 prune 出索引。周期对账 MUST NOT 发生在请求路径上。

#### Scenario: TUI 外建会话进入索引
- **WHEN** 一个会话在 TUI 中被创建（未经 Web UI create 路径）
- **THEN** 该会话在一个对账周期内出现在索引与列表中

#### Scenario: 删除的会话从索引移除
- **WHEN** 一个 OMP 会话文件被删除
- **THEN** 下一周期对账将其从索引与列表中移除

### Requirement: 事件驱动增量

会话创建、live 模型切换、标题变更等事件 SHALL 立即增量更新索引，不等待周期对账。

#### Scenario: live 模型切换即时反映
- **WHEN** 用户在 Web UI 对一个 live 会话切换模型
- **THEN** 索引中该会话的 model_provider/model_id 立即更新，无需等待下一次周期对账

### Requirement: 完整元数据提取

对账对新会话 SHALL 做全量读取（含 transcript 尾部）以一次性提取完整元数据（含模型）；对已存在的冷会话变更 SHALL 做全量读取刷新元数据；held/live 会话 MUST 跳过全量读取（其元数据由事件增量持有）。

#### Scenario: 新会话模型一次性提取
- **WHEN** 对账首次检测到一个含 assistant 消息的新会话
- **THEN** 该会话的模型元数据随本次对账一次性写入索引，不留空

### Requirement: 一次性 webui.json 迁移

桥接层 SHALL 在首次启动时执行一次性迁移：读取现存 webui.json 的 legacy `dashSessionId` 与 `permissionPreset`，灌入索引的 `dsh_session_id` 与 `permission_preset` 列。迁移 MUST 幂等，重复启动不得重复写入或覆盖既有配对。

#### Scenario: 迁移幂等
- **WHEN** 桥接层在已迁移过的状态下再次启动
- **THEN** 索引配对保持不变，不产生重复行，也不覆盖已有真实 DSH id
