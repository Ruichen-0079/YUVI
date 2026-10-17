# 提交合同与故障验证

生产提交 `70fd46f`，回归提交 `e67160c`，基于 #328。2026-10-17 从保留的磁盘状态重启**自有** 31508 PostgreSQL16.15，再创建/删除独立测试 schema；没有操作 5432 或 Alice 的数据库。公开证据只含合成数据。

[故障结果](evidence/observation-atomic.json)、[实际 Server/Character 输入摘要与状态](evidence/server-entry.json)。前者通过生产 Dispatcher/Store、实际 SQL 和单独 Node 子进程；adapter 是有实际本地读文件与调用计数的 Host fixture，不是语义质量证据。后者从真实 Server 启动入口，经可信 Host 和协议一致 Provider fixture。

| 注入位置 | 持久结果 | 恢复/重执行 |
|---|---|---|
| start 前 SIGKILL | 没有调用、没有终态/报告 | 证明未执行后只首次实际调用 |
| adapter 返回后 SIGKILL | started、无终态/报告 | 恢复 UNKNOWN；调用总数1，不重做 |
| 报告 INSERT 后、终态前 SIGKILL | 两者回滚 | UNKNOWN；调用总数1，不重做 |
| COMMIT 后 SIGKILL | APPLIED + STORED + 报告 | 重启读取同一提交，不重做 |
| COMMIT 已执行，响应 seam 抛 ECONNRESET | PostgreSQL 保留同一提交 | Dispatcher 从数据库诊断正确 recorded=true，不重做 |
| 投影中 SQL 除零/正式入口 INSERT trigger 失败 | savepoint 回滚报告，APPLIED+FAILED | 不谎报保留，不重做 |
| 投影写入后 pg_terminate_backend | 实际数据库连接中断、事务回滚 | 终态 UNKNOWN，不重做 |
| 报告与终态引用不匹配 | deferred constraint 拒绝 STORED；APPLIED+FAILED | 无悬挂报告，无假成功 |
| TTL 在 SQL 提交期间到期/读取时到期 | APPLIED 历史仍在 | 立即 EXPIRED，HTTP/Context 无正文 |
| 原始 Host grant 在 Provider 调用与保存间撤销 | APPLIED+WITHHELD | 无私人报告，无后续结果披露 |
| 保存后重启/删除后重放 | APPLIED 不改，正文保留或已擦除 | 不重建已删报告；异 digest CONFLICT |

COMMIT 响应丢失是对**实际已提交 SQL**的 transport seam 注入，不冒充穷尽真实网络分区；pg_terminate_backend 则实际关闭数据库连接。没有测试可保证任意外部执行与 PostgreSQL 原子提交；不明窗口诚实保持 UNKNOWN。真正副作用 Plugin 的全部迁移仍不在此切片覆盖范围。

正式入口验证原图单独开关、跨轮/重启恢复、长 OCR 独立字段、Person 隔离、删除、TTL、默认关闭、禁止保存、工具 PARTIAL 与撤权；新增 execution API 的 own/foreign/read-after-erasure 与 SQL 故障状态实际路由断言。单连接池测试验证 Journal/Host grant 在同一客户端读取；应用角色测试拒绝修改 commit_digest。

复现（仅隔离库）：

```bash
YUVI_PRODUCTION_PATH_TEST_DATABASE_URL=postgres://.../yuvi_pr_... \
YUVI_MEMORY_R5_TEST_DATABASE_URL=postgres://.../yuvi_pr_... \
YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY=/protected/new-output \
pnpm --filter @companion/server exec vitest run \
 src/observation-atomic.integration.test.ts \
 src/evidence-continuity-entry.integration.test.ts \
 src/conversation-host-identity.integration.test.ts
```

测试要求本地 31508/yuvi_pr_* 或显式 CI 隔离库，不能向任意数据库注入强停。故障套件和正常入口进入 CI 的正式 PostgreSQL 门禁。最终 check/build/test 与远端 CI 以 PR 最新结果为准；CI 全绿不等于 R5 全部迁移、产品接管、全域删除或长期可靠性已完成。
