# 派生索引：可靠性、容量与未关闭门槛

[集成及首轮反例](evidence/integration.json)、[并发/恢复](evidence/integration-final.json)、[计量补充](evidence/integration-measured.json)、[本次规模计划](evidence/scale.json)。新建独立数据库中的小scope采用真实Host/Journal来源、正式admission/Authority/projection；内容是合成协议负载，不是LLM主动学习质量。原百万合成数据库仅复用已有派生索引和正式Reader，不假装新建了百万自然语言事实。

## 确认的正确性缺口

- 高频旧事实：最早current记录包含 `amber spruce`；后160条近期记录只分别包含其中一个词。每词33 posting的生产Reader漏掉旧记录，诚实 `candidateLimited=true`。GIN合取原型能取到它，计划/BUFFERS公开，首次小scope合取诊断约1.94ms（含EXPLAIN+查询，不是p95）。
- 合取不能直接全量替代：所有词同时高频时，GIN匹配和排序仍可能随scope增长；用户原句中的虚词/不同语言也不宜全部AND。尚未证明可持续的普遍召回方案，**没有把33扩大到1000或发布未经负载验证的深检索**。
- 长中文：约1623字符（大量不同Han字符）产生512条posting，但尾部 `LONGTAIL_9762` 未召回。原256词项表示仍有信息上限；新支持判断无法找回没进入候选的事实。这是正式阻断，不能用短查询成功掩盖。

下一索引切片应比较：短语/属性合取、真实词频选择率、精确标识、向量通道，以及有专用连接/事务deadline的受控补查。限制最终返回ID不足以约束GIN扫描量；超时必须返回PARTIAL，不可报空。需要冻结高频旧事实和长尾Ground Truth，再测1万/10万/百万、不同选择性、并发和冷存储；不能先上默认策略再补证据。

## generation、纠正与恢复

首次小域12次正式supersede后旧posting不再可读。175条历史下，active generation的posting1325条；shadow构建/切换后两代共2650条，relation占用约1.93MB，原约1.03MB。正式退休旧代后逻辑posting回到1325，但已分配relation页未立即缩小：逻辑删除不是磁盘收缩，也不是第二套权威历史。

shadow中途pause/resume通过；人为删除current索引后 `LEXICAL_VERIFY` 检出MISMATCH并退回BUILDING；正式REBUILD/ADVANCE分批恢复，回填中新增已确认来源仍在，点检无差异。备份恢复后active generation及posting计数/digest一致。所有原始Journal和Authority历史保留；没有手工修改权威状态来通过修复。

连续回填与Reader/Writer的小burst：40读、9写；读p95约1.40ms，包含Journal/admission的写p95约24.46ms，采到一次transactionid锁等待。5ms采样会漏短锁，只证明这个短burst的结果；不是长期写入SLO或“零锁等待”。每批仍锁scope，长正文/大批次/长压测尾延迟未认证。

统计快照曾看到posting累计插入2175、删除808、估计dead808；这些PG统计可能滞后，不能据此声称最终完整写放大。清理旧generation和VACUUM不会把relation长度立即归零。本轮源码没有新增压缩策略或自动VACUUM治理。

额外三条正式写入检查了逻辑扇出：短事实6个current posting，纠正后旧事实0、新事实6，长中文新事实512。COMMIT前抓取的 `pg_stat_get_xact_tuples_*` 显示history_inserted为1/2/3，不能误当每笔独立计数；原始值完整保留。结合[PostgreSQL统计文档](https://www.postgresql.org/docs/16/monitoring-stats.html)及[官方问题讨论](https://www.postgresql.org/message-id/CABPTF7XO101mBvA9u01nHkvt1gaQ3i60hypYOvNp6DdOFnY0jQ%40mail.gmail.com)，按未flush本地计数解释，不宣称得到了精确逐事务/WAL放大。完整物理写放大仍开放。三条探针发生在备份验证检查点之后，不能拿后来的DB头与之前备份摘要比较后误报丢失。

## 本次热缓存边界

复用既有index，未重新回填百万。实际Reader、同机#330原Reader，30热样本：

|历史规模|当前混合p95|#330混合p95|
|---|---:|---:|
|1万|2.23ms|4.05ms|
|10万|2.04ms|24.90ms|
|100万|1.96ms|133.52ms|

这是本批重测，不取代#331的2.71ms历史结果，也不证明本PR又优化了Reader（Reader未改）。EXPLAIN/BUFFERS及backend CPU原始值公开；机器共享、并非冷盘或独占SLO。百万posting及索引约3.52GB、额外覆盖索引约264MB的代价仍在；新模型支持判断约秒级，不应藏在数据库毫秒数之后。

验收B仅通过小域纠正/generation/损坏修复/恢复及有限并发。高频旧current、长正文尾部、物理写放大、长期VACUUM/锁等待、多scope/模型空间及完整冷缓存压力尚未通过。数据库副本恢复也不是全Alice资产、密钥、远端Mem0或备份隐私擦除验收。
