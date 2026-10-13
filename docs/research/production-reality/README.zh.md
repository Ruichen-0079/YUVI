# 生产真实性与认知连续性

本工程基于 #326 `8632dd9`，独立分支 `feat/production-reality-cognitive-continuity`。**阶段 A/B 的纵向切片，整个工程及 Memory R5 仍未完成。** 没有更新真实 Alice、正式数据库、凭据或 QQ。

首先恢复验收的真实性：Server 在 test、development、production 中都装配 Character。Mock 只替换 Provider；Gate、正文、Cognition、Conversation、Journal、Effect 和发布链保持原结构。低层 Runtime 的可选 Character 接口仍供库消费者使用，不能代替 Server 产品验收。

随后处理同一信息在不同层反复裁剪的问题：历史从独立、有来源的 Conversation evidence 进入 Character/Cognition；依据声明的模型窗口统一预算，保护当前输入、人格及执行结果，保留合法已接纳的失败轮原话。Character ABI 的 4,000 字符 summary 合同保留，较长原文不再伪装成这个 summary。

[设计与取舍](architecture.zh.md)、[验收与证据](verification.zh.md)、[总门槛](open-gates.zh.md)。R5 的权威事务、来源、租约、UNKNOWN、Shadow Projection、向量 outbox 和隔离机制继续使用；[R5 总矩阵](../runtime-memory-r5/phase2.zh.md#总体验收矩阵)仍是 Memory 整体合同。
