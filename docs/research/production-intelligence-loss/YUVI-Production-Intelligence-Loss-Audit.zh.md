# YUVI 生产智能损失与后端能力可达性审计

**当前最有证据的解释是：基础模型经由 YUVI 后，拿到的历史、可执行能力和可保留输出都比直接运行时更窄。部分程序还先于模型解释自然语言、执行副作用，或把控制失败变成正常沉默。** 后端的存储、接口和执行协议已经相当丰富，但丰富程度不能直接转化为模型可见信息与用户可用能力。

这不是对基础模型水平的实测结论。本轮没有获得可用的模型凭据和实际 Alice 部署配置，不能证明某个模型在这些提示下会降低多少质量，也不能把远端 QQ 分支视为正在运行的版本。不过，已经用真实生产函数证明了几处与模型水平无关的损失：相同 Cognition 输入被重复发送；否定形式的记住请求会删除记忆；有效正文因长度结束而整体失败；QQ 历史投影舍弃持久化对话；分类协议失败被包装成正常沉默。

**下一步最值得做的不是再扩展后端概念，而是恢复已有信息和能力的可达性，并用同模型对照确定控制、输入和表达重生成各承担多少责任。** 其中删除误判需要先止损，历史恢复最可能改善日常体验，工具授权入口决定工程能力能否存在于产品中。

## 1. 基线、范围与证据

审计日期：2026-10-09；交付前远端复核时间：13:01 UTC。

| 对象                              | 锁定版本                                   | 本轮地位                                             |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| 远端 `main`                       | `b5abb06c9dcdd846fa20152c401eff88aac57205` | 主生产基线；取得后只读调查                           |
| 生产源码最近基线                  | `46a24878536d537021c49d50c5ce004d93489628` | 至上述 main 的变化是研究文档，不能把新文档当作新能力 |
| 远端 `feat/plunge-webui-20261008` | `adff0c70648b42a3a15ea45609adae1c45b31fc5` | 单独调查的 Alice/QQ 装配；不是 main，也未确认部署    |

