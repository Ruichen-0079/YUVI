# 验证结果与边界

## 生产入口与原失败

`evidence-continuity-entry.integration.test.ts` 启动实际 `apps/server/src/index.ts`、正式 Character、真实 PostgreSQL/Journal/Conversation/Effect/R5 Worker；只替换远端 HTTP 模型依赖，保留 Gate/Body/Reasoning 协议。测试不宣称 fixture 能理解自然语言。

原始 #327 `ce5e078` 的独立 detached checkout 使用同一 probe 重放：在 `Runtime.handleUserMessage` 之前强退，Journal 来源 1、Conversation 接受行 0，断言失败，零模型调用。新路径两者为 1，Worker 恢复 user-only 任务并正式提交。[原反例](evidence/entry-baseline.json)、[当前入口输入/来源/快照/Effect 摘要](evidence/entry-current.json)。没有改原 #327 工作树。

同一入口还覆盖：正常、SILENCE、TERMINATE、429、非法 Gate、SSE 取消；禁用 Worker 后重启；冻结省略回答的解释上下文，不能出现未来纠正；匿名、禁写和跨 Person 拒绝；第二/第五轮视觉、重启、复查、删除、真实 TTL；一次合法 read_text 后 PARTIAL；Gate/Body 之间 supersede/备注/Host 撤销；错误 Person 文件授权、能力在 Reasoning 等待时撤销。直接检查实际 Provider Messages、持久来源和 A9 结果。

额外真实 PG 故障/竞态回归覆盖：source 已 prepare 后撤权不能提交新记忆，已 APPLIED 仍按原真相幂等对账；应用角色不能改来源/TTL/owner；等待异步授权期间能力被撤销，不打开文件，终态 PROVEN_NOT_APPLIED；Host maintenance 与过期传输 token 分离，但维护回调失效仍无调用。原 #327 30 轮/P8 损坏/部分读取入口继续通过，未恢复直接 Chat 验收旁路。

全量 PG 首次扩大运行捕获了旧测试依然复用观察依赖答案/Person projection 少 authorityRevision 字段的预期，以及 reserve/close/free-port 的真实竞态。一个 Server 的健康检查进入另一个 fixture gateway，引发 EADDRINUSE 和无效 JSON。已迁移预期并检查原本用户可见答案仍正确；正常启动改为 OS 原子绑定并向父 Host 发送 bound-port readiness，健康检查不再猜空闲端口。没有捕获端口冲突后悄悄改用直接 Chat 或其他服务。

本机执行 `pnpm check`、`pnpm build`、`pnpm test`、显式 PG 的 Authority/Finalized/Migrations/Effects/Server 测试。Check CI 加入新正常入口；Durable Conformance 同样从全仓 test 运行，归档摘要，不将缺少 PG 的本机 skip 当完整 PG 通过。远端最终状态以 PR 对应 SHA 的检查为准。

## 真实模型

2026-10-15/16 实机只读核对独立安装：DeepInfra compatible Chat `deepseek-ai/DeepSeek-V4-Flash-0731`，Reasoning 配置 `zai-org/GLM-5.3-Flash`，实际安装仍 `MEMORY_BACKEND=mem0`、repository postgres。本分支没有成为她的运行版本。

隔离实验明确将 Reasoning 路由设为同一个 DeepSeek，**不是隐式 fallback，也没有修改安装配置**；本批没有重测 GLM 可用性。temperature=0、max_tokens=2048、声明窗口 65,536；Persona `evidence-synthetic-v1`、独立 Character、Person/scope/schema、正式可信 Host grants。向量索引关闭，故本批不证明完整混合检索质量。

