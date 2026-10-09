# 来源、阅读范围与证据等级

本文件支持 [主报告](YUVI-Persistent-Internal-State-Foundations.zh.md)，记录哪些结论来自原文，哪些是作者提出的假说，避免把文献支持扩大为“人工个体已被证明”。研究日期为 2026-10-09。

## 一、仓库与历史

- 阅读基线：远端 main `c28e5901f4ef3578a85ab8fd9513652ddaab5866`，即上一轮报告发布后的 main。
- PR #321：GitHub 元数据显示 closed、未合并。只读抓取 head 至 `refs/research/pr321`，SHA `0b0f1366b341adcf9662b7e0c2d0ab5cd64c2ce9`。抓取引用没有修改生产代码。
- 本轮不深入重审生产实现，不把此前源码审计的缺陷清单作为研究议题。

### Future 阅读如何覆盖理念演变

沿用上一轮 [future-corpus.csv](https://github.com/Ruichen-0079/YUVI/blob/c28e5901f4ef3578a85ab8fd9513652ddaab5866/docs/research/next-generation-architecture/evidence/future-corpus.csv) 的全体系清单，并在本轮重新定位索引与交叉引用。上一轮清单记录 78 份 Markdown、14,369 行；本轮不把这件事冒称为又将每份工程附件全部逐行读过。

本轮重读的核心包括：旧 00 北极星、01 身份与关系、02 表达／认真认知边界、03 时间、04 连续性与注意、05 监督、06 能力认知、07 具身、08 后训练；当前 README、north-star、measured-consolidation、selection-research、research-methodology、model-replacement；相关 identity/provenance、ownership、embodiment、prospective-continuity、authority、memory/lineage 材料。较长材料分段阅读；工程表格用于理解思想边界，而非作为心理机制来源。行为规范、评估与数据目标，以及 09、10 与后续路线的理念地位也纳入对照。

PR #321 的三个关键材料分别是改写后的 00 北极星、`00b-persistent-functional-self-research.md` 和 `00c-current-architecture-reinterpretation.md`。上一轮的理念重建、冻结从零设计和主报告均作为本轮批判对象阅读，没有修改它们来迎合新的研究方向。

关键历史定位：

| 快照 | 所研究的变化 |
| --- | --- |
| `d37c07564c4709a2256e02f5a2541dba47585f76`，2026-08-28 | 结构化陪伴、时间与连续性设计；不把这一阶段错误描述为已经采用激素总调节器。 |
| `2256cf26bbf774cb7e6e77fed824e84bb71747d2`，09-01 | 先使用已有记忆／上下文，暂缓显式连续性与额外机制的工程收缩。 |
| `4278eb36b1a01acde82dde27b806dca996739972`，09-19 | 人工个体北极星，以生活、内在张力、调节与认知投入扩展研究对象。 |
| PR #321 head，09-20 | 从较广泛的持续个体论述，转向功能性自我与干预实验；读取其关键演变提交，而非只看 PR 摘要。 |
| `07509e47de6d37a3d6b0e934f275ed6779b01b46`，09-24 | 当前因果历史体系确立：不强制 Self，转向可归因、可纠正的历史作用。 |
| `46a24878536d537021c49d50c5ce004d93489628`，10-07 | main 保留 PR #321 的因果惯性与行动干预，没有整体合并该 PR。 |

历史阅读围绕关键分歧及其原因，不声称穷尽每个 Git 提交。旧文的心理词汇在报告中作为讨论对象，不把当前文件里未核实的具体“情绪向量实现”写成事实。

## 二、外部原始研究

下表中“全文可得”表示已取得原始全文并重点阅读主论证、方法、实验范围与局限，**不表示所有附录均逐页通读**。所有应用到 YUVI 的机制、预测及实验设计都是本文提出的推论，原文没有直接证明 YUVI 的持续个体。

| 原始研究与链接 | 本轮读取范围 | 采用的解释增量／限制 |
| --- | --- | --- |
| Clark & Chalmers，1998，[The Extended Mind](https://consc.net/papers/extended.html) | 作者公开正文 | 操作边界不等于物理边界；哲学论证，不证明外部数据库已具有心智。 |
| Shalizi & Crutchfield，2001，[Computational Mechanics: Pattern and Prediction, Structure and Simplicity](https://csc.ucdavis.edu/~cmg/papers/cmppss.pdf) | 全文可得，重点读预测等价、状态定义与适用条件 | 用未来差异约束历史保留；预测意义的 causal state 不等于干预因果或人格。 |
| Littman, Sutton & Singh，2001，[Predictive Representations of State](https://proceedings.neurips.cc/paper/2001/file/1e4d36177d71bbb3558e43af9577d70e-Paper.pdf) | 全文可得，主体论证 | 用行动条件的未来测试描述状态；原表示结果不能外推为无限开放环境的价值生成。 |
| Di Paolo，2005，[Autopoiesis, Adaptivity, Teleology, Agency](https://yannickprie.net/archives/ENACTION-SCHOOLS/docs/documents2006/autopoiesis_teleology_2005.pdf) | 全文可得，重点读适应性与规范来源 | 持续存在与主动适应不同；软件维持不自动等价于生物自创生。 |
| Oudeyer, Kaplan & Hafner，2007，[Intrinsic Motivation Systems for Autonomous Mental Development](https://www.pyoudeyer.com/ims.pdf) | 全文可得，机制、机器人实验及进展计算问题 | 学习进展形成历史相关选择；仍有人工偏置，不能证明主观兴趣。 |
| De Jaegher & Di Paolo，2007，[Participatory Sense-Making](https://lifecognitionschool.ias-research.net/files/2010/06/dejaegherdipaolo07participatorysensemaking.pdf) | 全文可得，重点读互动自治、双向影响 | 个体与交互共同组织意义；理论框架，不是数字个体的完成证明。 |
| Auvray, Lenay & Stewart，2009，[Perceptual Interactions in a Minimalist Virtual Environment](https://cepa.info/fulltexts/478.pdf) | 全文可得，重点读条件、机会归一化及结果 | 总点击差异可能来自遭遇机会；不能只用总行为推断个体内部识别。 |
| Mendl, Burman & Paul，2010，[An Integrative Functional Framework for the Study of Animal Emotion and Mood](https://doi.org/10.1098/rspb.2010.0303) | 原始摘要及公开可访问片段；全文抓取受访问／接口错误限制 | 仅用期待与歧义判断的功能性思路，不宣称已完整检验动物情绪实验，更不外推数字情感。 |
| Friston 等，2015，[Active Inference and Epistemic Value](https://www.fil.ion.ucl.ac.uk/~karl/Active%20inference%20and%20epistemic%20value.pdf) | 全文可得，主论文机制、偏好与模拟；不以附带评论替代原论证 | 信息获取与偏好后果共享计算的候选；偏好不是公式凭空生成。 |
| Wang 等，2016/2017，[Learning to Reinforcement Learn](https://arxiv.org/abs/1611.05763) | 全文可得，循环状态、任务训练与重置条件 | 活动态可实现学到的适应；原研究的 episode 重置与任务族限制保留。 |
| Kirkpatrick 等，2017，[Overcoming Catastrophic Forgetting in Neural Networks](https://arxiv.org/abs/1612.00796) | 全文可得，机制及实验范围 | 学习型参数保护的候选；特定持续学习情境不等于终身个体。 |
| Wang, Lehman, Clune & Stanley，2019，[Paired Open-Ended Trailblazer (POET)](https://arxiv.org/abs/1901.01753) | 全文可得，环境共演化、迁移及实验限制 | 环境发展机会很重要；限定环境空间不等于无限开放式生命。 |
| Geiger, Lu, Icard & Potts，2021，[Causal Abstractions of Neural Networks](https://arxiv.org/abs/2106.02997) | 全文可得，因果抽象、交换干预与实验 | 可读出不等于被使用；方法不能自动证明自我或涌现。 |
| Biehl, Pollock & Kanai，2021，[A Technical Critique of Some Parts of the Free Energy Principle](https://doi.org/10.3390/e23030293) | 全文可得，重点读被批评的推导范围 | 限制总理论外推；不把它误写成所有主动推断模型被推翻。 |
| Geiger 等，2022，[Inducing Causal Structure for Interpretable Neural Networks](https://proceedings.mlr.press/v162/geiger22a.html) | 全文可得，干预训练与预先结构 | 人工诱导的因果图与非预设形成应分开，适合作为实验控制。 |
| Bulatov, Kuratov & Burtsev，2022，[Recurrent Memory Transformer](https://proceedings.neurips.cc/paper_files/paper/2022/hash/47e288629a6996a17ce50b90a056a0e1-Abstract-Conference.html) | 全文可得，记忆 token、分段学习与实验 | 支持训练读取／更新；序列实验不证明长期生活。 |
| Dohare 等，2024，[Loss of Plasticity in Deep Continual Learning](https://doi.org/10.1038/s41586-024-07711-7) | 原始全文通过 Europe PMC 获取，主体实验与局限 | 新学习能力损失不同于旧内容遗忘；所试方法不保证所有 LLM 永久可塑。 |
| Hafner, Pasukonis, Ba & Lillicrap，2025，[Mastering Diverse Control Tasks through World Models](https://doi.org/10.1038/s41586-025-08744-2) | 全文可得，方法与跨任务实验 | 同一算法广泛适用不等于同一状态跨任务生活。 |
| Behrouz, Zhong & Mirrokni，2025，[Titans: Learning to Memorize at Test Time](https://papers.nips.cc/paper_files/paper/2025/file/a4ca07aa108036f80cbb5b82285fd4b1-Paper-Conference.pdf) | 全文可得，关联记忆、梯度动量、遗忘及实验 | 测试时参数记忆可行；surprise 是计算量，不直接证明心理惊讶。 |
| Behrouz, Razaviyayn, Zhong & Mirrokni，2025，[Nested Learning: The Illusion of Deep Learning Architectures](https://arxiv.org/abs/2512.24695) | 全文可得，更新频率、连续记忆与实验 | 多尺度耦合学习的启发；不采纳生物类比作为个体证明。 |

另定位了动力认知综述与循环网络自组织行为图式研究，但未取得可靠完整正文，未以它们支撑关键机制或实验结果。二手综述只用于定位，主报告不靠论文名称数量或权威声望论证。

## 三、本文新增而未验证的主张

以下不是原论文已证明的结论：

1. 多尺度、行动条件的预测组织及状态依赖可塑性，可能形成 YUVI 所需的跨情境共同作用。
2. 个体发展的重要指标之一，是经历改变以后怎样学习，而不只是以后怎样回答。
3. 模型迁移应同时检验当前行为与后续更新关系。
4. 统一性应通过合法干预、留出迁移与独立控制器对照，而非状态全交换来判断。

它们在主报告中都有竞争解释与失败条件。没有训练或真实长期行为数据支持它们已成立。

## 四、实际实验与发布边界

运行的只有三个形式反例：完整重放、独立控制器拼接／旋转、时间分段。脚本使用 Python 标准库，不读仓库生产实现，不调用模型，不产生外部副作用。

从任意目录运行：

```bash
python /path/to/experiments/formal_counterexamples.py
```

结果会保存为脚本旁的 `results.json`。这些反例只验证不充分论证，不能作为人工个体能力或体验收益的证据。

论文全文缓存保留在本地研究工作区，发布材料不包含论文 PDF 或大段全文复制。GitHub 发布仅包含本轮报告、来源说明、形式反例与验证记录。生产代码与上轮冻结设计不改动。
