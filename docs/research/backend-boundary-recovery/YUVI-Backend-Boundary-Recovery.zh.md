# YUVI 高风险生产边界验证与智能能力恢复

本批次已经修改生产代码：修复或安全缓解五项指定缺陷，并修复三项相邻、可重复复现的问题。恢复的是合法信息和执行结果通过现有通路的机会。没有证据据此宣称 Alice 的总体回答质量或长期学习已经改善。

研究基线为 `0d894cc70d42ebba0df132924f5ea181c062b431`，首次检查工作区干净。生产修复截至 `7ea26d683c8e0a1001478014dac45e4b39b298d1`，目标分支 `fix/backend-boundary-recovery-20261010`。生产、兼容测试和本报告分别提交，不直接改写 main。

这一交付是**高风险修复批次与部分合同调查**。六类生产边界的完整枚举/语义验证没有完成。机器结果 `scopeComplete=false`，所有未确认装配、未验证路径和旧差异继续公开；不得把本报告称为完成全后端验证。

## A. 指定高风险缺陷的实际结果

### P0-A：普通连接与诊断连接重新分开

`routes/websocket.ts` 的 query 在 upgrade 前验证：缺省为普通连接；只接受明确 true/false；字符串 `false` 不再变成 true；非法、大小写变体、空值和重复/冲突 query 返回 400。普通连接只能接收自己认领 trace 的事件，并检查已知 session，不能因为“脱敏过”就接收别人的正文。

真正的诊断订阅走现有本地 Dashboard 授权：loopback，配置了开发令牌时还要匹配既有 token。浏览器令牌通过 `Sec-WebSocket-Protocol` 的 base64url credential 传送，客户端不再把它放进 URL，Server logger 隐去该 header。HTTP `/events/recent` 和开发 prompt preview 也使用本地 Dashboard 检查；合法 Dashboard 的 wildcard 调试保留。

入口复查又确认：恶意网站打开 localhost WS 时，TCP 来源也在 loopback。仅 IP 检查不够。已有 CORS 响应头不能保护 WS，也不能阻止所有简单 HTTP 副作用。本次复用既有 Desktop allowed Origin 集合，拒绝明确 foreign browser Origin。localhost/Tauri 浏览器及无 Origin 的本地程序调用保持可用。追加合法 IPv6 浏览器测试发现 URL.hostname 返回 `[::1]`，旧 allowlist 漏掉该形式；`7ea26d6` 保留 IPv6 loopback，1 项 before 失败、修复后相关 74 项通过。该检查也适用于使用同一本地 Dashboard helper 的受保护操作。

证据是实际 Fastify WS 路由、upgrade 和真实 EventBus；同时检查合法 wildcard、默认/false 隔离、invalid query、远端、缺 token、外来 Origin 及合法本地 Origin。**没有引入多租户身份模型**：production 原有本地信任、开发令牌只在 development 生效，仍不是远端多用户服务的认证方案。

同类布尔入口复查未再找到 `z.coerce.boolean()`。Memory 查询已有 Booleanish preprocess，runtime-settings 会把接受的 on/off 等规范化成 true/false。Server config、settings 展示值等仍存在不同宽容域；本次不把可信配置格式不一致升级成已证明越权，也未宣称查完所有配置合同。

### P0-B：聊天文本不再有删除权

移除 Runtime prompt 准备阶段仅凭 forget 关键词直接删除的调用；兼容 `detectExplicitForgetRequest` 不再确认意图。`MemoryService.forgetExplicitMemory` 在访问 backend 前返回 `CONFIRMATION_REQUIRED` 或 `SCOPE_REQUIRED`。原句、用户/个体 scope、时间和正常召回保留。删除需要现有管理入口中明确选择记录并符合真实授权，不能让 ChatModel 代替控制者授权。

这是安全缓解：包括 “Please forget …” 在内的普通聊天都不能自动删；不是再增加一个否定/引号关键词分类器。兼容方法的行为有意变更，不能假称“仍然自动理解明确删除”。历史已删内容没有恢复来源，本次不声称恢复。

