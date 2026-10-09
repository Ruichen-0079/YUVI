# YUVI 覆盖率驱动的生产源码审计

**交付性质：可复核的部分审计。生产全集清点完成；全仓消费者、字段语义和异常路径调查没有完成，不能称为通过完整性验收。**

研究日：2026-10-09 UTC。获取远端 main 后锁定完整 SHA：`fb0e1e62841106c533e4edd1d7e60327dc4315b4`。源码及证据均针对这个提交；随后发布本报告的文档提交不是生产基线。本轮没有修改生产实现，没有重新研究 Future，没有提出新的总体架构。

本轮最有把握的结论是：YUVI 已有实际可用的历史、记忆召回、认知结果回注、媒体观察和执行保障；也存在**成功的后端产物在下一条合同边界上失去效用**的情况。新探针确认了授权文件正文被整体丢弃、WebSocket 字符串布尔值扩大诊断范围、整段语音输入上限跨语言不一致，以及无效 WS 事件使既有请求回复失去订阅。它们并不能解释全部 Alice 表现。我们没有实际部署 SHA、模型质量对照和足够的全仓人工阅读，不能把剩余代码的价值宣布为零，也不能证明主要责任一定在模型。

## A. 究竟检查了多少

以下数字由 [check-coverage.mjs](evidence/check-coverage.mjs) 从 Git 清单、固定分类策略、语法索引和调查台账重算，详见 [coverage-summary.json](evidence/coverage-summary.json)。

| main 范围 | 数量／结果 | 具体含义 |
|---|---:|---|
| Git 追踪记录 | 1,435 | 包含生产、测试、文档、Vendor；没有按熟悉模块预先筛选 |
| 生产候选 | 702 | 533 源码、68 配置、76 资源／呈现源、25 SQL 迁移 |
| 已分类／未分类生产候选 | 702／0 | 分类覆盖 100%，不代表运行可达或正确 |
| 完成结构分析 | 595／702，84.76% | 语法／配置结构解析完成，不代表调用和字段语义完成 |
| 有人工针对性阅读记录 | 49／702，6.98% | 包括下面的完整深读文件；一个文件可有多个阅读区间 |
| 完整逐文件深读 | 16／702，2.28% | 其余 686 个保持待深读；针对性阅读不关闭同文件其他函数 |
| A 路线入口候选 | 412 | 路由、事件、注册、定时器、Python／Rust 入口等；尚须确认实际装配 |
| 分组链路调查 | 14 组，关联 64 个候选 | 分组记录不证明组内每个异常分支；348 个入口候选未完成链路调查 |
| B 路线状态／类型／事件候选 | 1,710 | 包含需要去重和语义确认的类型；包含全部 TS 类型／接口／类；不能说系统有 1,710 种长期状态 |
| 重点产物记录 | 24 类 | 另有明确生产者—消费者台账；不冒充自动候选全部调查完成 |
| C 路线变换候选 | 1,538 | 模型、存储、外部调用、转换语法；不等于 1,538 个已确认高风险边界 |
| 人工字段边界记录 | 15 | 指定函数、条件、结构、保留／丢弃字段和消费者 |
| 交叉差异／OPEN_GAP | 3,956／3,956 | 已记录分类及原因；**分类不是调查解决** |
| 真实模型质量对照 | 0 | 探针中的模型均为输入记录器；没有质量提升或下降百分比 |

未计入生产候选分母的 733 个记录是：396 个测试／测试支持、251 个文档／研究／法律资料、86 个 Vendor。它们仍在 [source-inventory.json](evidence/source-inventory.json) 中，保留排除理由；Vendor 的构建条件与第三方运行边界没有被抹掉。所有 SQL 迁移都保留，没有按年代排除困难实现。生产导入排除类会产生差异，不能靠改分类掩盖。

最初规则给出 710 个候选。反向复查发现七个 `test-support` 文件和一个导入 `node:test` 的脚本，修正的是全局技术分类规则，并重新扫描。记录没有删除，原清单保存在 [initial-source-inventory.json.gz](evidence/initial-source-inventory.json.gz)，八个变化逐条见 [scope-revision.json](evidence/scope-revision.json)。这是可以检查的测试归类修正，不是把未查清区域改成排除项。

### 语言与构建边界

