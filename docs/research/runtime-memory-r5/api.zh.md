# Memory Product API v1

本阶段提供本地 operator 读取 API。复用 `requireLocalDashboardAccess`：loopback、Origin 和已配置的 dashboard token；开发模式配置 token 时必须用 Authorization Bearer，不在 URL 传 token。`MemoryService.getKnowledgeReader` 检查 Character/Persona 所有权。operator 可读取该 Persona 的合成/历史 Person 分区；它不是普通聊天主体的任意 Person 读取授权。未来多主体 UI 必须接入正式 Host principal 披露策略。

所有读取必须显式提供 canonical `scope`。模型 Runtime 读取另外要求 Host `MemoryReadAuthority`，不会从 URL 或 `subjectUserId` 获得权限。后端未启用返回 503 `UNKNOWN/MEMORY_AUTHORITY_NOT_ENABLED`，数据库失败返回 503 UNKNOWN，不返回空列表冒充无记忆。

| GET 路由                | 参数                         | schema/读取责任                                                                                                 |
| ----------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/memory/v1/overview`   | scope                        | `memory.overview.v1`：持久版本、投影水位、增量数量、兼容分类、worker 最近错误/模型空间、最近 10 个迁移 manifest |
| `/memory/v1/current`    | scope, limit, cursor, state? | `memory.page.v1`：默认 current+conflicted；显式状态筛选可检查历史                                               |
| `/memory/v1/detail`     | scope, id                    | `memory.knowledge.v1`：命题内容、来源 ref、source/commit 时间、状态、解释性质、选区                             |
| `/memory/v1/timeline`   | scope, limit, cursor         | `memory.page.v1`：按持久形成版本倒序的命题历史；不是完整 Journal 时间线                                         |
| `/memory/v1/relations`  | scope, id, limit?            | `memory.relations.v1`：单跳 typed 边、持久版本、limited；不冒充完整 A→B→C 图                                    |
| `/memory/v1/ingestion`  | scope, id=finalizedTurnId    | `memory.ingestion.v1`：正式完成/待处理/失败、materialization 阶段、计数、下一次尝试、完成时间                   |
| `/memory/v1/processing` | scope, id=jobId 或 recordId  | `memory.processing.v1`：语义提取状态或对应 vector outbox 状态；CURRENT/MISSING/RETIRED 投影                     |

limit 默认 20、允许 1..100。游标包含 scope、首次读取版本 anchor、最后版本；BigInt 水位/数量用十进制 string，防止 JavaScript 精度损失。游标不包含敏感正文。跨 scope/无效游标拒绝；不是历史快照：翻页期间旧命题状态可以被新的合法纠正改变。sourceAt 是来源记录时间，不是模型猜测的事件发生时间。

不同状态不会混淆：排队 pending ≠ complete；提取任务 complete ≠ authority 写入 complete；vector complete ≠用户知识已经被模型使用；UNKNOWN ≠失败后安全重试。找不到 detail 返回 404 UNKNOWN；未知 ingestion 返回 404 UNKNOWN。无语义任务且无 index rows 的 processing 返回 null/空数组，不声称已处理。

产品 DTO 使用显式字段白名单，去除 arbitrary metadata、旧导出的未知顶层字段和未校验 lineage；legacy lineage 仅保留在保护的 authority payload，不伪装为新验证来源。内容是命题，来源为稳定 Journal ref 和 Unicode 选区。展示来源时不能自行加载原始私人 Journal，需要相同 Host 披露边界。`MODEL_PROPOSED` 不表示 verified truth。`integrity=NOT_VERIFIED` 明确缺少全域审计证明，即使版本相同。

TypeScript Client 位于 `packages/memory/src/authority/client.ts`，由 memory 包导出。传入现有已认证 HTTP transport，HTTP 非 2xx 必须由 transport 抛出/解析 `MemoryProductError`。例如：

```ts
const memory = new MemoryKnowledgeClient(authenticatedGet);
const page = await memory.current({ scope, limit: 20 });
const history = await memory.timeline({ scope, cursor: page.nextCursor ?? undefined });
const detail = await memory.detail(scope, page.records[0]!.id);
```

Current 与 Timeline 的游标虽使用同格式，但消费者应使用各自响应的游标，不复用不同查询的分页位置。Client 当前 Overview 类型只声明基础字段，扩展的 migrations/workers 尚需统一 schema；Ingestion Client 类型也仍需收紧。当前样例接口不能视为所有未来 WebUI 功能完备。

完整隔离 Server 实际响应见 [http-example.json](evidence/http-example.json)。路由测试使用真实 PostgreSQL，覆盖 foreign Persona/ID、remote、Origin、token、游标及 metadata redaction。未提供 Retrieval Evidence 的持久选择/排除 trace、完整关系图、偏好/目标类别筛选、真正删除/隐私清除或后台操作 mutation API；这些是正式阻断，而不是由前端推断补齐。
