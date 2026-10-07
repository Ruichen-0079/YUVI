# YUVI / QQ 东方爱丽丝：自然参与、人格隔离与 Attention Router 研究

研究日期：2026-10-07 UTC。本文是源码审计、反证与架构判断，没有改动 YUVI 实现，没有连接真实 QQ 账号或向 QQ 发送消息。

**结论先行：方向值得验证，但现在不能把“通用 persona overlay + personaId + 4B 二分类”视为已经成立的独立东方爱丽丝运行架构。** 当前最明确的阻碍是 Character 的生产人格来源和会话语义仍围绕原生 Yuvi / 单 subject 构造。小模型是否足够则是另一件未解决的事：本地实验显示 4B 能保守放行，却可能几乎没有过滤收益；8B 更能区分部分场景，也存在明显提示敏感性。应先建立完整多人上下文下的主 Character 基线，再按“机会召回—成本—时机”曲线判断是否需要 router。

两个独立人格是产品目标，**不是架构缺陷**。用户已澄清：历史 ZIP 的 overlay 是通用机制，完整“东方爱丽丝”persona 是未来准备装入的内容。下文不会把 ZIP 没有 Alice 人设当作实现失误。

## 1. 实际取得、阅读和运行了什么

### 固定源码与 ZIP

实际 fresh clone、fetch 全部分支及 tags，并再次用 `ls-remote` 核验：

| 对象 | 固定版本 |
| --- | --- |
| YUVI 重点开发分支 | `codex/v0.1.3-platform-completion-20260922` |
| 该分支真实 HEAD | `94e20d0ceb63b127781ed66f60337ac655820001` |
| YUVI main | `4278eb36b1a01acde82dde27b806dca996739972` |
| GitHub ZIP release | `qq-snowluma-v1.0.0`，2026-10-07 发布 |
| ZIP 大小 | 138805 bytes |
| 实测 ZIP SHA-256 | `aec0eb58d8bc6f3612e101da23453972532b1de6f60111438269320ac927c570`，与发布值一致 |
| MaiBot 当前 HEAD | `3f65e6fa8b8404e0c21be5779d1cd1e6a6d5eac7` |

开发分支是按远端最新提交及 v0.1.3 开发内容确定的，不把默认分支 main 当作当前重点开发版本。完整版本记录见 [source-snapshot.json](./source-snapshot.json)。

ZIP 实际包含 `manifest.json`、`index.js`、`assets/THIRD_PARTY_NOTICES.txt`。`index.js` 大部分是打包的 `ws`；已完整阅读其中 252 行插件本体，并单独抽出 [plugin-readable.js](./historical/plugin-readable.js)。这不是凭描述重建的源码。

