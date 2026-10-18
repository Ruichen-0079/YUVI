# 归因、模型与回归

## 实际执行路径

沿用 accepted-dialogue Harness，新增独立实验选项：真实 512D embedding、正式索引完成等待、隔离库显式升级/回填、同库 resume 和每段实现 SHA/diff digest。没有把 Mock 换成另一产品架构。所有 Runtime 质量轮均使用正常 `/message`、可信合成 Host grant、Character Gate/Body、Journal、R5 Worker、Authority、Retrieval Evidence。原始模型请求在本机受保护目录，公开 [逐轮归因](evidence/runtime-quality.json) 只含合成答案、候选、实际输入安全摘要与 digest。

每个 memory-only 问题之前，用正式 `PostgresRecentEpisodeStore.markStatus(...,'expired')` 失效该合成 schema 的 L1，再停止/启动该隔离 Server，使用新会话。没有擦除 Journal、Conversation 或权威 Memory 来制造效果。Body 输入按真实 fetch 记录检查，而不是只看 PREPARED_FOR_USE。相同问题的重复轮全部保留。

Host grant 由隔离 operator 注册，客户端实际发消息使用 grant 而非 operator token；这是正式 Host 合同实验，不能替代真实 Desktop/WebUI/QQ 的凭据生命周期。索引验证/修复只接入认证本地运维入口，不暴露给聊天模型。

Chat/Reasoning：DeepInfra `deepseek-ai/DeepSeek-V4-Flash-0731`；temperature=0，正文/提取上限 2048，旧规划 512、新规划 768、8 秒。Persona 文本固定 `evidence-synthetic-v1`。不同初始 cohort 的抽取结果可以不同，所以它们不是严格的检索 A/B；**同库对照**保留相同 Person/Persona、权威 ID/内容/状态摘要、已索引向量，再只更换实现和派生索引。