| 语言／格式 | 生产候选 | 结构完成 | 限制 |
|---|---:|---:|---|
| TypeScript／TSX／JavaScript | 469 | 469 | TS Compiler API 5.9.3：导入、签名目标、调用、构造、声明、类型引用；接口目标不等于实际动态实现 |
| Python／构建 spec | 27 | 27 | Python 3.12.14 AST；动态分派、实际依赖和侧车通信另查 |
| Rust | 19 | 18 | tree-sitter 语法；trait、macro、cfg 和平台执行未闭合 |
| SQL 迁移 | 25 | 25 | pglast 7.7 解析；事务／锁／恢复正确性没有由解析证明 |
| JSON／TOML | 48 | 48 | 配置结构读取，不代表每项配置有消费者 |
| Shell | 8 | 8 | `bash -n` 与字面索引；环境展开和实际发布未执行 |
| 其余格式／资源 | 106 | 0 | PowerShell、Batch、YAML、Dockerfile、HTML、CSS、GLSL、XML、二进制等仅做元数据／字面索引，保持未完成 |

另有一个 Rust 文件解析未通过：`supervisor.rs:1746`，是当前 tree-sitter 对 HTTP 响应解析处的语法错误节点，**不是已证明的 Rust 编译错误**。环境没有 cargo/rustc/pwsh，不能替平台构建作保证。各 package、语言、进程的完整分组和所有待查路径在覆盖 JSON 中，不用一张精选表代替全清单。

### 验收结果

全集完整性／分类门槛 A 通过；B 的记录存在性通过，消费者调查未完成；C 的全关键字段调查未完成；D 的差异登记完成，调查解决未完成。`limitedAuditComplete=false`。默认校验退出 0 仅说明证据清单有效；`--require-complete` 退出 **2**。反向校验能发现缺记录、错 SHA、藏入口、藏边界、藏状态、藏缺口及没有动态检查证据的“无消费者”结论，见 [checker-regression-results.json](evidence/checker-regression-results.json)。这些防线也不能证明不存在其他遗漏。

## B. 真实生产能力及独立版本

共享 main 的关键运行链是：外部请求 → schema／身份与选项归一 → Host Journal receipt → Runtime 回合 → Conversation、Memory、P8／Person 投影 → Character 模型输入与决策 → 条件满足时 Cognition／Capability → 表达正文 → Publication／History 写回。媒体侧车提供观察或语音，Dashboard 则另有事件消费者。**Journal 权威、Person 范围、人物含义与诊断日志不是同一种信息。**

普通 HTTP、SSE 和 WS 有各自的发表与断开处理；它们使用相同后端不等于错误路径完全相同。桌面先由原生设置、密钥和 Supervisor 决定哪些进程归自己管理，再连接 Server／Mem0／STT 等；不能只扫描 TS 就声称看过桌面实际配置。WebUI 的输入、音频、呈现和管理消费者也不能用 Server 能力清单替代。

入口调查分别记录激活条件、输入方、归一、权限、模型消费、终点、失败／取消／重启边界，见 [entrypoint-traces.json](evidence/entrypoint-traces.json)。下表是已经建立的重点链路；“条件成立”不等于已确认 Alice 部署条件成立。

| 能力 | 实现与装配 | 正常触达与实际消费 | 效果证据／剩余边界 |
|---|---|---|---|
| 日常文字、历史 | HTTP/SSE/WS → Runtime／Conversation／Character | 有真实历史和用户原文消费者；Character 可回应、沉默、交给 Cognition | 控制／输入正例；自然度、长历史和所有断开路径未测 |
| 长期记忆 | legacy／Mem0、grounded ingestion、检索；依配置选择 | 召回结果确实能进模型；Mem0 不应整体说成规则记忆 | 旧召回正例按源码一致性复用；实际模型写入、自然纠正与跨重启闭环未测完 |
| 认知与工具 | Character handoff、真实 Reasoning 回合、Host 授权能力 | 合法短文件结果进下一轮；host path／plugin grant 是真实条件 | 正向反馈消费与溢出丢失已测；普通用户授权入口、多工具和持续任务仍有缺口 |
| 身份／人物／关系 | authored 身份、产品 Person、P8 证据与修正 | Person 参与范围选择；P8 部分含义进入表达上下文 | 不能把范围隔离当人物理解，也不能把全部 P8 宣告无效 |
| Profile | 生命周期、物化、验证、读取 facade 已装配 | 当前 A4 明确 `NOT_USED`；生命周期与验证确有消费者 | 全部动态 Host 是否另有语义读方仍为 UNRESOLVED |
| 视觉／屏幕 | 媒体 Vision、图片消息、条件性观察请求 | 当前观察文字可进入模型；原始媒体非永久文本证据 | 硬件、真实视觉模型、后续回源及多次观察未完整验证 |
| 语音理解 | local STT、声学模板、分段与 finalized speech | 本地 STT 真实形成各说话区间正文；下游转录进文字链 | 声学匹配不等于 Person；语境中的说话者消费仍需端到端对照 |
| 语音／呈现 | TTS、媒体 seal、播放／呈现回执、Companion 渲染 | 真实跨语言语音请求；输出／设备能力有消费者 | 2000 字符边界已测；真实 GPU、完整播放／呈现恢复未测 |
| 主动行为 | consent／policy／scheduler／decision provider | 条件性触发与正常 NO_OP；默认会话问题有旧输入证据 | 不是无条件定时说话；所有暂停／恢复／并发路径未闭合 |
| 恢复与执行保障 | Journal、outbox、lease／fence、ingestion／profile workers | 有取消、未知结果、重试／reconcile 的控制消费者 | 源码价值成立；本轮未跑真实数据库故障恢复 |
| 插件 | manifest/lifecycle、host-issued grant、runtime capability surface | 标准启动默认 discovery／grants 为空；注入 Host 可接入 | “manifest 声明了能力”不表示普通 Chat 能调用；回调及超时矩阵未审完 |
| Dashboard／诊断 | 事件 wildcard、限长列表、脱敏与呈现诊断 | 管理界面确有消费者；不是模型长期记忆 | 应保留观测价值；诊断模式切换错误已测 |

