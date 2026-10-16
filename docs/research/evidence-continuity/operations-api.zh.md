# 升级、保留与 API

没有执行真实 Alice 升级。新的 Server、Runtime、Provider、Memory、Effects、Protocol 必须配套构建，不能只替换一个包。

独立 Host 可用 `SERVER_PORT=0` 由 OS 分配端口，通过父进程 IPC 的 `yuvi.server-ready.v1` 获得实际端口；正常指定端口仍遵循原行为。常规 Desktop Supervisor 仍使用配置中的固定 Runtime URL，尚未接入动态端口发现，不应为该产品配置 0。readiness 只含端口，不携带凭据，也不替代 HTTP 健康检查或改变 Character 装配。

## 数据库与启用

隔离库使用正式 `pnpm db:migrate`：037 接受用户任务/nullable assistant/frozen dialogue/rejected propositions；038 观察投影及 owner/time 索引；039 只允许向擦除 tombstone 单向变更的数据库 guard。Authority 启动核对正式迁移回执；缺失不带病运行。应用角色与 migration owner 分开，按更新后的 `packages/memory/operations/provision-roles.sql` 授权；应用不能改历史、拥有者、digest、TTL，也不能 DELETE/TRUNCATE。

先备份并验证可恢复副本，停写升级 schema/角色，再启动相同版本服务并预检查。没有在 Alice 上演练正式切换/备份恢复；仍须后续单独授权。旧二进制不理解 user-only ingestion、附加 Provider 授权 basis、观察与新的状态投影，**不能直接向新库降级写入**。回退须冻结写入并恢复已验证的备份/相容版本，不能删除新历史来制造旧 schema 兼容。

观察保留需显式配置：

| 设置                                 | 默认 / 合法范围               | 含义                                                      |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| `YUVI_OBSERVATION_RETENTION_SECONDS` | 0 / 整数 0..86400             | 0 不保存/披露持久报告；其他为限期投影                     |
| `YUVI_OBSERVATION_RETAIN_IMAGES`     | false / 共享严格 boolean 解析 | 额外保留允许复查的原图，最大 20MB；不开启仍可保存结构报告 |

还需可信 Host + PostgreSQL Authority、合法 PRIVATE 来源和该轮 writeMemory 允许。`writeMemory:false` 同时禁止保存观察；readMemory:false 不装入报告。此轮禁写不会删除以往已获准保留的数据。禁用保留也不等于数据库物理擦除；到期清理与完整隐私删除分开。

## 产品读取

请求必须携带自己的 Host bearer，不能用 operator bearer 冒充 Person；token 不进 URL。所有查询带所属 `sessionId`，并受正常 Host Origin/session ownership 约束。普通网页的凭据签发/轮换产品流程仍未完成，本批未把 operator token 发给客户端。

| 路由                                                      | 返回 / 边界                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /observations/v1?sessionId=...&limit=...&cursor=...` | `observations.page.v1`，稳定 ID、游标、OK/UNAVAILABLE，最多 32                                                             |
| `GET /observations/v1/:id?sessionId=...`                  | `observation.v1`，source/provider/time、APPLIED action、NOT_INFERRED goal、报告/原图可用性；不可见 404，不泄露他人存在性   |
| `DELETE /observations/v1/:id?sessionId=...`               | 正式清除投影 payload/image 的 COMPLETE；未知提交仍 UNKNOWN 文义，动作回执保留；没有全域隐私删除含义                        |
| `GET /v1/conversations/history?sessionId=...`             | Authority 模式确认 session 身份；观察依赖答案改为引用提示，原始用户话保留；user-only ingestion ID/请求决定明确不等于完成   |
| `GET /memory/v1/ingestion?scope=...&id=accepted-user:...` | 原 operator 受保护的状态 API；`sourceLifecycle`、可空 assistant、拒绝命题与正式状态，未 materialize 仍 UNKNOWN，不是假成功 |

`packages/protocol` 导出严格 DTO 和 `ObservationClient`，使用调用方提供的认证 transport。`MemoryKnowledgeClient` 增补 user-only 状态字段。旧助手任务和 ID 仍可读，其 assistantMessageId 仍是字符串；新客户端必须允许 null，不能用“无 assistant”当作未接纳。HTTP 路由与实际 TypeScript shape 的测试通过正常 Server 执行。

示例（合成）：

```json
{
  "schema": "observation.v1",
  "kind": "READ_TEXT",
  "availability": "UNAVAILABLE",
  "unavailableReason": "EXPIRED",
  "goalStatus": "NOT_INFERRED",
  "coverage": "BOUNDED_PROVIDER_REPORT",
  "sourceArtifact": "UNAVAILABLE"
}
```

这里只展示状态字段，完整 schema 还要求稳定 source/id/time/action；过期对象不能含 evidence。空 page 只说明没有可列的保留报告，不是工具执行历史的否定证明。

## 能力控制与恢复

本地管理认证的 `POST /capabilities/read-text/authorize` 接受绝对 path、sessionId 及可选 personId。Authority 下给私人 Person 授权必须明确 personId；不传时仅匿名控制合同，不生成 Memory 身份。`POST /capabilities/read-text/revoke` 接受 sessionId，撤销在途/未消费的同一进程授权。控制事件记录 operation/target scope，路径不进入控制 receipt；A9 自身维持其原有受限执行描述。重启不恢复文件能力。

Semantic Provider 失败看持久任务与错误码；拒绝命题看 PARTIAL/rejectedPropositions；正式权威写入以 processing/ingestion 为准。HTTP 200、模型说“记下了”、排队与持久成功互不等价。报告保留失败目前只有运行告警和 A9 事实，缺少完整 durable 修复接口，是本批已明确的阻断，不能让管理员靠重跑工具猜测结果。