main 没有 QQ/Plunge 实现或实际 Alice 私有配置。QQ 分支的共同祖先是上述生产源码基线，但它修改了 Character、上下文投影和 Core，不能把两个版本的局部路径拼成一个“生产 Alice”。发布包的 [`build.json.commit`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/scripts/plunge/package.mjs#L75) 可用于确认真实部署；本轮没有该发布物、私有 composition 或 Plunge 配置。

先检查入口、生产装配、模型请求和输出，再运行小型探针，最后对照旧调查。本轮没有重新阅读 Future 理论体系，没有修改生产实现、设计 API 或制定版本计划。

证据标记如下：

- **S：源码事实。** 实际装配与函数控制流支持。
- **P：执行事实。** 调用真实源码，替换外部模型/存储依赖，证明输入、调用、删除、输出接受与控制路径。
- **M：真实模型质量证据。** 本轮未取得。文中的体验改善均为待验证假说。
- **D：实际部署证据。** 未取得私有配置和生产轨迹。默认、可配置与分支装配分别描述。

探针和原始结果保存在 [experiments](experiments/README.md)。它们不模拟模型智力、不访问远端模型；A/B/C 的投影例子不是完整同模型实验。D 的部分路径通过真实 Runtime 执行，未覆盖实际网络、PostgreSQL、QQ 服务与发布环境。断言通过不等于端到端产品质量通过。

## 2. 真正进入模型与用户的执行链

### main：文本、会话与输出

```text
Main / Dashboard / HTTP / WS
  → 接收凭证与 Journal；确定 session 和身份
  → Conversation 保存用户消息
  → Runtime 恢复有限历史、L1、相关 Memory、Person/P8 与时间
  → canonical context / Character 预算与投影
  → Chat：JSON disposition gate
     ├─ SILENCE / TERMINATE → 成功无回复，跳过回复后的记忆写入
     ├─ RESPOND → Chat：自然语言正文原生流
     └─ NEED_COGNITION → Reasoning + 有界 Capability
          → Chat：结果 gate → Chat：自然语言正文流
  → 接受正文、Conversation / 事件 / Publication / 语音与呈现
  → 已完成轮的异步记忆准入、存储与派生状态
```

生产接线在 [`createRuntime`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/apps/server/src/context.ts#L507)，不是仅存在的接口。`NODE_ENV=test` 或 `PROVIDER_ALLOW_MOCKS=true` 会不装配 Character；这些路径的顺畅回复不能证明真实 gate 路径同样顺畅。本轮 Runtime 探针显式安装了生产 Character，且在 development、禁止 provider mocks 的环境中运行；外部依赖由探针明确注入。

| 阶段                   | 实际输入与输出                                               | 缩减或转换                                                                 | 恢复渠道                                                          |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Adapter / 接收         | 文本、身份、session；HTTP 单张图片可选；WS 自己的事件 schema | 非文本的语音先经 STT；不能假定 WS、HTTP 和 UI 有相同附件能力               | 原始接收记录或专用媒体路径；不会自动给 Chat 原始音频              |
| Journal / Conversation | 收到什么与当前会话行                                         | 保存不等于模型消费；失败/未发表回复有独立状态                              | 历史接口供人查看，未见通用“取回任意旧轮”的模型能力                |
| Runtime 历史恢复       | 默认最近 6 轮、6000 字符的 DirectContext，再加有界 L1/L2     | 历史摘录、脱敏、L1 规则摘要、召回筛选                                      | 后续检索可能补充，但不能承诺补回刚被裁掉的约束、代码和助手答案    |
| Context / People       | 绑定的个体语义、已解析 Person、Memory、时间                  | 多次字符预算与段落压缩；Profile 生命周期产物不直接进入 A4                  | 当前可见 Person/P8 与用户重述；配置大窗口不会自动取消工作预算上限 |
| Character 请求         | 当前输入 + 被投影的背景；通常两个文本 message                | 历史角色转成背景文本；先生成 disposition，后生成正文                       | 原始历史仍在库里，但本轮 gate/正文不会因此自动看到它              |
| Cognition              | 原请求、focus、规范化背景、当前能力目录                      | 自定义文本协议；没有模型原生 tool role / function calling；CONTINUE 无载荷 | REQUEST_CAPABILITY 的请求/观察会进入下一轮；普通 CONTINUE 不会    |
| 输出与写回             | 原生正文流、完成状态、Publication                            | 8000 字符上限；`length` 整体拒绝；升级答案由 Chat 再表达                   | 暂无自动补完；流式用户可能看过前缀，正常历史却未必保留            |

`/message` 和 `/v1/messages` 的非流式接口也走 Character 正文流，不是调用一次 `generateReply` 即可。普通 RESPOND 通常 **2 次 Chat**；升级通常 **初 gate + N 次 Reasoning + 后 gate + 正文 Chat**，即 N+3 次模型调用，不含视觉、重试、后台抽取。调用多本身不是质量缺陷，问题是每一步是否保留必要信息、是否产生额外贡献。

### QQ 分支：输入前后还有两组门

```text
OneBot → decodeQQPacket → allowed channel → 全局串行队列
  → QQSocialAdapter：短时 scene、引用句柄、mention/continuation/attention
  → HostCharacterSurfaces：接收 Journal；ambient 到此结束
  → admitted turn：Person 绑定、Conversation、Runtime
  → 当前轮语义授权分类器 → Character gate → 可选 Cognition → 正文
  → OutwardEffect → QQ send ACK / UNKNOWN → Publication 与 scene 更新
```

这条链由分支 [`index.ts`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/index.ts#L39) 的 `composePlunge → buildServer(surfacePlugins)` 接入；不是 main 的通用插件发现流程。收到 ambient 消息会有接收 Journal，但 [`HostCharacterSurfaces.receive`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/character-surface-host.ts#L171) 在创建普通 Runtime 用户轮之前返回 OBSERVED。它不意味着模型已阅读、形成 L1 或存入长期记忆。

QQ 身份来源与已发送 ACK 的区分做得正确。另一方面，scene 是短时进程内缓存；它替代普通会话历史的行为，与 main 显著不同，见 F1。

## 3. 已有能力到底能不能用

| 后端能力           | main 默认/实际入口                                                        | QQ 分支装配                                                                      | 判断                                                           |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 文本理解、正文流   | 非 mock 路径由 gate 放行；Main 与 Dashboard 使用 SSE                      | admission + 语义授权 + gate                                                      | 可达，受到多道语义控制；质量未测                               |
| 忠实多轮历史       | 有 Conversation，模型只见有界投影                                         | 模型舍弃 RECENT_CONVERSATION，依赖短 scene 和摘要                                | 存储可用，消费显著不足                                         |
| 长期记忆           | 配置默认 legacy、rule-based；Mem0 是明确可选模式                          | 只有已绑定到存在的 Person 才 read/write                                          | 有条件可达；昵称、同一个 QQ 号不自动等于正式 Person            |
| LLM Memory 抽取    | `MEMORY_EXTRACTOR=llm` 可以配置，实际 adapter 始终调用规则 fallback       | 共享该实现                                                                       | 名义启用，语义抽取不可达；不能归咎于用户没开开关               |
| 自然语言纠正       | 一般内容先进入当前历史；长期 supersede 的规则覆盖很窄                     | 再受历史遗漏和 Person 门影响                                                     | 当前理解可能修正，长期修正不能保证                             |
| 关系/P8 与 Profile | Person/P8 部分进入请求；ProfileProvider 被构造而未作为 A4 消费            | Person 需显式绑定；已有 Profile 也不因此自动成为理解                             | 部分可达；不能把 Profile COMPLETE 当作 Chat 已理解             |
| 更强推理           | 只有 NEED_COGNITION 升级；有界多轮                                        | SOCIAL 明确禁 Cognition；TASK/RESUME 仍要 gate                                   | 可达，但 CONTINUE 不积累普通进展                               |
| 读本地文本         | 唯一本地能力；需要先调用受保护授权路由，单路径单轮                        | 必须 Alice composition；该路由不注册                                             | 默认目录空；Alice 常规装配下授权入口断开，见 F2                |
| 通用工具/插件      | buildServer 可注入 discovery/grants；标准 index 不注入，默认 discovery=[] | QQ 是 surface plugin，不等于 Cognition 工具目录                                  | 不能称为已有通用工具 Agent；浏览、shell、任意 MCP 未见生产装配 |
| 附图理解           | Main 支持单图；Vision 分析后给 Chat 文本证据，非 Chat 原图                | 只携带第一张图；授权决定是否感知                                                 | 单图有条件可达；两图比较没有充分输入                           |
| 语音与呈现         | STT、声学身份处理、分段 TTS、播放反馈、字幕/动作有真实入口                | QQ codec 将不支持的媒体标为未知内容；非同一语音链                                | main 资产真实存在，不能算成 QQ 已有能力                        |
| 沉默/等待/主动     | 有 disposition、主动调度与 consent/quiet policy；正文和外部效果有边界     | ambient attention 只为收到消息创造机会；未找到 QQ 订阅主动流并选择收件目标的路径 | 响应式群参与可达；后台主动能力不能直接等同 QQ 主动发言         |

这里不建议为“可达”而解除权限。正确结论是：用户需有产品内的授权机会、可靠身份或显式支持的入口；模型应看见当前确实存在的能力。普通话语“读这个路径”现在不能自行授予文件权利。在 main 的本地控制端可以调用授权 HTTP；扫描前端没有发现该文件授权路由的消费入口。不存在一个神奇的“请用工具”口令能补回未装配的 registry。

## 4. 最高影响的新损失链

### F1. QQ 用短时现场替代持久历史，同时切断摘要中的助手内容

**范围：QQ 分支；S+P；日常体验影响高，实际部署待确认。**

[`renderCharacterModelContext`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/character-model-context.ts#L60) 对 surface 直接 `continue`，不渲染 RECENT_CONVERSATION。替代它的 [`QQSocialAdapter`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/plunge/qq-social.ts#L44) 只有最近 12 个 observation，超过 120 秒未触碰即丢弃整个频道，重连也清空；一次收发可能占两个 observation。

随后 [`renderSurfaceSituation`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/packages/core/src/surface-situation.ts#L68) 将每个旧消息缩成前 512 字符，并把旧现场控制在约 2700 字符预算。当前消息和当前引用保留较好，这是优点；旧代码、推导和关键尾部仍可能消失。更严重的是 [`L1 投影`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/packages/memory/src/memory-vnext.ts#L160) 明确 `includeAssistantContext:false`；`whatHappened` 只组装前四条用户摘录，不包含 outcome，不能补回助手刚给出的方案。

**因果链：** 用户让 Alice 修改上一份答案 → 上一份答案虽然在 Conversation，模型投影却舍弃 → scene 若已过期、重连或摘录掉尾部，L1 也不给助手内容 → 当前“继续/修改那里”缺少对象。再严格地约束当前轮不得制造旧任务，就更容易不继续、询问已讲过的事，或者凭空重建错误版本。这是多机制叠加，比“把 maxTurns 调大”更严重：调大被舍弃的 RECENT_CONVERSATION 没有作用。

探针确认普通投影包含历史独有 marker，而 surface 投影没有；旧 scene 的第 600 字符之后 marker 丢失；同频道 1 秒内还有 observation，121 秒后为零。这些探针分别验证组成条件，不假装完成了整个 QQ 部署重放。长期 Memory 仍可能偶然召回相同事实，当前引用句柄也可能恢复一段内容；均不是忠实对话的通用恢复通道。

**反事实：** 给模型带角色、时间、作者和发表状态的忠实历史，仍标为非当前指令，模型就能拿到之前的代码、自己的答案和撤回过程。优先改变“非授权历史必须消失”的投影选择，保留真实 scene 的身份与 ACK 区分。预计体验收益高，M 未验证。

### F2. 工具执行器存在，日常产品没有完整授权入口

**范围：main 与 QQ 分支；S；工程能力影响高。**

[`executeProductionCognition`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/apps/server/src/cognition-production.ts#L33) 仅在 `runtimeAuthorizedPath` 存在时注册并发现 `read_text_file`；其他能力来自显式注入的 plugin snapshot。标准 [`buildServer`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/apps/server/src/server.ts#L84) 默认 discovery=[]、grants=[]；标准 index 不提供替代注入。目录为空时模型并没有隐含的浏览器、shell 或任意文件工具。

全仓生产调用点中，`authorizeReadText` 唯一入口是 [`/capabilities/read-text/authorize`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/apps/server/src/routes/local-services.ts#L137)。但 [`server.ts:226`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/apps/server/src/server.ts#L226) 只在没有 characterComposition 时注册整组 local-service routes。QQ 分支仍保留该条件，而 Plunge 强制使用独立 Alice composition。其 WebUI 也未发现替代文件授权调用。因此在所审装配中，不只是“用户得知道特殊命令”，而是该能力的正式授权入口根本不挂载。

**因果链：** 用户给路径要求分析 → gate 可以认真升级 → Reasoning 看到空能力目录 → 无法获取文件，只能要求贴内容、给通用答案或表达不可用。接口/allowlist/效果持久化的工程投入没有抵达用户。本轮生产 Cognition 无路径探针也确认目录不含 read_text_file，但没有试图绕过授权。

**反事实：** 保留受保护的文件选择、范围授权、单轮限额和持久 effects，让已有授权入口在实际产品中可达，并让当前能力清晰进入模型目录。同模型将获得真实文件内容与执行机会。无需先造新工具框架。若实际部署使用自定义宿主注入，须以其 runtime inventory 纠正这里的默认结论。

### F3. “Don’t forget”被程序提前解释成删除，错误又被描述成没找到

**范围：Mem0 + writeMemory 开启的 main 路径；QQ 共享相关实现且还需 Person 绑定。S+P；破坏性高，出现频率未知。**

[`intent.ts`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/memory/src/intent.ts#L26) 将 `don't forget` 识别成 remember，同时 [`forget`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/memory/src/intent.ts#L67) 的 `\bforget\b` 也匹配它。Runtime 在 [`prepareChatPrompt`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/core/src/runtime-orchestrator.ts#L3715) 中、召回与模型判断之前，就按 forget 规则调用删除。

输入 `Don't forget that my project codename is Blue Heron.`，真实 MemoryService + 受控 backend + 真实 Runtime/Character 探针删除了已有 Blue Heron 记录。删除不是无条件删除所有搜索结果：`forgetMemoriesInScope` 有内容重叠筛选、scope 和最多五条限制；但这些限制无法修正“记住被当成删除”的方向错误。

[`MemoryService.forgetExplicitMemory`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/memory/src/service.ts#L943) 还把 backend 异常转换成 `deleted:0, notFound:true`。删除逐项失败也可回落为同样的 notFound。Runtime 因此给模型插入“没有匹配记忆”的情况说明，而非“操作失败”。探针确认 backend search 抛错时，该错误事实没有进入模型，请求背景反而断言 no matching memory。

**因果链：** 原始语义被关键词提前替换 → 真实记忆副作用发生 → 模型只能解释已被程序改变的世界；或操作失败被写成不存在 → 同模型也会基于错误背景回答。单纯更换基础模型不能阻止这个删除，因为它尚未被询问。

**反事实：** 首先移除仅凭 `forget` 子串执行破坏性动作的路径；保留可验证 scope/来源/显式删除意图与结果状态。区别 NOT_FOUND、FAILED 和部分成功。模型将获得未被误删的记忆与真实操作结果。无需读取或保存模型内部推理轨迹。

### F4. CONTINUE 是有预算的再次抽样，没有累积推理进展

**范围：main；QQ 共享循环和协议。S+P；认知成本与失败风险高。**

[`interaction-round.ts`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/cognition/src/interaction-round.ts#L105) 要求 `CONTINUE with no payload`。[`executeRuntimeCognitionInteraction`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/core/src/runtime-cognition-interaction.ts#L134) 对它只做 `continue`，history 仅在能力请求得到 observation 后追加。provider 调用之间也没有保留可用的本轮中间业务状态。

真实 `executeProductionCognition` 探针连续返回 CONTINUE、CONTINUE、COMPLETE，三次 ReasoningInput **深度完全相等**。稳定目录和背景下，第二次不是读取第一轮发现后的“接着推理”；默认四轮预算可被重复输入耗尽。随机采样有时能换到一个更好答案，但这必须叫有界重采样，不能把轮数当作连续思考能力。

**因果链：** 模型想继续 → 本轮只留下无载荷指令 → 下一轮仍解原题 → 再次 CONTINUE/耗尽 → 后续 Character 面对失败结果。加预算可能增加同题重试成本，并不自然改善推理累积。

**反事实：** 未提供可消费的进展前，删除这种 CONTINUE 选项比调大轮数更诚实；如确需多轮，先验证可保留的中间结论、未决问题、证据变化是否真实进入后续请求。不能以暴露供应商隐藏思维链作为必要条件。现有 REQUEST_CAPABILITY→observation 的反馈链可以保留，它确实改变后续输入。

### F5. 正文预算与严格完成协议形成“有效回答整体归零”的悬崖

**范围：main；QQ 仍有相同拒绝条件。S+P。**

[`modelContextBudget`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/memory/src/context-compression.ts#L168) 将输出最多限为 2048 token。随后 [`streamCharacterBody`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/core/src/runtime-orchestrator.ts#L7730) 在 `finishReason=length` 时拒绝整个完成；超过 8000 字符也失败。没有自动续写。即使非流式 HTTP，也必须具备 native stream；compatible/unsupported provider 不能仅靠有效 `generateReply` 使用此正文路径。

探针给出完全相同的有效正文与 delta，仅改变 stop/length：stop 返回答案且保存助手 completed 行；length 抛出 ProviderError、没有正式答案，非流式路径只留下用户行。流式入口可能已让用户看见前缀，再将助手行标为失败/中断；不能推断该入口一定“从未显示过文本”。

**因果链：** 长代码/研究回答超过人为预算 → 模型已完成的一部分被当成无效控制结果 → 当前请求失败、后续正常历史失去该贡献。相比直接模型的可见截断或继续机会，用户获得更少输出。这里的问题是长度耗尽的业务处理，不是要求伪造完整答案。

**反事实：** 将可见未完成正文诚实保留为部分结果，允许适当续写或明确请求缩短；按任务验证输出预算。保留严格 delta/完成文本一致性、取消与重复发送防护。不要把 content_filter 的处理一并机械放宽。长回答的真实改善需模型实验。

### F6. QQ 的控制协议失败被合成为成功沉默；压缩请求又约束后续理解

**范围：QQ 分支；S+P；频率与实际语义误判率未知。**

[`createServerCharacterPort.authorize`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/character-runtime.ts#L284) 用当前 ChatModel 再做一次当前轮授权分类。最多两次，400 token，严格 JSON、原文 evidence 子串、请求最多 300 字符；格式/证据不符、length 或 content_filter 会使 authority 无效。两次后不是显式分类失败，而是 `authority ?? {authorization:NONE}`，随后 `silenceDecision`。

真实 port 探针输入明确的私聊计算请求，离线模型两次给出无效分类 JSON，结果正常返回 SILENCE。它不证明真实模型经常给无效 JSON；它证明系统无法从正常沉默结果区分“理解后不回应”和“分类失败”。供应商抛错另有错误路径，不能声称所有异常都被吞掉。

[`character-turn-authority.ts`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/character-turn-authority.ts#L112) 还把短 `Authorized goal` 交给后续阶段，SOCIAL 禁感知和 Cognition，TASK 若 perception=false 也禁止感知。原始当前消息仍在请求，**不能说被 300 字符完全替换**；但短解释被赋予控制约束，若漏掉“比较两幅图/验证/继续修正”，后续模型看见全文也未必有相应机会。

**因果链：** 历史先缩减 → 分类器据不完整背景判断指代/续接 → 严格子串与短目标进一步过滤 → gate 再决定是否回应/推理 → 最终 silence 或不使用已有能力。忠实历史不足和语义门控错误会相互放大。

**反事实：** 保留失败为失败，不让它冒充意愿；保留完整当前条件对后续解释的影响；测量分类器对当前私聊、明确 mention、纠正、图像指代的漏放行率，再决定是否保留独立分类 pass。身份、渠道和外部副作用权限不应依赖放宽语义分类来授予。删除当前轮所有权限边界不是合理反事实。

### F7. 记忆形成依赖“有完成回复且未视觉落地”，使合理倾听变成长期遗漏

**范围：main；QQ 共享大部分写入条件。S；未做实际长期质量评测。**

[`executeUserMessage`](https://github.com/Ruichen-0079/YUVI/blob/b5abb06c9dcdd846fa20152c401eff88aac57205/packages/core/src/runtime-orchestrator.ts#L2301) 在 null reply 时提前返回，跳过普通轮结束后的 Memory 写入。`writeMemory=true` 也不改变它。用户说“项目已从 X 迁移到 Y，你先听着不用回”，合理 SILENCE 与长期记录分离失败：消息有 Conversation，但没有经过正常长期入库。这不等于原文完全消失，L0/L1 仍可能短时使用。

带图轮在处理开始就标记视觉 ephemeral，正文完成后仍以 `Visual grounding is ephemeral` 跳过长期写入；相关消息也被 L1 的 `memoryEligibleMessages` 排除。保护未经确认的图像解释进入事实记忆有价值；然而一条可信的文字“这是新目录，以后以 Y 为准”仅因同时附图，也失去正常长期准入机会。

**因果链：** 记住取决于回复成功/媒介类别 → 被要求倾听、输出 length 失败、同轮看图的文本事实被排除 → 以后像没听过。若改 gate 让系统更常沉默，却不改变准入条件，还可能扩大记忆遗漏。

**反事实：** 区分原始用户文字、未经验证视觉结论与助手生成；无需伪造回复也能判断可信原文是否值得准入。保留来源、Person、披露范围和视觉不确定性边界。改动会恢复记忆形成机会，不保证每句话应存或下次必召回。

### F8. QQ 输入在 Journal 前可被拒绝，全频道串行又放大多调用延迟

**范围：QQ 分支；S+P（codec），队列压力为 S。**

[`decodeQQPacket`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/plunge/qq-codec.ts#L90) 仅取第一张图片，后图变为 contents unavailable；文本合并后超过 4096 字符直接返回 undefined，超过 64 个 segment 也拒绝。探针确认两图请求只能携带 first.png，4097 字符消息不被接受。这不是同一模型“看不懂两图”，它没有两图输入。主桌面 HTTP 的单图限制也不应被称作多图能力。

[`QQTransport`](https://github.com/Ruichen-0079/YUVI/blob/adff0c70648b42a3a15ea45609adae1c45b31fc5/apps/server/src/plunge/qq-transport.ts#L218) 对所有频道使用同一个 promise chain，等待整轮处理和发送；queued≥16 就在接收 Journal 前返回。长 Cognition、分类重试、正文与 QQ ACK 等待会阻塞别的频道。INGRESS_FULL 有 trace，不能称完全无日志；但被丢消息没有进入正常 Journal/Conversation，后续模型无从恢复。codec 无效消息也不会在该位置告诉用户“请缩短”。

**反事实：** 在渠道顺序与效果去重不被破坏的前提下，审查跨频道全局阻塞是否必要；将拒绝输入变成可观察的接收失败；多图能力未实现时明确提示限制。若任务是比较两图，需真实保留两图或两份可验证证据，仅提示模型更认真没有作用。

## 5. 已知问题的简短复核与本轮增量

本轮完成入口、模型与输出调查后，才阅读仓库可访问的上一轮 [源码发现记录](../next-generation-architecture/evidence/pre-audit-source-findings.md) 和 `docs/yuvi-v0.1.2-source-audit.md`。后者主要是已修复语音反馈/分段问题，不能当作仍在 main 的未修复项。用户提到的另外两份独立“产品行为审计/架构前提研究”未定位到可确认的完整报告；不猜测其结论。本节也不声称此前所有讨论都从未提到本轮发现。

| 已知方向          | 本轮确认                                                           | 新增的系统因果                                                               |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Context 截断/预算 | 最近轮、L1 和 Character 有多次缩减；24K 工作上限且用字符保守计费   | QQ 不是再裁短一点，而是直接不消费 RECENT_CONVERSATION，同时 L1 删助手内容    |
| 规则 Memory       | LLM extractor 实际不调用 reasoner；不是 enabled=false 可解决的问题 | 删除方向在模型前误判；静默与视觉导致可信原文不进入正常长期准入               |
| Character 双调用  | 非 mock main 确实 gate + body                                      | QQ 还多一个授权分类；失败→NONE；短 goal 限制能力。不能用总调用数代替质量归因 |
| Cognition 预算    | 默认 4 reasoning / 2 capability / 60 秒；硬上限存在                | CONTINUE 相同输入重采样。问题首先是进展未保留，而非数值太小                  |
| Profile 消费      | 构造与 lifecycle 不等于 A4 消费                                    | 这是已有理解资产未消费的一部分，优先级不应自动高于忠实历史和工具入口         |
| 输出处理          | 原生流契约已存在                                                   | length 被整体拒绝、普通历史缺助手贡献；与短预算、记忆依赖完成回复叠加        |

最重要的增量是把损失串起来：**短历史导致指代理解缺料，授权门据缺料收窄目标，空工具目录令行动不可达，重采样耗尽认知预算，正文长度失败再阻断回复历史和记忆。** 每个阶段可能分别符合契约，组合却缩小了同模型能理解、能做和能留下的范围。

## 6. 哪些机制值得删除或简化，哪些边界要保留

| 判断                                                            | 原因                                                     | 需要保留的正确性                                   |
| --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| 删除 substring forget 直接决定破坏性操作的路径                  | 模型尚未理解就删；否定、引用、讨论词义都不是可靠意图     | scope、来源、明确操作意图、可验证结果和部分失败    |
| 删除无进展载荷的 CONTINUE，或明确按重采样评估                   | 下一轮没有新增可用状态；提高预算不能解决                 | 总预算、过期执行检查、能力观察反馈与取消           |
| 改变 surface 舍弃全部普通历史的规则                             | 历史作为非指令数据仍有认知价值；短 scene 不替代持久对话  | speaker、发表状态、时间、当前指令/历史证据区分     |
| 删除 FAILED→NONE / FAILED→NOT_FOUND 的成功映射                  | 失败被当作个体意愿或世界事实，诊断与模型都被误导         | fail-closed 外部执行；不给未授权操作开门           |
| 改变“只有成功有声回答才有正常记忆准入”的耦合                    | 认真倾听和可信文字不需要助手先回复                       | 不保存虚假助手经历；视觉推断与可信原文分开准入     |
| 对 gate + 重表达及 QQ 授权 pass 做合并/旁路对照，再决定去留     | 当前没有证据证明它们净增质量，也不能凭多调用就判定应全删 | 自然沉默、权限、可靠工具执行、规范化结果的真实状态 |
| 停止把 llm extractor 配置与 Profile COMPLETE 宣传成当前语义能力 | 现有装配未兑现这些含义                                   | 来源、纠正谱系、诊断和已有存储资产可继续保留       |

不建议删除 Journal、身份隔离、OutwardEffects、UNKNOWN send ACK、真实流取消或语音分段反馈。它们解决可验证问题；去掉后可能重复发送、误认身份或虚称发表。也不建议把原始音视频直接塞入每轮文本模型、取消所有预算，或让历史中的任意指令变成当前授权。

Provider 抽象确实只提供文本 Chat/Reasoning，自定义能力文本协议隐藏了原生 tool/function、结构化输出和多模态消息机会；`ReasoningInput.effort` 在所查 DeepSeek adapter 中也没有传到供应商请求。这是接口能力上限的 S 证据，**不是实际选定模型已支持却一定被关掉的 D 证据**。不复制供应商隐藏 reasoning_content 本身不构成智力损失；缺的是跨调用可消费的业务进展，而非必须获得隐藏思维链。

## 7. 最少需要做的真实模型对照

先确认运行包 commit、Chat/Reasoning 实际路由、memory backend、Person 绑定、context window 与当前 capability snapshot。不需要提交秘密。随后只做三组实验，避免继续堆等价截断测试。

统一 A/B/C/D：**A** 相同 Persona + 忠实带角色历史直接给基础模型；**B** 当前真正装配的 gate/正文输入；**C** 保持 B 的身份、权限和当前请求，只恢复被省略信息；**D** 完整实际入口到 Publication/历史写回。模型版本、采样参数、任务和权限固定。B/D 有多阶段调用时，分别保存每次实际输入和输出，不能把 B 伪装成单次调用。多调用组报告总推理费用；补做等总预算比较，避免只比较不同花费。

1. **指代、纠正与延时历史。** 一段合作中先给代码和约束，在中间/尾部加入撤回与修正；再请求“改刚才那版”，覆盖 1 秒、超过 120 秒、重连。A/B/C 盲评约束保留、错误版本、是否无谓追问。D 记录 scene、RECENT、L1、模型确实看见的段落及回复历史。先恢复忠实历史，再单独测 L1 助手内容，分清责任。预计信息保存差异明确，质量差异待测。
2. **推理与可执行机会。** 用固定授权文件包含不可猜的随机事实；确保各组享有相同真实 read 权利，不能让 A 使用 shell 而 B 没授权。比较直达模型能力、当前 gate 升级、C 的可达 inventory，以及 D 真正调用。另用需要多步验证的题比较一次充分预算、当前 CONTINUE、带真实新增证据的多轮。测升级漏放行、工具请求/执行、准确性与费用；不是只看 disposition 是否合法。先证明入口通了，再衡量原生工具协议是否更好。
3. **输出保全与安静记忆。** 同模型要求跨 2048 token 的代码/研究答案；分别看生成质量、length/8000 字符拒绝、Publication 与历史。另一场景提供值得记住的可信文字，分别要求不回复、附无关图片、正常回复，之后更换会话问回。记录准入/写入/召回/使用的每一步；避免将“模型没提到”误当“没有存”。加入真正错误更正，检验未来判断而非背诵原句。

少量自然请求还要统计 QQ 授权的正确 NONE、语义漏放行、协议无效、供应商错误，各自独立；这些分类可以附在第一/二组，不需第四套宏大基准。若 B 与 C 质量相同而 D 更差，应查门控、工具执行和输出；若 C 明显优于 B，输入责任成立；若 A/C 都差，再讨论基础模型或任务难度。任何方案仍需观测真实沉默是否合理，不能把“多回复”当唯一改善。

## 8. 按预期体验收益排序的少量决策

**立即止损：F3 的错误删除。** 它的覆盖率可能不高，但破坏性无需等待模型评测才承认。保持生产实现本轮只读，后续修改应另行执行。

| 顺序 | 决策                                                                       | 预期收益与不确定性                                               |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | 确认 Alice 部署 SHA；若为所审 QQ 路径，恢复忠实持久历史，保留角色/发表状态 | 直接影响每次跨轮合作、指代和纠正；范围最大；真实质量提升未测     |
| 2    | 让现有文件授权/能力目录在实际宿主与 UI 可达，诚实呈现空目录                | 从“会讨论”变为“能获取工程证据”；对工程请求收益极高，闲聊影响较小 |
| 3    | 区分控制失败与真实 NONE；停止无进展 CONTINUE                               | 减少假沉默、无效推理费用与诊断误导；频率需真实轨迹               |
| 4    | 保全可信未完成正文，解开沉默/视觉与可信原文准入的耦合                      | 避免长任务和合理倾听成为历史/记忆断点；需权衡呈现与准入质量      |
| 5    | 做同模型 A/B/C/D，再决定 gate/重表达/额外授权 pass 去留                    | 有机会减少所有对话的干扰与费用；目前不能宣称去掉必然更聪明       |

Profile 语义消费、扩大窗口、开放更多插件、调高 Cognition 预算不应排在这些生产断点之前。它们可能有价值，但当前瓶颈更基础；继续增加未被消费的后端功能不会抵消输入和控制损失。

## 9. 最终归因：当前表现差主要责任在哪里

**按现有证据排序，而非对未知部署按百分比分摊：**

1. **模型输入受损与历史不可恢复。** main 已有有界压缩；QQ 分支进一步舍弃普通历史、失去助手内容和短 scene。最有可能广泛降低日常对话理解，QQ 部署归属仍待确认。
2. **已有能力不可达。** 默认工具目录空；独立 Alice composition 的文件授权入口不挂载；LLM extractor 名义启用却仍规则；Person 未绑定不读写 Memory。对行动、长期记忆问题，这一项可能排第一。
3. **系统间相互干扰及输出过滤。** 无进展 CONTINUE 消耗预算，多个语义 gate 累积；长度失败再损害历史和记忆；沉默/视觉策略改变准入机会。部分已由 P 证明，净质量影响需 M。
4. **程序误解语义与掩盖失败。** 错删记忆是已证实的破坏性误解；分类失败→NONE、backend 失败→NOT_FOUND 也是已证实的误映射。覆盖率未知，不能因此排序为低风险。
5. **基础模型自身能力不足。** 当然可能存在，包括协议遵循、指代、推理和人格表达；本轮没有真实模型对照，尚无证据将它列为首因。也没有证明某个更大模型能抵消这些损失。

可确定的是，**同一个再强的模型也无法使用没进入请求的旧答案、调用空目录里的工具、阻止自己被调用前已经发生的错误删除，或让被后处理拒绝的正文成为成功回复。** 先打通这些已经付费建设的信息与执行通路，再研究模型本身的剩余上限，才是对当前 Alice 表现最有解释力的诊断顺序。
