# 权威历史、当前认识与索引

## 诊断与保留资产

旧路径为 Conversation → Journal grounding → Extractor/Admission → Finalized ledger → Mem0 → 全 scope 快照 → Admission/纠正图联接 → Character Context。Journal 保存来源，Finalized 保存冻结候选、交付租约及 reconciliation，Admission 是 Host 来源边界；这些资产保留。

原 Mem0 路径把记忆实体与检索索引混在跨持久化边界的更新中；检索最多读取 4096 条全 scope 快照，逐条对照 Admission 并重算纠正关系，成本随历史增长，超过上限整次失败。旧纠正失效按共享 Journal 根展开，无法区分同一消息里的独立命题。规则在模型前裁决引用、假设、forget，模型不可用又可能落回规则。原提取先调用模型，再形成正式任务，恢复依赖正常进程。

新后端不沿用这些机制。`MEMORY_BACKEND=postgres` 是显式选择，不改默认/真实安装。Mem0 在新后端中不承担权威或前置写入依赖；旧后端仍单独保留兼容，其硬性问题不能被新后端测试掩盖。

## 数据模型

Schema 位于 `packages/memory/migrations/026_memory_authority_v1.sql`。

| 表                                    | 长期职责                                                       | 主键/索引与不变量                                                |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `memory_authority_records`            | 追加命题、冻结语义 payload、摘要、source/commit 时间、来源分类 | `(scope,id)`；逻辑键与版本在 scope 内唯一；历史不因纠正删除      |
| `memory_authority_admissions`         | Host 准备的冻结摘要与 producer                                 | `(scope,logical_key)`，重放必须同摘要/producer                   |
| `memory_authority_relations`          | `supersedes/conflicts/supports` 及形成版本                     | 来源与目标均为同 scope FK；精确命题 ID，无 Journal 根传播        |
| `memory_authority_scopes`             | 持久版本、投影水位与增量计数                                   | scope writer 行锁分配版本；回执前同事务更新                      |
| `memory_authority_current`            | 可重建的当前/历史状态和文本投影                                | 当前分页部分 B-tree、状态分页索引、文本 GIN                      |
| `memory_semantic_jobs`                | 模型前持久队列、租约、尝试、结果/usage/失败                    | `(scope,job_id)` 与 source digest；冻结结果重放，无规则 fallback |
| `memory_authority_index_jobs`         | 同事务 vector outbox、租约与重试                               | `(scope,id,model_tag)`；模型空间分离；待处理部分索引             |
| `memory_authority_vectors`            | 512 维可替换语义索引                                           | scope/id/model；authority version；HNSW，不能决定命题有效性      |
| `memory_authority_migrations/batches` | 迁移身份、检查点、批次摘要和提交回执                           | 检查点、导入记录、批次回执同一事务                               |

当前状态包括 `current/superseded/conflicted/supporting/legacy_unverified/unattributed`。来源分类 GROUNDED 表示可追溯，**不表示用户自述已被外部验证或模型解释一定正确**。产品读取另标 `MODEL_PROPOSED`。旧数据不被伪造为新 Admission；无真实身份的来源保留为 unattributed，不进入当前知识。

## 形成与提交

完成回合先由 Finalized service 建立待 materialization 状态，再进行语义评估。语义任务使用稳定 ID、来源摘要、40 秒租约、20 秒 Provider 超时、30 秒重试间隔和 8 次尝试上限。过期最后一次租约明确进入 terminal failure。正常发言异步排队，不等待远端提取完成。

模型看到合法来源及有界相关/近期当前命题，提出独立命题、唯一精确 evidence quote、关系与已呈现的目标 ID。不以关键词决定模型是否看到输入。Host 校验来源选择、scope/Person、principal、关系数量、目标当前状态及严格时间顺序；模型不决定数据库权限。提取失败保留 Journal 与任务，不产生规则候选。

事务验证 Host Admission → scope writer 锁 → 稳定键/摘要对账 → 目标验证 → 追加命题/边 → 精确投影变更/向量退休 → 计数/水位 → 可选索引 outbox → COMMIT 后回执。任何不明 DB 错误视为 ambiguous，读取持久键/摘要决定 applied/not_applied/conflict，不把丢失 COMMIT 响应当作安全重试。

纠正只退休指定 ID，其他共享 Journal 的命题不变。冲突没有撤回关系时保留双方并标记 conflicted；重复事实添加 supporting 记录和证据边，保留一个当前事实。每次强化仍增加历史证据；证据压缩/分层尚未建设，不能声称避免全部历史增长。

## 身份与检索

Runtime 读取必须由 Host 提供 `MemoryReadAuthority`，验证 Private audience、principal namespace/actor、Person 和 scope。`subjectUserId` 仅是兼容分区键，不能生成真实权限。语义 prior 也按相同 principal/Person 过滤；Provider 的 source work context 包住语义与相关检索。

实际 `/message` receipt 目前把身份与 audience 记为 UNKNOWN。新后端对此返回 reader authority unavailable、来源进入 unattributed；完整 Host 接入是硬性阻断，不能通过把 scope 当认证来“修好”演示。

正常结构化查询使用索引 keyset，不拉全 scope。文本候选上限 513、结果上限 100，命中候选边界返回 PARTIAL。向量和文本候选共同通过当前投影；旧 A 即使相似度高也不能重新成为现行知识。向量失败及尚未完成的 outbox 返回 PARTIAL/UNAVAILABLE。当前是简单有界混合排序，不是完整融合 ranker；过滤和 HNSW 在大规模多 scope 的代价仍待验证。

后台 vector worker 按 Character 与 Journal namespace 选择任务；Finalized worker 也在 SQL 选择/读取/租约阶段限制 Persona。运行时 Host authorization、Publication、取消与外部效果协议保留，不由 Memory 或模型创造权限。

## 可重建与取舍

投影可按版本 keyset 分批校验；重建取 scope writer 锁，在一个事务中替换投影并重算计数，失败回滚保留原投影。百万条重建实际耗时 17.12s，会阻塞该 scope 的写入，仍需在线增量重建设计。

水位能说明事务处理到哪个持久版本，不能自动证明摘要、来源和所有关系完整。Overview 始终显示 `integrity=NOT_VERIFIED`；已实现校验只覆盖当前状态/文本投影，不冒充完整证明。全量审计水位、DB append-only 权限、索引损坏自动检测和迁移政策升级仍在下一阶段。
