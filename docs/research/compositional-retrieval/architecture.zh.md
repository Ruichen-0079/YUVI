# 有界检索与当前认识合同

基线 #330。权威仍是既有 PostgreSQL History/Admission/Relation/Current Projection；新表只承担可删除、可重建的检索投影。A9、Journal、Worker、Host 权限未改为模型控制。

## 查询和选择

1. 默认无新模型调用。显式开启原有 `MEMORY_QUERY_EXPANSION_ENABLED` 后，一次既有 Reasoning 调用产生最多五项需求，每项最多两条 128 字符查询；输出上限 768 token、8 秒，不做修复循环。
2. 每项 `quote` 必须来自用户问题、按序且不重叠。错误则整个计划不可用，原始问题仍能查；旧 v1 两查询计划兼容读取。它不能改事实或选择权限。
3. 原查询与需求分别取有界文本候选；配置向量时保留整句通道，并以每需求查询现有模型空间。原查询向量 8、各需求 4，最多 28 个向量 ID；无需求时维持原有 32。不是提高全局 ANN top-K。
4. 文本阶段最多合并 32 条，保留各需求首选；加向量及一次有界版本刷新后，当前投影解析仍在既有 100 ID 上限内。不会重复语义规划或远端 embedding 来追赶无限并发更新。
5. 组合时必须保留每项首选，不能因为某个低排名候选恰被别项使用就宣称覆盖。最终按真实权限和同一 current generation/version 重核，superseded/supporting/legacy 不绕过 current 状态。
6. `preferredSelected=false`、通道失败、索引/兼容积压或候选/词项边界使结果 PARTIAL；错误不会伪装 empty。审计保留原查询、实际需求、通道、首选及最终状态。API 增量字段可选，旧记录不伪造历史需求。

文本同一需求内保留匹配强度，避免一个偶然汉字与完整翻译短语被当成相同强度的 rank-1。向量与文本不再在需求内固定偏向“只要 ANN 排第一就胜过正确文本”；但它不是语义蕴含校验。候选中的无关真实事实仍可能进入预算，所以 coverage/precision 必须分别评估。

## 词项索引

042 在现有 Projection 上维护 `memory_lexical_postings`。仅 current/conflicted 建 posting；原始标识和 tsvector 词项保留，常用 Han/CJK 扩展 A 增加字符和 bigram。原代码中数字/连字符会吞并其后的中文，新的查询正规化与历史派生解析都处理该边界。不更改不可变历史的 `search_terms`，也不将分词用于 admission。

单次文本查询最多 32 个词项，每词顺序读取最多 33 条 posting，再在这个有界集合内评分、取正文。标识符通用加权，单 Han 后备降权。词频只是有界探针频数，不冒充精确全库 IDF。

043 的精确访问键与 044 的 current 点查覆盖索引来自实际失败计划：新 scope 统计滞后时，优化器曾选清理索引扫描全部 posting，或把正文连接变成全 scope 扫描。新查询固定有限 posting 后才以主键/覆盖键逐记录读取。键包含 scope、generation 和词项；最终再按 scope/权限重核，不靠相似度作授权。

复杂度约为有限词项的 B-tree seek、至多 32×33 个 posting、最多 100 个最终状态解析；不排序完整历史。**这不是全库精确 Top-K 保证**：高频词只保留近期 posting，旧的正确项仍可能不在有界集合中。触及 33、词项裁剪、结果裁剪均明确 PARTIAL；单纯的词项检索不理解所有同义关系。极长问题、罕见 Unicode Han 扩展、未有共同字/译词以及不充分 ANN 候选继续是边界。

规划/文本只处理前4000字符时另记录 `originalQueryTruncated`，不把重复词导致的长输入误判成完整 empty。超过五项需求的完整拆分不受保证；准确源片段不是“所有需求已被识别”的证明。无历史 scope 返回正常 empty，不伪造待回填任务。原有记录256词项上限也未被本批全面替换，长命题尾部召回继续开放。

## 迁移和维护

- 先由迁移角色应用 042、043、044，应用启动校验正式 ledger digest；普通角色不得自动 DDL。现有 generation 标为 BUILDING，不自动全表回填，不让旧数据无声消失。
- 未准备好时保留 #330 GIN 读取并明确 `BACKFILL_PENDING_GIN_FALLBACK` / PARTIAL。回填期间该兼容路径仍可能扫描大量匹配项，不能宣称已获得新查询成本。
- 认证本地 operator 通过既有 `POST /memory/v1/operations` 的 `LEXICAL_ADVANCE` 推进一批（路由最多 200，库函数最多 1000）。返回类型化进度、checkpoint、generation、actor；不是“队列已接收即完成”。无 token/远程/错误 Persona 继续拒绝。
- 每批和 checkpoint 同事务，短暂锁定 scope 以与 Writer/cutover 排序。并发新写走相同 trigger，即使 ID 位于 checkpoint 之前也不丢；中止后重放幂等。回填完成才 READY。隔离百万实际回填约 142 秒，而非一次长事务。
- `LEXICAL_VERIFY` 按有界 ID 页比较 posting 的缺失、多余词项和版本；发现漂移就禁用该 generation 的索引，恢复兼容读取并标记 BUILDING。`VERIFIED_BATCH` 仅证明这一页/这一版本，不冒充全域持续审计水位。
- `LEXICAL_REBUILD` 正式开启修复，重复开始保留已进行的 checkpoint；`LEXICAL_ADVANCE` 每批先清除该批旧 posting 再从权威 Projection/记录重建，可修复多余或错误词项。实际 SQL 损坏测试通过这些接口恢复，没有手改状态来“修复”。这不是运行时自动全库对账，持续检测仍开放。
- 新 scope 与 Shadow generation 随 Projection 写入维护；纠正撤下旧 posting，retire 删除 Projection 时通过 FK 删除该 generation 的 posting。状态索引不成为事实权威。
- 备份和恢复仍按 R5 的完整流程执行。先关闭规划可回退语义策略；回到 #330 会忽略 posting，但仍可读取既有 Authority。不要删除已记账迁移或在活动写入期间随意删除索引；移除新 schema/恢复旧程序仍须单独预检查。

存储代价真实存在：当前 111 万历史负载及少量增量写的派生 posting 表和其索引约 3.52 GB，不是零维护成本。较长中文记忆和并行 generation 会进一步增长，压缩、容量规划及长期 vacuum/升级负载仍开放。
