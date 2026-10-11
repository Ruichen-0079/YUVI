# 正确性、语义质量与恢复证据

## 两种验证分开

确定性测试证明事务、身份、来源形状、状态、幂等和恢复。测试中的固定 reasoner 只用于无效输出/超时/租约故障，**不计入模型质量**。

真实语义 Harness 复用仓库 Provider Registry，使用真实 PostgreSQL Journal `appendWithHostAuthority`、grounding resolver、Finalized service/executor、authority/provider/indexer。每次采用独立随机 Person 和会话；Chat 只看到该次生产检索选出的知识，未带入历史对话。召回表达直接调用真实 ChatProvider，**不是完整 Character `/message` 端到端实验**；Host 身份接入缺口不能用这个 Harness 掩盖。

真实模型路由于 2026-10-11 重新核对：DeepInfra Chat `deepseek-ai/DeepSeek-V4-Flash-0731`，Reasoning `zai-org/GLM-5.3-Flash`，local embedding `Qwen3-Embedding-0.6B-Q8_0.gguf`，512 维；temperature=0、max_tokens=2048。合成 Host persona `character-instance:r5-isolated`，语义政策 `memory.semantic.v1`。恢复对照显式将实验 Reasoning 路由改为同 Provider 的 DeepSeek；不改变真实 Alice 配置。

## 真实模型结果

| 组                                         | 客观结果                                                                         | 解释                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 冻结前，无 vector：3 个随机 A→B +独立茶叶  | 三组形成/纠正都正式 complete；新会话 B+茶叶 2/3                                  | 一组 GLM 把命题改写为英文，中文关键词查询选不到，模型回答未知；已保留失败                     |
| 加入实际 Qwen vector 的恢复：另 3 个随机域 | 新进程 B+原茶叶 3/3；A 历史、B current                                           | 曾因 Harness 未继承 local URL 出现 index retryable_failed，修正合法配置并重建；未把失败算成功 |
| 引用、假设、无长期价值闲聊                 | 三个来源语义评估后 skipped，无新增纠正                                           | 不由关键词预筛；证据为模型实际结果                                                            |
| 强化偏好                                   | supporting 证据边，原命题 current                                                | 不复制第二个当前事实；历史证据仍增长                                                          |
| Person Y                                   | Y 自身召回正确，未取得 X 的纠正                                                  | 合成域隔离，不代表全部 principal 组合已验收                                                   |
| 未明确撤回的两条冲突来源                   | 双方 conflicted，回答说明不确定性                                                | 没有选择性抹掉一方                                                                            |
| 冻结 SHA `2d63673`：新随机域               | GLM 两次 429；恢复再遇网络失败；无正式写入                                       | 状态 retryable_failed，模型召回未知，正确计作失败                                             |
| 同冻结域，显式 DeepSeek 提取恢复           | 原任务/Journal 恢复 complete；A superseded、B current、茶叶 current + supporting | 新会话和新进程都正确回答 B/原茶叶；没有生成新的来源或改任务 ID                                |

[无向量原始合成结果](evidence/semantic-before-vector.json)、[混合索引新进程结果](evidence/semantic-hybrid-restart.json)、[对应持久行与关系](evidence/semantic-hybrid-durable.json)、[冻结版本失败→恢复→新进程](evidence/semantic-frozen.json)。质量判定为实际答案包含随机 B/茶叶编号且没有继续使用 A；不是“模型说记住了”或记忆条数增加。

上述是七个小型诊断域，不足以证明长期可靠或广泛语言覆盖。初期重启 Harness 复用了输出文件，覆盖了一份完整 vector trial 汇总；DB 权威行、关系与调用 trace 仍在，报告只展示可恢复证据，不伪造丢失汇总。之后结果/重启结果分开保存并记录不可变代码 SHA。

## Provider 用量与失败

[model-calls.csv](evidence/model-calls.csv) 保留 60 个远端调用（57 HTTP 200、2 HTTP 429、1 transport failure），57 个响应报告 usage/estimated_cost，合计 16,539 input tokens、3,044 output tokens、Provider estimated_cost **$0.001826385**。这些是响应估算，不是账户最终账单。调用首字/总延迟按真实 fetch 记录；非流式响应没有可用 firstText 时留空，不补造。

早期一份 trace 目录复用，可能缺失一次成功 GLM 调用，所以不能宣称完美费用账本或绝对 60 次总请求上限。停止时已达到留存调用预算，不再执行无意义重复探针。成本审查上限 $0.25；现存 usage 与固定 max_tokens 对这一小型实验有充分余量，但生产级原子预算/费用记账仍开放。[usage 与限制](evidence/model-usage.json)。模型配置从实际运行进程读取，凭据/私人 Persona/原始轨迹未入 Git。

## 确定性与故障

实际 PostgreSQL 指定回归 43 项：新增 authority 17、Finalized ledger 21、executor 5。覆盖精确命题纠正、跨 scope/Person/principal、同源独立命题、并发纠正单胜者/迟到拒绝、冲突/强化、COMMIT 响应丢失、投影事务失败回滚、查询异常非空、坏投影重建、新连接持续性、旧记录迁移/摘要冲突/失败检查点、未知迁移结果、语义 worker 崩溃租约/最后尝试、无规则 fallback、未归属来源、模型前待处理恢复、索引失败/重建/退休、跨 principal prior 不披露、foreign Persona 任务不可读取或领取租约。

