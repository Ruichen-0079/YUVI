# 检索质量：调查与验收边界

#328 原失败在 [model-results](../evidence-continuity/evidence/model-results.json) 的 `run-dialogue` 第 10 轮：英文组合问题只回答周四和茶叶，漏掉已持久化的中文编辑器认识；[实际输入摘要](../evidence-continuity/evidence/model-input-summary.json) 显示编辑器没有进入模型。不是最终回答忽略已经收到的编辑器证据。

最新基线的 `MemoryKnowledgeReader.search()` 确有 GIN 索引；问题是 materialized candidates 在 `ts_rank` 前无序 LIMIT 513。相关记录可以被低相关高频词候选提前挤掉。这与跨语言词项不重合独立存在：旧实验关闭向量，英文 editor 不能凭中文 bigram 索引自动匹配“编辑器”。仅移动 LIMIT 无法宣称解决跨语言语义。

此 A9 提交切片尚未修改检索算法。后续有独立 Ground Truth、真实 PostgreSQL 查询计划/延迟、向量不可用对照以及实际模型输入/回答证据前，检索验收 B 保持开放。此前百万向量 p95 13.62ms 只证明合成向量负载性能，不是自然语言召回率。