低层 scope helper 仍在代码中，但退出普通生产聊天消费链；其正常删除测试证明的是接口合同，不是普通用户可以访问 Mem0 删除。Search/list 异常返回 FAILED，成功空查询才是 NOT_FOUND；delete 抛错可能已经发生副作用，因此记 UNKNOWN；已确认删除加未知为 PARTIAL；取消和 scope 不匹配有独立处理，不盲目重试未知删除。现有显式 bulk ID 管理返回逐项结果，HTTP 207 保留部分/未知及真实 deleted 数量；不把一项异常掩盖成全部失败或全部成功。

**尚未闭合**：remember/correction 的自动写入、grounded claim supersession 以及 Mem0 infer 更新仍需语义反例与消费者检查。合法来源不等于对纠正含义的解释正确。管理记录视图也不自动等于当前 Mem0 backend。相关边界在 OPEN，不能将“停止聊天删记忆”扩张成“所有自然语言持久化安全”。

### P1-A：授权读取的成功正文不再整体归零

读取器保持原有 64,000 **bytes** 权限/容量，只读合格 UTF-8 普通文件，取消与文件句柄清理保留。Observation 仍最多 16,000 **UTF-16 code units**，没有统一调大上限。

完整可容纳的文本原样进入下一轮。超过 Observation 预算的合法读取，以不会切断 surrogate pair 的前缀返回 SUCCESS，并携带严格校验的 PREFIX coverage：总字符单位、提供的单位数及明确的未提供尾部。下一轮 Reasoning 的真实输入包含正文、配对 capability/source ref，以及 PARTIAL coverage 和不能推断全文件的说明。空/纯空白文件是合法成功；无正文结构、坏编码、缺文件、真实读取失败仍为错误。具体 Host path 不被升级成模型授权。

真实文件系统 → 生产 `executeProductionCognition` → normalizer → Observation → 下一轮 ReasoningInput 验证 16,000/16,001/64,000 ASCII、Unicode 单位差、空白、64,001 bytes、非法 UTF-8、不存在和预先取消。64 组 seeded Unicode/property cases检查有界前缀、内容保真、长度可信及非法 coverage 拒绝。

**没有实现尾部恢复/分块**。文件末尾的重要内容仍可能不可达，模型现在必须知道缺失而非获知完整正文。文件权限和 Journal/store 在这一 Cognition 集成测试中是显式 Host 注入；真实 PostgreSQL admission 仍未验证。

### P1-B：只有资源所有者才能清理自己的请求

Envelope、支持类型和 payload 先验证，再认领 trace。Registry 为每次新认领保留 Symbol owner 及 request/session；错误 packet 没创建资源便不能清理已有资源。旧 owner 的 finally 不能删新 owner；重复同 request/session 的失败也不能取消首次合法工作；不同 request 或 session 复用 active/保留 trace 时拒绝并要求新 trace。

EventBus 和 Publication target 都检查 trace 与已知 session。真实连接关闭清理自己的 target/subscription/registry，不影响其他连接。已有上限、terminal 保留/到期、消息去重和 Publication 治理保留。

追加验证发现：拒绝 packet 即使不再删订阅，沿用合法 trace 发 `runtime.error` 仍可能被客户端理解成合法工作失败。本次未拥有资源的拒绝用独立 error trace，并在 `rejectedTraceId` 指向被拒 packet；确实拥有该工作资源的执行失败仍沿原 trace 报告。

剩余边界包括：没有 session 的内部事件仍依赖可信 trace；到期后复用 trace 的跨分布式迟到事件没有新 generation 字段；关闭 WS 不等于撤销已提交的 Runtime/外部操作。这些没有被此次局部所有权修复假装解决。

### P1-C：停止无证据情绪预解释

关键词 CurrentAffect 自动推断关闭，返回 null。默认 Prompt 不再加自动心理标签或 “没有检测到情绪” 占位。原句、身份、时间、trace 和来源不删；已有明确 authored 输入合同仍可接受显式字段，不建立新的情绪系统。

“我不担心”、引用他人、条件句、讨论词义及真正表达担心都只保留真实文本。实际 Runtime 最终 prompt 断言原句完整且没有强制 anxious label，真实 Server 文本/语音 preview 更新兼容测试。其他控制摘要/主动词义规则未统一验证，保留 OPEN。程序停止错误解释是确定性事实；模型的自然度是否提高仍待实际对照。

## B. 跨组件合同复查与新增证据

### 新复现 N1：授权读取的检查与占有之间存在 await 窗口

