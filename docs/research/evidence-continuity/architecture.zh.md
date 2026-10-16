# 实际数据与执行边界

## 已接受的经历

Authority Server 启动要求 Journal 与 Conversation 支持同一个 PostgreSQL 事务。正常 HTTP、SSE、WebSocket 在调用 Runtime 前，锁定原始事件键并检查可信 Host grant，原子提交 Journal 来源、用户 Conversation 行、稳定摄取键、允许/拒绝决定与 scope。提交结果不明返回 UNKNOWN 文义，不能告诉客户端“肯定没提交，可以随便重试”。相同事件重放比较内容、trace、身份和决定；冲突拒绝。没有稳定事件 ID 的全新 HTTP 重发仍是新事件，不承诺网络层 exactly-once。

R5 discovery 从用户行发现未 materialize 的任务；assistantMessageId 可空，旧成功助手任务仍可恢复。Authority 的新助手行不再重复创建事实任务。正式 `pending/retryable_failed/partial/terminal_failed/complete/skipped` 与聊天可见正文分离。后台失败不会删掉已经接受的原话。

提取前保存 `memory_semantic_jobs.input_context`，重试沿用同一来源快照。加载严格在来源 sequence 之前、且在其接纳时已经完成的对话，避免 Worker 稍后看见未来修正。身份、受众不同以及禁写/短期视觉依赖的缓存不进入解释上下文。前序问题可以解释“周三”，不能冒充用户已确认的事实。每个命题必须在当前用户原文中唯一定位准确证据；一个提案错误不会否决其他独立有效提案。无有效命题与全部提案无效是不同结果。

候选按 recent/text/vector 交错后去重，再执行既有有界接纳。真实模型发现日期细化被错误支持宽泛“要面试”命题，故增加命题等价说明与 canonical support 引用格式：新属性不是同一命题的重复；supports 使用已呈现目标的规范内容。这是模型语义合同加确定性引用验证，**不是字符串相等证明语义相同**。无效项保持拒绝及原因。

来源授权在模型前后及正式权威事务提交前重新验证；已提交事件的幂等对账先返回原真相，不因随后撤权伪造“从未写入”。原 Host grant 过期/撤销后，尚未完成任务可能显式 terminal_failed；保留用户来源不等于永久授予后台处理权限，重新授权恢复政策仍需产品建设。

## 观察与回执

`retained_observations` 是 A9 APPLIED 的限期内容投影，主键由 attemptId 派生，外键关联真实执行。保存前验证实际 receipt、source、主体、Person/Persona、PRIVATE audience、用户允许保留。任意模型 JSON 或声称“已执行”不能创建正式观察。Provider/model、时间、置信度、结构字段、摘要和原图 digest 分开记录。

OCR、scene、objects 分别预算。持久报告也有显式中部省略标记，CJK/转义内容满足 80KB JSONB 边界；模型 Context 使用更小的每字段 head/tail 投影，单个长 OCR 无法吃掉场景与对象。它不是完整图片或全文承诺，`coverage=BOUNDED_PROVIDER_REPORT`。内容保持不可信报告，OCR 里的指令无执行权限。

正常 Runtime 取最近最多 4 个报告；分页产品读取最多 32。读取和每次 Provider 暴露重新验证当前主体、原始来源授权、TTL/删除状态；原图复查还验证内容 digest。不能跨 Person、Persona、Instance、audience。当前实现只接受 PRIVATE，不为 QQ GROUP 开口子。历史助手答案若依赖观察，后续短期重建、L1/情节、提取上下文和 History API 不再复用其内容，通过合法报告重取。原始用户话仍保留。

TTL 即时限制读取；运行中定时/启动时有界清除 payload/image，并发清除使用行锁 skip-locked。进程停止期间不会运行物理清理；重启后恢复，数据库备份中的内容不在该清除合同内。删除只清 retained payload/image，保留 tombstone、原始来源和动作回执。**这不是全域隐私删除**，也不代表历史 Journal/Conversation/已披露内容被撤回。

报告保存失败保留 A9，不重做动作；但缺少同事务内容保存/恢复，完整性阻断见 README。观察尚未作为工具事实进入永久语义 Memory：当前永久事实仍要求合法用户来源；不会将工具计划伪装为完成经历。

## 权限、快照与新鲜度

`verifyAuthority` 检查当前执行权；`checkFreshness` 返回 CURRENT/STALE/UNKNOWN；Manifest 记录 CAPTURED_AS_OF。选中记忆后来被 supersede 仍可作为授权历史快照，不能继续标成最新事实。Body 若快照已变，在实际 Messages 中加入 Host 新鲜度声明，计入输入预算及 digest；预算放不下显式要求刷新，不无限循环，也不重新命名为 AUTHORITY_REVOKED。

Person 普通资料 revision 与 authority generation 分开：备注/显示名更新不撤销身份，绑定/删除重建改变授权代际。旧配置首次升级保持原 authority generation，避免普通编辑使所有已有 grant 意外失效。P8 普通动态知识变化属于 freshness，真正 Runtime/Persona 所有权改变仍由执行代际治理。

Provider、Publication、工具维持实时 Host 检查。后台向量维护使用 Host scope maintenance 的明确授权回调和审计 basis，而非把一个过期传输 token 永久当作维护凭据；它不能绕过选中 Context 自身的权限检查。该回调不在模型 DTO/API 中。

文件控制仍是 Host 本地能力：显式 Person 目标在来源 Journal 与当前原生绑定上验证，省略 Person 在 Authority Server 中只适用于匿名会话；不能让另一个 Person 先占 session 就消费私人授权。授权单次消费、进程内有效；控制者替换/撤销可使在途引用失效，实际文件 leaf 在异步验证后再查一次。不会因为撤销去重写此前 APPLIED，也不会把 UNKNOWN 自动重试为 APPLIED。
