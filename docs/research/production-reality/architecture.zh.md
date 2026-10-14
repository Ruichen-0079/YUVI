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

## 从实际入口扩展到能力控制与租约

独立 Character 的启动原来跳过整个 Local Services 路由，连实例自己的文件授权入口也不可用（真实实验 HTTP 404，尚未调用模型）。现在把 `read-text/authorize` 抽为 Runtime 所属的 capability control；独立实例只接入这项有认证/Origin/Journal 的能力控制，仍不接入全局 People、配置、Voice 管理。

最后一个推理回合可以提出本实例已经合法授权的只读查询，因为 Character 有正式 PARTIAL 观察消费者。Host 通过发行的 descriptor 与 QUERY 合同确认这一点；Core 默认没有这项许可。没有持久终态合同的 Plugin 仍保留原“需有后续推理回合”限制。Capability 预算、权限、身份、取消和 Deadline 都继续独立检查，模型不能设置这些许可。

真实模型还暴露了 COMPLETE 被用来承诺未来读取：协议现在要求最终答案基于已获得证据，能力目录只是可用性，计划不等于观察。保留两个模型的实际 REQUEST_CAPABILITY、单次真实读取、PARTIAL 输入与最终随机标记回答；不把 Prompt 当权限或持久成功回执。

续租故障原回归使用 30ms 租约和 45ms 等待，CI 可能在真正进入 Provider 前就失败。按实际调用时点注入后，暴露续租失败但尚未过期时晚到结果会记录 APPLIED 的缺陷。Dispatcher 现等待本回合正在进行的续租结果；丢失续租权时只能记录 CALL_UNCERTAIN/UNKNOWN，不泄露晚到返回值，也不重试。同样检查成功续租正常 APPLIED，保留原 shutdown/fence/幂等保证。

发布的同事务入库与执行激活是两个时点。后台 Worker 原来会在 HTTP/SSE 回调尚未绑定时 claim publication，并把缺少回调判成 AUTHORITY_REVOKED/WITHHELD。新的 `EffectAdapter.isReady` 仅由 Host 提供，在缺少临时执行工作时保留 PENDING、不 claim；实际执行仍必须通过全部 `isCurrent`、lease、fence、Target generation 和 Journal 检查。它不代表权限已授予，也不允许重放未知结果。