`HostReadTextEffects.execute` 以前检查 key 不存在后，等待 context capture，再安装 grant。两个同 key 调用可一起越过检查，即使捕获缺省，await 也会让出执行权。新回归暂停首次 capture，让第二次进入，证实不应重复的调用进入了 admission/dispatch。

现在先同步占有私有 grant，再等待 context/admission；currentness 包含 grant object identity；admission 的 intent ID 必须匹配；finally 只释放当前对象。第一个成功、第二个被拒、capture 失败正确释放后可再次合法尝试都有测试。来源、授权路径、effect intent、取消和 UNKNOWN 治理未旁路。测试对 Journal/store/dispatcher 提供明确 fixture；并未证明数据库并发与进程恢复。

### 新复现 N2、N3

N2 是 foreign Origin 通过 localhost 取得诊断授权；N3 是 unowned rejection 错误事件与合法 trace 混淆。两者是本轮增加的可执行证据，不把原来的 dashboard=false 或 cleanup 删除重新称作新发现。

### 抽样纠正了识别方法，而非只补一条清单

第一次风险名称规则漏掉 `writePrivateJson` 这一持久化包装。固定种子样本的 voice-review 暴露了这类漏检，规则扩展到私有/普通文件写入、删除/rename、P8 correction/fence 等同类调用，再重新生成所有风险候选。这使候选增加，并没有靠删记录降低待办。

另保留 `open:private-sample-retention`：30 行样本保留上限与未完成 enrollment 的稳定引用是否相容，临时 index 的 writer 生命周期是否安全。当前只有 source/graph 证据，没有丢失样本的失败复现，因此不仓促修改语音存储。语音 Journal 的异常映射、code-point selector 与未解决 principal/audience也进入样本复查；真实异常提交状态仍需数据库实验。

## C. 实际恢复了什么能力

| 通路         | 确定性变化                                                  | 不能据此宣称                          |
| ------------ | ----------------------------------------------------------- | ------------------------------------- |
| 普通 WS 回复 | 无效同 trace packet 后合法回复仍抵达；外 session 正文被阻断 | 所有分布式迟到/重连都正确             |
| 长期记忆     | Don't forget 不再在模型理解前破坏记忆；召回文本及原句保留   | 纠正学习闭环完整或历史记忆恢复        |
| 合法文件认知 | 以前变 ERROR 的长读结果现在有界抵达下一轮并声明缺尾         | 64KB 全文可达、日常用户授权 UI 已接通 |
| 自然语言理解 | 不再添加确定错误的心理断言                                  | 模型质量已经提升                      |
| 授权执行     | 同 key 异步 capture 不再产生两个 grant owner                | 全 Worker/跨进程 lease 已验证         |
| 管理与诊断   | 真失败、未知/部分结果与合法诊断功能并存                     | 远端多用户授权已实现                  |

普通 HTTP/WebUI 的日常 read-text 授权入口、通用插件 discovery/grant 的默认空配置、完整工具产品仍没有在此建立。存在工具执行器不等于 Chat 可以调用。本次恢复的是已有合法 Host 路径，不凭自然语言扩大文件或插件权限。

## D. 修改组织、回归和可靠性

原始失败与修复后结果详见 `evidence/defects-and-fixes.json`。下表由对应 Vitest JSON 生成，after 的组内总数可能因增加正向测试而不同，不是质量指标。

| 缺陷 | 新旧           | 独立生产提交 | before 失败 | after 失败 |
| ---- | -------------- | ------------ | ----------- | ---------- |
| P0-A | KNOWN          | `e5b803f`    | 12          | 0          |
| P0-B | KNOWN          | `750eb5e`    | 13          | 0          |
| P1-A | KNOWN          | `7d1a5ca`    | 4           | 0          |
| P1-B | KNOWN          | `82e71d2`    | 5           | 0          |
| P1-C | KNOWN          | `c1475da`    | 6           | 0          |
| N1   | NEW_REPRODUCED | `a98adc3`    | 1           | 0          |
| N2   | NEW_REPRODUCED | `38ad4b9`    | 1           | 0          |
| N3   | NEW_REPRODUCED | `fa62e97`    | 6           | 0          |

独立测试提交 `f23efff` 更新真实 Server 的两条旧 affect 预期，初次跨包结果中的这两项失败保留。最终版本跨包回归 2,530 通过、0 失败、273 跳过；跳过主要涉及 PostgreSQL/环境先决条件，不计成功。后续 WS error-trace 改动也完成重新跨包回归；最后的 IPv6 allowlist 兼容修复另跑相关 Server/WS/CORS/security 74 项全通过。

