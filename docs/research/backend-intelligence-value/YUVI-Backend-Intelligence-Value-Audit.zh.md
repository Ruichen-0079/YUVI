# YUVI 全后端智能效用、能力可达性与系统性设计审计

**YUVI 已经创造了真实能力，但其工程投入更多兑现为可靠运行，尚未等量兑现为语义理解、经验学习和行动自由。** 它能给模型提供部分历史、相关长期事实、时间信息、图像观察、语音转写及授权工具结果；也能可靠管理个体归属、接收、取消、发表与恢复。这些不是空壳。然而，数据库中的经历、人物证据、任务执行凭证，通常不会自动成为下一轮模型的新认识。部分生产路径还缩减历史、预判语言含义、收窄可用工具，并再次生成或拒绝已有答案。

目前不能给出“兑现了百分之多少”的诚实数字：没有实际 Alice 部署配置、生产轨迹或可用模型凭据。本报告分别评价 **Implemented、Wired、Reachable、Consumed、Effective、Counterproductive**，不把它们合成成熟度分数。源码能证明新增信息和执行机会存在，不能证明这些信息提高了回答质量；离线执行能证明输入变化，不能证明模型体验。

**有限资源应先投入已有信息和能力的正确连接，再决定哪些中间控制值得保留。** 优先恢复日常理解与输出、建立可用工具授权、让已经观察到的证据有适当消费者。不要继续把“又多一个可持久化对象”当作 Alice 又获得一种智能能力。

## A. 基线、方法与真实机器

审计日期：2026-10-09。研究开始获取全部远端分支，锁定下列版本；交付前再次检查远端。只提交研究文档及实验，不修改生产实现。

| 研究对象                                | SHA                                        | 能够据此声称什么                                                         |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| 最新远端 main                           | `b307704a0c798fe092966766ad4422a9aaa31262` | 本报告共享后端、桌面及普通服务器的生产基线                               |
| QQ/Plunge：`feat/plunge-webui-20261008` | `adff0c70648b42a3a15ea45609adae1c45b31fc5` | 独立调查的另一运行版本；未确认是正在运行的 Alice                         |
| main 最近生产源码基线                   | `46a24878536d537021c49d50c5ce004d93489628` | 至本轮 main 的 apps/packages/services/scripts 没有差异；旧实证可复核复用 |

其他实际产品或工程分支也做了定位：`linux-release`（`4bed36f…`）、`release/astra5-v0.1.0`（`a59a8ec…`）、`release/v0.1.1`（`f9634d3…`）是历史发布线；`feat/mem0-live-integration`（`e9b5e66…`）是早期集成；`salvage/desktop-presentation-20260923`（`4da3466…`）涉及呈现恢复；`agentbus-v2/sol-finish-7d2b`（`7887659…`）增加开发协作脚本。没有把它们叠加成 main 的能力。分支非 main 祖先并不证明功能未合入，squash 和后续演变会产生这种情况。完整定位见 [分支记录](evidence/selected-branches.json)；历史发布线没有逐版本重放。

本轮先扫描实际 boot、装配、模型请求、状态和外部效果，保存[初始能力地图](evidence/initial-capability-map.frozen.txt)，再深入跨系统消费者，运行探针，最后对照旧报告。由于沿用同一会话的知识，不声称双盲。冻结地图没有事后改写：其中对 Profile 管理消费者的初步推测，已被本轮调查否定，修正在下文明确记录。

证据分为：**S**＝源码及实际装配；**P**＝真实生产函数的确定性执行/输入；**M**＝真实模型行为效果；**D**＝实际部署。本轮新增七组 P，M、D 未取得。探针显式安装正式 Character；模型是请求记录器，存储与声学/工具输入部分用 fixture。没有真实 PostgreSQL、Mem0 sidecar、麦克风、QQ 或远端模型端到端实验。

### 从入口看，它实际上做什么

```text
外部文字／已准入语音／附件／渠道观察
  → Channel 或 HTTP/SSE/WS 接收、身份与 Journal 凭证
  → Conversation 用户消息、会话恢复
  → Runtime：当前输入 + 有限历史 + 相关 Memory + L1/L2 + 时间 + P8
  → Character：Chat 决定回应／沉默／升级；再生成自然语言正文
       升级 → Reasoning → 有界授权 Capability → 观察 → Reasoning
            → 规范化结果 → Character 再决定和表达
       视觉 → 单次有界观察 → 文本证据
  → Conversation／Publication／语音和呈现效果
  → 已完成轮的 Memory 准入、投递、L1、Dream 与 Profile 生命周期

另一路：自动主动时钟 → 固定会话 → speak score → 短文字 → 发表
```