### 分支不得拼接

已获取并枚举全部 104 个远端 head，保存各自 SHA 和树差异。没有 open PR。日期、分支名或文件新增不能证明正在维护或部署；101 个历史 head 的实际活跃性仍未确认。

| 独立树 | 完整 SHA | 追踪／生产候选／结构完成 | 人工范围 |
|---|---|---:|---|
| main | `fb0e1e62841106c533e4edd1d7e60327dc4315b4` | 1435／702／595 | 本文重点调查；仍是部分审计 |
| `feat/plunge-webui-20261008` | `adff0c70648b42a3a15ea45609adae1c45b31fc5` | 1438／729／620 | 独立装配定位、独立索引及旧分支证据的限定复用；未完成该树全量三路人工调查 |
| `salvage/desktop-presentation-20260923` | `4da346636be7bdaefeeb7617f1530eaedbcd0711` | 1162／615／509 | 独立索引、merge-base 后现有文件变更；未完成人工语义调查 |

QQ 在独立树 `index.ts:39–62` 中由 `YUVI_PLUNGE_CONFIG_PATH` 和独立 Character composition 激活，`composePlunge` 提供 surface 插件；该树 `server.ts:90–106` 将 surface sources 加入 lifecycle，并在 WebUI 装配时调用 `protectPlunge`。`qq-composition.ts:96–140` 构造 QQTransport 并提供 source。**main 没有这条装配。**本文的 main WS 结论也不等于已证明带 Plunge token guard 的部署暴露情况。

桌面呈现分支没有新增生产文件，但在自己的 merge-base 后修改了既有画布、呈现投影、外观和字幕代码。若只找新目录／新文件，会漏掉这个独立变体。三棵树分别有 inventory 与 AST 索引，数量不相加为“main 覆盖”。其他 head 的所有差异保留在 [build-and-branch-matrix.json](evidence/build-and-branch-matrix.json)，没有偷偷归入 main，也没有简单宣布全部废弃。真实 Alice SHA 仍未确认。

## C. 已兑现的智能与运行价值

**历史与可消费召回有真实贡献。** 当前 Runtime 不只是把数据库摆在旁边：已有正例捕获到 Mem0 检索标记进入真正 Character 请求；本轮认知探针也捕获到工具结果进入第二次真正 Reasoning 输入。它们提供基础模型单次无历史请求没有的信息。是否更准确，仍须同模型评测。

**认知交接与证据回注不是纯接口。** 本轮真实 Character port 能表示 RESPOND、SILENCE、NEED_COGNITION；成功认知结果中的答案、uncertainty、caveats 可以进入重入请求。这里没有证明模型会在恰当时刻选择它们，只证明已有生产消费者。

**媒体有实际观察结构。** 本地 STT 在多分段时独立识别各时段，不把整段话复制成每个人的话；声学模板也明确不冒充人格或信任。语音、播放、呈现和原生服务控制有真实消费者。它们的下游边界有缺口，不等于整套媒体设施无效。

**可靠执行有独立价值。** Host authority、来源范围、幂等、ownership、lease/fence、过期／取消、UNKNOWN 结果及回执把“模型想做”“允许做”“已经做”分开。过早删除这些保障会把超时或失联误当作未执行，再触发重复副作用。包构建与隔离 Installer smoke 也提供产品运行价值，即使不直接提高语言推理。