另在独立 `0d894cc` worktree 装好自己的 frozen 依赖，编译原生产代码后覆入测试，得到 49 项预期失败、10 项通过；修复版定向回放 59 项全通过。该回放不共享新旧 workspace package 链接。逐项 before/after 及额外 property/owner 验证保留，测试结果只能说明合同行为。

最终构建还发现新增 WS 测试帧类型漏写 trace/rejectedTraceId 声明（Vitest 不做这项类型检查）；`207fbcd` 补齐测试声明，保留失败日志后重跑通过。最终 `pnpm check`、根 `pnpm build`、源文件 Prettier、`git diff --check`、WebUI 完整 Vite 构建通过。字体准备首次因未采用环境 proxy 而失败，使用既有证书/代理配置和 `NODE_USE_ENV_PROXY=1` 后成功；原失败日志保留。没有生产原生/Python 修改，未运行完整 Tauri/真实音频设备/sidecar 打包；PostgreSQL integration 的 11 项跳过另在 read-grant 原始结果中保留。

必要边界没有删除：scope/个体归属、Journal grounding、Host grant、opaque source refs、取消、worker/UNKNOWN 治理和 Publication 真实状态。此次没有 Runtime/Memory/Character 重写、新 Manager 或新大协议。

## E. 实际覆盖与收敛依据

冻结图谱原生产基线 `fb0e1e62841106c533e4edd1d7e60327dc4315b4` 与 `0d894cc` 的 Inventory 生产文件字节相同；检查器以 Git 验证。旧 702 个生产候选、A 412、B 1,710、C 1,538 和 3,956 个差异全部原 ID 保留。新源码不被冒充旧 AST；变动按 current blobs、明确 sourceVersion 和定向探针记录。

`candidate-disambiguation.json` 区分 erased type contract 与运行时 allocation、静态调用与已注册入口、风险候选与人工确认调用链。类型合同不因 erased 就丢弃。无法确认动态消费者不称 UNUSED。旧缺口继续为 PRESERVED_OPEN_GAP；本轮修复记录链接到相关候选，不假装关闭文件中所有问题。

当前台账总行数 1043，包括 79 个确认顶层 Server 注册、52 个 native/sidecar 条件候选、899 个待确认风险调用和 13 个人工调用链主题。13 个主题中 1 VERIFIED、7 MITIGATED、5 OPEN_WITH_REASON；派生调用/注册不会因同文件局部修复自动算验证成功。这些类别不是同一种“生产边界”，也不能将各类数量相加求成熟度。

下表由 `check-boundaries.mjs` 从冻结图谱与台账重算。中间列混含已确认注册和已读调用链，**不能解释成该领域的全集**；模型/持久状态/跨进程/副作用/清理的动态、间接、平台调用仍未完成消歧。故没有完整性百分比。

| 范围                   | 索引行（含候选） | 确认注册/人工链 | VERIFIED 或 MITIGATED | 装配未确认候选 | 完整枚举 |
| ---------------------- | ---------------- | --------------- | --------------------- | -------------- | -------- |
| EXTERNAL_ENTRY         | 135              | 83              | 3                     | 52             | 未完成   |
| MODEL_IO               | 74               | 5               | 3                     | 69             | 未完成   |
| PERSISTENT_STATE       | 495              | 6               | 3                     | 489            | 未完成   |
| AUTHORIZED_EFFECT      | 48               | 7               | 6                     | 41             | 未完成   |
| CROSS_PROCESS_PROVIDER | 294              | 3               | 2                     | 291            | 未完成   |
| ASYNC_OWNERSHIP        | 126              | 11              | 3                     | 115            | 未完成   |

检查器验证所有原始 ID 双射、冻结输入摘要、实际 source/test blobs、必需合同字段、正反向测试及对应结果。自测证实删除原候选或更改 source blob 会失败。它不会证明人工注释正确；OPEN 从不算验证成功。

固定种子 `3211010` 按 package 抽取 29 个剩余生产文件：配置/构建完整文本、少量小源码、代码片段及两个二进制资源元数据分别记录。片段阅读不冒充深读，没有全设备执行。扩大文件写入规则后重新抽样，新增 speech receipt 文件也保留审查记录。发现识别规则遗漏已补同类规则；没有得到“所有低风险代码无缺陷”的证据。

