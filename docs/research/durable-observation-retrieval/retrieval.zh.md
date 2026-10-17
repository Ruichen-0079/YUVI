# 检索质量：第二个独立切片

基于 #329 `066072d`，独立 worktree/分支 `fix/memory-retrieval-quality`；生产修改 `4737bd6`。**已改善特殊标识候选和编辑器召回，组合问题完整性仍未通过，不宣称 R5 已完成。** 默认只改变确定性的排序/降级合同；付费语义展开必须显式启用。

## 已确认的根因

#328 有 GIN 索引，问题不是缺索引。旧 `MemoryKnowledgeReader.search()` 在 `ts_rank` 前物化无序 LIMIT 513，真正相关的记录可以在排序前消失。修正为同一 current generation 中先评分/稳定排序，再取 requested limit+1，最后才按主键加载有界记录正文。没有全 scope 快照、容量提高或旧事实回流。

原英文问题还存在独立的跨语言问题：实验关闭向量，英文 `editor` 不匹配中文“编辑器”的 bigram。复测发现，L1 近期经历即使跨进程仍会补足答案，**答案正确不证明 LTM 选对了证据**。为隔离变量，后续两组实验在专用合成 schema 中通过 `PostgresRecentEpisodeStore.markStatus(...,'expired')` 清空短期有效性，再重启、新会话查询；保留 Journal、Conversation 和权威 Memory。

[实际模型与逐轮候选](evidence/retrieval-model-results.json)、[基线输入摘要](evidence/baseline-328-input-summary.json)、[新输入摘要](evidence/revised-input-summary.json)。基线在无 L1 的组合问题仅收到面试事实，编辑器/茶叶均缺失，单独英文编辑器问题也没有证据。实际 Body 输入直接确认这一点。

## 生产改动与权限

`MEMORY_QUERY_EXPANSION_ENABLED=true` 允许现有 Reasoning 路由把**已授权问题**变成至多两个中英检索查询。默认 false；最多 512 输出 token、8 秒、单次模型调用，不做自动语义修复循环。模型不接收目标答案、候选事实或记录 ID；只提出检索词，不能写 Memory、改变现行状态或创造权限。

Host 在调用前后检查当前 Person/Persona/PRIVATE 及 grant，并将调用送入现有 Provider/A9 管线。真正失去权限是 fatal，不能降级后继续读 Memory；普通计划错误/超时允许保留原始文本通道，并明确 PARTIAL/UNAVAILABLE。各文本查询有界排名后做 RRF，再与既有向量通道融合，最终按同一 current projection 重核状态和披露。没有新增队列、Manager、执行账本或关键词接纳规则。

文本查询与向量通道独立处理失败：真实 SQL 除零后，仍可使用合法向量候选并返回 PARTIAL；向量不可用保留文本，两个都失效不会伪装 empty。单汉字检索采用通用 tsquery 前缀以匹配既有 bigram 的起始字符；不硬编码“茶”或具体事实，**也不等于完整中文分词/单字倒排索引**。

041 为现有 retrieval run 增加有界 `query_plan`，不改权威历史。Typed Client 的 retrieval detail 可读取：实际查询、模型/用量、每个文本通道的命中 ID、文本/向量状态。`APPLIED` 只表示计划已被用于查询，绝不表示所有子问题已正确回答。无权候选 ID 不写入公开计划。旧 run 为 null，不能伪造历史计划。部署需先迁移 041，再启用匹配程序；真实 Alice 未迁移/启用。提供凭据或修改模型路由不由该开关完成。

## 真实质量：保留所有失败

两组都使用 DeepInfra `deepseek-ai/DeepSeek-V4-Flash-0731` 的 Chat/Reasoning，temperature=0；沿用现有真实 Harness。非计划调用上限 2048，计划遵守其 512 上限。不开启向量，避免将现成向量能力混作新排序的收益。Persona 文本版本一致，Person/Persona/scope 和数据库分别隔离。

| 实际问题 | #328 无 L1 | 新路径无 L1 |
|---|---|---|
| 英文组合问题：面试/编辑器/茶叶 | 候选及答案 1/3，仅面试 | 三轮分别 2/3、3/3、2/3；编辑器均进入 Context |
| 单独英文当前编辑器及旧代号 | 无候选，不能回答 | 正确新代号，并指出旧代号无效 |
| 引用/假设的编辑器变更 | 未接纳成真实变更 | skipped，当前仍是露川-4A87 |
| Person B 相同问题 | 无私人证据 | 无私人证据 |
| 单独英文茶叶追问 | 未作配对质量结论 | 得到月桂-5967a1 |

