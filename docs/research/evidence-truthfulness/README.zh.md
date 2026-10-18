# Evidence Support 与集成就绪度

基线 #331 `91d0100`；独立 worktree/分支 `feat/evidence-support-integration`。本批未改 Authority 历史、A9 终态、Observation 隐私生命周期，没有新队列/执行账本。真实 Alice、私人数据库、正式配置、QQ 均未改变；没有合并或部署。

## 实际生产变化

候选覆盖与语义支持现在是两个独立合同。正常 PostgreSQL Provider 在原有最终候选预算之后，可显式启用 `MEMORY_EVIDENCE_SUPPORT_ENABLED`，用已有 Reasoning route 的**一次有界调用**评估最多五项需求、八条候选。它不扩大读取，不改 Memory、不创建权限。每项支持/反驳必须引用本次授权 current 候选的准确子串；伪 ID、改写引文、conflicted/过长证据不得变成确定支持。失效 Host grant 仍是致命授权错误，不降级成“没有记忆”。

`SUPPORTED / CONTRADICTED / INSUFFICIENT / UNAVAILABLE` 是模型语义评估加确定性来源约束，**不是数据库真理标签**。没有候选直接表示“这里没有充分证据”，不花模型调用、不证明数据库不存在。调用/格式失败为 UNAVAILABLE；一项引文无效可以保留其他项的合法支持。超过1600字符的候选不允许仅凭截断前缀形成确定支持，明确 `EVIDENCE_CONTEXT_BOUND`。

只把支持/反驳所引用的记录交给后续 Memory/Associative Context；被选中过但未建立支持的候选在 Retrieval Evidence 保留 `EVIDENCE_NOT_ESTABLISHED`。API 复用原 query_plan JSONB，版本化增量字段 `memory.evidence-support.v1`，Typed Client 自动获得类型；无需045迁移。普通聊天 grant 无权读取运维检索 API。原始候选指标仍存在，不被重命名成“已回答”。

Character 区分“已持久化”与“足够支持答案”，明确来源第一人称应转为用户/原说话者，而非 Alice。引文携带来源、主体、状态和原文推导的数字/标识约束；自然语言表达保持自由。没有拦截已发出的 SSE 后偷偷替换答案，也没有最终回答裁判模型；因此不能保证模型永不违背这些约束。

## 实际效果与失败

[冻结评测与全部答案](evidence/support-quality.json)使用真实 PostgreSQL/current resolution、固定对抗候选和真实 DeepSeek Character/Reasoning。它从候选阶段开始，不是新的 ANN Recall benchmark。初始20题先冻结，后来追加四题在代码固定后再运行；保留第一次20题的所有失败。最终20题复用原 baseline 答案，不重复付费；事实内容/问题相同，重新接纳后的物理记录 ID 不同。新增四题的 baseline 使用当前 Character +旧 Memory context，只作 Context 对照，不能冒称全部24题都是严格 #331 产品 A/B。

| 最终24题指标 | 观察结果与分母 |
|---|---|
| 候选阶段已知证据覆盖 | 13/13（固定候选合同，不代表实际 ANN） |
| Candidate Precision，micro | 13/29，44.8% |
| 实际语义支持/反驳 Precision | 10/10；未知/无支持错误接受0/11 |
| 已有支持被错误拒绝 | 3/13，23.1%；有效证据保留10/13 |
| 严格四类标签匹配 | 21/24；新四题3/4 |
| 完整答案正确（人工逐条、绑定回答digest） | baseline12/24，新19/24；相关但未回答的事实不算完整答案 |
| 无支持命题仍被回答 | baseline4/11，新1/11 |
| 已知答案条件归属准确率 | baseline10/13，新10/10；新组另外3次拒答，不能隐藏分母变化 |
| 未知项校准完成 | 新9/11；另一次虚构自身茶偏好、一次把冲突说成“以前没有提过” |

新的误拒包括 Nora 饮料、Lea/user 混合门禁卡，以及旧编辑器反驳。正确引文不等于语义蕴含；模型可以过于保守。茶杯干扰中仍出现 Alice 虚构茉莉茶偏好，两条茶问题未明确“我的”，歧义被保留为失败；没有事后改 Ground Truth。编号抄写在本样本中未新增错误，不代表 #331 的5967→91反例已普遍解决。引用 ID/引文真实性有确定性反例回归；本轮自然回答没有大量主动引用 ID，不能宣称引用准确率100%。

[正式 Server 实验](evidence/runtime.json)另用自然提及形成三条 current Memory；每个 QA 前正式失效 L1、重启隔离 Server、新会话。规划开启时，编辑器“苔桥-4836”和茶“木槿-9275”进入真实 Body，咖啡杯订单作为干扰被排除，回答两项并明确咖啡烘焙未知。Person B 无私人候选/编号披露。客户端发消息用 Host grant，operator 仅做隔离注册；不等于 Desktop/WebUI/QQ 已接管。

关闭查询规划的前两次复测（ordinal5/6）整题误拒，保留为失败。根因是还把整句作为预先确定的单需求输入给支持模型。最后移除这一占位需求，原句只作为 question，输出必须逐项引用问题源片段；ordinal7在同库同题得到两项支持、一项不足，正确表达。没有额外规划调用或检索，最终候选预算也未扩大。此模式仍不能找回原候选未选中的事实，也不能证明所有需求均被识别。

**两种付费开关都默认关闭。** 默认产品不会自动获得语义支持筛选/需求翻译/多需求保证；它具有既有 current/权限过滤、有界文本/可配置向量召回、新来源归属与 Character 证据约束。必须显式选择 PostgreSQL 且有可信 Host，不能将 operator Harness 当已发布产品。没有足够样本支持默认开启付费判断。

## 成本、性能与边界

[逐调用 CSV](evidence/model-calls.csv)、[usage](evidence/usage.json)保留模型、输入摘要、usage/cache、延迟及 Provider 估算。本批共200次 Chat/Reasoning，已知估算约 $0.00804，另计实际 embedding；非账单，不将冻结 baseline 重用计为新调用。模型为 DeepInfra `deepseek-ai/DeepSeek-V4-Flash-0731`、temperature0；Runtime embedding为实际 Qwen/Qwen3-Embedding-0.6B 512D。没有新的 Vision 调用。支持判断最多1536输出token/12秒，不做无限修复；它的网络/模型延迟远大于数据库检索，具体分布见 usage。

[索引和恢复实测](index-reliability.zh.md)没有关闭高频旧事实、长命题尾部和容量门槛。[十份PR集成与发布前计划](integration.zh.md)验证了迁移和隔离备份恢复，也证明旧 runner 不能原地回退。**这批可以交付纵向机制和已观测收益，不能宣布 Evidence Truthfulness、长期索引或 R5 接管整体验收完成。**

[纠正 PARTIAL 根因与下一切片](formation.zh.md)单独记录，没有用检索/支持改善掩盖写入失败。原始轨迹仅在 `~/.local/state/yuvi-evidence-support-20261018`（0700），公开均为合成资料。
