# YUVI 持续内部状态基础研究

本轮研究以持续组织与个体发展为理论起点，不修改生产代码、不设计 API、不制定版本实施计划。研究基线为 main `c28e5901f4ef3578a85ab8fd9513652ddaab5866`，对照 PR #321 及上一轮架构研究。

- [主报告：YUVI-Persistent-Internal-State-Foundations.zh.md](YUVI-Persistent-Internal-State-Foundations.zh.md)
- [来源、阅读范围与证据等级](sources-and-scope.zh.md)
- [形式反例脚本](experiments/formal_counterexamples.py)
- [运行结果](experiments/results.json)
- [最终验证记录](evidence/final-verification.json)

核心判断：持续组织状态是有价值、尚待验证的研究假说；重点是经历能否通过共同机制改变跨情境行为及以后怎样学习。完整历史重放、独立控制器拼接、交互耦合是必须面对的竞争解释。

本轮实际运行的只有三个形式反例。主报告的九项行为实验是研究设计，不是已经验证的个体能力。没有调用带凭据的模型、没有训练潜在状态，也没有将论文全文缓存发布到仓库。