[release](https://github.com/Ruichen-0079/YUVI/releases/tag/qq-snowluma-v1.0.0) 声明构建源码提交 `7dcf4b01c5956e24a189859b399d185756e9389e`，工作区 HEAD `e8a0971929870df8f6b63ed7de4308e4fae4aff3`。两者均不能从本次公开远端解析/取得。当前开发 HEAD 没有 ZIP 所调用的 `surfaceRegistrations`、`promptPatchRegistrations`，也没有公开 QQ Host 实现。

**因此可以审计插件产物，并与当前公开 Host 对比；不能声称已还原当时完整 Host，或完成与这两个构建提交的逐行源码 diff。** 缺失可能来自未发布提交、私有/不可达历史或其他工作区；“一定是未 push 修改”仍然是推断。

### 实验与边界

运行了 MaiBot 当前源码的 likelihood / dynamic gate 离线复现，以及 Qwen3-4B、Qwen3-8B 各 28 次本地推理。模型只输出是否值得主 Character 考虑，没有生成 QQ 回复。所有消息都是合成研究样例。详见第 8 节。

没有真实中文 QQ 数据集，没有已完成的东方爱丽丝人格，也没有生产主 Character 的反事实参考输出。因此本文**没有实测生产机会召回率，也没有 7B 实测**。源码事实、模型小实验、他人报告和架构推论分别标明。

## 2. ZIP 的 persona replacement 到底是什么

插件注册了两个 patch：

```js
{ fragment: "PERSONA", mode: "replace",
  content: "You are QQBot, a distinct QQ character with your own social memory. Express yourself naturally in an instant-messaging setting." }
{ fragment: "RESPONSE_REQUIREMENTS",
  content: "Prefer concise, natural QQ replies. ... In groups, not every message needs a response." }
```

只有 `PERSONA` 明确指定 `mode: "replace"`；`RESPONSE_REQUIREMENTS` 没有声明 mode，其默认语义依赖缺失的 Host。**插件本体没有 `CHANNEL_CONTEXT` patch。** patch 通过 `surface === "qq"` 的 registration 注册，所以插件表达的是按 QQ surface 替换人格；这一 registration 最终如何选用、是否影响 Cognition/re-entry/proactive，ZIP 不含实现。

这确实表达了“换成另一个 Character”的意图，不只是 QQ channel style。但一句 “with your own social memory” 是人格文本，**不会自动建立 Memory partition**。当前 ZIP 也没有 `personaId`、`subjectUserId`、Memory 创建/检索代码。

覆盖 `PERSONA` 是否足够，取决于所有人格来源：身份名称、authored persona、relationship、近期自我发言、长期记忆、Cognition 输入及 proactive continuation。只替换一个 prompt fragment，不能证明其余来源一致。

### QQ channel context、sender 与回复决策

插件把每条文本消息交给 Host `surface.receive()`，字段包括：

- `accountId`、`conversationKind`、`conversationId`、`senderId`、`content`；
- `messageId`、`sourceTimestamp`、`replyTo`；
- `mentionedIds`，最多 4 个；
- 若本地最近消息映射能查到，提供 `replySenderId`；
- `identityObservations`，包含 UIN、nickname、group card 等观测值、来源及时间。

这是**不错的结构化入站材料**，但不是已经构造好的主模型多人 prompt。近期窗口、thread、audience、Alice 历次自我发言怎样进入主 Character，都留给 Host。

插件自己没有 `RESPOND/SILENCE` 决策，也没有 reply probability、group participation state 或 proactive policy。`recentMessages` 是有限的 message → sender 查询缓存，`enrichments` 是身份信息更新节流，不能解释为 attention state。manifest 没有 Cognition capability；插件重点是 input/presentation surface。

值得特别保留或核对的细节：

1. 只取 text segments，纯 @、纯图片/语音等空文本会被丢弃。不能让最终评测把这类漏看算作 router 智力问题。
2. 入站并发达到 16 时直接忽略后续消息，没有插件层的显式丢弃 trace。社会机会可能在模型前已经消失。
3. 最近映射只记录入站，发送 ACK 不写入该映射；而 `message_sent` 也不走接收路径。故插件自身不能可靠推导 reply-to-Alice 的 `replySenderId`。它仍保留 `replyTo`，Host 若维护出站 ledger 可以补足，不能据此断言完整历史系统一定失败。
4. `senderId` 优先取 event 的 `user_id`，identity observation 可能取嵌套 sender 的 UIN；不一致时不能把两者静默合并成同一个可信 principal。
5. metadata enrichment 使用 `observationOnly: true`。这个“身份观测与对话 turn 分开”的设计值得保留，避免刷新昵称就触发模型或写人物事实。

**保留思想：**薄 transport、expected-account/readiness 校验、明确 account/conversation/sender/message/reply/mention、observations 与发言分离、可替换 persona 的产品意图。**需要重新验证的临时性边界：**固定 SnowLuma 1.14.19/1.14.19-node 兼容检查、text-only、有限缓存、静默并发丢弃，以及依赖不可取得 Host 的 patch API。它们有具体理由，不应以“现代化”为由整体重写。

## 3. 一个 harness、两个 Character：当前隔离是否成立

**类型与部分存储能表达隔离，当前生产装配尚未把独立 Character 实例落完整。** `personaId` 目前主要是 scope selector，不是完整 Character 实例的构造参数。

关键证据：

- [P8 identity](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/p8/src/index.ts#L5) 有 `characterInstanceId / personaProfileId / subjectScopeId`，但默认 Character instance 与 persona 都是 Yuvi；默认 authored identity 名称为 `Yuvi`。
- [production-invariants](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/p8/src/production-invariants.ts#L3) 固定 `Speak as Yuvi`，函数不接收 Character 实例参数。
- [attachSemanticContext](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/core/src/runtime-orchestrator.ts#L1043) 用默认 address，只用传入 `personaId` 替换 `personaProfileId`，随后仍调用同一份 `productionAuthoredInvariants()`。
- [Character context](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/apps/server/src/character-runtime.ts#L423) 来自 canonical shared sections；不能假设历史 fragment patch 会替换当前 P8 的源。IDENTITY/PERSONA/RELATIONSHIP_CONTEXT 受到预算与 Cognition re-entry 保护。
- [Runtime state](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/core/src/runtime-orchestrator.ts#L361) 有单份 proactive policy、单个 scheduler session/identity、共享的 activity revision、explicit-turn depth、speech 活动与 current control authority。
- [Product Person](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/apps/server/src/services/product-store.ts#L7) 是 `id/displayName/personaId/notes`；primary Person 决定一个全局 `MEMORY_PERSONA_ID`。这把现实人物与当前 Character 关联绑得偏紧。

所以，把 `personaId=qq-alice` 填入当前普通消息路径，会改变 scope，却不会把固定 Yuvi authored identity/persona 换成 Alice。反过来，只对一段 PERSONA 做 overlay，又可能仍读到 Yuvi 的 identity、关系或旧自我发言。两个问题不能互相抵消。

| 维度 | 应共享什么 | 应隔离什么 | 当前判断 |
| --- | --- | --- | --- |
| Runtime | 实现、事件/效果基础设施、受治理的存储服务 | 每个 Character 的状态、取消域、attention 和 policy | 当前 composition 主要是一个 Runtime/Character；不能靠 surface name 完成隔离 |
| Persona | 描述与加载机制 | instance identity、authored invariants、人格版本、自我历史 | 类型存在，生产人格源仍固定 Yuvi |
| Memory | backend、检索/证据治理机制 | 每个 Character 见过/经历/相信的内容及关系；同时保留 audience | user × character scope 已有，群体 episode/多 subject 仍偏双人 |
| People | 同一个现实人物的稳定 Person ID、可信绑定事实的 owner | 各 Character 对该人的认识、亲密关系和可披露材料 | Person registry 可以复用；当前 Person 内置单 personaId 不够自然 |
| Profile | materializer 与 provenance/lifecycle | 可见证据集及 Character/context 对人物的视图 | 当前是 Memory scope 的派生证据投影，不是全局无条件画像 |
| relationship | 数据结构和解释规则 | Character × Person，必要时含群/场景 | P8 有 address/scope fencing；完整多实例装配尚未闭合 |
| proactive | 候选与有效性检查、可复用 evaluator 实现 | consent、quiet policy、计划、候选、回退及输出目标 | 当前单 scheduler/policy 不能承担两个独立人格、多群状态 |
| conversation/session | message graph 与存储服务 | account/conversation/thread/Character 的明确命名空间 | session cache 按 sessionId；同 ID 跨人格仍有近期上下文风险 |
| Provider/Cognition | 客户端、模型、pool、路由机制、工具执行底座 | route selection policy、Character 的完整语义快照与能力授权 | 可以用同一模型；不能共享未标明所属实例的语义 context 或全局 mutable turn state |

用户本人应在两个人格里映射到**同一个现实 Person**；Alice 与这个人有自己的关系与经历。桌面 Yuvi 知道的私聊事实，不因此自动变成 Alice 看见过的事实，也不因此可以在 QQ 群披露。

最小的架构方向不是重写 harness，而是让已存在的 address/scope 真正贯穿生产 composition：每个 Character 有一致的实例定义、人格来源、state owner、context snapshot 与输出目标。可以先采用两个独立 Runtime composition，复用底层服务；共享过程必须显式。单纯 new 两个现有 Runtime 仍会拿到固定 Yuvi invariants，需要把这个生产人格来源也做成实例级输入。

## 4. 当前桌面文字、声纹、People/Profile 的真实路径

### 桌面文字

[message route](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/apps/server/src/routes/message.ts#L308) 从请求字段或环境解析 `subjectUserId/personaId`，没有在此猜昵称。二者进入 Runtime event，Memory 通过 [scope encoding](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/scope.ts#L1) 建立：

```text
yuvi:v1:user:{subjectUserId}:character:{personaId}
```

Mem0 缺少二者时拒绝建立 scope，不随便发明默认用户；legacy compatibility 仍有 `default-user/default-persona`，不能把 Mem0 的严格行为推广为全系统均严格。

Runtime 再以 subject 为 `subjectScopeId`、persona 为 `personaProfileId`，读取该 scope 的 Memory/P8 correction，产生 IDENTITY、PERSONA、RELATIONSHIP_CONTEXT 与 Memory/近期会话 projection，然后送入 Character。

但是 **scope selector 不等于可信身份**。当前 [conversational receipt admission](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/apps/server/src/conversational-receipt-admission.ts#L136) 有意记录 unresolved principal、unresolved Person binding、unknown audience、空 subjects。普通 HTTP 请求中的 `subjectUserId` 不被 Journal 视为已经认证的人。

People Product settings 是人物 owner，不是聊天昵称映射器。当前 A10 `ProfileProvider` 以 [MEMORY_SCOPE](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/profile-types.ts#L40) 为 subject，materialize 有来源约束的证据，保留 UNVERIFIED、冲突和 completeness。不能把它当成无条件共享的 Person 画像。当前 Runtime 的 `reconstructP8MainProfile` 也不是 A10 `ProfileProvider` 的同名别称；在检查过的普通 Character 路径里，没有发现 A10 Profile snapshot 自动注入 Character 的调用。Person `notes` 被投影为 NON_EVIDENCE，不会因保存设置自动生成 Memory truth。

### 声纹

实际路径是：audio → STT observation/segments/profile match → 显式 handoff/受控 turn → Host 读取当前 voice binding owner、revision 与对应证据 → [P8 voice-person resolver](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/p8/src/voice-identity.ts#L134) → Person → [scopeVoiceTurn](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/core/src/runtime-orchestrator.ts#L781) 的 `subjectUserId/personaId/speakerId` → Memory/P8/Character context。

只有 MATCHED profile 不够；当前绑定 projection 必须 CURRENT、eligible、显式 local controller issuer，有 owner/binding revisions，并与本次 committed acoustic observation 对齐。模型说“我是某某”、sidecar label、相似度分数都不直接绑定人物。多 speaker 无法得到唯一 claim assertor 时，也不会强选一个 Person。未解析身份的 voice turn 会禁用人物 Memory 读写。

**声纹回答的是“这次声音可被当前可信绑定解释为哪个 Person”，没有负责生成 Profile。** 且 speech Journal receipt 仍保留未认证 principal/Person authority；语义 speaker resolution 不能反过来把声纹变成账号认证。当前代码及 [identity-and-provenance 决策](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/docs/future/identity-and-provenance.md#L3) 明确区分这些事实。

### QQ 与 voice 可以共用什么父概念

可以共用更一般的**外部身份引用 → Person 的受治理绑定**：source kind/namespace、稳定 ID、绑定 owner、issuer、有效期、revision、撤销、冲突和证据。但不能把所有引用都称为已认证 principal：QQ UIN 是账号层 principal 的候选；voiceProfile 是带误差的声学识别引用，保障来源不同。

QQ 至少应分成 bot account、sender UIN principal、display observation、可信 Person binding、语义 speaker 和 referenced persons。昵称/card 只影响显示与语言消歧，不负责建立 binding。未绑定者仍能正常群聊；只能说是某个稳定 QQ participant，不能套用同名现实人物的 Profile/relationship/Memory。

绑定建立之前，还要知道 UIN 是由哪个受信 transport connection/account attestation 提供的。ZIP 的 expected-account 校验支持确认所接 bot account，但不单独证明嵌套 sender 数据、Person 绑定或 group audience 的权限。这里应复用 receipt/provenance 的来源约束，不能让模型读到一个 UIN 就视为现实人物已认证。

不要把 QQ sender 继承成 `LOCAL_EXPLICIT_CONTROLLER`。当前普通桌面 turn 使用这一控制授权，与“群里某人说别讲话”是不同来源；群成员的边界可以影响当前 interaction，却不能默认改写 Alice 的全局持久 consent/policy。

## 5. 多人上下文是当前比 router 更早的缺口

当前 [Character port](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/apps/server/src/character-runtime.ts#L150) 明确将桌面 turn 投影为 `DIRECTED_TO_YUVI`。ABI 实际允许 `NOT_DIRECTED/AMBIGUOUS` 和 `SILENCE`，所以**不是 ABI 根本不会沉默，而是生产输入被预设为 directed**。QQ 非 @ 插话也可以是适合参与的机会，不能把 `NOT_DIRECTED` 机械转换成必须 SILENCE。

当前上下文存在两种需分别处理的问题：

1. [DirectContext](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/core/src/runtime-orchestrator.ts#L7213) 把历史表示成 `User: ... / Assistant: ...`，cache/restore 按 sessionId，不以 Character/Person 对每条消息做身份过滤。若不同人格复用 session，可能串近期上下文；同群不同 speaker 会丢失作者语义。
2. [Memory vNext](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/memory-vnext.ts#L92) 会按当前 persona/subject 过滤 messages。这保护单 subject 不被其他人的历史重标，却在群聊里可能删除理解 thread 必需的其他人的消息。[RecentEpisode](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/recent-episode.ts#L211) 仍按 user/assistant 汇总，episode 只有单个 subjectUserId。

不能以“把所有 sender 都填进 subjectUserId”为解决方案。session/conversation owner、message author、Memory claim subject 是不同轴。

主 Character 的近期 context 应保留原消息图：稳定 participant label + display 名、message ID、真实作者、source/observed time、reply 目标及引用范围、mentions、Alice 自己的实际出站、当前 audience、候选 thread 和最新变化。thread 可以是带不确定性的关联集合；一句消息能同时接续多个话题，不能强迫每条消息只属于一个精确 thread。

建议**结构化 envelope + 带 speaker 的原文**。结构保住可证实的关系，原文保住玩笑、黑话、否定、反讽与语用信息。模型推断的“这是给 Alice 的”只能作为 hypothesis，不能覆盖 source reply/mention。quoted 文本的作者和消息本身的作者分开，显示名里的 `Alice: ...` 也不是新说话人。

结构化 state 也可能成为新的丢失点：thread linking 连错、只保存摘要、错误判定 closed，都会让更强模型无从纠正。应保留原始 anchors、关联置信状态与有限原文回查。当前 JSON 小实验只测试包装变化，不能证明复杂 structured state 比 raw 更好。

例如：`Alice：Bob 昨天告诉我他准备退课。` author/assertor 是 Alice，claim subject 候选是 Bob，addressee 可能是群体/Charlie；若人物可解析，这是第三方 claim，不能变成 Alice 要退课，也不能变成 Bob 已确认要退课。现有 [MemoryClaim](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/provider.ts#L36) 已区分 assertor/subject，[claim admission](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/claim.ts#L67) 拒绝 unresolved 与不一致 SELF_REPORT。应走这个显式归因路径，不能沿用 directed 单人 turn 的默认 self-report 假设。

## 6. 真正的父概念：社会参与机会，而非回复压力

最强论证是：**社会证据有对象、因果、归属和失效条件；沉默时长没有这些信息。**

`这个怎么回事 → 可能昨天的 bug → 爱丽丝昨天不是研究过吗` 建立了更明确的主题、与 Alice 的关系和邀请。第三条新增的是证据，不是积攒到足够大的发言欲望。相反，`修好了 → 不用查了 → 换话题` 会撤销机会，即使她还没讲话。

但“证据越多机会越强”也不是正确的单调规则：十条消息可能同时证明 thread 已关闭；一条短 @ 或感谢就足以形成机会。正确对象是**可更新、可撤销、会过期的 participation opportunity**，记录其消息锚点、邀请/延续证据、尚未完成的互动以及是否仍适合加入。不要把社会证据重新压成随消息数上涨的 interest。

至少分两条判断轴：

- **贡献可能性：**有没有具体内容、回应、笑点、帮助、简短 acknowledgement 值得主 Character 考虑？
- **社会时机：**当前是她的 turn、可自然加入、需要稍等、已被别人回答、已收尾、或已经过期？

“知道答案，但 B 已经在答”与“刚被感谢，只需回一句”是完全不同的组合。内容价值也不能只定义为知识纠错，Alice 是独立群友人格，玩笑、接话、承认或关心都有可能成立。

时间可以减少证据有效性、检测约定 follow-up 到期、重验已存在候选；它不该仅因久未讲话提高参与概率。机会失效还取决于语义关闭和话题进展，固定 TTL 是兜底而不是全部判断。

### 最强反例：router 看不到 Character 的理由

两次群聊的消息完全相同：“昨晚那个崩溃还在，有人复现了吗？”一位 Alice 刚在其 Memory/Cognition 里得出相关结论，另一位没有。两者主 Character 的贡献判断可能不同，router 若只看 stream 会给相同结果。

这不是 4B 专属错误，是信息边界问题。人格偏好、关系和幽默也能带来同样反例。若 router 不拥有或读取同样的全部语义，不能保证准确预测最终 RESPOND；若为了预测而复制完整 persona/Memory/Character，又违反了其轻量角色，并产生第二套 authority。

可接受的折中是从主体系提供小的、只读、版本化参与线索，例如 Alice 参与过的 message anchors、仍未完成的承诺、近期任务与可贡献线索。它们是 attention evidence，不是 router 自创的 Memory。未知关联应增加放行倾向。但这仍是实验假设，无法消除所有遗漏。

## 7. MaiBot：问题不是一个统一的“时间压力系统”

### 历史 willingness 的事实与反证

实读 [0.8.1 classical](https://github.com/Mai-with-u/MaiBot/blob/0.8.1-alpha/src/chat/normal_chat/willing/mode_classical.py)：每秒乘 0.9 衰减，interest/mention 增加值，再映射为概率。**它不是沉默越久越增长。** 0.6.3 dynamic 模式则有随机高/低意愿期、定时切换及简化追问判断；这些节律不等于捕获当前 thread 的邀请。

最贴近用户体验的是 [issue #683](https://github.com/Mai-with-u/MaiBot/issues/683)：前面名字/兴趣抬高意愿后，对后续无营养消息逐条/隔条回应。作者讨论了并行回复时提前降低意愿，后又说明 willingness 已移除。Git 历史中移除 commit 为 `1f91967d`，2025-08-11。机制问题是**旧话题的活跃量被转移到新消息上**，不必依赖时间单调增长。

[issue #204](https://github.com/Mai-with-u/MaiBot/issues/204) 讨论了表情包压低意愿、概率映射极端值与上下文关联弱；[discussion #525](https://github.com/Mai-with-u/MaiBot/discussions/525) 提供“低活跃多说话，高活跃少插嘴”预设。它们说明调概率主要改变数量，不保证回复对象或时机正确。

### 后来版本的时间驱动

[issue #1298](https://github.com/Mai-with-u/MaiBot/issues/1298) 的原始日志明确写了“长久没有回复，可以试试主动发言，开始生成问题”，并报告旧群聊话题被再次带回。维护者称来自群聊过往内容、LLM 决定，并说明新机制最多触发一次。这里的问题是**过去可讨论的内容被当成现在仍适合提出的问题**。这是 issue 中的具体版本/日志证据，不能说用户旧部署必然用了同一版。

[issue #1786](https://github.com/Mai-with-u/MaiBot/issues/1786) 则报告低活跃群空窗补偿与延迟自唤醒导致过度回复。当前源码已给 idle-equivalent count 封顶并要求至少一条真实 pending 新消息，不能沿用该 issue 将“纯沉默不断自唤醒”当成当前 HEAD 已证实的行为。

### 当前 1.3.x 的另一个反例：热群门控失明

实读 [scheduler](https://github.com/Mai-with-u/MaiBot/blob/3f65e6fa8b8404e0c21be5779d1cd1e6a6d5eac7/src/maisaka/turn_trigger/scheduler.py)、[likelihood](https://github.com/Mai-with-u/MaiBot/blob/3f65e6fa8b8404e0c21be5779d1cd1e6a6d5eac7/src/maisaka/turn_trigger/reply_likelihood.py)、[dynamic gate](https://github.com/Mai-with-u/MaiBot/blob/3f65e6fa8b8404e0c21be5779d1cd1e6a6d5eac7/src/maisaka/turn_trigger/dynamic_gate.py)：

- 私聊不经过该动态门控；@ 有强制进入 Planner 的分支。
- 非 @ 估计概率来自 mention、@other、问号、媒体占位、近期自身发言比、消息量、距离上次发言时间和 pending count。
- `log1p(seconds_since_bot)` 权重为正，但只有 0.0571；不能把所有不自然行为都归因于这一小项。
- 近期 5 分钟消息数权重为负，`-0.0367`。门槛还由预计/实际回复数量与频率控制。
- 门控目标是进入 Planner 后调用 reply 的统计概率，不直接等于当前社会上合适的发言机会。

实际运行上游两文件，设固定 frequency=0.8、self ratio=0、问号=true、pending=30（源码 cap 为20）、since bot=3600：

| 5 分钟消息量 | 估计概率 | 冷启动门槛 | 进入 Planner |
| --- | --- | --- | --- |
| 60 | 0.39408 | 0.25 | 是 |
| 80 | 0.23790 | 0.25 | 否 |
| 120 | 0.06709 | 0.25 | 否 |
| 200 | 0.00380 | 0.25 | 否 |
| 300 | 0.000097 | 0.25 | 否 |

[脚本](./maibot-offline-probe.py) 与 [结果](./maibot-offline-probe.json) 可复现。它独立复现了当前门控条件，与 [#2109](https://github.com/Mai-with-u/MaiBot/issues/2109) 的热群报告一致；没有复现完整 24 小时部署或所有动态窗口状态，不能把 issue 的所有数字当成本轮测量。明确的结构性风险是：消息越多越不放行，bot 不参与又不能增加自身参与比；关键未 @ 机会被挡在 Planner 前。

也不能把全部“该说不说”解释为 social classifier：[issue #2018](https://github.com/Mai-with-u/MaiBot/issues/2018) 报告 Planner 有 reasoning/content 却无 reply tool call而整轮结束，当前 `reasoning_engine.py` 的 no-tool 路径确实以 cycle end 收尾。这属于协议/终止行为。重复回复还涉及 stale target、并发、执行后状态和历史再摄入，见 [#1087](https://github.com/Mai-with-u/MaiBot/issues/1087)。

可保留 MaiBot 当前 [message prefix](https://github.com/Mai-with-u/MaiBot/blob/3f65e6fa8b8404e0c21be5779d1cd1e6a6d5eac7/src/maisaka/context/planner_messages.py) 对 msg_id、quote、time、user、group_card、is_self_message 的明确表示，以及显式 wait/结束、对重复目标的提示。不要继承以回复数量目标替代机会有效性的控制。用户旧部署的准确版本/config/trace 缺失，根因应停留在这些被证明的机制与相符的失败类型，不能做唯一归因。

## 8. 4B / 7B / 8B：本地实测能支持什么

### 方法

同家族 Qwen3-4B/8B，Unsloth GGUF Q4_K_M；llama.cpp b11457 / `5ad1c5da0`，3 vCPU、9.7 GiB RAM、无 GPU。context 2048、temperature 0、seed 42、thinking/reasoning off、JSON output、max_tokens 32。

12 个中文短场景：隐式邀请、Alice 参与后的追问、@别人、旧引用含 Alice、多话题交错 reply、黑话回指、机会已关闭、别人之间玩笑、短 acknowledgement、同名真人、分条请求、已过期。6 个标为“应让主 Character 考虑”，6 个标为“没有明显交接必要”；后者含社会判断，不等于已被主 Character 判定 SILENCE。

每模型：12 场景 × 两种高召回提示 = 24 calls，再给 4 场景套保留原文的 JSON wrapper，共 28 calls；总 56 calls。提示改写尽量保持同一高召回意图，但仍包含措辞/强调差异；结果不能量化纯同义词扰动的因果效应。JSON 实验只是序列化变化，不是完整 structured social state。

### 结果

| 模型 | 提示 A：预期机会放行 | A：6 个非必要样例额外放行 | A：总放行 | 提示 B：总放行 | 两提示标签变化 |
| --- | --- | --- | --- | --- | --- |
| Qwen3-4B | 6/6 | 4/6 | 10/12 | 12/12 | 2/12 |
| Qwen3-8B | 6/6 | 1/6 | 7/12 | 11/12 | 4/12 |

4B 的旧引用、过期机会因提示改写改变标签；“已经解决/不用查”的场景，raw 在提示 A 下放行，JSON wrapper 下不放行。8B 在提示 A 更有选择性，但提示 B 也开始放行 @别人、旧引用、已关闭话题、旁人玩笑。8B 并没有凭规模解决校准稳定性。

两者这 6 个简单 positive 均没有观察到漏放。**这不能证明低 false negative。** 即使不顾选择偏差，把 6 例视为独立样本，零失误也远不足以证明个位百分点漏放率；真实场景更长、存在多人指代、多流负载和 Memory 信息缺口。

wall latency（28 calls，包含每种提示首次较长 prefill；server 有 prefix cache）：

| 模型 | 中位数 | p95，nearest rank | 最大 |
| --- | --- | --- | --- |
| 4B | 2.43 秒 | 6.20 秒 | 7.56 秒 |
| 8B | 4.02 秒 | 10.61 秒 | 10.93 秒 |

此 CPU 环境达不到“非常快速”；也不能据此推断用户 GPU 的速度。队列、多群竞争、长上下文、主 Character gate 与回复生成尚未计入。样例未截断、56 个结果均可解析。完整 [方法](./model-experiment/methodology.json)、[汇总](./model-experiment/summary.json)、[脚本与原样提示](./model-experiment/experiment.py)、[4B 输出](./model-experiment/qwen3-4b-results.jsonl)、[8B 输出](./model-experiment/qwen3-8b-results.jsonl) 均保存。

结论不是“4B 根本不够”，也不是“4B 已经够”：**存在高召回但几乎不省调用的工作点；8B 某一提示更省调用，但同样需要校准。** 若 router 漏掉主 Character 真正会响应的机会，它事实上就是最高过滤器，名义上没有人格 authority 也不能解除这种影响。

### 直接相关外部研究

[When2Speak](https://arxiv.org/html/2605.05626v1) 比较 Qwen3-4B/8B 等模型：其 zero-shot 4B 过度介入，8B 出现 always-SILENT；SFT 后两者 Macro F1 约 0.737/0.739，但该研究报告 SFT 模型整体 missed intervention rate 约一半；对 Llama-3.1-8B 的非对称 RL 提升 recall 到约 0.78–0.81，仍非接近零遗漏。

它支持“时机是需要专门训练/校准的能力”和“accuracy/Macro F1 好看仍可能严重漏机会”，**不支持将数值搬到 QQ**。它是基于 Yahoo Answers grounding 的合成多 speaker 数据、8-message window，AI 介入以知识类任务为主，不是中文黑话 QQ 群友 Alice。论文中的自报结果还需要独立复现，尤其不应把 8B 某个 zero-shot 崩塌解释为所有 8B 的固有行为。

[GroupMemBench](https://www.microsoft.com/en-us/research/publication/groupmembench-benchmarking-llm-agent-memory-in-multi-party-conversations/) 报告多方 Memory 在 speaker belief、词义和 audience 上明显失效，一些系统不及 BM25。它加强了“不能在摄入时擦掉作者与 reply 结构”的警告；同样是合成 benchmark，不能作为 YUVI 已失效的实测。

### 7B/8B 的性价比与高 recall 成本

7B 没有本轮推理数据。参数量不等于能力排序：不同家族、训练版本、thinking mode、量化、模板与中文能力的影响可能更大。本轮旧 Qwen3 对比也不能代表较新的 Qwen3-4B-Instruct-2507。正式对比应纳入实际候选 4B instruct、中文 7B、8B，保存完整型号/版本，不按 size 选冠军。

粗略成本是 `N × C_router + q × N × C_main`，还要加入 deterministic bypass、聚合、重验、shadow audit 与队列成本。q 是放行率。本轮 4B 的 q 达 0.83/1.0，8B 达 0.58/0.92；只能用来说明高召回可能吞掉节省空间，不能估计真实 QQ q。

已有主 Character RESPOND 路径本身有 gate 再 prose 的两阶段调用，加 router 会再加一个串行决策。输出短并不代表计算便宜：长群聊窗口的 prefill 和排队才可能是主要成本。更大的本地模型若能在相同机会召回下显著降低 q，可能整体更省；反之强主模型/缓存/候选聚合可能更划算。必须比较整条链的成本与 deadline success，不能只比较 tokens/s。

## 9. Reactive / Proactive 可以共用候选，但不应合并成一套定时器

当前 [proactive instruction](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/core/src/runtime-orchestrator.ts#L233) 已要求 concrete recent open thread 与 one specific useful thing worth adding now。这个思想适合 QQ；当前 scalar speak score 仍把贡献和时机放在一起，且桌面默认 60 秒 interval、NO_OP 30 秒 backoff、emit 120 秒 quiet 是另一种时间尺度。

共用：recent social evidence、candidate/thread anchors、open/closed 状态、Alice 参与痕迹、贡献线索、有效性/披露检查和最终 Character disposition。

分开：触发来源、deadline、消息聚合等待、打断规则、budget、consent/quiet policy、输出目标、timer revalidation。Reactive 不必被映射成 desktop proactive 才有权回应未 @ 消息；timer 也不应制造虚拟用户 turn。

message-driven 路径应在实际证据变化时更新候选，必要时做很短的有上限聚合；@/reply 可优先交主 Character，依然允许 SILENCE。idle/timer 路径只重验已存在的 open candidate、承诺/约定到期等具体理由。没有候选的五分钟沉默不会凭空生成机会。

生成后、发布前需要再次确认：目标 audience 和 Character instance 一致；相关 thread 未被关闭；请求未撤销；reply target 可用；机会未过期。不能每来一条无关群消息就取消，否则热群永久无法完成；也不能只验证模型调用前的旧快照。

## 10. 多流 attention：黏性来自未完成互动，不来自欠回复额度

候选归属于 `Character instance + account + conversation + thread/anchors`。全群可并行保留多个候选，不先塞进一个“当前最后消息”。Alice 的 active attention 可以同时记住几个尚未完成的互动；它是持续关系与承诺的上下文，不必被限制为单一 CPU 的 focus 指针。

例如同时有私聊 A、群 B、群 C @Alice、群 D 延续她先前话题：

- 群 C 的 direct address 优先进入主 Character；如果是“你刚才说错了”且影响正在生成内容，可中断。若只是无紧迫性的另一个问题，可以短暂等待现有回复完成。
- 群 D 的延续因 Alice 自己参与过而天然保有线索和连续性，不要求再次 @。
- 私聊 A 的完整请求通常有更长有效窗口；无关群 B ambient 不应打断所有工作。
- 当前参与 thread 有黏性，因为 reply 链、尚未答完的问题和关系承诺仍在；一旦关闭，黏性消失，不跨到该群下一个完全无关话题。
- switching cost 是重新准备上下文、打断未完成生成和社会连续性的成本，可以影响选择，但不变成越来越想讲话。

容量不足时，先合并同 thread 的重复唤醒、丢弃过期候选、为 direct/unresolved request 留容量。starvation 衡量“仍有效的请求反复无法得到审视”，不是每个群必须轮流讲话。机会过期后无需补一句交差；如果是对 Alice 的明确请求，则应在仍合适时承认延迟、重新确认或回答，这也由 Character 判断。

可以用队列/调度原语实现容量控制；不能让 round-robin、公平额度或最长未发言群定义社会行为。有限 deadline 下，成本、有效性和社会义务要分别保留，不能折叠为一条 reply probability。

## 11. Ambient observation 与长期 Memory

**“看见过”不等于“成为人物事实”，也不等于“必须完全忘掉”。** 当前 Journal receipt、短期 social context、长期 Memory evidence 和 Profile projection 是不同层；不要为 QQ 再建一套自主管理长期事实的总结数据库。

建议语义：

| 状态 | 对即时 conversation 有什么用 | 何时可能晋升 |
| --- | --- | --- |
| 纯旁听 | 维持作者、reply、时间、主题与已关闭机会的有限窗口 | 后续与 Alice 任务/参与有关、显式要求记住、稳定且相关的直接 observation/claim；仍需既有 admission |
| Alice 已参与 | 维持她实际说过什么、别人怎样回应、承诺是否未完成 | 具体 interaction、commitment、重要 episode，带确切来源和参与身份 |
| unresolved Person 的消息 | 可以知道这个 QQ participant 在群里说过原话 | 不能凭 display name 晋升现实人物 Profile；后续可信绑定也要保留当时身份状态与版本 |
| 别人谈第三者 | 对当前话题有用 | 是某人关于第三者的 claim，保留 hearsay，不自动转成被谈者的 self-report |

当前 [lineage](https://github.com/Ruichen-0079/YUVI/blob/94e20d0ceb63b127781ed66f60337ac655820001/packages/memory/src/lineage.ts#L18) 已能保留 principal、binding、audience、source selector、origin 与 clocks；`EXTERNAL_OBSERVATION` 可以区别用户 assertion，派生 evidence 保留多来源 ancestry。Profile/source reader/host EvidenceAdmission 的限制值得复用。

但已有 claim 的 `UNKNOWN_AMBIENT` 被拒绝，意味着 unresolved 人物归因不能当 durable claim；它不表示“所有旁听一律无意义”。当前 finalized ingestion 与 episode 路径偏 completed directed turns，**不是已经实现纯群聊旁听晋升机制**。应在现有 owner/admission 下添加明确的 observation eligibility，而不是伪造 user turn、Person 或 ASSISTANT fact 来绕过。

当天旁听可先用有限 social buffer/受治理保留的源重建；次日“昨天听过”的连续性取决于源是否保留、何种 observation/episode 已合法晋升。不能承诺对每天几千条全部无损记忆。忘记噪音与遗忘关键旁听是不同目标，需要分开评测。

## 12. 参考项目能提供什么

| 项目 | 实际查看的重点 | 可借鉴与边界 |
| --- | --- | --- |
| MaiBot | 多代 willingness、当前 scheduler/heuristic gate、Planner context、原始 issue/讨论 | 多 speaker/quote/self 标注、未完成 turn、重复目标控制；频率/空窗补偿不是机会模型 |
| AstrBot | [waking stage](https://github.com/AstrBotDevs/AstrBot/blob/8831d9502575f0aa6fbe5a2f77339b3e94954819/astrbot/core/pipeline/waking_check/stage.py)、[follow-up](https://github.com/AstrBotDevs/AstrBot/blob/8831d9502575f0aa6fbe5a2f77339b3e94954819/astrbot/core/pipeline/process_stage/follow_up.py)、quote/identifier/context | 默认 prefix/@/reply-to-self/private wake，按来源维护 runner/follow-up 次序；是可靠唤醒与会话工程，不等于已解决 ambient 自然参与 |
| smart-wakeup / 灵犀 AstrBot 插件 | [main.py](https://github.com/MagicalYuYu/astrbot_plugin_smart_wakeup/blob/dbf1e1952a365e5955b2625ddea2c37a21e0df53/main.py)、README、故障调优 | 保留群缓存、BOT/回复关系、多消息 debounce；其能量/flow/动态概率/idle rescue、149 可调参数说明复杂节律状态易膨胀，不能当自然性已验证。紧跟 BOT 5 秒就标“回应BOT”仍是启发式，可能误判交错话题 |
| NoneBot | [event dispatch](https://github.com/nonebot/nonebot2/blob/d598f1170f3abefe7a3f29edee0b0cc0cac13289/nonebot/message.py) 的 permission/rule/priority/block | 适合作为 deterministic ingress/routing；matcher priority 不代表 Character social attention |
| SnowLuma | [message converter](https://github.com/SnowLuma/SnowLuma/blob/87527cb7641a5a42f8f0efb73cb066102e004dee/packages/onebot/src/event-converter/to-message.ts)、message IDs、self-sent | UIN、nickname/card、message/self-sent/target、reply 原始材料；所检查的 OneBot 层没有 LLM social participation。`#sl` cooldown 是 status command，不能误读为人格发言意愿 |
| NapCat | [message/sender schema](https://github.com/NapNeko/NapCatQQ/blob/ec6aadaeea38ed3bca67b82bab3d7a9c0f91b8d8/packages/napcat-onebot/types/message.ts) 与 message events | 可靠提供 transport principal/display/reply/segments；不能替代 Person binding 或社会参与判断 |

这些项目都不能仅凭 feature 列表证明“该说就说、该静就静”。MaiBot 原始失败 trace 比节律引擎宣传更有价值；协议端材料比昵称包装更有身份价值。

## 13. 真实 QQ evaluation 应如何设计

评估单元应是**带时序的机会片段与整条系统轨迹**，不只是最后一句 message 的 accuracy。

### 数据与标签

取经授权、去标识的连续群聊/私聊导出：保留稳定 speaker aliases、QQ principal 的一致性、reply ID、mention、bot 自己出站、source/arrival time、编辑/撤回及多个流的同时到达。训练/开发/测试按群、时间与 thread 划分，禁止同一 reply chain 的相邻窗口落进不同集合。

覆盖中文口语、黑话、反讽、多人转述、同名/改 card、reply 目标在窗口外、多人交错、分条说话、Alice 接话后没有 @、第三人提到 Alice、旧引用、纯媒体/@、topic closure、直接请求后他人已回答、高速 burst、多群排队。多 principal 无 binding 也是正常测试组，不全选“已认得的人”。

每个 prefix 只提供当时可见的信息；未来消息可用于标注机会最后有效时间，不能泄漏给决策模型。标签允许 MUST_CONSIDER、MAY_CONSIDER、NO_CURRENT_OPPORTUNITY，并单独标 addressing、贡献类型、合适窗口、closed/answered、referenced persons，不强迫所有人类分歧变二值。

至少两类参考：

1. 固定版本 Alice persona + 同一 Memory/P8/People snapshot + 足够好的多 speaker context，让**主 Character 在没有 router 过滤时**做 disposition；必要时生成很短 contribution sketch 供判断。
2. 熟悉实际群文化的人评审机会与输出社会合适性。主 Character 的 RESPOND 也是待验证的行为，不是绝对 ground truth。

因此同时报告“router 是否挡住主 Character 会 RESPOND 的机会”和“主 Character 想 RESPOND 是否真合适”。NEED_COGNITION 也应保留：它可能最终产生值得说的内容，不能当成负例挡掉。

### 指标

- **主 Character 机会漏放率**：参考路径会在仍有效窗口内产生合适 RESPOND 的机会中，有多少从未得到主 Character 审视。分 explicit/implicit/continuation/banter/ack、群活跃度及 binding 状态报告。
- **及时召回**：窗口截止前进入审视、以及实际有效发布的比例。后来重触发但已过期，仍算这次机会遗漏。
- **路由假阳性**：无当下机会却唤醒主 Character的数量、token/算力/队列影响。
- **最终不当发言**：错误插话、抢答、重复、错误 audience、错误人物引用、已关闭话题、私聊材料被用于群回复。它与 router FP 是不同层指标。
- **延迟**：消息→候选→router→Character gate→Cognition→回复→发布的 p50/p95/p99；warm/cold、排队与流竞争分别记录。
- **连续性与 starvation**：她参与后的追问是否自然衔接；仍有效 direct/open request 是否持续没有审视；不把每群沉默时长当 starvation。
- **稳定性**：等价提示、说话人标签改名、card 变化、irrelevant interleaving、context length、JSON/raw serialization、量化和随机种子的结果变化。
- **成本—召回前沿**：在同一及时机会召回目标下，主调用率 q、全链成本、队列过期数。accuracy 不能替代这张曲线。

0 个遗漏的样本量要求也要明说：在独立同分布假设下，大约 300 个 positive 机会零遗漏，才有约 95% 单侧上界接近 1%；QQ 同 thread 强相关，实际应按 episode/group 做 cluster bootstrap，更多样本也不消除分布外问题。门槛可先设 direct bypass 近乎零路由丢失、implicit 的及时召回目标 ≥98%，但这些是**待协商的初始研究目标**，不是现有系统指标或 universal 社会标准。

### 必须跑的 baseline 与消融

按成本公平比较：确定性 @/reply/participation cues；短 burst 聚合后强主 Character 直接审视；4B router；7B/8B router；raw speaker transcript；structured metadata + raw；仅结构摘要；不同近期窗口及 reply anchors；是否提供既有参与/未完成承诺线索；reactive/proactive 独立 policy 与共用 candidate reader。

“直接审视聚合候选”基线必须覆盖全部可接收的近期 message bursts，聚合只改变调用粒度，不先按“看起来值得说”筛掉消息。否则机会筛选只是搬到了 candidate builder，无法检验“不需要复杂 attention system”这个反例。thread/机会假设可以辅助主模型，但不应在基线里静默删除原文；聚合等待也要计入机会 deadline。

不要只在已经放行的消息上评估。阻挡项中随机抽样送主 Character shadow 审视，记录 reference propensity；这是发现 silent false negatives 的必要证据。上线前先用导出数据/合成回放，随后可只做 shadow，不发送真实 QQ 消息。本轮没有进行线上收集或账号操作。

## 14. 上线后最值得保留的 trace

价值最高的是**被拒绝候选的可重放依据**，其次是“生成时合适、发送时已过期”的完整轨迹。只记已发送文本，会看不到 router 的最大风险。

每个 opportunity trace 应能关联：

- account/conversation/Character instance、message anchors、source 和 arrival clocks、reply/mentions、speaker principal/display/binding state；
- 候选更新/撤销/过期理由及证据 refs，router 型号/量化/prompt revision/原输出、bypass 或错误 fallback；
- 主 Character 实际使用的 persona/context/Memory/P8 revisions、选入/未选入消息 refs、disposition 与 Cognition 结果状态；
- 排队、打断、切流、deadline、generation/发布前重验；
- outgoing target/reply ID、效果 intent、ACK/unknown 状态、实际出站回灌，避免把“生成了”当“群里说过了”；
- 后续群友 reply、忽略、纠正、换话题，及获准保留的人工反馈；shadow 被拒项的采样率和标签。

自动收集的是系统决策与已获准保留的源引用，不能让 trace 摘要再变成独立 Memory truth。principal binding 或 audience 有修正时保留原 receipt 与新的解释版本，不改写历史成“当时早已知道是谁”。

## 15. 当前最推荐的整体方向与停止条件

推荐的概念链是：

```text
QQ transport observations（真实 speaker / reply / mention / audience）
          ↓
每个 Character 的有限 social context + 可失效的 participation candidates
          ↓
deterministic bypass / optional 高召回 router / 容量选择
          ↓
独立的东方爱丽丝 Character（当前完整多人 context + 受治理 Memory/P8）
          ↓
RESPOND / SILENCE / NEED_COGNITION
          ↓
机会与 audience 再校验 → effects/publication → 实际自我发言回灌

idle/timer 只重验有具体理由的 candidates，不增加沉默压力
```

这是概念边界，不是本轮建议马上实现的新协议。

最小推进顺序：先把 Character instance 的人格/关系/状态/语义快照边界闭合；以 ZIP 的清晰 transport 字段构造真实多 speaker context；建立主 Character 直接审视聚合候选的成本/自然性基线；再让候选小模型在 shadow 评估中竞争。共享既有 Journal/Memory/People/Provider 基础，补具体缺口，不复制第二套长记忆或人格决策者。

router 的允许用途是减少明显无关候选和节约昂贵审视；它不决定 Alice 的最终发言。direct address、可靠 reply-to-self、未完成互动的关键 continuation 应保守进入主 Character，@“别回我”仍可由 Character SILENCE。模型错误/不确定可以放行，但过载时不能以无限 fail-open 排队毁掉全部 deadline，需要容量控制、聚合与可观察的降级。

出现以下证据应放弃或收缩 router：在目标及时召回下 q 接近 1；小模型延迟使秒级机会过期；prompt/模板变动导致持续漏机会；所需 context 已与主 Character 等大；主 Character 聚合基线成本已足够低。出现以下证据才值得升级 7B/8B或专门训练：同等召回显著减少 q/队列失效，且跨群测试稳定。升级规模不能替代证据。

这轮最强的正面判断是“积累并撤销社会证据”比“欠回复压力”更符合机会的因果结构；最强的反面判断是 router 看不见完整 Character 理由，而且高 recall 可能让它几乎失去经济价值。**当前应该优先修正单 Character/单 subject 的生产装配与多人 context，然后让实验决定 attention router 的复杂度和模型规模。**
