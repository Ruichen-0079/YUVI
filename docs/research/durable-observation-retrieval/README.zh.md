# Durable Observation 与检索质量

基线 #328 `a7b5e9b`，堆叠依赖 #322→#328；独立 worktree/分支 `feat/durable-observation-retrieval`。本切片完成 **A9 与限期报告的提交合同**，并完成两张合成图片的真实 Vision 小样本。检索工程独立推进，**本报告不表示 B 或 R5 整体验收完成**。没有修改、重启、迁移或部署真实 Alice，没有访问她的私人数据库或发送 QQ 消息。

## 原失败与现在的行为

旧 `read_text` 在 Dispatcher 提交 APPLIED 后才保存报告；Vision 在 Runtime 收到 Provider 结果后才保存。两次提交之间崩溃会留下 APPLIED 和永远找不回的正文。旧失败案例仍在 #328 的研究证据中，新的 SQL 故障测试保留相同的执行事实，没有将已发生动作改成失败。

现在实际 Host adapter 在获得结果后，把有界报告作为**同一终态事务的 SQL 投影**交给既有 Effect Store。事务锁顺序、lease/fence、UNKNOWN、幂等和恢复均保留。没有新增队列或执行成功账本，也没有用重新执行恢复报告。

1. 同一 PostgreSQL 事务写报告与 A9 APPLIED。040 的双向延迟约束校验 exact attempt、report ID 和 digest；成功提交的 STORED 不会只剩单边。
2. 投影 SQL 或校验失败时，回滚 savepoint 内的私人报告和 STORED 终态，再提交原本已证明的 APPLIED + `FAILED/REPORT_PERSISTENCE_FAILED`。这表示执行成功、报告未保留，**不是可重建正文的成功**。
3. 连接断开或整个终态事务结果不明，沿用 A9 诊断/UNKNOWN。查询实际已提交的终态可解决回执丢失；没有终态时不能由报告、模型或重做工具补造 APPLIED。
4. 重放只返回原执行真相，不重新运行投影。删除、过期、旧版缺失均不能借重放复活内容；相同 attempt 的报告 digest 不一致返回 CONFLICT。
5. Journal 和 Host grant 的事务内验证复用同一 SQL 连接。单连接池的实际回归保证不会因嵌套申请连接而死锁。

外部动作与数据库不可能成为一个事务：Adapter 已调用、终态未提交时强杀，动作有可能发生，数据库只能恢复为 UNKNOWN。该阶段报告也可能丢失；本实现不声称消除了外部执行的不确定性。

## 执行事实与报告生命周期

| 状态 | 含义 |
|---|---|
| NOT_STARTED / NOT_APPLIED | 尚无合法执行，或已证明未执行/拒绝 |
| UNKNOWN | A9 不能确认实际结果，不自动重复 |
| APPLIED + NOT_REQUESTED | 默认关闭或用户禁止保存，不持久化报告正文、图片及内容 fingerprint |
| APPLIED + STORED | 终态 COMMIT 包含有界报告；不代表永远允许读取 |
| APPLIED + WITHHELD | 保存时来源授权已失效，不写私人报告 |
| APPLIED + EXPIRED | 保存前已超过期限，不写私人报告 |
| APPLIED + FAILED | 正式诊断保留失败；不能承诺找回正文 |
| APPLIED，当前 EXPIRED / DELETED | 报告曾提交，当前内容不可披露，执行回执仍在 |
| APPLIED，LEGACY_MISSING | 旧历史无报告，无原子保留证明；不伪造或重新执行 |

`GET /observations/v1/executions/:attemptId?sessionId=...` 返回 `observation.execution.v1`：执行状态、是否有 APPLIED 回执、提交时保留结果、当前报告可用性。`ObservationClient.execution()` 提供类型化访问。只允许当前可信 Host 主体读取自己的 Person/Persona/PRIVATE audience；operator bearer 不能绕过；不存在与不可见对象同为 404。不会暴露文件参数或报告全文。现有 list/detail/erase 路由兼容保留。Runtime 继续使用实际可披露报告；失败报告的诊断通过正式执行状态接口与 A9，不会编造一条有正文的 Observation。

## 隐私与迁移

Observation 默认关闭，必须显式启用；原图单独开关。读取同时检查当前读者与原始来源授权、Person/Persona/Audience、digest、TTL 和 tombstone。TTL 即使在事务期间到期也立即阻止披露：STORED 是提交事实，不是 AVAILABLE 保证。清理仅抹除内容/图片，执行回执与无内容摘要不删；显式删除比 TTL 清理有独立来源。普通能力撤销阻止后续工具执行，原始 Host 来源撤销阻止旧报告正文披露。

部署前先用专用迁移凭据应用 040，再启动匹配代码。应用启动校验 schema digest，并拒绝可修改 commit digest/来源/期限的角色。旧报告 `commit_digest=null` 保持旧 provenance，不回填假证明。040 后旧程序的双提交 INSERT 会被拒绝，因此**不能把旧二进制继续写报告当作安全回滚**；恢复旧版本须先关闭观察写入或采用经验证的前向恢复。真实 Alice 未执行此迁移。

私人正文只在可擦除的 retention 表；A9 仅存摘要、状态和引用。删除不会清理已有备份/Provider 留存；旧备份恢复可能早于删除 tombstone，恢复时必须重放后续擦除或禁止报告披露。本轮未完成全域隐私删除、备份擦除与完整恢复演练。

## 证据与开放门槛

- [故障合同](verification.zh.md)：生产 Dispatcher + 实际 PostgreSQL + SIGKILL/断连/SQL 故障；协议 Fixture 用来定位链路，不证明语言理解。
- [真实 Vision](vision.zh.md)：Qwen 实际看图，DeepSeek 实际回答，正式 Server/Character、限期报告、重启及删除。
- [检索调查](retrieval.zh.md)：无序候选截断与跨语言词项缺失是不同问题，不能把百万向量延迟等同于语义召回。

本轮不关闭：全部旧资产迁移、持续审计、备份恢复、冷缓存/多 scope 长压力、模型空间升级、Desktop/WebUI Host 接管、QQ 受众安全、全部 Plugin Effect 迁移、工具观察长期语义学习、全域隐私删除。真实 Alice 切换仍阻断。
