# 实机模型价值实验与生产修复 — 2026-10-10

本轮实际调用模型，并修复四处生产损失：合法 SSE 心跳使回复失败、已发表历史正文被逐条截断、合法 length 正文被整体拒绝、绑定 Character 的 Memory 检索未传显式 scope。没有部署或合并；日常 Alice 服务、配置、数据库 schema 与长期记忆没有改动。

不能宣称 YUVI 已在所有任务达到原生模型水平。跨会话记忆纠正、控制 JSON 格式、偶发 SILENCE、工具选择仍有真实失败。这里交付的是可归因的局部改善，而不是总体智能认证。

## 运行环境与版本边界

| 对象              | 实际证据                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常仓库          | `Ruichen-0079/YUVI`；`Projects/yuvi` 是另一个旧仓库，未用于开发                                                                                                             |
| main              | `0d894cc70d42ebba0df132924f5ea181c062b431`                                                                                                                                  |
| #322              | OPEN，HEAD `e92e30bbd4c9242c74860bf48d1eed8bde40e58e`；重新查询仍未合并、无新 HEAD                                                                                          |
| 日常 Alice        | 运行安装包 `yuvi-runtime-server.mjs`，安装 manifest 与 release checkout 都指向 `5064c29fa85da959b6a5b29a1655bfdadb2a6a3d`；不是 main/#322                                   |
| 实验分支          | `fix/runtime-model-value-20261010`，独立 worktree，基于 #322；没有写其他 worktree                                                                                           |
| QQ/Plunge         | 独立 worktree `adff0c70648b42a3a15ea45609adae1c45b31fc5`；未发现运行 QQ 入口。本轮不把它与安装包拼接                                                                        |
| Server/Web        | 安装包 Server 6121、静态 Web 5173；Desktop/语音入口没有取得独立运行轨迹，不能以配置证明它们接通                                                                             |
| Chat              | DeepInfra OpenAI-compatible，`deepseek-ai/DeepSeek-V4-Flash-0731`；实际请求与响应均记录                                                                                     |
| Reasoning         | 同供应商，`zai-org/GLM-5.3-Flash`；完整 Server Memory 场景保留此路由                                                                                                        |
| 路由/参数         | Chat、Reasoning 各一个 route，无第二模型 fallback；部署普通 Character 请求未显式设置 temperature/max_tokens。实验明确固定 temperature=0/max_tokens=2048，不把它冒充线上默认 |
| Persona           | 安装版本硬编码 Persona 以 “Speak as Yuvi” 开头，memory persona 为 Alice。实验复制实际 Persona；新 Server 使用独立 authored Character 实例承载同样文本，没有在线重命名       |
| 上下文            | 未发现部署显式配置模型 context window；当前本地预算缺省 window=16,384，working=min(24,576, 75% window)、输出/安全余量各 2,048；另有会话 6,000 字符及单项压缩约束            |
| Memory            | PostgreSQL + Mem0 sidecar，infer=false；本地 Qwen embedding，Runtime 512 维，Mem0 独立 1,024 维；不能混用两者维度                                                           |
| Journal/ingestion | 部署数据库/健康检查正常；ingestion running。维护 scheduler disabled。健康快照不能证明每个事实已提交或后续被消费                                                             |
| 人物/能力         | Memory subject×persona 绑定已核对；P8 当前身份和稳定人物归属没有获得独立语义消费证明。普通完整 Server 请求显示 “No tools are currently available”                           |
| 多模态/主动       | STT/TTS/Vision 缺配置，不能做真实正向试验；proactive 有独立 Llama route，但本轮隔离实例关闭主动行为，没有测试主动会话选择                                                   |

