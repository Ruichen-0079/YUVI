# 性能与资源实测

[执行计划、原失败、CPU、并发和冷启动](evidence/performance.json)。使用独立 PostgreSQL16.15/pgvector、127.0.0.1:31508 的合成 scale 数据库。机器报告 24 logical CPU、约 50.1 GB RAM，与其他应用共享资源，不是独占性能机。没有清理全机缓存或重启真实 Alice。

原百万历史仍在，复制了 1 万/10 万负载 scope。百万域为 1,000,050 历史、约 900,001 current、99,999 superseded、50 legacy；较小域同样保留失效比例。并发负载后来增加 40 条合成历史（20 unattributed、20 current），实际 overview 随每次测量保存，不能把“10 万”当精确不变行数。

## 排序与访问代价

旧 #330 全匹配排序与新生产 Reader 查询在同一数据库对照。最后一次带 CPU 计量的 30 个热样本（另两次预热）混合查询：

| 名义历史 | 新 p95 / p99 | 同机 #330 p95 |
|---|---:|---:|
| 10,000 | 1.59 / 2.60ms | 3.77ms |
| 100,000 | 1.86 / 1.89ms | 27.42ms |
| 1,000,000 | 2.71 / 3.22ms | 140.52ms |

另一次最终点查修正测量百万 p95 为 2.35ms；此前 #330 的 138.36ms 是不同批次，不作为同机同次精确比率。罕见标识、混合、高频和三需求查询分别测量，计划和 BUFFERS 均公开；不是以旧 2.51ms 丢答案路径作性能目标。

百万混合 32 次请求的同一 PostgreSQL backend CPU（含预热）新约 user20/system10ms，旧约 user3880/system420ms。时钟 tick 分辨率 10ms，排除可能的 parallel worker CPU，不代表整机能耗或完整回答成本。三需求测量是并发提交给单连接 Reader 的 SQL 工作量，p95 约 4.95ms；完整五需求还包括模型和远端 embedding，见 Runtime 证据。

I/O 证据主要是实际 EXPLAIN BUFFERS 和数据库页计数；没有启用完整物理 I/O 时序追踪，`blk_read_time=0` 不能解释为没有 I/O。RAM/CPU 与其他程序竞争，结果也不是独占硬件 SLO。

保留过的反例很重要：初版 posting 在新 scope 上仍因统计滞后选错索引，10 万 p95 达 154ms；确实扫描了 100,000 正文。043/044 和受限 lateral 点查修正该计划，不是只运行 ANALYZE 后挑好成绩。新正常路径每词至多33 posting、每 query 至多32词，排序作用在有界集合内。高频旧目标可能因此漏掉，已标 PARTIAL，不宣称全局精确 Top-K。

## 索引、写入和恢复

百万有效 generation 的在线分批回填 1,001 批，处理 1,000,050 行，约 141.9 秒；每批 checkpoint 同事务，并发新写由触发器维护。该总用时不等于阻塞写入 142 秒，但本批没有完整采样每批锁等待 p99，因此不宣称零阻塞。

该首次回填发生在增加“每批替换旧 posting”的完整修复入口之前；最终修复合同用实际 PostgreSQL 小样本验证，未再做百万级完整重建。因此141.9秒不是最终修复/损坏恢复 SLO。正常检索 SQL 的最终性能不受该运维入口改变。

posting 表及其索引 `pg_total_relation_size` 约 **3.52 GB**；另有 Projection 候选覆盖索引约 **264 MB**。细分：posting PK约1.536GB、record清理索引184MB、seek索引883MB。它们是 PostgreSQL relation 字节，不能拿共享文件系统的 df 差值冒充精确物理增量。索引大小是真实代价；更长正文、多 generation、vacuum 和容量压缩尚未长期验收。

四 Reader、两 Writer 的短并发实验为 100 读、20 次 prepare/commit/随后读取。目标读取100/100，写后读取20/20，零任务错误；之前一次 fixture 未给解析身份，20 条成为 unattributed，读取全部拒绝，保留为身份控制而非“确认数据丢失”。新实验每个 backend RSS 约35–48 MiB，包含共享页，不可简单求和为独占内存。CPU、I/O和全部样本在 JSON；这是小 burst，不是稳定吞吐或长期压力 SLO。

在确认没有其他客户端后，仅重启自有31508实例。百万 scope 第一次读取10.69ms，10万3.70ms，1万2.27ms，均命中。**只清空了 PostgreSQL shared buffers，OS缓存未驱逐，每规模只有一次首次读取，不报告冷 p95。** `/tmp` tmpfs 已满曾使测试临时写和该实例 Unix socket 启动失败；测试改用私有 TMPDIR，实例以私有 socket目录恢复，TCP/数据不变，没有删除其他进程文件。

## 性能门槛仍开放

全机/存储真正冷缓存、长时间混合负载、更多 scope/worker、频繁 generation 切换、长中文正文、vector space 升级/退役以及 posting 容量放大仍未完成。原百万合成512D HNSW成果保留，但本轮真实语义向量矩阵规模较小，不能把它冒称百万自然语言 Recall 验收。SOURCE/Authority/隐私删除的 R5 开放门槛也没有因这张延迟表关闭。