独立 PG 31506 被实际 `pg_ctl stop -m immediate` 中断 B 事务：结果 ambiguous；重启 A 仍 current，B not_applied；同键重试 B 正式 written；成功回执后再次立即停库重启，A superseded、B current。[crash-frozen.json](evidence/crash-frozen.json)。共享 Alice PostgreSQL 从未被停止。

产品路由另有 3 组实际 PG/Fastify 路由回归：旧数据状态/计数/metadata redaction、token/Origin/remote/Persona/cursor、其他 scope ID/UNKNOWN ingestion/分页上限。完整隔离 Server 实际 HTTP overview/current/timeline 显示 2 条当前知识、4 条历史，见 [HTTP 示例](evidence/http-example.json)。新 Server 重启后 worker 不再领取其他 Persona 测试任务。

最终 `pnpm check`、`pnpm build`、`pnpm test` 通过；普通无 DB 全仓测试中 PG suites skipped，不能把 skipped 计为已执行。实际 PG 回归单独执行，并在 GitHub Check 增加必跑步骤。完整故障矩阵、持久审计水位和长期 soak 未完成，详见 [阻断台账](open-gates.zh.md)。

仓库级 `pnpm format:check` 失败：405 个未修改的既有文件有格式差异；与本 PR 修改文件无交集。未越界批量改写这些文件。本 PR 的全部修改/新增 TS、MJS、Markdown、JSON、workflow 单独 Prettier 检查通过。

PR 复核后又收紧产品 DTO 白名单，并增加实际旧 JSON 的未知顶层/lineage 字段不披露回归；无效游标明确 FAILED，不混淆数据 UNKNOWN。此前模型/负载证据的 SHA 保留原值，不把读 DTO 修复伪装为重新模型实验。

配置装配回归还验证：只提供 PostgreSQL provider、缺少 semantic Policy 时，MemoryService 明确 disabled，Keyword 输入也不能触发默认规则写入。此补充只改变缺失配置分支，Server 实际 Policy 继续使用既有语义实现。并发“单胜者”测试证明事务不重叠，不证明较晚纠正自动重新规划后最终收敛；后者仍为阻断。

## Phase 2 验证范围

新增实际PG覆盖可信Host session所有权、来源审计/撤证、原始digest保留的重评及最终映射、在线shadow暂停/重开/并发推进/退休、schema receipt原子性、受限role实际commit/cutover、防DDL/历史编辑、旧副本250条恢复/并发批次/摘要对账/源变化/注入事务失败、实际HTTP维护和读取、Character子调用context关联/A9消费者，以及Embedding期间纠正不泄露旧事实。实际PG指定套件68项（新增竞态、重评保护、production 披露与 Person revision 边界后），完整仓库test/check/build单独运行；数量不是成熟度声明。

实机正常Server质量、million向量/在线writer与两次own-PG强停分别在 [Phase 2](phase2.zh.md) 和 [证据目录](evidence/phase2/)；确定性故障fixture不冒充模型判断。初次远端Linux/Conformance因旧P8测试仍期望重播migration名称而失败，修正为第一次有receipt、第二次no-op，并保留完整authority读写隔离断言；旧失败不隐藏。最终CI结果以PR最新SHA为准。

2026-10-12 继续核对 `61fe11c` 时，push 的 Durable Conformance 另捕获 Effects shutdown 回执竞态（同 SHA 的 PR 工作流通过）。没有靠重复运行抹去失败：真实 PostgreSQL 确定性调度复现了 UNKNOWN 提交后旧 post-start 快照继续执行、durable record 返回 STALE 而 dispatcher 无条件报告 recorded=true。生产分支现检查 RECORDED/REPLAY；旧结果不伪造持久成功、不改 UNKNOWN、不调用工具。实际 Effects 全套 127 项与 check 通过，[原失败与正式状态证据](evidence/phase2/dispatch-shutdown-receipt.json)。这是 Runtime 的回执边界修复，不证明所有长期故障门槛已关闭。

随后在独立 31508 cluster 的新数据库同时启用 DATABASE_URL、Effects/Journal/Profile 和 R5 数据库套件，执行 db:migrate → pnpm test。扩大并行验证暴露测试夹具共享 public 的问题：Authority 恢复测试保留的 pending synthetic event 被另一套件的 legacy worker 领取。改为每个 Authority 套件独立随机 schema；所有重新建池也继承相同 search_path，不能通过更换数据库视图伪装恢复。原失败断言保留，未过滤 writes 来遮掩问题。修正后完整命令正式退出 0，Memory 617 passed / 3 skipped、Effects 127 passed、Server 708 passed / 48 skipped；缺少本轮对应服务的 skipped 不计入验收。check/build 也通过。没有在共享 Alice 数据库跑这一扩大验证；其结果不代替远端 packaged conformance 或长期运行验收。