供应商目前列出的两个模型窗口均为 1,048,576 tokens：[DeepSeek 模型页](https://deepinfra.com/deepseek-ai/DeepSeek-V4-Flash-0731)、[GLM 模型页](https://deepinfra.com/zai-org/GLM-5.3-Flash)。这是供应商规格，不是 YUVI 实际可用窗口，也不是本轮对百万 token 的实测。没有为此擅自放大生产预算。

实验使用三个独立 PostgreSQL 数据库（Smoke、安装版本、当前修复版）与新的测试 subject×persona；Mem0 sidecar 的测试 scope 与 Alice 隔离。原始 HTTP 请求、每次远端输入/响应、流事件、promptPreview、控制决定、Mem0 请求及执行反馈在本机 0700 目录保存。没有读取真实私聊或向 QQ 发实验消息。

起步时两个 Harness 误并发争用生成文件，已停止仅属于实验的进程并保留无效轨迹。这些输出不进入质量分母，仍纳入可捕获费用。最初完整 Server fixture 漏传 512 维配置且复用了测试 session；保留这些失败，后续改为新 session、正确维度，并轮询实际 semantic 证据。不能把未提交的记忆当成已学习。

## 比较方法与有效输入

复用 #322 的 `live-model.ts`。补齐其真实 Provider 原生 stream 接口，才实际可运行当前 Character；没有新增实验框架。每个主要文本任务重复三次。temperature=0 仍有供应商非确定性。

| 路径           | 有效输入与控制                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 原生         | 相同部署模型与 Persona，原始 user/assistant 历史、当前原文；不经过 Character/Cognition/压缩。任务不依赖时钟；Runtime 增加的时间/语义包装列为输入差异                |
| B 生产函数     | 真正 RuntimeOrchestrator + Server Character；真实 InMemoryConversation，Memory 明确关闭；保留生产上下文投影、gate、流解析、发布与存储。这不是完整 Journal HTTP 入口 |
| C gate 消融    | 同 Runtime、Conversation、Persona、投影、Provider，关闭独立 Character gate；不会因此补回已被投影丢掉的信息。权限边界未移除                                          |
| 完整 Server    | 安装版本单独启动；当前版独立编译/启动，PostgreSQL、Journal、Mem0 都为实际实现。用私有 instrumentation 固定主要采样参数并记录原始/生效请求，模型凭据只在子进程环境中 |
| 工具信息增益   | 无文件观察的原生模型 vs 合法授权的实际文件能力；随机标记不能凭模型知识猜出                                                                                          |
| 工具同信息控制 | 原生完整文件 vs Cognition 的实际 Observation；256 字符文件信息相同；16,001 字符文件观察只含前 16,000，不能拿两者当作同信息比较                                      |

评分使用 exact nonce、纠正后的确定值、正文是否发表/存储、Python 编译与函数数量等客观检查。检查函数先处理内容，再附路径标签；这不是独立人工盲评。否定/引用只报告交付与分析事实，没有用模型自评主观人格质量。所有合成回答公开在 [synthetic-answers.json](evidence/synthetic-answers.json)；真实参数、模型别名、角色序列、输入字符数、逐调用 token/延迟/费用见 [model-calls.csv](evidence/model-calls.csv)。

## 模型结果与归因

| 场景                                           | 原生 A                               | 修复前生产 B                           | 消融/修复后                                                    | 结论                                                        |
| ---------------------------------------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 连续历史纠正：银杏-731 / 海盐-926 / 旧口令失效 | 3/3 正确                             | 3/3 正确                               | 无 gate 3/3 正确                                               | 此样本未显示 gate 的质量增益；不能由此判定全部历史投影无损  |
| 否定/引用，只分析歧义                          | 3/3 有分析                           | 原始 2/3 发表，1 次合法心跳导致失败    | 只修心跳后 3/3 发表；无 gate 原始/后续均 3/3                   | 一个失败由传输解析引起，不是模型不懂否定                    |
| 已发表 1,854 字符代码尾部确认码 松岚-852       | 修复前后均 3/3 正确                  | 0/3 正确，出现 CONFIRM-7A3F9K2Q 等编造 | 去 gate 仍 0/3；恢复正文后有/无 gate 各 3/3                    | 已发表信息逐条 800 字符截断是直接根因，单独去 gate 无法修复 |
| 90 个 Python 函数，输出固定 2,048 tokens       | 3/3 返回部分正文，均未完成 90 个函数 | 原始与只修心跳后均 0/3 发表            | 保留 length 正文后 3/3 发表，约 6,512–6,513 字符；显式 PARTIAL | 改善是保住工作成果，不是完整完成任务。原生也受同样预算限制  |

尾部实验明确区分信息与控制：C 保持相同损坏投影，所以失败率与 B 一样；补回已发表正文后两者都正确。新实现保留换行、User/Assistant 标签、时间与原文，但总体会话预算、选择与其他压缩仍存在；没有声称已恢复全部长历史的原始 API 角色结构。

gate 每次正常 RESPOND 仍需要控制调用 + 正文调用，消融只需一次。尾部修复后，三次 B 共 6 次调用、9,544 input / 107 output tokens、估算 $0.00052278；C 共 3 次、3,485 / 57、$0.00021936，两者 exact 结果均 3/3。只有三个样本且延迟波动很大，不能将此扩展为普遍速度或人格结论。

### Memory：增益存在，纠正闭环未完成

安装版本独立实例中，事实 栀子-613 写入 Mem0、跨新会话进入 RelevantMemory，并由模型正确使用。这是原生无该事实输入时不拥有的信息。

当前 #322 的绑定 Character 路径却在查询 Mem0 之前返回 MEMORY_PROVIDER_ERROR。确定性复现中 backend.search 调用次数为 0：`characterMemoryProvider.check` 要求显式 scope，`Runtime.retrieveFromProvider` 只传 subjectUserId/personaId。生产修复只用这两个已经确认的身份生成既有 `buildMemoryScope`，保留包装器所有隔离检查。

修复后两个完成写入并确认可召回的完整 Server 样本都在跨会话正确回答栀子-613，Memory status=ok。第三个样本的初次 gate 选择 SILENCE，跨会话又遇到控制格式失败/连接中断，保留在结果中；不能报告为总体验证 3/3。原始未修复样本还有 SILENCE 和错误 post-Cognition presentation 格式，均不是“正确无事可答”。见 [memory-results.json](evidence/memory-results.json)。

所有完成的纠正链都没有在下一新会话正确使用青禾-947。安装版本反复写入旧候选；当前版对“纠正：我用的是……”产生 0 候选、`no-factual-memory`，真实 Reasoner 没有为这一回合生产新事实。Conversation 保存了纠正，不等于可召回记忆已经更新；infer=false 无法补足它。报告不把检索入口修复称作完成长期学习。

### Cognition / 文件：真实操作增益与仍有的控制损失

文件由实验宿主单独创建，只授权该文件，原因来自真实 PostgreSQL conversational Journal receipt。实际 `HostReadTextEffects` 走 Host grant、Effect admission/dispatch、Observation；没有模型生成权限，也没有脚本强制 REQUEST_CAPABILITY。

当前 Chat 模型在不带/带 canonical context 的两组 256、16,001 字符文件试验中都没有选择能力（4 个任务）；其中一次把目录描述当成文件事实，其他回答没有授权路径。请求确实含有一个 opaque 能力引用，不能把失败归为“根本没有目录”。

改用实机实际配置的 GLM Reasoning 模型，分别锁定其原生和 Cognition 路径，256 字符文件三次都自行 REQUEST_CAPABILITY → 实际读取 → 新 Observation → COMPLETE，开头/结尾随机标记全部正确。无观察基线不知道标记，完整观察基线正确。证明工具产生信息/行动增益，但这不是 DeepSeek Chat 的质量提升，也不是完整 Chat→自动升级→工具→Character 的验收。

16,001 字符 GLM 试验确实读取并消费 `Coverage: PARTIAL prefix; provided 16000 of 16001`，证明 #322 的 Observation 保留通路实际到达模型。最终模型输出 `COMPLETE开头标记...` 缺少协议换行，被 parser 拒绝；同时它将缺一个字符的尾标记称为已完整看到。保留这个失败，不能算准确完成。详见 [file-results.json](evidence/file-results.json)。

## 生产改动与异常保障

| 提交      | 修改、失败前证据与修复后验证                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5b178b6` | CI Smoke 增加独立 PostgreSQL/pgvector 与迁移；main/#322 原 Smoke 都复现 503 JOURNAL_UNAVAILABLE。没有放松 Journal fail-closed；[诊断](ci-baseline.zh.md)                                                                  |
| `0ad384f` | SSE comment heartbeat 无 data 时忽略，业务数据依旧严格解析；失败前 18 pass/3 fail，后 21 pass。真实 Provider 的 `: ping` 曾让随后合法正文丢失                                                                             |
| `d713389` | 移除逐行压平/800 字符截断，保留总预算和公开文本；失败前 8 pass/1 fail，后 35 pass；真实 tail exact 0/3→3/3                                                                                                                |
| `bb77495` | 仅允许有效非空、正文相符、未过滤的 length 正文作为 PARTIAL 发布；HTTP 与 SSE 都保存 Provider finishReason/部分状态，恢复历史时注明未完成。相关 69 项通过，包括重启恢复、缺完成/正文不符/content_filter 拒绝与既有取消验证 |
| `62acf36` | 检索请求补既有 user×Character scope；失败前 10 pass/1 fail（search=0），修后 59 pass，涵盖 scope mismatch、缺身份、跨人物结果拒绝；完整 Server 真模型确认召回恢复                                                         |

`pnpm check`、`pnpm build`、根 `pnpm test` 通过：工作区 Vitest 3,661 pass / 355 skip，根 Node 脚本 63 pass；额外在专用 PostgreSQL 运行真实文件 effect 集成 11 pass。最终 Smoke 六项通过。跳过项不能算已验收；所有日志在私有目录。新字段可兼容旧调用者，但旧 UI 未必显示 PARTIAL；模型下一轮与持久 Conversation 已保存该状态。没有自动续写或抬高输出预算。

SSE 注释的处理符合 [WHATWG event-stream 规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)；未知字段、无 DONE、DONE 后业务数据、无效 UTF-8、取消等拒绝规则仍保留。

## 费用、复现与证据位置

捕获 205 次实际模型响应的 usage：183,940 input / 69,395 output tokens，供应商估算费用合计 **$0.021235425**（包括试跑及无效起步记录）；另有一次 60 秒超时，无 usage/费用。启动时并发无效试跑可能覆盖个别记录，因此这是可捕获账目的下界，不是发票或精确全部消耗。未将本地 embedding/Mem0 CPU/GPU 成本伪装为零。逐调用延迟、模型别名与采样参数均在 CSV；[accounting.json](evidence/accounting.json) 保留账目限制。

源码版本：`controlled-before` 在 `5b178b6`；`controlled-heartbeat-fixed` / `tail-before` 在 `0ad384f`；`tail-after` 在 `d713389`；`length-after` 在 `bb77495`。完整新 Server 的 scope 修复先编译实验再提交，最终生产源码与 `62acf36` 相同。早期轨迹只有 HEAD，没有完整 dirty-source 摘要；后续 runner 已增加生产源文件 SHA256 manifest，不将早期元数据冒充更强证明。

从仓库根目录，设置模型凭据到环境（不要写入命令历史），使用实际 Persona 文件：

```sh
export YUVI_AUDIT_CASES_FILE="$PWD/docs/research/runtime-model-value/synthetic-cases.json"
export YUVI_AUDIT_REPETITIONS=3
export YUVI_AUDIT_SKIP_FILES=true
node docs/research/backend-boundary-recovery/experiments/run-live-model.mjs "$PWD" --run /PRIVATE/yuvi-model-run
python docs/research/runtime-model-value/evaluate.py /PRIVATE/yuvi-model-runs /PUBLIC/sanitized-evidence
```

远端模型、base URL、API key、Persona 分别通过 `YUVI_AUDIT_MODEL`、`YUVI_AUDIT_BASE_URL`、`YUVI_AUDIT_MODEL_API_KEY`、`YUVI_AUDIT_PERSONA_FILE` 传入。每次一个独立输出子目录，不并发使用同一生成文件。只有合成任务可交给公开汇总脚本；它不是通用私聊脱敏器。

本机原始轨迹：`~/.local/state/yuvi-model-value-20261010`（0700）。实验服务已停止，保留测试数据库、scope 与证据，真实 Alice 进程继续运行。Git 仅包含合成答案、测量和工程资料。

## 未解决的问题与当前收敛点

四个修改都对应直接复现和单独归因，没有一次删除所有控制层，也没有引入新治理平台。下一批最有价值的实验是：可信纠正 → 既有 Memory admission 的语义生产；在保持相同可用信息和权限时减少 Character 控制格式依赖；真实产品 Host grant 入口 → Chat 自动升级 → 工具 → Character 的完整验收。

CONTINUE 仍不保存新增业务状态，本轮没有捕获可归因的真实 CONTINUE 重复轨迹，故未修改。长历史仍受总预算、选择/压缩影响；2048 tokens 不足以完成本次长代码任务。People/Profile/Dream/STT/主动行为没有新增真实消费者证据；这些模块不能因存在记录、显示启用或单测通过就算兑现了智能。QQ 需要在实际启动对应分支后另行验证。

Journal、Host grant、Person/Instance scope、Effect 幂等与 Cancellation 都保留；UNKNOWN/PARTIAL/FAILED 没有被平滑成 SUCCESS。本轮工程收敛点是可审查的四处生产恢复与一次 CI 装配修复。余下失败完整公开，不以报告代替已授权但未做的线上部署；本轮没有合并或部署授权。
