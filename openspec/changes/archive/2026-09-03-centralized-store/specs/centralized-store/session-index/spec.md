## Purpose

定义桥接层集中式会话索引的行为契约：会话三向映射（dsh ↔ omp ↔ file）、元数据、UI 专属字段与 workspace 归组/排序的存储与查询，作为桥接层唯一的会话事实索引。

## ADDED Requirements

### Requirement: 会话三向映射由索引唯一持有

桥接层 SHALL 在中央索引中维护 dsh-session-id ↔ omp-session-id ↔ 会话文件路径 的三向映射，并以其为唯一权威；配对解析 MUST NOT 再读取 webui.json（迁移完成后）。任意一侧 id 到会话的翻译 MUST 经索引完成，而非全量扫描 OMP store。

#### Scenario: DSH id 翻译不触发全量扫描
- **WHEN** Web UI 以一个 DSH 会话 id 发起列表/历史/恢复请求
- **THEN** 桥接层经索引直接命中对应 OMP 会话，不执行全量 `scanOmpSessions()` 或逐个读 webui.json

#### Scenario: 配对解析不读 webui.json
- **WHEN** 桥接层解析任一会话的配对关系
- **THEN** 只读索引，不读任何 webui.json 文件

### Requirement: 元数据集中且完整

索引 SHALL 为每个会话存储 cwd、title、created_at、last_modified_at、transcript_size、model_provider/model_id、agent_preset 等元数据；凡会话存在至少一条 assistant 消息，其 model_provider/model_id MUST 非空（入索引即提取），不得因"未被查看"而留空。

#### Scenario: 新会话入索引即完整
- **WHEN** 一个 OMP 会话首次被检测并写入索引
- **THEN** 该行的元数据（含模型）一次性齐全，后续列表/详情读取无需再回读 transcript 头

#### Scenario: 未查看的冷会话模型非空
- **WHEN** 存在一条含 assistant 消息但从未被 Web UI 打开的 OMP 会话
- **THEN** 其索引行的 model_provider/model_id 仍非空

### Requirement: UI 专属字段

索引 SHALL 承载 Web UI 专属的会话字段：archived（归档标记）、forked_from（fork 源的 DSH id）、agent_preset（composition id）、last_visited_at（最后查看时刻）。这些字段 MUST 随索引持久化，供 Web UI 消费。

#### Scenario: 归档会话不展示
- **WHEN** 一个会话被标记 archived
- **THEN** 默认列表不再包含它，但其索引行与数据仍保留（可恢复）

#### Scenario: fork 源可追溯
- **WHEN** 一个会话由 fork 产生
- **THEN** 其 forked_from 字段记录源会话的 DSH id

#### Scenario: 最后查看时刻可追溯
- **WHEN** 一个会话被打开查看
- **THEN** 其 last_visited_at 更新为当前时刻，供 refresh 优先服务

### Requirement: workspace 归组与 ungrouped fallback

会话 SHALL 按其 cwd 归入对应 workspace；当会话 error/corrupt 导致 cwd 缺失或不可解析时，MUST 归入常驻的 `ungrouped` fallback 组，保证任何会话都有归属、不被丢弃。

#### Scenario: cwd 缺失会话归入 ungrouped
- **WHEN** 一个 OMP 会话文件损坏或头记录不可解析，无法得到 cwd
- **THEN** 该会话仍出现在 `ungrouped` 分组下，而非从列表中消失

### Requirement: 手动排序持久化

索引 SHALL 持久化 workspace 的会话展示顺序：全局 sort_mode（last_updated / manual）与 per-workspace manual_order（有序 DSH id 列表）。manual 模式下的拖拽顺序 MUST 跨重启保留。

#### Scenario: 拖拽顺序跨重启保留
- **WHEN** 用户在 manual 模式下拖拽重排某 workspace 的会话顺序
- **THEN** 桥接层重启后该顺序仍按持久化的 manual_order 呈现

#### Scenario: 默认按最后更新时间倒序
- **WHEN** sort_mode 为 last_updated（默认）
- **THEN** 会话列表按 last_modified_at 倒序呈现

### Requirement: 索引化查找与列表

列表、按 dsh id / omp id / 文件路径的解析 MUST 经索引查询完成，其延迟不得随 OMP store 会话数量线性增长。

#### Scenario: 列表延迟与 store 规模解耦
- **WHEN** OMP store 内会话数量显著增长
- **THEN** 单次列表/解析请求的延迟不随会话数量成比例上升
