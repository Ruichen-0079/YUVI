# Smoke 基线诊断

2026-10-10 核对 PR #322：OPEN，HEAD `e92e30bbd4c9242c74860bf48d1eed8bde40e58e`；Check 的最新 run `38018858823` 在 Smoke 失败，Linux Persistence 与 Durable Conformance 成功。

独立 checkout 的 main `0d894cc` 和 PR HEAD 分别构建后执行原 `scripts/smoke.ts`，均在 `POST /message` 得到 `503 JOURNAL_UNAVAILABLE`。两版 Smoke 文件 SHA256 相同：`06afb985a480adc5b1b6567ffe49cbdaca8ef02f8add0845381f7bd1643d151d`。

真实初始化链：`createAppContext` 只在存在 DATABASE_URL 时建立 `PostgresJournalRepository`；`HostConversationalReceiptAdmission.admit` 在没有 Journal 时拒绝；message route 将拒绝映射到 503。in-memory Conversation/Memory 不提供持久 Journal。故这是已有测试装配缺失，非 #322 引入的回归。

使用本机另建的专用测试数据库、现有全部迁移、mock Provider 和原生产 Server，六项 Smoke 全通过。CI 现在为 Smoke 提供独立 pgvector PostgreSQL 服务，显式迁移后运行；其他测试不继承 DATABASE_URL。Smoke 缺数据库时给出明确先决条件。没有增加 in-memory Journal 替代或放松生产准入。

原始日志仅在操作者本机受保护实验目录保存，后续报告汇总最终回归与远端 CI。此修复没有模型质量含义。
