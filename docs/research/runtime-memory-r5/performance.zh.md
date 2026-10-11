# PostgreSQL 规模与性能验收

本机 Intel Core Ultra 9 275HX、24 CPU、约 47GiB RAM，PostgreSQL 16.15 + pgvector，数据库与日常 Alice 同机但使用独立 DB。性能 SLO：100,000 条同域、普通结构化分页/单条读取 p95 <300ms；文本、向量、模型、网络、写入和重建单独测量。此处不包含真实模型延迟，也不测 Alice 数据。

## 数据与方法

实际持久化 1k → 10k → 100k → 1M 同 scope 的 authority record/current projection，使用正式 Schema、索引与 `MemoryKnowledgeReader`。负载生成器直接写入合成索引 fixture，**绕过 Journal/Admission/LLM**，因此只能证明索引与读取组件的规模行为，不能证明百万条 grounded 写入质量、Provider 吞吐或完整数据审计。

每种查询预热 10 次、测量 100 次，排序报告 p50/p95/p99；分页 limit=20；单条/稀有文本取中间唯一 token；宽泛词命中整个 corpus 时，候选读取有界并明确 PARTIAL。4 并发执行 400 次分页。样本小、缓存热，数据库共享机器，不能推广为所有工作负载的容量承诺。

原四档测量来自冻结前工作树，完整数值见 [load-scales.json](evidence/load-scales.json)。最终百万条复测记录不可变代码 SHA `2d63673`，其后仅修改 worker Persona 选择，未改检索函数。

|  记录数 | 分页 p95 ms | 单条 p95 ms | 文本 p95 ms | 宽泛词 p95 ms | 4 并发分页 req/s |
| ------: | ----------: | ----------: | ----------: | ------------: | ---------------: |
|    1000 |       0.678 |       0.237 |       0.432 |         0.834 |             4539 |
|   10000 |       0.796 |       0.208 |       1.585 |         2.639 |             4242 |
|  100000 |       0.954 |       0.823 |       3.126 |         2.016 |             4478 |
| 1000000 |       0.810 |       0.832 |       3.793 |         2.243 |             4097 |

第一份冻结百万条复测：分页 p95 **1.380ms**、单条 **0.509ms**、文本 **30.298ms**、宽泛词 **1.893ms**；4 并发分页 3951 req/s。[最终结果与 EXPLAIN ANALYZE/BUFFERS](evidence/load-million-frozen.json)。文本从旧测量约 3.8ms 上升到约 30ms，保留真实变化；未针对 GIN pending list/cache 作独立归因，不能选择最好一次数字替代最终结果。

分页执行计划为当前有效 partial B-tree → 20 条 authority PK lookup，无全 scope 快照。稀有文本使用 GIN，后续只处理实际候选。候选上限避免应用层全量排名；不等于所有多 scope 或低选择性 SQL 计划的代价已被证明与完整历史无关。

## 资源、写入与恢复

5 秒资源负载为 3 个分页 reader，第 4 个连接每 50ms 只采样本实验 PostgreSQL backend。实际完成 27771 次分页，用时 5050.0ms。累计 CPU 约 5.87 CPU 秒；各连接采样峰值 RSS 合计 99.1MiB（包含共享页重复计数，不是 DB 全进程峰值或 PSS）。未采集加载阶段的连续资源峰值；此前 spot sample 不冒充峰值。IO 是该独立 DB 的累计计数，受前序测试/重建影响，不能当单次查询 IO。

百万条时 authority 表及索引合计约 1.18GB、其中索引约 492MB；当前投影合计约 556MB、其中索引约 374MB。最终实际尺寸在 JSON 中（新增有效分页索引、重建后尺寸会变化）。数字为索引 fixture 的存储，不包含百万条真实 Journal、embedding 与来源 payload。

从 100k 追加到 1M 的 900k 合成行耗时 35.66s；百万条同事务投影重建耗时 17.12s，重建后最后 1000 条结构/文本验证无差异。只检查了这个有界尾部，不宣称全域完整审计通过。重建锁住同 scope writer，在线无阻塞重建仍开放。

另在已有 1M 索引 fixture 的同 scope 中通过正式 authority commit 写 A、独立茶叶和 B→A：首次提交含冷启动 110.12ms，独立命题 5.79ms，纠正 8.05ms，检索 3.57ms。A superseded、B current、茶叶 current。见 [incremental.json](evidence/incremental.json)。这是单次确定性增量路径验证，不是并发写入 p95 或语义模型质量。

## 未达成的规模门槛

结构化路径没有原 4096 条全量快照正确性悬崖，在实际百万条背景下可工作。**百万级整体验收仍未完成**：向量 HNSW/过滤/多 scope、cold cache、混合写入、高历史失效比例、完整 Journal 大 payload、磁盘满、长期压力、加载 CPU/内存峰值及 Writer 热域吞吐都需下一阶段实测。512 维模型空间限制必须显式迁移，当前不能直接替换任意 embedding 维度。

## 产品 DTO 白名单后的最终复测

保护 payload 与读取 DTO 分离后，使用 `a2d0629` 再测 1,000,003 条（百万索引 fixture + 三条正式增量记录）：分页 p95 **2.258ms**、单条 **0.346ms**、文本 **28.982ms**、宽泛词 **2.445ms**，4 并发分页 **1527 req/s**。产品读取增加逐条 schema 校验，吞吐降低，保留最终实际值而不沿用之前较好数字。未用此单次差异证明全部吞吐变化的因果；结果仍低于本机结构化 SLO。

[最后代码版本的完整数据/资源/执行计划](evidence/load-million-dto-final.json)。此负载只复测受改动影响的 reader，不重新生成百万行，也不重复调用已耗尽预算的远端模型。

## Phase 2 百万向量与在线投影

[Phase 2 实测与限制](phase2.zh.md#实际实验) 提供1M合成512D向量、HNSW查询计划、旧全量计划失败、ANN漏召回及修复、混合reader、百万shadow重建与并发正式writer，以及实际恢复后查询/资源快照。目标仍是100k普通结构化p95<300ms，本机测试满足。1M最终热vector p95约13.62ms；在线重建读p95约2.50ms、写p95约11.08ms；无数据正确性差异。恢复后first vector64.94ms，OS缓存未驱逐。合成向量的5/5近邻不能替代跨语言/真实embedding Recall@K和多年运行，完整规模门槛仍开放。
