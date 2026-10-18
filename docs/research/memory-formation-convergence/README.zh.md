# 同来源纠正收敛与产品接管

基线 #332 `c1c507d`，独立分支 `fix/memory-formation-convergence`。没有合并、部署、迁移真实 Alice，未访问私人数据库或 QQ。本切片只修改目标 A；目标 B 尚未实现，不因本 PR 关闭产品 Host 门槛。

## 因果提交合同

原失败及两组反向提交结果保留在[前轮诊断](../evidence-truthfulness/formation.zh.md)。不是提取零候选：两个合法命题分别替代 A，第一条提交后第二条被冻结为 stale，三次无关系重评被拒绝，最终 PARTIAL。

比较共同事务与同源识别后选择后者：已有逐命题接纳、租约、UNKNOWN 和对账继续工作，坏引文不回滚独立合法命题。没有新增 Queue、账本或 SQL migration。

`PostgresMemoryAuthority.commit` 在现有 scope 写锁内，允许仍指向已 superseded 的 A，**仅当**所有直接 superseder 都满足：

- 与待写命题同一 durable finalized turn，两个 frozen payload digest 与正式 ledger 对应。
- 同一唯一 Journal ref、完整身份/受众快照、commitSeq/来源时间、FINALIZED 策略版本；不同引文选择可以属于同一来源。
- 每个兄弟仍为 current；被更晚来源替代、进入冲突、不同来源、另一次处理或缺失证明均不能使用此例外。
- 候选最多十二条，使用既有 `(scope,to_id,version)` 关系索引及 logical key 唯一索引，不遍历 scope 或递归扫描历史。

新命题保留原始 A 为关系目标，不伪造 B→兄弟的用户时间顺序。A 只扣减一次 current_count；每条记录、关系、投影、版本、vector outbox 在原事务提交。幂等 key/digest 不变。已有 reassessment 的旧任务不改写解析合同，历史 PARTIAL/terminal_failed 不被回填为成功；用户新澄清走新可信来源。

若更晚来源 C 已使某兄弟失效，旧兄弟不能借此例外成为 current，仍走原严格重评。该机制证明来源与因果关系，不判断两个命题是否语义矛盾；模型语义质量仍独立验收。

## 验证及限制

真实 PostgreSQL `127.0.0.1:31508`、独立 schema、正式 Host/Journal、SemanticPolicy 和 Finalized executor：正反提交顺序、并发/重复 claim、独立属性纠正＋新事实＋坏引文、同 ref 伪装但不同 logical cohort、晚到旧 Worker、合法新澄清、lease 恢复、真实 COMMIT 后丢 ACK、重播、Shadow projection 重建、计数、向量 outbox 与检索审计。模型替身只用于确定性协议，不用于语义质量结论。CI 正常生产入口门禁已加入本套测试。

[实际模型结果](evidence/model-results.json)：复用 accepted-dialogue.py，DeepInfra DeepSeek-V4-Flash-0731，temperature=0/max_tokens=2048；规划/支持开关关闭，独立 Person/Persona。两组精简复测摄取正式完成、重启清空 L1 后新编号回答正确；模型此次没有产生原来的双 supersedes，且未回答旧编号失效，**不能算完整原失败质量通过**。

第三组重放原七轮事实。模型将 4A87 改为 4A88，并将错误编号写入 evidenceText，来源校验拒绝，任务 terminal_failed。这是提取失真，尚未进入 Authority，不是同源提交失败。保留失败后，以新来源明确澄清，正式完成，重启清空 L1 后答对 4A87 及 613 已停用。旧失败回执保持不变，不通过更改 Ground Truth 或放松引文冒充通过。

三组总 48 次 Chat/Reasoning 调用，Provider estimated_cost 合计约 $0.004864；第三组另含实际 Qwen 512D embedding，用量无费用回执部分不计入上述数值。没有用成功采样估计总体成功率。原始轨迹在本机受保护目录，Git 仅含合成摘要。**事务顺序修复有正式数据库验证；自然语义完整性及产品 Host 整体验收仍开放。**

## 集成与停止清单

1. 冻结 #322→#332→本分支 HEAD，复查祖先、CI、变更与 migration digest；没有本批 045。运行 001–044 正式 runner 及重播，不能调用旧 runner。
2. 隔离新库先跑来源/Worker/授权/生产 Character 回归，执行本套故障与重建，保留 UNKNOWN 对账记录；失败即停止，不改旧任务状态。
3. 同版本部署包、停旧 Writer/Worker、备份与来源检查须另行授权。本批不执行。033 的 view、037 的 accepted-user、038–040 Observation/A9 合同仍阻止旧二进制安全原地回退。
4. 中止后按同版本 ledger/lease 续跑和对账；不能删除回执重新执行。用户新来源可以澄清旧失败，历史结果保留。
5. 产品 Host/WebUI、全部旧资产迁移、持续审计、PITR/隐私删除、QQ/Voice、冷缓存与长期多 scope 等仍依赖[集成合同](../evidence-truthfulness/integration.zh.md)及[R5 开放门槛](../runtime-memory-r5/open-gates.zh.md)，不得据本切片切换 Alice。