茶叶仍不稳定的原因可直接追踪：计划一次用了独立单字“茶”，原 bigram 不匹配；前缀规则覆盖该形态。但另一轮用了“喜欢的茶”，bigram 仍与“茶叶偏好”不重合，茶叶没有进入候选/Body。**这是未关闭的语义分词/召回门槛，不能说组合查询已可靠。** 没有靠反复抽到成功结果来改写失败记录。

另一个独立失败：新组摄取英文框架自述时，模型复制了 prior 中三条中文事实作为当前来源引文；接纳层全部拒绝，正式状态 terminal_failed。框架没有形成，后续说未知是正确行为，不计入检索 miss。基线形成的是中文 canonical 事实，因此两组的框架结果不能当作“英文记录→中文问题”的真实模型质量对照；反向链路目前只做了实际 PostgreSQL + 明确标注的协议 fixture。该真实模型门槛仍开放。

实验是修正过程中的小样本，不是冻结单一 HEAD 的统计性成功率。结果保留最初 SHA 与 dirty 标志；最后单字前缀重放在已提交生产代码 `4737bd6` 后进行。研究脚本/测试修改不作为生产模型配置。初次基线收集因旧 schema 没有 commit_digest 而停止，修复兼容读取后恢复同一 schema；短期清理脚本的一次引号错误也发生在模型调用前。原失败文件和调用轨迹仍留在受保护目录，没有重复种入成功事实。

费用合计不可直接当作 A/B 节省：基线包括有 L1 的诊断轮，输入/回合不同。逐调用记录见 [基线](evidence/baseline-328-calls.csv)、[新路径](evidence/revised-calls.csv)。基线 40 调用、输入 57,067/输出 1,686/缓存 15,872、Provider 估算 $0.00301326；新路径 48 调用、输入 42,184/输出 2,116/缓存 15,616、估算 $0.00220920。不是最终账单。新增计划确实多一次调用和网络等待，默认不开启；网络 first-byte 与总延迟在 CSV，不能冒充所有非流式模型的首可见 token。

## 百万级结构化检索

[实际 PostgreSQL 测量/最终查询计划](evidence/text-scale.json)，复用既有专用百万数据，不重新制造向量规模：1,000,050 历史、900,001 current、99,999 superseded、50 legacy_unverified。原与新路径都用真实查询；向量模型/索引不变，不声称新的语义向量 Recall@K。

最终完整生产查询的三个常见词+特殊标识目标 Recall@8 从 0/3 到 3/3，没有返回 superseded。只选择罕见标识时 p95 1.54ms；混合 p95 138.36ms，高频 124.16ms；旧混合约 2.51ms。前一轮只返回候选 ID 的初步探针为 1/3，缺少原查询的正文 JOIN，保留在 [初步探针](evidence/text-scale-preliminary.json)，不作最终延迟对照。无序候选会随执行计划改变，不能把一次探针当成固定正确率。旧路径便宜但丢答案，新路径的 CPU/I/O 成本提高，不能隐藏。

这些是热缓存、20 个测量请求与真实 EXPLAIN BUFFERS，不是完全冷缓存、多 scope、长期混合负载或资源峰值验收。**高频 OR 仍可能扫描/排序全体匹配的当前项，成本随匹配集增长**；目前没有具备全局 Top-K 保证的倒排排序索引，不能据百万条达到延迟目标就关闭长期次线性成本门槛。常规稀有词走现有索引；没有恢复全 scope Mem0 快照。

## 验收结论

可交付：无序截断修复、独立通道失败语义、显式有界查询规划、可见检索计划及生产入口回归；真实编辑器召回与百万标识定位改善。

继续阻断：组合所有子问题稳定召回、中文语义分词、英文权威记录的真实反向跨语言质量、更广 Ground Truth/错误召回率、低选择性查询的扩展性、真实 embedding/multi-scope/模型空间和冷缓存长负载。连同 #329 报告中的 R5/产品/隐私开放项，**不允许切换真实 Alice**。

验证记录：本地 `pnpm check`、`pnpm build`、全仓 `pnpm test` 已通过；实际 PostgreSQL Authority/角色/质量/计划回归通过。正常 Server 入口覆盖运行中撤销 query-planning Host grant，后续文本检索与 Character 调用均被阻止；权限验证查询异常同样 fail-closed。#329 过期擦除幂等补充通过本地合并接入，保留独立提交与 PR 依赖。最终 CI 以各 Draft PR 最新 HEAD 为准。
