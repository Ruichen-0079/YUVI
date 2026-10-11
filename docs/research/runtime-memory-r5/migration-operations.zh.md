# 迁移、恢复与运维

**没有运行真实 Alice 数据迁移或部署。** 下列流程供下一阶段授权升级评审；本阶段只在隔离合成数据库执行。旧 Mem0/Profile/派生数据到新认识投影的完整升级尚未验收，不能直接切换日常安装。

## 升级前提与回退限制

1. 冻结配置、SHA、PostgreSQL/pgvector 版本及 Persona 所有权；核对未完成 Finalized/semantic/index jobs。使用真实 `pg_dump` 备份并实际恢复演练，而非只确认文件存在。备份需同时覆盖 Journal 保留 payload、Admission、Finalized ledger、Mem0 权威旧记录和新 authority；私人导出保持保护权限。
2. 在副本上运行正常 migration runner 的 `026_memory_authority_v1.sql`。SQL 幂等，新 authority 表为空；对已有 Finalized/Conversation 新建索引仍会持有锁。需要测量真实资产大小并制定停写/升级窗口；没有在线无锁迁移承诺。pgvector extension 与 512 维索引必须可用。
3. 当前后端默认不变。只有新环境显式 `MEMORY_BACKEND=postgres` 才使用新 authority，缺少交易 pool 不允许降级 legacy。尚未完成 Host 身份与旧数据兼容之前，不授权真实切换。
4. 新系统正式回执之后，旧代码不消费新 authority，退回 Mem0 会丢失新知识的可见性。不能通过 DROP 新表“回滚”。需保留数据、停写并制定逆向转换/升级修复方案；此方案未交付，因此真实升级仍阻断。

## 旧数据批次导入

`experiments/import-legacy.ts` 接受完整 MemoryEvent DTO JSONL、显式 scope、数据库与 `YUVI_R5_MIGRATION_ACK=BACKUP_VERIFIED`。它是离线受权限约束的管理工具，不是模型接口，不直接访问真实 Mem0 API。

每行至少有 canonical scope、sourceRecordId、content、kind、source、recordedAt 或 observedAt。这不是直接 Mem0 raw export；必须先转换并核实旧时间/来源。未知时间拒绝，不能用导入时钟伪造过去经历。完整导出 SHA256 构成 source/migration 稳定身份；改变文件产生不同迁移，不能混用检查点。每 100 条 authority 记录、批次回执、检查点同事务提交。处理允许停止、重启、同批摘要幂等；相同批次换内容拒绝。

```bash
# 仅用于已经另行授权的隔离/副本环境；DATABASE_URL 从受保护配置提供。
YUVI_R5_MIGRATION_ACK=BACKUP_VERIFIED YUVI_R5_MIGRATION_BATCH_LIMIT=1 pnpm exec tsx docs/research/runtime-memory-r5/experiments/import-legacy.ts "$R5_SCOPE" "$R5_EXPORT"
# 去掉 BATCH_LIMIT，按相同文件/identity 恢复至结束。
```

停止限制只在完整批次提交后生效。进程扫描/哈希整个文件，检查点跳过已提交行；重启成本仍为 O(导出文件大小)，属于管理迁移工作，不是普通检索。需要下一阶段 seek/分片清单和更大导出验收。

实际 250 行合成旧 DTO：100 后停止、恢复到 250、再次运行 ALREADY_COMPLETE。旧条目全部 `legacy_unverified`，current=0，不制造新 grounding。最初错误时间字段的合成导出拒绝，manifest failed、count=0；正确 DTO 的不同文件身份完整提交。[阶段结果](evidence/migration-cli-phases.json)、[最终 manifest/计数](evidence/migration-cli.json)。这不证明早期 raw Mem0、缺 Admission、Profile、已有 correction 或部分旧任务均可升级。

## 状态与恢复操作

| 情况                                | 系统行为                                                             | 恢复方式                                                                        |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 模型 unavailable/429/无效/截断/超时 | 保留 Journal；materialization/semantic retryable_failed；不落回规则  | 原来源、任务、政策版本在 due time 后恢复；8 次终止并保留原因                    |
| 写入响应丢失/DB outcome unknown     | ambiguous/reconcile_required，不报成功/安全失败                      | 读取同 scope 逻辑键与 digest；applied 结束，not_applied 同键重放，conflict 停止 |
| Migration unknown                   | manifest reconcile_required，检查点不猜测前进                        | 同批次摘要读取 durable batch receipt 并重放                                     |
| Vector Provider 失败                | authority 写入仍可确认，index job 独立失败；检索 PARTIAL/UNAVAILABLE | 恢复 Provider；过期租约/重试；新空间显式 enqueue keyset batches                 |
| 旧命题退休过程中 index 晚到         | commit 和 index 通过当前状态锁协调，不复活旧 vector                  | retired job 完成或当前版本重新验证                                              |
| 当前投影异常                        | 水位不同拒绝普通读取，查询故障不冒充 EMPTY                           | 分批 verify →事务 rebuild →复查；保留权威行                                     |

`verifyMemoryProjection` 以持久版本 keyset 检查最多 10k，返回检查点/差异/是否耗尽。`rebuildMemoryProjection` 是有实际生产消费者的管理入口和负载 Harness，完整事务重建，百万条约 17s；它需要 scope writer 锁。索引损坏自动发现、持久验证水位、不可中断在线 shadow rebuild 尚未实现；当前 Overview 不报 VERIFIED。

`enqueueVectorIndexBatch` 每批 <=1000，按版本推进；新 embedding model_tag 不混用旧空间，同模型缺/坏 vector 可重新排队。当前 schema 512 维，其他维度明确不支持；旧空间 task 的退休/保留政策尚未完成。模型换路由只影响可恢复提取，政策升级与 backend 切换则需要 drain/对账，不可假定旧 policy digest 兼容。

Finalized worker 在新后端 boot 时限制 owner Persona；vector worker 另限制 Persona 与 Journal namespace。热切换后端的 worker owner 重绑定尚需专项验收；生产 rollout 应使用新进程和已校验固定配置。terminal job 的 operator 重试 API、Provider 费用的原子账本和持续积压告警未完成，不能要求运维长期手工改 SQL 来补足。

## 可观测性的实际范围

已提供 scope 计数/水位、来源分类、semantic 每任务模型/usage/duration/重试/错误、index job 状态/模型空间/投影、worker 最近扫描/错误次数、DB pool idle error 计数、Finalized 正式状态和最近迁移 manifest。计数来自提交，不使用 HTTP200/口头承认代替写入。

每日接纳/合并/纠正率、最老积压年龄、全域不一致数、检索 histogram、Provider invoice reconciliation、验证持久水位等仍未形成完整产品指标。读取 API 无原始 source body；运维下载/披露原始来源仍需 Host policy，禁止把私人 dump/模型输入放 Git。