实际接线在 [server 启动](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/server.ts#L184)及 [createRuntime](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/context.ts#L494)。Profile、记忆 ingestion、read-text effect 有实际生命周期；MemoryMaintenance 是过期/恢复维护，不能把它当作 Dream 的后台语义整合。

这台机器尚不是任意任务 Agent。当前默认产品没有模型可用的通用 shell、浏览器、桌面点击或跨重启任务执行器。主模型也没有原生工具消息接口。其“行动”主要是发表、语音/呈现、受治理状态命令，以及条件性单文件读取和宿主注册插件。开发者 AgentBus 不在 Alice Runtime 内，不计入她的多 Agent 能力或学习能力。

## B. 全后端能力地图：存在、连接、使用与效果分别看

以下是 main 的实际状态。**“是”只表示对应阶段存在；所有语言质量增益仍缺 M。** 运行保障的价值用其防止的错误说明，不冒充智力提升。QQ 的版本差异单列在 E，不套用 main 的函数链。

### 输入、理解与认知

| 能力                     | Implemented                    | Wired                                   | Reachable                       | Consumed                           | Effective 证据                            | Counterproductive / 限制                       |
| ------------------------ | ------------------------------ | --------------------------------------- | ------------------------------- | ---------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 当前文字与会话历史       | 有                             | HTTP/SSE/WS → Runtime                   | 正常接收与 session              | 当前输入、有限历史进入 Character   | P：非默认会话旧文本进入请求；理解改善缺 M | 历史有界、多次投影；数据库完整不等于模型完整   |
| 时间与间隔               | 有                             | Runtime / canonical context             | 正常轮及主动路径                | 时间、未知时间和距上次交流进入请求 | S：额外现场信息                           | 不提供不存在的离线经历；时间推进不等于认知推进 |
| authored 身份、P8 修正   | 有                             | instance binding、重建、controller 修正 | 正式构造与可用 correction store | 身份/人格语义进入 Character        | S：可重建与隔离资产；风格效果缺 M         | 修正存储不可用会诚实降级；不能算自动发展人格   |
| CurrentAffect            | 有                             | 当前文本规则检测 → situation            | 普通文本即可触发                | 提示进入 gate / body               | P：确实改变输入；合理性未证明             | 否定、引用也被高置信标签预判，见 F4            |
| Chat 路由与 fallback     | 有                             | ProviderRegistry                        | 合法凭据和选定 route            | 模型、温度、流、错误信息           | S：提供运行选择；未实测供应商质量         | 同一能力可能由不同模型执行；预算仍有其他上限   |
| Cognition 升级           | 有                             | Character → production callback         | 升级决定、reasoning route、预算 | 结果回到 Character                 | P：有界工具观察进入下一轮推理             | 自定义协议、固定额度、再表达；收益缺 M         |
| Provider 原生工具/富消息 | 当前 Chat/Reasoning 接口不提供 | 未接入该运行路径                        | 主模型不能自行使用原生接口      | 无                                 | 不声称已支持某供应商所有能力              | 接口上限真实存在；模型原生支持须逐供应商确认   |
| Embedding / 检索排序     | 有                             | 配置 provider + repository              | 维度、连接、scope 满足          | 搜索/筛选结果决定可见记忆          | S：提供召回方式；命中与质量缺 M           | 不是经历理解器；较好检索不能补出从未写入的内容 |

### 经历、人物与长期状态

| 能力                                 | Implemented      | Wired                                    | Reachable                                | Consumed                                  | Effective 证据                    | Counterproductive / 限制                                    |
| ------------------------------------ | ---------------- | ---------------------------------------- | ---------------------------------------- | ----------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| legacy 长期记忆                      | 有               | MemoryService / repository               | 配置与 scope 正常                        | 有界相关事实进入 prompt                   | S：持久化/召回通道；缺纵向 M      | 规则入口、语义覆盖窄；不等于 Mem0 完整路径                  |
| Mem0 长期记忆                        | 有               | backend / typed MemoryProvider           | sidecar、归属、写入准入                  | 搜索结果进入 Character/P8 evidence        | P：事实标记进入正式请求           | infer=false；不会自动补做通用语义提取                       |
| finalized ingestion                  | 有               | coordinator / repository / server worker | 符合条件的已完成轮                       | 幂等写入、重试/恢复状态                   | S：防漏投、模糊结果防盲重投       | 提高投递可靠性不提高候选语义；输入遗漏不能靠重试修复        |
| L0/L1/L2、关联回忆                   | 有               | conversation / episodes / MemoryVNext    | 已保存、可回源且相关                     | 有界近期摘要及相关片段                    | S：提供短期之外的信息             | 规则摘要/关键词关联不是理解或学习；重复来源不增加事实可信度 |
| Dream                                | 有               | Runtime 前台回合后的 consider/runDue     | 显著性/重复、source、writer 条件         | 派生 LTM、episode/job 状态                | S/P：触发和工作状态；学习效果缺 M | 没有独立执行时钟；idle 参数生产未传；提取仍为规则           |
| Profile 物化/生命周期                | 有               | coordinator、失效与后台 worker           | 具备有效证据源                           | 生命周期/快照内部使用；**未发现模型读方** | S：来源/版本快照资产              | COMPLETE 不等于理解；初图“管理消费者”未成立                 |
| ScopePeopleModelReader / PersonModel | 有读接口与类型   | reader 在 context 构造                   | 无普通产品调用方；PersonModel 返回不可用 | 未发现生产调用 reader                     | 无产品效果证据                    | 有实现不等于 People 智能功能，见 F1                         |
| Person 资料/选择                     | 有               | product/shared owner / scope             | 管理与显式绑定                           | 身份、scope、voice、owner 校验            | S：正确隔离与绑定                 | displayName/notes 不由此自动进入语义；身份凭证不是人物理解  |
| P8 关系认识                          | 有投影与修正机制 | Runtime 重建                             | 证据、controller 修正可用                | relationship section；自动候选缺 meaning  | P：有 evidence 仍无关系含义       | 缺自动语义生产方；不等于模型不能从原文推断关系              |
| 在线训练/持续参数适应                | 未发现生产实现   | 未发现                                   | 无                                       | 无                                        | 无                                | 研究/声学模板维护不能计作聊天模型持续学习                   |

### 感知、行动与运行保障

| 能力                                           | Implemented   | Wired                                    | Reachable                                | Consumed                        | Effective 证据                          | Counterproductive / 限制                                  |
| ---------------------------------------------- | ------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| 图片附件 / Vision                              | 有            | 专用媒体/文本附件路径                    | MIME/大小、Vision route、准入            | 观察文本进入当前理解            | S：额外观察能力                         | 原图主要给 Vision；跨轮回源及继续观察有限，见 F5          |
| 当前屏幕                                       | 有 KDE 捕获器 | 平台检查后注入 Runtime                   | Linux + KDE Wayland + Spectacle          | 单次 Vision 证据                | S：限定环境有观察机会；未本机实测       | Windows/macOS/GNOME 等不能从 Vision 配置推断已接通        |
| STT / VAD / PTT / hands-free                   | 有            | 本地 sidecar、media、捕获控制            | 权限、本地模型、接收凭证                 | 转写进入 Chat；VAD 控制打断     | P：正式语音链的文本可用                 | 逐段说话者/置信度没有完整语义投影，见 F3                  |
| 声学身份 / Person binding                      | 有            | acoustic owner + P8 + controller         | 显式治理绑定                             | speaker 与 Memory 归属          | S：混合声音不会擅认同一人               | 全局 speaker 不能替代逐段多人理解；未知身份需保持未知     |
| TTS / 播放 / 打断                              | 有            | media effects、前端反馈                  | route、语音设备及许可                    | 用户声音与播放控制              | S：真实交互设施；声音体验缺实测         | 播放反馈不自动成为长期人物认识；不应删除取消/迟到反馈边界 |
| 字幕 / Live2D / embodied presentation          | 有            | bridge、effects、前端窗口                | 对应宿主设备和运行状态                   | 可见呈现、硬门和播放配合        | S：产品表达资产                         | 呈现状态不是外部工程任务的成功结果                        |
| 单文件 read-text                               | 有            | production Cognition / durable effect    | **宿主明确授权路径**；默认 UI/请求缺入口 | P：观察进入下一轮 Reasoning     | P：调用/消费成立；文件 adapter 本轮注入 | executor 接通但日常授权不完整；不是任意文件访问           |
| 插件 Capability                                | 有            | lifecycle、宿主 discovery/grants         | 标准启动 discovery/grants 默认空         | 有注册和授权时进入能力目录/观察 | S：可扩展基础；默认无插件效用           | 配置/声明不能自行产生许可；缺产品连接而非解析器数量       |
| 自动主动回应                                   | 有            | scheduler + score + prose                | consent、quiet、无占用等门满足           | 默认会话、短文字、发表          | P：目标会话及评分输入                   | 非默认会话错位；无 Cognition/Capability 主动任务执行      |
| quiet / consent / 延续抑制                     | 有            | 持久策略、投影、hard gates               | 正常控制入口                             | 影响未来发言/播放机会           | S：真实跨轮行为状态                     | 不应因固定会话错误删除这些边界                            |
| Journal / lineage / context-use                | 有            | PG 条件装配；部分无 DB fail-closed       | 有来源与授权时                           | 回源、校验、归属、失效、诊断    | S：防伪来源/越界/过期结果               | 接收或验证过不等于模型已理解；审计用 SELECTED 需看用途    |
| effects / Publication / UNKNOWN                | 有            | read-text、provider、语音/呈现、输出效果 | 准入及存储/宿主满足                      | 防重复、取消、发布/恢复状态     | S：必要执行保障                         | 成功的证据层有限；缺面向未来理解的普遍结果消费            |
| 配置 / supervisor / 私有持久化 / observability | 有            | desktop/server 与发布设施                | 平台和本地依赖                           | route、重载、排空、恢复、运维   | S：可运行、可诊断资产                   | 未实测故障矩阵；NATS 选择明确拒绝，不是可用总线           |

此地图最重要的分界：**Memory 检索有语义消费者；Profile 的生产对象有生命周期，但没有已确认的产品消费者；工具结果有当前轮消费者，但缺一般长期经验消费者。** 三者不能统称“记忆系统已接通”。

## C. 已创造的价值：应保留哪些资产

**一是基础模型原本没有的信息。** 会话恢复让重启后的模型有机会看到旧文本；有界 Memory 召回能补充不在当前输入中的事实；时间投影避免把未知时间伪造为现在。新探针的正向对照显示：`work` 会话的旧文本进入正式 Character；注入的 Mem0 事实 `BACKEND_MEMORY_MARKER` 进入 gate/body。这里证明的是信息获得，不是正确回答率。

**二是现实观察和有条件的推理增量。** STT、附件视觉和限定环境屏幕捕获确实增加感知。授权工具观察可以进入下一轮 Reasoning：本轮调用实际 `executeProductionCognition`，两轮推理之间新增 `CAPABILITY_OBSERVATION_MARKER`。因此“后端所有工具结果都没有消费者”是错误判断。限制主要在授权入口、能力种类、持续使用以及是否值得再表达，不在已有观察循环完全不存在。

**三是可靠存在与执行。** 个体 definition 与 instance 分离；存储根、Journal namespace、数据库 owner 及记忆 scope 能避免换角色时串历史。声学模板与 Person 绑定分开，未知声音不自动成为已知人。取消、捕获世代、barge-in、原生流、迟到播放反馈和 Publication 解决真实并发/设备问题。效果尝试与 APPLIED/UNKNOWN 的区分，防止网络中断后盲目重发。这些资产即使不提高一道问答的分数，也应保留。

**四是把运维失败变成可辨认状态。** ingestion 的幂等投递、恢复扫描和缺失准入检测值得继续利用；Profile 版本/来源和 context-use 校验有审计价值；路由、fallback 尝试信息、维度验证、秘密与私有 sidecar、进程监督让系统可运行。不能把它们统统当成“多余的 Agent 框架”。不过目前未做真实断电/设备/服务故障演练，不能宣布全部恢复组合已得到 D 验收。

## D. 尚未兑现的投入：缺的具体连接

### 1. 保存经历不等于一般经验提取

实际写入语义仍偏向用户陈述和规则候选。配置 `MEMORY_EXTRACTOR=llm` 会构造 LlmMemoryExtractor，却不自动恢复已关闭的 reasoner 语义提取；Mem0 写入的 `infer=false` 不让 sidecar 接手该职责；Dream 复用规则 ingestion。向量检索只能找到已经形成的条目。增加写入重试、证明来源、提高物化完整性，不会补出规则不认识的研究纠正、共同活动与失败原因。

这是旧发现，本轮没有重复跑提取器计数。生产代码没有变化，复核 [extractor 装配](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/context.ts#L409)、[Dream 提取](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/memory/src/dream-consolidation.ts#L595)及 Mem0 投递路径后保留该判断。不能据此取消来源审查；正确方向是测试合法来源下哪些语义被遗漏。

### 2. 人物证据、人物身份、关系理解尚未形成完整链

Person 资料用于明确身份和运行 scope。context-use 中的 `PERSON / SELECTED` 原因明确写着“Runtime scope selection”，不表示姓名、notes 或关系资料已经进入模型。Profile 的 COMPLETE 指证据集合/物化状态，不是理解；`narrative=null`，冲突语义是 `NOT_ASSESSED`。再加上 F1 的 reader 无消费者和 P8 无含义生产方，这解释了为什么维护很多人物证据仍不能自动改善熟悉感与合作理解。

不能把未知关系强行标成 KNOWN。反事实应是“让相关原文和可质疑的解释进入模型”，而不是伪造一份确定的人物档案。模型仍能从已召回原文自己推断；现有系统缺的是某条被宣称的结构化产品能力，不是取消了 LLM 的全部社会推理。

### 3. 有工具执行治理，尚没有完整日常工具产品

默认 [启动入口](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/index.ts#L29)不提供插件 discovery/grants；HTTP/SSE 和现有日常 UI 不提供 read-text 的宿主授权路径。`executeProductionCognition` 在无 path、无宿主插件时给出空可执行目录。自然语言“帮我读这个文件”不能创建授权，也不应该创建授权；缺的是明确的产品准入连接。

因此下一笔工具投入应是让已许可的一项操作正常可达，测完整结果循环，而不是继续增加 Capability 类型、协议层或没有宿主的测试注册表。此项旧审计已有，本轮新增正向执行证据说明：补上连接后，已有推理循环确实能消费观察。

### 4. 自动主动文字不等于连续工作

主动评分衡量“最近有未闭合的对话、现在是否有一个值得补充的点”；输出是短文字。没有进入正式 Cognition/Capability 任务循环，也没有跨重启的工程计划执行。持久 quiet/consent 是真实延续状态，不能因缺少任务自主性否定它；但也不能把 timer + score + prose 宣称为长期工作能力。F2 又揭示了它在不同会话上的额外错位。

## E. 横向能力与纵向入口：哪些限制是共享的

### 语言、纠正、历史

main 当前消息保留，近期历史、L1、L2 和事实召回可以共同帮助理解。但是多个投影有各自字符预算；较大模型窗口不自动取消 working-token 上限。历史角色被转成背景文本，也不等于直接多轮消息。纠正可能只存在近期历史，未进入规则长期候选；controller P8 修正是另一路显式治理入口，不能与普通自然语言纠正混同。F4 则展示程序会给仍然保留的原句附加错误解释。

本轮不重跑已有截断实验。最重要的下一步是检查**一项反证能否在后续请求中保持正确归属、时序和否定**，不能只统计保存行数或 UNKNOWN 标记。

### 认知、模型与行动

普通回应通常是 gate + 正文两次 Chat。一次升级通常是初 gate + 若干 Reasoning + 再 gate + 正文；Vision、fallback、TTS 另计。多次调用不自动有害，但它们不是免费的，也不自动等价于累积推理。当前 CONTINUE 无语义载荷、固定预算与 `length` 完成拒绝已被上轮证明，仍适用于未变化的 main。

[ChatInput](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/providers/src/types/chat.ts#L9)是 TextMessage，没有原生工具定义/结果角色；`tool_call` 明确保留但不支持。这是可表达能力的上限，不能推断所有当前模型都被隐藏了某项必需能力。温度配置“完全未消费”的猜测被本轮排除：路由 adapter 使用 `input.temperature ?? options.temperature`，正文未统一覆盖配置值。NATS 则在 context 明确拒绝，不能写成“启用后悄悄仍用内存”。

### 多模态与后续经历

转写、图片证据和屏幕观察提供真实额外信息；声音身份治理也有效。但语音中的不同说话者不等于一个全局 speaker，视觉摘要不等于可再次观察的原图。要分别问：当前模型能看见什么，下一轮还能看见什么，模型能否请求进一步观察，以及这些观察能否形成适当的长期经验。F3/F5 证明其中部分连接很窄。

### 不同入口的实际差异

| 入口/版本                         | 可确认的真实接线                                                                                                                               | 相对于共享后端的额外限制                                                                                   | 不能据此声称                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| main 桌面 Main                    | Tauri 管理服务与窗口；文字、图片、语音观察 ID、记忆开关、主动订阅、播放/字幕/呈现                                                              | 自动 scheduler 固定 default；切换 session 不自动跟随；屏幕捕获受宿主平台限制                               | 默认 Main 已坏掉：它默认就是 default；也不能声称全平台屏幕观察      |
| main Dashboard / 普通浏览器 WebUI | 文字与诊断/管理；同 Runtime 和模型路由                                                                                                         | 不同 session/设备/凭据；管理面展示状态不等于开启语义消费者                                                 | Dashboard 能力等于完整桌面媒体/设备能力                             |
| main HTTP/SSE                     | receipt → conversation → Runtime；SSE 正式 Character 流；特定 schema 支持附件/已提交语音 ID                                                    | 没有一般 read-text 授权字段；不同接口的媒体 schema 不同                                                    | HTTP 能任意调用所有后端组件                                         |
| main WS / event bus               | 已有消息和运行事件；与专用媒体/播放反馈配合                                                                                                    | 不能把其他 transport 的附件/authority 直接挪来；需要其自己的准入                                           | 某路由成功就证明所有 Channel 有同样权限/语义                        |
| Plunge 分支 QQ                    | 独立 Alice composition + Plunge config → composePlunge → surfacePlugins → QQ transport / scene / participation / Runtime / outward publication | 该版本修改 Core/Character；QQ 的媒体 codec、历史投影、分类/排队有独立损失；main 媒体设施不自动成为 QQ 能力 | 已确认正在运行的 Alice SHA；QQ 插件已在 main；QQ 与 main 完全同路径 |
| 历史 release、开发脚本            | 发布/运维/开发入口真实存在                                                                                                                     | 比 main 更早；AgentBus 为工程人员工作流                                                                    | 这些分支相加就是当前个体的生产能力                                  |

QQ 装配定位在该分支的 [index](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/index.ts#L40)和 [composePlunge](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/plunge/qq-composition.ts#L40)。账号、peer/group allowlist、Person binding、发布许可和 UNKNOWN 处理是有价值资产。前轮 QQ 八项发现保留为入口专项证据，本轮未重复执行。确认 Alice 需发布物 `build.json.commit`、私有配置和一次真实请求轨迹。

新 main 探针只导入 main，不能证明修改后的 QQ Core 在 F2/F3/F4 的每个细节也完全相同。入口专项结果与共享能力判断分别陈述。

## F. 全系统的新发现与重大综合判断

### F1. 关系体系缺含义生产方，人物读接口没有产品消费者

**因果链：** Runtime 取得 Memory 证据 → P8 重建 → 固定 `relationship.current` 候选仅有 domain，没有 meaning/evidenceLinks → adapter 只接受给定含义，不生成含义 → 有证据仍 UNKNOWN、无 summary → Character 没有得到由该链产生的关系理解。

确切生产位置：[候选构造](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L1173)、[解释状态](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/p8/src/evidence.ts#L303)、[关系投影](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/character-abi/src/p8-projection.ts#L126)。探针给出一条合作事实，生产形状候选得到 UNKNOWN、无 meaning；人为补充带证据的解释得到 PARTIAL 和 summary 所需的 meaning。**解释是探针供给的，不是现有系统自己生成，也没有冒充为 KNOWN。**

另一端，[ScopePeopleModelReader](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/memory/src/profile-lifecycle.ts#L752)只被 context 构造并挂在对象上，未发现生产调用；`readPersonModel()` 固定返回 `BINDING_AUTHORITY_UNAVAILABLE`。Runtime 则明确记录 [Profile NOT_USED](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L1218)。源码搜索和装配追踪也没有证实初图假定的普通管理读方。

**影响与反事实：** 新增一批 Profile 状态/完整性测试不能让 Alice 更了解人。先让已授权、相关的事实或可修正解释有消费者，会增加可用关系信息；直接删除空关系占位只减少提示，并不会创造关系理解。保留来源、修正、身份隔离。不能把 Person ID 解析成功当成人物理解，也不应因为无自动关系产物删除身份机制。S/P 高；实际熟悉感提升待 M。

### F2. 主动 scheduler 与当前交流会话没有自动关联

**因果链：** context 启动/重载调用 `startProactiveScheduler({sessionId:"default"})` → 用户在 work/dashboard 等会话交流 → 普通轮正确恢复该会话 → schedulerSessionId 不随之更新 → 自动时钟仍读取 default → 默认历史决定是否说话，发表也属于默认会话 → 当前 UI 只订阅当前 session 时可能看不到这次回应。

位置：[启动目标](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/context.ts#L723)、[scheduler 所有权](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L603)、[实际执行](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L1747)、[当前会话订阅](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/web/src/main-page.tsx#L456)。

探针先保留两个带不同标记的会话，用户继续 work；正式普通 Character 看见 work 历史，真实 scheduled executor 的评分请求却只看见 default 标记。用注入时钟推进并直接 await 已注册时钟对应的真实执行函数，避免 timer 的异步竞态；未进行真实发表，评分记录器返回零。

**反事实：** 给自动任务一个符合明确会话选择的目标，评分将获得当前对话的上下文，发表也有机会到正确订阅者。不能在多人场景粗暴“最近说话者夺取全局目标”；必须保留 consent、scope、安静、播放/当前轮硬门。默认 Main 使用 default 时没有这个错位，显式 proactive 请求也能指定 session。S/P 高；自然度和合适时机待 M。即使修正会话，它仍是短主动文字，不是后台任务 Agent。

### F3. 语音身份工程保留了证据，语言理解却失去逐段现场

**因果链：** STTOutput 有 segment text/cluster/time/confidence → committed transcript 保留部分 segment 字段，但漏掉逐段 confidence → scopeVoiceTurn 计算全局 speaker/归属 → canonical 当前输入使用合并文本及全局 speaker → Chat 不知道两段反对意见分别来自哪一个匿名说话者、哪一段不确定。

位置：[STT 数据](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/providers/src/types/stt.ts#L31)、[转写提交](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L1528)、[全局身份判断](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L862)、[当前模型输入](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L4430)。

探针两段分别说“支持甲”“反对甲”，cluster-A/B、置信度 0.97/0.31。经过真实 reserve → receipt fixture → finalize → commit → Runtime → 正式 Character，两段仍在 transcript event，置信度不在 segment，两个 cluster 标记也不在 provider 请求。合并文本到达请求。该探针没有测试 STT 准确度或真实绑定；没有把匿名 cluster 当 Person 身份。

**反事实：** 保留有限逐段转写和匿名说话者区别，模型将得到“不同人意见相反”而非同一用户自我矛盾的现场证据；保留可信的置信度信息可给澄清决策机会。是否改善判断需要 M。正确的声学隐私/未知归属逻辑必须保留。输入分段的理解问题，与先前已经修复的 TTS 输出分段/迟到反馈是两件事，不能混为一谈。

### F4. 开放语言被错误的情绪提示提前解释

[CurrentAffect](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/memory/src/affect.ts#L26)匹配“担心/worried”等子串，并赋予 0.82 的固定 confidence 和行为提示。没有处理否定、引用、翻译任务或讨论他人的情绪。

输入“我不担心这个问题。请给出完整推导。”后，真实 Runtime/Character 的模型请求保留原句，也包含 `User appears anxious. Keep the response steady, bounded, and actionable.`。P 证明错误解释进入正式请求；**没有证明模型一定服从提示、缩短推导或质量下降。** 这是与事实存储无关、覆盖普通对话的共享语义干扰。

**最小反事实：** 去掉这条规则生成的提示，同模型仍拥有完整原句，可以自己解释用户状态。成本低、边界风险低，适合直接做同模型比较。不要为了保留这个规则再扩建情绪分类体系；也不要把本发现上升为未来持续内部状态理论的否定。

### F5. 视觉观察能力受两种独立限制，配置健康不能证明可达

其一，实际 [screenCaptureAvailable](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/apps/server/src/screen-capture.ts#L11)只接受 Linux/KDE Wayland/Spectacle。配置一个健康 Vision provider 并不会给其他平台创造屏幕适配器。附件观察仍可存在，所以不能说“这些平台完全没有视觉”。

其二，[Runtime](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L4456)只允许一个 visual grounding cycle；附件证据已经占用，或请求发现屏幕不可用，都先消耗 visualUsed。随后没有观察—澄清—再观察循环，Cognition 的默认目录也不含屏幕观察能力。

**影响：** 小字、遮挡、变化后的屏幕和需要核对另一处的任务，可能在第一份证据不够时无法获得第二份；模型再强也不能观察它未收到的现实。反事实是给已授权、受取消与预算约束的任务继续观察机会；不是无限截图，也不是删除临时图像的隐私边界。S 高；本轮未用模型或桌面验证改善，不能称持续屏幕理解已实现。旧报告提到有界视觉，本轮新增具体平台装配与机会消耗原因。

### F6. Dream 的持久工作状态没有独立生产推进时钟

[consider](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/memory/src/dream-consolidation.ts#L250)要求传入 idleMs 才能触发 idle；当前实际 [调用](https://github.com/Ruichen-0079/YUVI/blob/b307704a0c798fe092966766ad4422a9aaa31262/packages/core/src/runtime-orchestrator.ts#L6196)没有该参数。`consider/runDue` 只在回合后的 recent episode persistence 调用，未发现 server 独立 Dream worker。pending、租约、reconcile 状态持久化，不表示用户离线时自动推进。重启启动的 Profile/ingestion workers 不负责执行 Dream。

探针真实 assembler/engine/store：相同近期 episode，仅推进 now 不触发；明确提供 31 分钟 idle 才触发；已入队任务在没有 executor 时隔一天仍 pending。最后一项只是解释“时钟不会自行执行对象”，不是用 fixture 证明生产停机；生产缺少执行方由源码装配证据支持。legacy 默认 getMemoryProvider 没有正式 Mem0 provider，且 main 未提供 dreamWriter，另有写入权威条件；不能把所有 backend 的 Dream 说成同样可用。

**反事实：** 若决定保留 Dream，应给已经存在的合法作业明确执行时机，让待处理工作不依赖下一次用户回合；但这只提高作业完成机会，规则派生不会因此突然学会理解经历。idle 没有新增语义收益时，可以删除该产品承诺和无消费者触发，而不强行给 timer 更多内容。幂等投递与未知写入处理应保留。此前确认了规则 Dream，本轮补出运行时钟与 writer 可达性的限制。

### F7. 执行回路与学习回路使用不同的“结果”

这是跨系统综合判断，前轮已经提出“来源/执行强于语义”，不作为完全新发现。工具观察能进入本轮 Reasoning；read-text effect 的内容是 transientResult，效果证据证明本地读取返回，不保存一个供未来普遍学习的读入文本。下一轮长期候选主要来自用户断言；Dream 也是用户陈述规则；L1 的 outcome 可以是最后一句助手表达。Publication APPLIED 又只代表各契约定义的交付层。

因此“实际完成过一次查证”与“以后懂得如何查证、保留纠正后的认识”不是同一条闭环。现有系统并非完全不保存行动痕迹；缺的是把适当外部结果、用户反馈和结论修正转成可消费经验的一般生产连接。也不是读过每个文件都应永久记住：需保持引用来源、披露许可、时效和不把助手臆测升为事实。

**反事实：** 对一项有确认结果的实际活动，选择性保留可回源观察与被支持的结论，下次同题模型将得到过去正确/错误依据，而非只看自己的旧回答。它是否使模型避免重复错误必须做纵向 M。先测一类实际任务，不需要发明新的宏观架构或给所有 effect 加心理模块。

### 本轮信息增量与旧结论的边界

| 主题                                                               | 既有研究           | 本轮增量/处理                                              |
| ------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------- |
| Context 预算、规则 Memory、Profile A4 未消费、Character 双调用     | 已明确             | 当前源码复核；不重跑等价实验，不算新增                     |
| QQ 历史/分类/codec/排队、误删、CONTINUE、length、沉默/视觉跳过记忆 | 上轮八项已有       | 保留严重性；不同分支独立引用                               |
| 关系自动语义未形成                                                 | 架构报告有方向判断 | 精确定位固定空候选、UNKNOWN 投影和 reader 无消费者；新增 P |
| 人物资料被“消费”                                                   | 过去描述较宽       | 区分 scope/校验消费与模型语义消费；修正本轮冻结地图初查    |
| 主动能力只是短文字                                                 | 已有判断           | 新增 default 与当前 session 错位的实际请求对照             |
| 语音/视觉有真实入口但有界                                          | 已有地图           | 新增输入语音逐段损失 P；平台/单次观察消耗 S                |
| Dream 是规则整合                                                   | 已有判断           | 新增缺 idle 参数和独立生产推进方的因果链                   |
| CurrentAffect 规则                                                 | 代码已存在         | 新增否定误判进入正式 gate/body 的 P                        |
| 工具完全无效                                                       | 不接受这种泛化     | 正向 P 证明授权观察进入下一轮 Reasoning                    |

后期对照了[前轮生产审计](../production-intelligence-loss/YUVI-Production-Intelligence-Loss-Audit.zh.md)、[独立源码发现记录](../next-generation-architecture/evidence/pre-audit-source-findings.md)与相关架构报告。`docs/yuvi-v0.1.2-source-audit.md` 的输出语音修复记录也没有当成当前输入语音缺陷。未取得更多不可确认的私有报告或生产轨迹，不猜测其结论。

## G. 价值取舍：保留、重新连接、简化与停止

| 决策                                                              | 对应价值                                   | 边界与代价                                                              |
| ----------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| 保留个体/人物隔离、Journal 来源、隐私 scope                       | 防串历史、伪来源和未同意披露               | 不把所有证据检查当作语义理解；减少重复投影不能跳过权威                  |
| 保留真实会话、检索、媒体、路由、取消、Publication 与 UNKNOWN      | 提供额外信息及可靠执行                     | 不盲重试不明发表；正文流/设备世代不能因“简化”失真                       |
| 重新连接已有工具的宿主授权和能力目录                              | 把 executor 兑现为可用操作                 | 不让自然语言创造权限；先证明一项授权任务完整闭环                        |
| 重新连接有限相关人物/关系证据、反馈与结果                         | 让已有长期资料进入未来理解                 | 不 raw dump 全量 Memory；不把推断改成事实；先验证输入与纵向收益         |
| 修正自动主动目标、语音逐段投影、实际屏幕可用性                    | 恢复现场和明确能力机会                     | 各入口独立处理；保持匿名声学身份与 consent                              |
| 删除/关闭错误的词匹配情绪提示                                     | 减少程序错误预解释                         | 原句保留，实际模型对照成本低；不能宣称所有情绪辅助皆无效                |
| 停止维护“已启用 LLM 提取”的名义兼容能力                           | 减少配置与实际行为不一致                   | 明确规则状态；是否恢复语义提取以真实纠正用例评估                        |
| 对无消费者 Profile/People reader 暂停继续扩建                     | 停止只增加物化协议的投入                   | 来源/删除失效等资产保留；后台物化是否改为按需需先确认依赖，不一刀切删除 |
| 对空关系占位、重复背景压缩/重序列化做删减对照                     | 消除没有信息增量的中间内容                 | 合法来源和未知状态必须仍可表达；减少层数未必改善模型                    |
| 双 gate、升级后的重生成、CONTINUE 协议、正文完成悬崖优先实验/修整 | 恢复推理进展和可保留答案                   | 不能直接把任意控制文本展示用户；取消、过滤、长度和断线分别处理          |
| Dream 只维护能兑现的触发/投递                                     | 保留有价值异步工作，去掉虚假的离线整合预期 | 没有新语义就不扩建触发器；仍需幂等、冻结来源、reconcile                 |

**值得停止的主要是没有产出消费者的继续扩建、误导性兼容配置和重复语义控制，不是底层可靠执行。** 目前没有足够证据宣布整个 Character 或 Dream 都该删除；应允许用同模型直接路径推翻它们的必要性，而不是用既有测试规模为其辩护。

## H. 最小反事实与验证：已经知道什么，还缺什么

### 已完成的七组确定性探针

脚本与原始请求见 [experiments](experiments/README.md)。它们 bundle 当前 main 生产源，显式启用正式 Character；不导入 QQ 分支。

| 探针                     | 已证明                                                                 | 没有证明                                    |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| Mem0 事实正向对照        | 搜索结果进入实际 gate/body                                             | 真实 sidecar 写入、记忆准确或质量提升       |
| 授权 Capability 正向对照 | 两轮 Reasoning、一项调用，观察只在下一轮出现                           | 实际文件/PG effect 执行、工具使答案更好     |
| P8 关系候选              | 有事实证据但空候选无 meaning；显式解释可供投影                         | 自动关系学习；供给的解释是真实世界事实      |
| 主动 session             | work 普通历史可见，自动评分仍使用 default                              | 实际发表位置、用户是否喜欢该回应            |
| 语音分段                 | segment confidence 丢失、cluster 不进入正式 Chat                       | 实际麦克风/STT 准确度、绑定正确性或多人质量 |
| 否定 affect              | 错误“焦虑”提示进入正式请求且原句保留                                   | 模型服从它或质量确实下降                    |
| Dream idle               | 生产调用形状不触发 idle；显式 elapsed 参数触发；无 executor 不自动执行 | 生产数据库恢复或长期整合效果                |

对 Dream 缺独立 worker、Profile 缺读方和平台装配的结论主要是 S；探针不冒充端到端部署。详细搜索索引见[生产消费者记录](evidence/production-consumer-search.json)。旧实证按[源码一致性记录](evidence/production-source-comparison.json)复用，避免反复证明同一机制。

### 最少还需要四类真实模型对照

统一锁定模型版本、人格、权限、采样、输出语言和任务；同一条轨迹同时保存所有模型请求/结果、fallback、能力观察、发布状态、总调用/输入输出 token、费用与首字/总延迟。人格不是用不同 Prompt 随意改变。多模型路径的质量与延迟必须算全部调用；不能只比较最后正文，也不要求读取隐藏思维链。

1. **日常理解与表达责任分离。** 相同输入/忠实授权历史的直接单模型路径；当前完整路径；保留 YUVI 检索/时间但去掉 affect 等预解释、减少重复压缩的路径。用指代、否定、代码约束和纠正轨迹；再单独比较 gate/body 与升级后的重表达。三条路径如果知识量不同，分别报告信息差异，不把它全算成模型能力差异。
2. **经历收益和遗忘责任分离。** 同一纠正/失败轨迹跨会话、重启后提问，比较当前写入与召回、只补充授权漏失证据的输入、直接忠实历史。逐项定位未写入、未召回、召回未消费、消费后模型不接受，而非只有终点完成率。加入过时和反证，避免“记得更多但更错误”。
3. **行动可达性与规划能力分离。** 同一基础模型、同一合法单文件工具，比较默认空目录、现有授权目录、原生工具接口或减少控制中间层的反事实。记录真实读取、错误恢复、观察消费、答案保留和一次后续复用。仅授权路径就明显改善则先接线；目录已充分而仍规划差才主要归因模型。
4. **现场消费和主动选择。** 逐段语音与合并文本、同一截图摘要与可继续观察、default 与明确当前会话的主动输入成对比较。评价“谁说了什么”、澄清、进一步观察、无用打扰、合理沉默和未来引用；提供机会但不强迫多观察/多说话。真正无事时 NO_OP 可能是正确表现。

这些实验可以改变本报告的排序：若完整上下文与能力都相同，当前 Character 明显优于直接模型，就保留它；若新关系解释造成更严重误认，就优先给原文而非解释；若规则漏写很少、主要错误发生在已充分输入后的推理，则提高模型本身的责任。没有预设消融必胜。

## I. 有限资源下的优先判断

| 次序 | 优先决策                                                                          | 体验覆盖与证据                                 | 成本、风险和应有验收                                                               |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | 恢复忠实日常输入、纠正和可保留输出；先移除错误 affect，处理已证实误删/length 悬崖 | 全对话/长期状态；S/P 强；质量收益待 M          | affect 低成本低风险；历史/输出/删除跨组件风险更高，必须保持取消/授权与发表真实状态 |
| 2    | 把一项现有授权工具接成正常产品能力                                                | 工程任务能力能否存在的前提；S/P 强             | 适中成本；权限与来源回归；验收目录、实际调用、结果及用户答案，不只 executor        |
| 3    | 让关键经历/纠正与外部结果有未来消费者；暂停无消费者 Profile 的继续扩建            | 跨会话认识与关系；缺口 S 强，方案效果未定      | 中等至较高语义/隐私风险；先选择一个已完成活动的纵向对照，保留失效与回源            |
| 4    | 修正会话目标、逐段语音和真实视觉可用性                                            | 影响特定入口，不应抢占全部文本优化资源；S/P 强 | session 选择需考虑多人；模态连接成本不一；明确平台与观察权限，分别验收             |
| 5    | 用真实同模型结果决定双 gate、重表达、CONTINUE 与冗余压缩的去留                    | 覆盖普通/复杂回答；机制 S/P，质量归因缺 M      | 实验成本相对低，贸然重构风险高；保留正确边界，仅移除无净增益环节                   |
| 6    | 决定 Dream 是否值得独立推进；不再仅扩大规则整合与物化规模                         | 长期后台价值；调度缺口 S 强、语义增益弱证据    | 接 timer 不能当作获得学习；需要先测输出独特信息，再投入运行整合                    |

排序兼顾当前止损与智能收益。某入口的严重丢历史当然应优先修该入口，但不能据此把全后端下一阶段变成 QQ 专项。没有把更换模型或新增宏观架构作为第一步；也没有证明当前基础模型足够完成所有期望任务。

### 最终三个问题

**一：只保留真正有价值的现有代码，一个自然交流、能记忆、认知和行动的 Alice 需要什么？**

需要正确实例/人物归属，忠实的当前输入与有限相关历史，能够写入和检索真实证据的长期存储，实际媒体观察，可靠模型路由和流式交互，一条有权限、能反馈观察的推理/工具循环，以及正确发表、取消、未知结果与恢复。还需要让相关长期信息真正进入下一次理解。无需默认保留所有空语义占位、重复压缩、无消费者 reader 或名义 LLM 提取选项；双阶段表达是否必要由实测决定。

**二：哪些代码符合既有设计却没有创造相应智能价值，甚至限制模型？**

规则情绪提示按契约工作，却误解否定；P8 adapter 正确拒绝把证据自动升级为理解，却没有含义生产方；Profile 正确物化但没有产品读方；Dream 正确维护作业，但生产没有 idle 输入/独立时钟；单次视觉正确限额却限制继续观察；默认插件和文件授权治理正确，却缺产品入口。另有已证实的历史投影、CONTINUE、长度拒绝和表达重生成风险。问题往往是局部合同正确、整体能力链没有兑现，不能靠增加同类局部测试解决。

**三：最值得继续投资、停止维护、重新连接的分别是什么？**

继续投资真实信息/观察、记忆与来源、可靠工具反馈、流式取消/发表及部署恢复；停止扩建没有消费者的语义物化与误导性兼容能力，删除已证实错误的预解释，并让冗余控制接受消融；重新连接工具授权、相关人物/纠正证据、行动结果、模态现场及主动会话。保留可靠性资产，让它们承载真实能力，而不是继续把它们本身当成智能成果。

**当前表现不足的有证据优先解释是：①可用输入和能力被缩窄；②已有产物缺消费者或正确运行机会；③程序预解释、协议与输出接受造成干扰；④多阶段模型之间可能相互削弱；⑤基础模型自身不足。** 前三项有 S/P，第四项部分机制确定但净质量缺 M，第五项尚无受控证据可排序成实际贡献比例。真实 Alice 的部署错误/配置责任也没有 D，不能排除。这个排序是先排查可证原因的顺序，不是对所有用户失败的统计归因。

YUVI 并非没有创造智能价值。它已经能获得直接文本模型没有的信息与现实观察，已有受治理推理/工具循环，并拥有值得保留的可靠执行底座。**它尚未表现出相应智能水平的关键，在于工程成果常终止于存储、证明和局部控制，没有持续抵达模型理解、下一次选择与用户可用操作；另一些抵达时又被压缩、预判或拒绝。** 下一轮的成功应以这些已存在的能力是否真正被使用来衡量。
