# 全后端智能效用审计

主报告：[YUVI-Backend-Intelligence-Value-Audit.zh.md](YUVI-Backend-Intelligence-Value-Audit.zh.md)。

生产基线：main `b307704a0c798fe092966766ad4422a9aaa31262`。QQ/Plunge 单独定位于 `adff0c70648b42a3a15ea45609adae1c45b31fc5`；未确认真实 Alice 的部署版本。

- [专题前冻结的能力地图](evidence/initial-capability-map.frozen.txt)：初查不是最终结论；主报告明确修正了 Profile 管理消费者的推测。
- [实验及原始结果](experiments/README.md)：七组实际生产函数的输入、控制和正向消费探针，没有真实模型质量评估。
- [分支范围](evidence/selected-branches.json)、[生产消费者索引](evidence/production-consumer-search.json)、[生产源码一致性](evidence/production-source-comparison.json)、[研究顺序与冻结哈希](evidence/research-order.json)。

先扫描生产装配、共享后端与入口，再选择跨系统消费者深入；最后对照前轮研究。未重读 Future、未创设宏观架构、未修改生产代码。既有实验在源码未变的前提下复核复用，不把旧发现包装为新发现。

覆盖了共享输入/模型/状态/效果链，主要 HTTP/SSE/WS/桌面及 QQ 分支装配，媒体、身份、插件、持久化、部署和工程脚本。没有逐个证明所有函数，没有重放历史 release、所有自定义宿主插件、所有 DB 迁移与网络故障组合，也没有真实音视频设备、模型和部署质量实验。上述范围不能视为全系统运行验收。
