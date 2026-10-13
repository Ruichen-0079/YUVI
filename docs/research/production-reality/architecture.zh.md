# 实际装配与信息合同

## 依赖顺序

1. 同一 Server 入口与可记录输入的 Provider fixture，先证明测试运行产品结构。
2. 历史、静态人格、已获得观察的独立生命周期，消除重复预算和失败清空。
3. 权限/知识快照分离，再建设不依赖完整助手回复的主动语义摄取；否则提前提交的正常记忆会让本轮 Provider 被误撤权。
4. 有界语义上下文、检索质量及观察保留。
5. 正式 Desktop/WebUI/QQ Host 凭据、产品消费者与 R5 资产收敛。

本批完成 1 和 2 的部分纵向能力；不把后续依赖描述为已实现。

## 配置权威

`@companion/config/environment` 是无 IO、无 Provider 依赖的叶模块。Runtime、Provider registry、Server、Supervisor 和 repository factory 使用同一解析：trim、大小写归一、显式无效值报错。Memory backend 默认 legacy，repository 默认 in-memory；显式 postgres 不启动 Mem0。已有显式 Mem0 安装不被迁移或切换。Packaged 配置仍只接受自己的配置根/显式 seed，不读取安装目录中的 `.env`。

`PROVIDER_ALLOW_MOCKS` 只允许依赖替身，`NODE_ENV` 只描述运行环境；二者都不改变 Character 装配。配置开关不再隐式切到另一套 Chat 架构。

## 输入生命周期

Conversation 和 Journal 保存原始合法用户经历。助手取消/失败影响回复状态，不再影响已完成用户原话的后续 DirectContext 可见性。未完成助手草稿仍不当成确认回复。正常长期摄取独立于助手成功的部分尚待建设。

Canonical Context 新增 `conversationEvidence`，包含有界、按时间排列的已接纳对话。Character Gate/Body 和 Cognition 投影都消费它；当前用户消息仍是最后的独立 user 输入。ABI 的 RECENT_CONVERSATION 只作诚实的来源指针，完整选中原文在单独 evidence 字段。

模型声明窗口决定预算；未知能力使用明确保守默认。输出保留和安全边际分别计算一次。最终渲染依据 UTF-8 字节估计整个消息数组，包括控制协议和视觉装饰。此估计不是真实 tokenizer。实际裁剪按所需缩减量进行，保持部分早期线索和尽可能多的完整近期行；超限状态为 PARTIAL。当前输入、人格、执行结果不因可选历史抢占而悄悄消失。无法满足保护内容时明确失败。

这不是永久摘要、语义历史检索或无限上下文。长单行截取有明确标记；超出实际窗口的早期原文仍需要后续可恢复摘要/索引。

## 人格与观察

P8 修正存储失败返回原失败状态，同时给出 authored-only 投影；没有接受损坏修正。Character 能看到带来源和警告的静态人格，Relationship 仍报告不可用/失败。这防止动态文件故障清空作者身份，也不伪造完整人格恢复成功。

Cognition 每个终态保留内部已执行交换。正常失败且已有可信成功观察时，向 Character 投影 PARTIAL，注明目标未完成、停止原因及有界观察。取消和 STALE_EXECUTION 不披露观察。执行授权、Effect lease、幂等、Journal 和 UNKNOWN 保证保持原样；此次没有将 Plugin 副作用重新接入，也没有自动重试未知动作。