停止的是此批可验证的生产修改：五项指定缺陷及直接相邻的复现缺陷已经闭合，剩余涉及模型效果、动态装配、数据库、媒体/Worker 或复杂长期状态，缺乏安全局部修改依据。并非因原始 3,956 差异消失或六类范围完工而停止。

独立分支仍锁定：`feat/plunge-webui-20261008` 为 `adff0c70648b42a3a15ea45609adae1c45b31fc5`，`salvage/desktop-presentation-20260923` 为 `4da346636be7bdaefeeb7617f1530eaedbcd0711`。远端核对未变；未修改、未将其 Core/QQ 链接入 main。实际运行 Alice 的 SHA 未获证据，因此不能宣称 QQ 部署已收到修复。

## F. 真实模型效果：仍为零，设施已交付

当前环境没有模型 API key 和 DATABASE_URL，实际模型调用 0。提供可执行 `run-live-model.mjs`，已验证 source bundle 编译、`--plan` 和缺凭据 `--run` 明确失败；没有用 scripted model 填补质量结果。

A 锁定模型/persona/sampling，对忠实原历史、当前 Runtime+Server Character、去掉 gate 的可逆反事实运行否定、引用、纠正及长历史；明确使用 InMemory Conversation、Memory 关闭。B 真实临时授权文件和生产 Cognition 对比直接合法正文、预算后的 Observation，记录真实模型是否选择工具，保留失败和不完整说明。C 需要配置一致、专用隔离数据的真实 Server，先纠正再跨会话，通过 records/semantic/prompt/reply 分辨写入、召回、消费及理解；缺少前提时保持 OPEN，不预填 fixture 记忆当作学习。

记录所有归一化业务输入输出、调用、token 用量、墙钟与提供价格后的可知成本；缺 token 用量/价格、服务端内部模型调用仍是 UNKNOWN。不会要求隐藏思维链。质量用遮蔽版本后的人工 rubric，不用调用少、合同通过或单次回答代替。

设施覆盖真实生产函数的对照准备，不等于已完成完整部署实验。详细先决条件、成本边界、模型版本和权限要求见 `experiments/README.zh.md`。

## G. 剩余优先事项

1. **独立分支与实际部署对齐。** 首先确认 Alice 的真实 SHA、诊断授权、Memory backend 和 Host 授权入口；明确哪些 main 修复需要独立 cherry-pick 与回归，不能直接套用 main 的结论。
2. **自动纠正/失效语义。** 针对有合法 source 的否定、引用、条件、跨说话者 correction，检查真正持久写入与 supersession。验收要同时证明合法纠正可达、假纠正不会失效旧证据和结果真实；不增加另一个词表。
3. **运行 A/B/C 质量对照。** 先选可控专用模型与少量真实场景，确认剩余历史压缩、控制 gate、正文 budget 的主要责任，再决定是否改变这些处理。没有数据不重写 Character。
4. **数据库与真实异步所有权。** 为已修 read grant 补真实 Journal/admission/dispatcher、未知结果和重启复现；随后检查语音 sample eviction、Worker lease、STT/TTS epoch/cleanup。成功、部分、失败与未知各有可归因终态。
5. **明确文件内容覆盖与日常授权产品缺口。** 先验证用户能否通过已有正常控制路径合法授权、模型是否选择执行，再研究尾部/分块消费。首尾证据要求完整时，前缀修复仍不足；不要继续扩大上限掩盖不可达。

现有来源、scope、授权与执行状态治理已经足够值得保留；当前没有证据应再增加新的个体/记忆编排层。继续投资应围绕真实边界的输入、输出、拥有者和消费者，以及少量实际模型证据。

## H. 结论边界

现在可以说：普通诊断 query 不再扩大范围；错误聊天删除已停止；合法长文件有了有界、诚实的认知输入；错误 packet 不再删除或冒充另一请求的终态；自动错误情绪指令被撤除；同 key grant 的 await 竞争得到所有者约束。

现在不能说：Alice 已经变聪明、长期学习完整、所有后端能力可达、所有异步路径安全或全高风险范围审完。这些区别在代码、台账、测试和实验状态里都有可核查的记录。