| 实验与生产 SHA                    | 观察结果                                                                                                                                                                                   | 不得扩大解释                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初次 `run-three`，177bb4e，dirty  | 自然面试→周三→周四；取消轮编辑器在重启后召回；寒暄 skipped、Person B 无私人事实、引用不触发改成周五                                                                                        | 日期第一次被误当 supports 宽泛面试命题，结构不正确；英文组合查询漏选编辑器，模型未收到事实。失败保留                                                                  |
| 修正后 `run-six`，0325838，dirty  | 每步正式投影显示：宽泛面试 current + 周三 current；自然纠正后宽泛事实 current、周三 superseded、周四 current；重启回答周四/周三作废；取消轮随机编辑器正式 complete，重启答对；寒暄 skipped | 八轮模型与数据库状态已取得。末尾报告 SQL 错用 created_at，Harness 总状态 FAILED；不改写失败原文件，也不为补导出重复跑模型。后续只读核对持久状态，脚本已改 observed_at |
| `run-tool`，57dab0a，dirty        | 自主选择实际文件读取，两个随机标记正确；writeMemory=false，正式零 retained reports，重启不编造标记                                                                                         | 这是禁保留对照，不是连续性失败或长期学习成功                                                                                                                          |
| `run-tool-retain`，57dab0a，dirty | 自主 NEED_COGNITION→REQUEST_CAPABILITY，真实 read_text 仅 1 次 APPLIED；预算 PARTIAL 后答对两个标记；重启/新会话从报告答对，明确执行/目标完整性区别；Person B 无标记                       | 仅一个有判别力的真实工具任务。不能宣称任意模型/插件可靠，也不是观察永久写入 Memory                                                                                    |

原始提示没有文件随机标记。真实 REQUEST_CAPABILITY 的输入也没有标记；直到 Host 实际读取后的 Gate/Body 才有。重启后本人输入再次含报告，Person B 的所有输入不含标记。脚本只提供一个合法文件授权，没有强制模型控制帧。[安全输入摘要](evidence/model-input-summary.json)、[逐轮回答/投影/关系/正式存储核对](evidence/model-results.json)。

真实模型 SHA 明确保留。后续提交修复了报告 CJK/转义边界、披露时过期与异步撤权的 leaf fence，相关故障通过确定性实际 PG 回归，未将旧模型样本冒充这些后续提交的重新远端测量。公开 evidence 只含合成来源、结果、输入 hash/角色/字节与控制帧；原始完整轨迹保留在本机 0700/0600 目录。

## 成本、延迟与未知

四组有实际模型调用的实验共 **74 次**，usage 可得部分合计输入 **89,569**、输出 **3,405**、cached input **28,160** token；Provider `estimated_cost` 合计 **$0.00471984**，另 1 次取消调用费用未知。不是价格表估算或最终账单。取消轮 A9 共保留 3 条 Provider UNKNOWN（两组不同运行），没有凭 usage 或模型正文将它们升级为 APPLIED。两次工具各自 APPLIED；没有工具 UNKNOWN 被重试为成功。

[逐调用 CSV](evidence/model-calls.csv)记录 phase、实际 model、HTTP、Token/缓存、首字节/首正文/总延迟、输入字节与错误。SSE 的首字节不等于首个可见 Token；未知留空。每组上限 60 调用，已知估算费用在轮次间达到 $0.10 即停止；不是原子账单上限，对未知费用不能保证严格封顶。启动前 PATH、文件 ownership、隔离 PG 未运行的四次拒绝均无远端模型调用，保留本机日志，没有为“测试数量”重跑已成功探针。

候选拒绝与摄取状态来自正式 parent/child，不用 HTTP 200 充当完成；本组未做长期 backlog/吞吐压测。Context 源占比目前可直接审查角色长度、语义 source/dialogue 与 retained-report 命中，尚无覆盖所有 canonical blocks 的统一成本分摊，不能声称成本最优。

## 仍阻断整体验收

图片观察的结构、TTL、跨重启、复查与身份边界是 **真实 PostgreSQL + fixture Vision** 证据，本批没有独立核实可用于实验的真实 Vision 路由并调用它。不能把这个测试写成视觉语义效果提升。

观察报告写入尚未与 A9 终态统一提交，跨所有 crash 点恢复未完成；持续来源审计、全资产迁移、产品 Host、QQ PRIVATE/GROUP、全域隐私删除等继续开放。没有百万级新观察压力、长期队列成本、全模型空间或真实 Alice 切换验收。参考 [总矩阵](README.zh.md)，这些不是 CI 绿色能消除的缺口。