这些正向判断来自特定生产链和探针，不是测试总数。未跑数据库／真实设备／长期故障试验的可靠性分支保持待确认。

## D. 尚未兑现的能力

1. **Profile 的语义消费不能由物化规模代替。** [Runtime A4](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/packages/core/src/runtime-orchestrator.ts#L1226)明确记录 synthesized Profile `NOT_USED`。`context.ts:797` 构造 `ScopePeopleModelReader`，`profile-lifecycle.ts:752` facade 又能委托读取；这些证明已有能力及暴露点，不证明模型已经理解它。已查解析引用、构造／导出和重点装配；尚未排除全部接口分派、回调、插件、配置 Host、跨进程调用，因此全局消费者结论仍为 UNRESOLVED。旧报告“未找到读方”不能升级成“任何生产配置都没有读方”。
2. **插件执行器不等于普通 Alice 已有工具库。** 标准 `buildServer` 默认 discovery 与 grant 为空；manifest 字段还明确写着 declarations only。需要 Host 的发现、实现注册、授权及 Runtime snapshot/invoke 连接共同成立。保留这些安全区分，但不要用静态声明数量宣传正常用户可达能力。
3. **合法工具结果未必成为未来可用经验。** read-text 正文是 transient result；模型本轮可消费，数据库效果证据记录的却是执行层事实。没有证明本轮内容会自动转为长期理解。隐私上也不能把全部授权文件永久写进记忆；应分别检查保留条件、来源与后续消费，而不是简单增加写入。
4. **持久作业不是自动发展的证明。** Profile、ingestion、read-text workers 在 Server 有启动点；Dream 的旧 idle／writer 问题保持限定结论。没有独立执行者的对象不会随时间自动工作，但本轮没有排除所有特殊 Host 的 Dream 调度，不能发布全局“永远无 Worker”结论。
5. **正常用户入口还缺少行为闭环证据。** 自然语言记住／纠正 → 合法写入 → 后续检索／修正、真实文件授权、观察回源、完整播放／呈现失败恢复，都不能用“有类、有测试、有配置”补足。场景与图谱的双向检查保存在 [user-scenario-checklist.json](evidence/user-scenario-checklist.json)。

## E. 已证实的信息与能力损失

证据等级：S 为源码／静态关系；P 为真实函数的确定性执行，注入依赖均列出；M 为同模型实际质量对照；D 为真实部署事实。本轮没有 M，也没有确认 Alice 的 D。

### E1. 成功读取的授权文件，在观察合同上丢掉全部正文【本轮新增，S＋P】

生产链：`executeProductionCognition` → Host admission／read-text binding → [readAuthorizedLocalText](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/read-text-effect.ts#L27) → [normalizeOutcome](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/mcp-read-text-observation.ts#L74) → 下次 Reasoning 输入。

读取器允许不超过 **64,000 bytes** 的普通文件；[观察契约](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/packages/cognition/src/capability-observation.ts#L23)仅允许 **16,000 个 JavaScript 字符单位**。这不是相同单位，ASCII 对照避开了编码歧义。normalizer 捕获契约异常后，只返回 `status:"ERROR"`，没有正文、溢出原因或分块机会。成功读取被描述为错误。

| 相同权限和主链，仅改变长度 | 实际文件读取 | 第二轮真实模型请求 |
|---|---|---|
| 16,000 ASCII 字符 | 成功 | 正文与 `END_OK` 标记进入输入 |
| 16,001 ASCII 字符 | 成功 | ERROR；全部正文及 `END_OK` 均不在输入 |
| 64,000 ASCII 字符 | 成功 | 同样整体丢失 |
| 预先取消 reader signal | 无成功读取结果 | 不提供成功正文；这不等于所有 Reasoning 调用均已取消 |

本轮调用实际文件读取、实际 production Cognition 和实际 normalizer；Reasoning 是请求记录器，持久 effect-store adapter 被注入，不冒充 PostgreSQL 授权恢复测试。每个读取场景记录两轮输入／输出、调用数和 fixture 时间；时间不是远端推理延迟。

**用户后果：** 一份完全合法的小型源文件／说明文档，后端已经读到，Alice 却只收到泛化错误，无法基于正文查证。模型可能合理地答“不知道”，看起来像理解能力差。**最小反事实：** 仅绕过此有损投影，原已授权的 16,001 字符正文仍存在，可提供额外有效信息；应协调有界读取、明确部分结果或合法分块，不必放弃权限边界。实际回答改善、token 代价及更大输入挤掉其他上下文的影响待 M。

### E2. `dashboard=false` 打开全局诊断流【本轮新增，S＋P】

[WS query schema](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/websocket.ts#L96)使用 `z.coerce.boolean()`。字符串 `"false"` 在 JS 中为真。随后 [订阅分支](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/websocket.ts#L138)从当前连接 activeTrace 过滤变为 wildcard dashboard，target 接受条件也允许 dashboard 模式。

真实路由和真实 EventBus 的探针使用合法 `AssistantMessagePayloadSchema` 事件；四个连接都未发送用户消息。缺省 query、实际 boolean false 不接收其他会话正文；string true 接收；**string false 也接收**。`redactValue` 按敏感键名脱敏，不过滤普通 `content` 和会话范围，私有正文标记仍在帧内。

**用户后果：** 希望关闭诊断的客户端会得到不属于自身活动 trace 的内容；也会错误地把其他会话输出理解成本次交互。这是范围和协议语义问题，不是模型推理错误。当前标准前端缺省 `/ws` 不自动命中此例，影响以发送该 query 的客户端为界。外网可达、具体部署权限、Plunge 的额外 guard 均未证明。

**反事实：** 保持事件、权限和输出治理不变，使用确切 false 解析，可恢复现有 activeTrace 过滤。无需删掉 Dashboard 或取消 Publication。探针未覆盖持久 outward ledger，但错误模式已进入 target 的源代码谓词；部署验证应同时覆盖该模式切换。

### E3. 整段本地语音在跨语言上限处失败【本轮新增，S＋跨进程 P】

[/v1/tts](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/media.ts#L67)对 text 只要求非空；[Runtime whole speech](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/packages/core/src/runtime-orchestrator.ts#L4660)、`context.ts:628` 和 [DotsTTSProvider](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/packages/providers/src/local/DotsTTSProvider.ts#L61)把整段 text 交下去。实际 Python [Service.synthesize](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/services/dots-tts/server.py#L209)只接受 `len(text.strip())<=2000`。

本轮用真实 TS Provider，经 localhost HTTP 调真实 Python Handler／Service；只替换昂贵的波形生成，不模拟输入验证或 HTTP 错误。2,000 字符得到 WAV；2,001 字符得到 HTTP400／`UNSUPPORTED_INPUT`、effectState `unknown`。1001＋1000 两个独立请求均能通过。另测实际 Service 的取消状态 409。

**用户后果：** 本地 dots、整段输出条件下，合法文字回答不能形成语音；语音模型是否聪明与此次拒绝无关。该结论不泛化到其他 TTS Provider、短文本或已分段的客户端。**反事实：** 同一正文若在既有合法语音段机制中有界处理，侧车可接受更多内容；但多一次调用的成本、韵律、播放治理及取消风险必须验证。不能把两段成功当自然度提升，也不能删除 UNKNOWN 执行保护。

### E4. 一条无效 WS 事件清掉既有请求的回复订阅【本轮新增，S＋P】

生产链：[WS message handler](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/websocket.ts#L162) → envelope 验证 → activeTrace 注册 → receipt／Runtime → EventBus → [activeTrace 输出过滤](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/websocket.ts#L144)。代码已记录 `traceAlreadyActive`，receipt 拒绝时也正确保护既有 trace；但 [非 user.message 分支](https://github.com/Ruichen-0079/YUVI/blob/fb0e1e62841106c533e4edd1d7e60327dc4315b4/apps/server/src/routes/websocket.ts#L187)无条件删除同一 trace。外层 catch 另有类似删除，后者本轮只有 S、没有执行探针。

探针先发送合法 user.message，经实际 schema 与 Journal ref 转换进入一个等待完成的 Runtime 替身。等待期间发送 envelope 合法、类型不支持的 agent.reply，复用原 trace ID；再让原请求产生合法回复。真实路由、ActiveTraceRegistry 与 EventBus 的结果如下：

| 同一合法请求与后续完成事件 | 额外客户端事件 | 原回复送达 |
|---|---|---|
| 正常路径 | 无 | 是 |
| 问题路径 | 同 trace 的不支持类型事件 | 否；仅收到该事件的错误帧 |
| 最小反事实 | 相同无效事件，仅保护之前存在的 trace 不被此次清理 | 是；错误帧与原回复都送达 |

**用户后果：** 一次已经获准、仍在运行的工作，因另一个无效包而失去当前连接的输出消费者；工作没有被取消，模型即使正确完成也可能表现为 Alice 沉默。**反事实：** 错误包的清理只撤销它自己新增的订阅状态，便可保留既有回复机会。探针临时替换 registry 的 delete 行为后立即恢复，没有修改生产文件。

证据边界是普通 WS、同连接、复用活动 trace 且时间重叠。Runtime 完成事件与 Journal receipt 由测试依赖提供，不宣称真实推理、数据库恢复、durable Publication 或所有客户端都会触发；HTTP/SSE 不由此推断。具体生产客户端是否会发送这种包仍需部署证据。错误输入应被拒绝，但拒绝不应被解释为取消另一项合法工作的订阅。

### 已知问题只复核，不冒充新增

Context 压缩／前缀预算、规则 forget 与否定、Character 控制加正文、Cognition 无进展 CONTINUE、关系含义缺产方、主动默认会话及 Dream idle 已有调查。本轮 Git 比较证明 `apps/packages/services/scripts` 与前次生产基线 `46a24878536d537021c49d50c5ce004d93489628` 没有差异，保存 [prior-evidence-reuse.json](evidence/prior-evidence-reuse.json) 及旧结果文件哈希，复用限定证据而不反复跑同一事实。

其中两个界限必须纠正：保守的一字符一 token 预算是源码明确写出的政策，不能凭单位表象宣布偶然类型 Bug；本地 STT 本来会产生分段正文，旧自定义 Provider 的 confidence 丢失证据不能解释成本地侧车本来输出 confidence。它默认没有该字段。语义损失与上游没有生产该信息是不同事实，见 [hypothesis-log.json](evidence/hypothesis-log.json)。

## F. 本轮新增的系统与方法发现

**第一，产物容量必须沿消费者链核对。** read-text 与观察契约分别局部正确，组合却使成功产物无效。单查 capability 调用成功和单查 observation 拒绝超限，都会漏掉能力损失；TTS 也表现为同类问题，但单位、模式和责任不同。审计必须同时记录生产者可生成的域与消费者可接收的域。

**第二，控制与清理也会改变可见信息。** WS 布尔转换改变诊断范围、target 准入和客户端理解；错误包清理又能抹掉已有工作的订阅。前者扩大范围，后者阻断结果，均不需要模型答错才会损害体验。只检查正文长度或模型请求会漏掉输出消费者的生命周期。

**第三，底层观察有价值但下游可见性另算。** 本地 STT 的逐段转录正例反驳了一个容易形成的错误解释。接着应追踪 segment、cluster、声学匹配与 Person 解释的各自消费者，不能因为最终模型输入缺标签而否定声学端所有投入。

**第四，按新增目录找分支能力会漏掉已有文件的新实现。** 桌面呈现分支是可复查的反例。分支筛查现在保留完整树差异和独立版本；不能仅凭名称、时间或 added paths 声称活跃／无关。

**第五，扫描器本身必须接受反例。** 首版 Python 装饰器入口规则遗漏了真实 `BaseHTTPRequestHandler` 和 `main`；TS 首版还把 entryKind 覆盖成 CALL，Node 内置／资源导入的归因也需修正。规则按全部相关文件重跑，记录在 [method-revisions.json](evidence/method-revisions.json)。终检还发现 B 曾用熟悉的状态词筛选声明，遂改为保留全部 TS 类型／接口／类，其他名称记作角色未定而不是排除；未定类型的缓存／闭包／动态对象仍有独立发现缺口。脚本输出不天然比人的模块表可靠。

**第六，新的高风险待查点也必须保留，而不能包装成发现。** 补查 Companion 的 `submitPresentationOutcome` 看到 HTTP report 链 `.catch(()=>undefined)`；这证明客户端在此吞掉报告失败，但尚未追完服务端重试／reconcile，不能断言效果永远丢失或 Alice 学习受损。该问题保留 `OPEN-PRESENTATION-REPORT`。同时补读 Person command、dispatch-store、installer smoke 的入口／边界；完整跨 Owner 事务仍未检查完。

## G. 三路交叉核对与共同根因

A 独立从入口／注册语法出发，B 从全部 TS 类型／接口／类声明、其他语言状态、table、持久接口与事件生产语法出发，C 从 IO／模型／变换签名出发；它们不是从旧缺陷表派生。Compiler 的签名目标可能是接口，程序特别保留这层不确定性，不把类型引用计为语义消费。

交叉程序检查：A 未有人工链的入口；B 未确定生产者／消费者的产物；C 未有字段记录的变换；B/C 不在 A 保守导入闭包中的节点；手工 trace/state/boundary IDs 互相失配；生产导入测试／Vendor 等排除类。**导入闭包仅是结构候选，跨进程和动态 Host 可能绕过它。** 不可达／无消费者结论不能由这个集合差产生。

当前 3,956 个 OPEN_GAP 的组成：348 个入口未深追，1,710 个自动状态候选的消费者尚未建立，1,526 个变换候选没有对应字段区间调查，275 个状态与 87 个变换未被 A 导入闭包锚定，以及十个明确的动态／平台／部署／行为缺口。这些集合有重叠，不能相加成缺陷数。手工链路的 ID 对照没有遗留失配，但这也不证明链路描述正确。

依据已研究的区域，可以提出以下综合解释，证据强度各不相同：

- **装配、可达、消费被混为一谈：** Profile facade、插件声明、持久作业分别能存在于控制／验证层，却不一定进入 Alice 的正常语义链；这是有边界的源码判断。
- **生产者与消费者独立设限：** 文件、观察、语音各自设限，但端到端允许域没有统一核对；新增 P 已支持两个具体实例。
- **规则／投影可能提前改变语义：** 否定 forget、affect、诊断布尔值、历史预算属于不同语义属性；不是所有程序约束都应删除。
- **验证失败与取消既有工作不是同一事实：** WS 的 receipt 错误分支保护原 trace，另一个错误分支却删除它；局部清理必须以资源所有权为界，本轮已有 P 对照。
- **交付与理解不是同一终点：** APPLIED、数据库写入、事件 publish、播放报告各证明特定层事实；尚未证明未来理解／适应。当前不能从可靠状态数量估计长期智能。

“状态普遍无人消费”“所有模型相互削弱”“所有外部结果不能成为经验”仍没有全仓证据，不写成既定共同根因。尚有 1,710 个候选归因未关闭，正是不能使用这类全称判断的原因。

## H. 现有代码的价值取舍

| 决策 | 具体依据 | 正确性边界 |
|---|---|---|
| 保留 | 忠实 Conversation、合法 Memory 召回、认知结果回注、STT 分段、Host authority、来源、fence／取消／UNKNOWN／恢复、服务 ownership | 这些有生产消费者或必要运行价值；未验证分支仍需补查 |
| 修复连接 | 有效读取结果到 Reasoning；本地整段语音到有界语音输入；已选定的合法人物／经历含义到实际上下文 | 权限、来源、部分观察、不确定性和隐私不能丢 |
| 简化／替换具体规则 | 错误布尔 coercion；无所有权区分的 trace 清理；不说明原因的成功→ERROR 投影；已经证实与原文冲突的规则提示 | 改单个责任，不大范围替换 Runtime |
| 暂停继续扩建 | 未证明语义消费者的 Profile／关系物化、仅增加局部契约与兼容路径 | 先补消费者或同模型价值证据；不把验证／管理消费者算作不存在 |
| 删除应附对照条件 | 无效果证据且重复消耗预算的语义控制／投影；误导性的配置或产品能力承诺 | 不能据本轮部分覆盖宣布整个 Character、Dream、People 应删除 |
| 继续研究效果 | Character 双阶段、保守预算、主动判断阈值、观察摘要和长期适应 | 同模型 A/B/C/D 输入及质量、全部调用与成本／延迟；目前 M=0 |

目前没有证据支持“删掉大部分后端就一定更聪明”。同样，已经实现且合同全部通过也不是继续维护的充分理由。删除标准是：移除后失去什么信息／行为／保障，省下什么成本，是否通过真正同模型和异常对照。

## I. 无法确认与遗漏检测的边界

固定随机种子 **3211009**，从最初冻结的 Git 源码／迁移集合，按自动发现 package 抽一个文件，共 24 个。重算脚本能复现原抽样；8 个完整深读，其余只有针对性阅读。没有重抽以避开大文件。对未深读、低引用、动态导入、跨语言／平台、状态写入较多的文件另选 16 个风险候选，追加针对性补查四个；其余保持 OPEN。完整抽样、规则、区间、发现与未完成状态见 [omission-sampling.json](evidence/omission-sampling.json)。

这种复查确实发现并修正了 Python 入口与分类方法问题，又扩展了原生配置、呈现回执和发布保障调查。但 24 个样本不是全仓无遗漏的统计保证；风险队列也没有全部完成人工调查。复杂的 `runtime-orchestrator.ts`、Journal、Profile lifecycle、effect dispatch、原生 Supervisor、Host environment 和多个 UI／发布文件都仍有大段未深读。

必须保留的其他缺口：

1. 接口多态、callbacks、plugin registry、反射／动态路由、特殊配置 Host 以及 Python／Rust 通信的完整消费者归因。
2. 107 个未完成结构分析候选，其中包含 Rust 解析问题和未充分分析的格式／资源；不能因不直接进模型而排除。
3. 普通记忆写入、纠正、忘记、保留原文、跨会话／跨重启召回的完整正负向矩阵；本轮只拥有部分正例、负例及旧证据复用。
4. SQL 真正恢复／并发、未知效果重试、原生声纹与人物绑定、浏览器断流／播放／呈现回执的实际异常执行。
5. 所有远端 head 是否仍承担产品或实际部署的证据；两个独立变体的三路人工调查没有完成。
6. 常见 Provider 环境 key 未配置的存在性检查，不等于已排除所有私有配置。真实 Alice 模型版本、参数、人格、设备、权限与消耗未知。

因此本轮没有“全后端所有关键机制都已审完”的结论。机器报告让未检查区域无法被一张看似完整的模块表遮住，但仍需要人工判断哪些候选是真正产品状态、入口和关键边界。

## J. 最高价值的下一步决策

本轮不实施。排序结合覆盖面、已确认用户后果、成本、风险和证据；不是新的版本路线图。

| 优先 | 修改／验证方向 | 清晰验收条件 |
|---|---|---|
| 1 | 修复成功读取正文被观察契约整体抹除 | 同权限 16000／16001／64000、空／坏编码／取消都具有诚实状态和可消费的有界证据；来源／授予不变；再做同模型查证对照，不能只测 adapter 成功 |
| 2 | 修复 WS 诊断范围与错误事件清理 | 缺省、true、false、非法 query 有范围对照；无效类型／坏 payload／receipt 拒绝不能删除同连接既有请求的订阅；关闭连接仍须清理；durable outward target 与部署访问边界单独验收 |
| 3 | 让整段／分段语音模式与本地服务上限一致 | 同一长正文不会未经说明地整段失败；各 Provider 模式、播放排序、取消／UNKNOWN 与段数成本一起验证；真实 GPU／音频另测 |
| 4 | 对共享 Context／Character／Memory 的已知有损处理做少量同模型实验 | A 简单人格＋忠实历史；B 当前真实请求；C 保留有效后端信息而少一次有损投影；D 完整执行链。固定模型、采样、人格、权限；保存所有请求、结果、调用／成本／延迟，分别测信息、质量及任务反馈 |
| 5 | 先关闭高风险消费者和 IO 缺口，再继续物化／协议扩建 | 从已存在的 24 类产物和风险队列中选具体闭环；能指出真实写入、读入模型、下一次选择／动作与失效通道；缺读方先查动态装配，不再凭字符串 absence 下全局 verdict |

为区分主要责任，模型实验优先选择：带指代／否定的长历史；合法中型文件查证；自然纠正后隔会话重问；多说话者矛盾陈述；完整工具结果后的下一步行动。输入保持性和动作机会用 S/P 先确定，再用 M 判断自然度和能力。无实际模型时不能把预期改善当事实。

最终判断：已确认的削弱首先来自具体信息／控制边界与连接条件，其次是已有能力的正常可达性和语义消费不足；多阶段投影相互干扰是部分已支持、部分待 M 的解释。模型自身不足在本轮没有比较证据，无法按感觉排第一或排除。YUVI 已有工程资产真实支持 Alice，但相当一部分投入目前只能证明“信息／动作／状态被治理”，不能证明“它们已经成为 Alice 的理解与长期适应”。本轮的增量既有四个新的边界证据，也有明确暴露的审查不足：**覆盖清单可以复算，尚未完成的代码和归因仍然可见。**

## 复查入口

- [复现说明](README.zh.md)：版本锁定、依赖、运行顺序、退出码、压缩索引与独立分支。
- [全集清单](evidence/source-inventory.json)、[机器覆盖](evidence/coverage-summary.json)。
- [入口路线 A](evidence/entrypoint-traces.json)、[产物路线 B](evidence/producer-consumer-graph.json)、[变换路线 C](evidence/data-transformation-boundaries.json)、[交叉差异](evidence/cross-pass-discrepancies.json)。
- [人工台账](evidence/manual-review.json)、[正反与反事实覆盖](evidence/behavior-coverage.json)、[原始 TS／跨进程结果](experiments/backend-results.json)、[原始 Python 结果](experiments/python-results.json)。
