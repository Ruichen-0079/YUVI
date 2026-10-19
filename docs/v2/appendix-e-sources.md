# 附录 E　来源与可行性探针

## E.1 项目内部来源

**项目史研究（[PR #338](https://github.com/Ruichen-0079/YUVI/pull/338)，提交 `3f6a9393`，尚未合并）：**

- [项目史](https://github.com/Ruichen-0079/YUVI/blob/3f6a9393a9d5290d2e924df1c7cf1ab72aa5c382/docs/research/project-history/PROJECT_HISTORY.md)：十个阶段、Future Doc 的演变、六条主题线。
- [PR 索引](https://github.com/Ruichen-0079/YUVI/blob/3f6a9393a9d5290d2e924df1c7cf1ab72aa5c382/docs/research/project-history/PR_RESEARCH_INDEX.md)：全部 336 个 PR 的分类与说明。
- [研究基础](https://github.com/Ruichen-0079/YUVI/blob/3f6a9393a9d5290d2e924df1c7cf1ab72aa5c382/docs/research/project-history/RESEARCH_FOUNDATIONS.md)：命题 P1–P8、八条原则、已验证机制、负面结果。
- [历史债务](https://github.com/Ruichen-0079/YUVI/blob/3f6a9393a9d5290d2e924df1c7cf1ab72aa5c382/docs/research/project-history/HISTORICAL_DEBT.md)：D1–D12 的形成机制。

**10-09 的独立研究（main 上）：**

- [理念与目标重建](../research/next-generation-architecture/YUVI-Vision-Reconstruction.zh.md)
- [从零架构设计（冻结原稿）](../research/next-generation-architecture/YUVI-Clean-Sheet-Architecture.zh.md)
- [下一代架构评审](../research/next-generation-architecture/YUVI-Next-Generation-Architecture-Review.zh.md)
- [持续内部状态基础研究](../research/persistent-internal-state/YUVI-Persistent-Internal-State-Foundations.zh.md)
- [生产智能损失审计](../research/production-intelligence-loss/YUVI-Production-Intelligence-Loss-Audit.zh.md)
- [后端智能效用审计](../research/backend-intelligence-value/YUVI-Backend-Intelligence-Value-Audit.zh.md)

**Future 文档：**

- [北极星（09-24 后）](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/docs/future/north-star.md)
- [研究方法（含 E7、E8）](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/docs/future/research-methodology.md)
- [模型替换](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/docs/future/model-replacement.md)
- [09-19 的人工个体北极星](https://github.com/Ruichen-0079/YUVI/blob/4278eb36b1a01acde82dde27b806dca996739972/docs/future/00-artificial-person-north-star.md)
- [PR #321（关闭）](https://github.com/Ruichen-0079/YUVI/pull/321)

**代码：** 见附录 A 中固定到提交的链接。

## E.2 外部来源

| 主题                     | 来源                                                                                                                                                             | 在蓝图中的用途                                                            | 注意                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 反思式记忆的自我强化错误 | [Honest Lying: Understanding Memory Confabulation in Reflexive Agents（arXiv 2605.29463）](https://arxiv.org/pdf/2605.29463)                                     | N3：错误解释被存入记忆并反复依据它行动；程序信号把重复率从 0.64 降到 0.10 | 预印本；任务是 ALFWorld/HumanEval，不是伴侣场景                                            |
| 代理记忆综述             | [Memory for Autonomous LLM Agents（arXiv 2603.07670）](https://arxiv.org/pdf/2603.07670)                                                                         | N3：自我强化错误是反思式记忆的主要风险；质量门槛仍不成熟                  | 综述                                                                                       |
| 情节记忆                 | [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents（arXiv 2502.06975）](https://arxiv.org/pdf/2502.06975)                                  | D-2：原文事件流作为情节记忆                                               | 立场论文                                                                                   |
| 持久代理综述             | [Always-On Agents: A Survey of Persistent Memory, State, and Governance in LLM Agents（arXiv 2606.30306）](https://arxiv.org/pdf/2606.30306)                     | N1：抽象过程中的出处丢失                                                  | 综述                                                                                       |
| 代理记忆综述             | [A Survey of Agent Memory in the Second Half（arXiv 2602.06052）](https://arxiv.org/pdf/2602.06052)                                                              | 背景：写入—管理—读取的分类                                                | 综述                                                                                       |
| 记忆压缩的率失真观点     | [What to Keep, What to Forget: A Rate–Distortion View of Memory Compaction（arXiv 2607.08032）](https://arxiv.org/pdf/2607.08032)                                | D-3：章节压缩按下游决策评估                                               | —                                                                                          |
| 离线计算                 | [Letta: Sleep-time Compute](https://letta.com/blog/sleep-time-compute)                                                                                           | N5：离线整理的价值与“推测无关”的风险                                      | 厂商博客                                                                                   |
| 自我编辑权重             | [Self-Adapting Language Models（SEAL, arXiv 2506.10943）](https://alphaxiv.org/abs/2506.10943)                                                                   | D-12：在线权重更新仍有灾难性遗忘问题                                      | —                                                                                          |
| 稳态框架                 | [Emotion-Inspired Learning Signals (EILS)（arXiv 2512.22200）](https://arxiv.org/pdf/2512.22200)                                                                 | N9：已有稳态框架主要基于强化学习                                          | —                                                                                          |
| 互补学习系统             | McClelland, McNaughton & O'Reilly (1995). Why there are complementary learning systems in the hippocampus and neocortex. _Psychological Review_ 102(3), 419–457. | D-5：快速情节 + 缓慢整合的类比                                            | 只作类比                                                                                   |
| 自我知觉理论             | Bem, D. J. (1972). Self-perception theory. _Advances in Experimental Social Psychology_ 6, 1–62.                                                                 | N2：由自己的行为推断自己的态度                                            | 只作类比                                                                                   |
| 百万 token 上下文        | [界面新闻：DeepSeek V4（1M 上下文）报道](https://m.jiemian.com/article/14318488.html)                                                                            | N7：上下文窗口已到百万 token 量级                                         | 新闻报道                                                                                   |
| DeepSeek 报价            | [benchlm.ai（2026-10）](https://benchlm.ai/deepseek/api-pricing)、[apidog：V4.1 Flash 报价与缓存](https://apidog.com/blog/deepseek-v4-1-flash-pricing/)          | N7 的费用估算                                                             | **第三方整理，未经官方页面核实**；来源之间对 V4 与 V4.1 是否同一型号说法不一；价格可能调整 |
| `node:sqlite` 状态       | [Node.js v26.7.0 文档：SQLite](https://nodejs.org/download/release/v26.7.0/docs/api/sqlite.html)                                                                 | D-11：稳定性 1.2（发布候选）                                              | 在 Node 22 中仍为实验特性                                                                  |
| sqlite-vec               | [piwheels: sqlite-vec](https://www.piwheels.org/project/sqlite-vec/)                                                                                             | D-10：仍在 0.1.x                                                          | —                                                                                          |

## E.3 可行性探针

**目的：** 检验“一个 SQLite 文件承载多年生活”在读写、检索、分叉上是否可行。

**方法：**

- 合成数据：70% 中文、30% 英文，词表很小。
- 一百万个事件，每个带场景、作者、回复关系；trigram 全文索引；WAL。
- 另有 20 万个随机 512 维单位向量，用于暴力检索。
- 脚本：[`evidence/lifefile_probe.py`](evidence/lifefile_probe.py)。

**环境：** 4 核、15 GB 内存的云容器；Python 3.13，SQLite 3.45.1，numpy 2.5。

**结果**（[`evidence/lifefile_probe_result.json`](evidence/lifefile_probe_result.json)）：

| 项                                                            | 结果                        |
| ------------------------------------------------------------- | --------------------------- |
| 写入 100 万事件（含全文索引）                                 | 76.5 秒（约 1.3 万事件/秒） |
| 文件大小                                                      | 443.6 MB                    |
| 读取最近 2,000 个事件                                         | 中位 4.4 ms，p95 8.2 ms     |
| 按场景读取最近 500 个事件                                     | 中位 2.2 ms，p95 2.4 ms     |
| 全文检索：3 字及以上中文短语（5 个查询）                      | 中位 0.07–0.17 ms           |
| 全文检索：英文两词短语 `music rain`                           | 中位 61 ms                  |
| 全文检索：极高频英文词 `remember`（合成词表只有 20 个英文词） | 中位 408 ms                 |
| 20 万 × 512 维向量暴力检索 top-10                             | 中位 14.7 ms                |
| 复制整个文件（分叉）                                          | 0.2 秒                      |

**发现：** trigram 分词器对少于 3 个字的查询返回空结果，见 [`evidence/cjk_trigram_check.py`](evidence/cjk_trigram_check.py)：

- “咖啡” → 0 条；
- “咖啡茶” → 1 条；
- `LIKE '%咖啡%'` → 2 条。

中文两字词很常见，因此 V2 必须为短查询提供退路。

**另做的检查：** 本机 Node v22.22.0 的内置 `node:sqlite` 可以创建 FTS5 trigram 表并正确查询；底层 SQLite 为 3.50.4；启动时有实验特性警告。

**局限：**

- 数据是合成的，词频分布与真实对话不同。高频词的慢查询主要是小词表造成的，真实数据中的表现需要在第一阶段用导入的历史重测。
- 文件复制时间受页缓存影响，冷缓存下会更慢。
- 没有测试并发写入和崩溃恢复，这些在第一阶段的恢复演练中验证。

**复现：**

```bash
python3 -I docs/v2/evidence/lifefile_probe.py 1000000   # 约 1–2 分钟，临时文件约 450 MB，结束后自动删除
python3 -I docs/v2/evidence/cjk_trigram_check.py
```