实际 embedding 通过现有 Provider 和 MemoryVectorIndexer，模型为 `Qwen/Qwen3-Embedding-0.6B`，真实响应为 512D；没有手工制造质量评分向量。[Provider 官方接口](https://deepinfra.com/Qwen/Qwen3-Embedding-0.6B/api)在本次检查时标价 $0.010/百万 token。矩阵后续算法重放复用该模型的冻结实际向量并明确标注 cache；这不是重新调用模型的成功率试验。几何 one-hot 向量仅用于实际 PostgreSQL 的“旧分数更高/空间不同”确定性异常合同，不计语义质量。

## 责任阶段

报告分别检查：正式源处理状态、当前权威事实、通道命中、最终选择、真实 Body 输入、答案值。被拒绝/未形成的英语事实不计召回失败；原回答即使猜对，缺少 LTM 证据也不能记为检索成功。评测实际使用的归因函数具有 CI 回归。

- 原纯文本中文三事实（旧组 ordinal 8）：茶叶 **CHANNEL_CANDIDATE_MISS**。升级同一隔离库后 ordinal 15：三项全部在真实 Context 且回答正确；权威摘要不变。
- 原向量/全局融合五事实（同库 ordinal 10）：茶叶、备份地区 **FUSION_OR_RESULT_BOUND**。新实现 ordinal 16：五项正确；同库的饮食组合从 2/3 到 3/3。两个三事实对照均维持 3/3。
- 新组最初五事实 ordinal 10：负责人确在首选候选，但被“低排名邻居已经入选”的错误覆盖判断丢弃。该选择逻辑已修复，并有冻结反例回归。
- 随后 ordinal 15：五项证据已在 Body，茶叶写为“月桂-91”，是 **ANSWER_GROUNDING_ERROR**。同库 ordinal 16/17 需求—引文格式后为 5/5；这是两条观察，不是总体可靠率。
- 两个自然纠正开发组：一条命题提交、另一条写入耗尽重试，正式状态 PARTIAL。旧组当前编辑器已经形成，新组没有形成新编辑器；分别评分，不能把后者的未知当检索失败。这是仍阻断 R5 的形成/写入问题，没有为本 PR 改 Authority 预期。
- 实际引用/假设输入处理为 skipped，未产生“虚构-000”的 current 事实。另一 Person 的请求没有私人候选、上下文值或答案值。UNKNOWN 航空座位没有被编造。上述都只是本合成样本的边界证据。

## 冻结矩阵

[完整结果](evidence/frozen-matrix.json)保留初次和修正后的失败。原 12 题在 `080c9a3` 冻结；其中 10 题有可读事实，两个是权限/未知控制，不纳入已知事实召回分母。原 development/holdout 都被用于调查，**不宣称盲测**。在代码固定后另以 `11040dc` 冻结 Lina/Marco/Nori、望远镜、电池、温度变化四题；未根据其结果再改算法。新文本/实际向量矩阵均 4/4 完整已知证据覆盖，旧温度未回流。这证明新增主题的索引/选择合同，不等于未见问题的 Chat 回答质量。

Runtime 五条预算下，新索引控制组的整句 Vector 完整覆盖 6/10、全局 Hybrid 3/10、全局展开 Hybrid 6/10，需求感知 Hybrid 10/10；Evidence Recall 宏均值分别约 0.72、0.553、0.72、1.0，precision 约 0.32、0.24、0.32、0.52。控制组共用新文本索引/同一冻结向量，不能冒称这些数字就是旧 #330 全产品结果；旧产品另见正常 Server 同库对照。

当前/旧事实泄漏与跨身份目标 ID 泄漏在这些样本中为零。UNKNOWN 槽仍可能拿到无关 ANN 首选（3/3），所以 candidate availability 不能作为语义蕴含或“数据库绝无该事实”的证明。当前 precision 和未知支持判定仍是正式开放项。

## 回答忠实度

[视觉报告对照](evidence/grounding.json)使用 #329 实际 Qwen 输出的同一份正确报告，重放正式 Character Port/Gate/Body 和真实 Chat；不重新调用 Vision，不声称这是新的完整 Host/A9 视觉实验。两组各 10 个问题，输入都含正确报告。旧组一次把 A(12) 称最矮同时又说 B(7) 更矮；新组“先列标签/值再比较”未发生该矛盾。未知背面颜色均拒绝猜测。没有额外验证模型，Gate 不增加正文格式要求。

Memory 的“月桂-91”反例单独保留。新引文结构还保留 source/current/conflicted，避免把引文第一人称自动变成 Alice 身份；但原饮食回答的第一人称归属错误尚未经过独立普遍验收，不能因数值正确就判所有语义正确。

## 成本与运行限制

四个 Runtime cohort（含失败、同库重放、引用控制）共 238 次 Chat/Reasoning 请求，输入 283,523、输出 11,469、缓存输入 92,672 token，Provider 已知估算 $0.01490556，另有一次失败无费用回执，**不是最终账单或精确上限**。各输出目录预设最多 60 调用和已知估算 $0.10，未为抽取成功而无限重试。视觉表达重放另为 40 次请求；embedding usage 和延迟另记录，费用不能混为免费。

新规划仍一次调用，没有取代原 Gate/Body；正文比较约束与需求格式不增加模型调用。五需求可产生六次并行查询 embedding（原句加每需求），旧整句只有一次，不能只报数据库省时。逐调用 CSV 提供 actual usage/cache/首字节/总延迟；非流式首字节不是首可见 token。不同 cohort 总费用不能当配对节省，严格同库问题的端到端耗时也保留在 JSON。

本地 check、build、全仓 test 与实际 PostgreSQL 的检索/Authority/角色/Shadow/Source/Server/Dispatcher 回归执行。CI 新增冻结覆盖、来源片段、失效向量、模型空间和评测归因门禁。一次新增空 scope 测试被错误嵌套，CI 拒绝，已修正为独立测试；不通过修改生产装配规避。最终 CI 以 Draft PR 最新 HEAD 为准。
