# 堆叠集成、升级与回退计划

核对时间2026-10-18。[远端快照](evidence/stack.json)、[实际迁移/备份恢复](evidence/integration-final.json)。尚未执行任何 PR merge、retarget、rebase、部署或真实数据迁移。

## Git 与迁移

当前 main `0d894cc`，#322–#331 的每一个父HEAD都是下一HEAD的祖先，缺失基线提交为零。`git merge-tree` 的树级模拟都等于相应 child tree；这是无分支变更的冲突检查，不是发布演练或实际合并。没有发现内容被额外分支覆盖。#322–324非Draft，#325–331仍Draft；原来成功的CI只证明各自SHA，不能授权发布。

| PR | HEAD | 新SQL |
|---|---|---|
|322|e92e30b|main已有001–025，第一次建立ledger回执后重播幂等SQL|
|323|c3f7f06|无新增|
|324|8c6eb38|无新增|
|325|11e88bd|026 Authority|
|326|8632dd9|027–036：Host、审计、generation、legacy workflow等|
|327|ce5e078|无新增，生产Character/上下文|
|328|a7b5e9b|037–039：accepted输入、Observation及删除guard|
|329|ccbf199|040：A9/报告终态提交|
|330|28361e0|041：检索计划JSONB|
|331|91d0100|042–044：派生posting/seek/点查|

新建空隔离数据库，使用**main旧runner的无ledger执行顺序**先应用001–025，插入一条旧 `memories` 合成记录。随后按十个HEAD逐步调用新正式migration runner，直到044；最后重跑返回空列表。公开记录每个文件的SHA256、应用阶段和耗时。旧记录digest仍在，不被伪造为新式 GROUNDED；这只证明物理升级保留，不是所有旧资产已可检索。

正常Server/Character入口另在新schema跑完整启动、可信Host、Memory、能力、取消/429/重启、实际输入和权限回归。类型/包依赖通过workspace check/build；packaged及跨进程配置另由最新HEAD CI执行，不能把开发Server启动等同为真实安装包升级。

## 发布前必须保持的版本边界

| 边界 | 验证/风险 |
|---|---|
|Runtime↔Provider/Character|正常生产结构和协议fixture相同；新增支持使用已有Reasoning契约。真实模型仍有误拒/幻觉，不能靠fixture关闭质量门槛|
|Supervisor↔Server配置|当前Supervisor已导入共享parseMemoryBackend；只在mem0模式启动Mem0。不能继续沿用“完全不认识postgres”的旧结论。解析/侧车合同有CI；未因此完成产品Host生命周期|
|Memory v1↔Typed Client|支持字段追加到原query_plan schema，旧记录缺字段保持缺失；新client能读，运维接口保持认证。本批无新storage migration|
|WebUI↔Memory|页面/client仍调用 `/memory/recent`、`/memory/search` 等旧CRUD；Authority模式明确410并指向v1。不是兼容接管，必须先迁移UI/告知用户，当前为产品阻断|
|Desktop/WebUI↔Host|隔离grant实验不是普通客户端自动注册/续期/撤销。不能把管理员token交给网页或模型补洞|
|QQ/Voice/Vision↔Memory|本链PRIVATE只读合同不能证明QQ分支PRIVATE/GROUP安全；Voice身份、QQ群受众仍须独立产品验收。没有合并旧QQ分支|
|旧数据↔Authority|SQL保留旧表≠raw Mem0/Profile/Dream/旧correction/pending的完整迁移；不明来源不得提升grounding|

## 建议合并顺序（只制定，不执行）

1. 保持十个冻结HEAD可追溯，按#322→#331顺序审查。优先使用 **merge commit**，保留原提交祖先和实验SHA。每次由授权维护者合入main后，将下一PR base改为main，重新检查diff/merge-base/迁移digest并跑该新merge SHA的完整门禁。不要假定今天的CI适用于之后的main。
2. 不建议逐个Squash/Rebase自动消掉祖先：后续分支仍包含旧父提交，三点diff可能重含已落地修改。若维护者必须squash，先冻结整链，逐个显式rebase `--onto`、对比patch/tree、重新记录实验对应关系与全套CI；禁止批量force push别人的分支。
3. 代码合并可以分PR；**运行发布不能在旧二进制/新schema/新worker之间交错**。026–044的R5存储、对应migrator、Server、Worker和app-role策略作为同一受控版本包。先停旧writer/worker、备份、迁移预检，再允许新版本写。041–044兼容新增字段/索引也不允许随意删除ledger回执。
4. 某个中间PR无法合入时停止向main推进。修复应由该PR所有者协调，后继分支显式传播修复、重新比较树/重跑验证；不能直接合顶层绕过审查。当前新代码PR继续堆叠在#331，不修改既有PR。
5. 可以保持付费规划、支持判断、Observation保留/原图保留关闭；保持现有backend而不擅自切换。但是禁用开关不修复WebUI/Host、旧数据和迁移问题，不能因此批准R5生产接管。

## 回退合同及实际反例

- 026新增Authority表不删除旧memories，但旧程序看不到后续权威新写入；“能启动”也不等于知识连续。
- **033**把current表改为generation表+view，并有一次性ALTER。实际在恢复副本运行#325旧runner，报 `42809 cannot create index on relation memory_authority_current`。不能用旧runner降级/重播，旧Authority写协议也未获得新schema兼容认证。
- **037**允许accepted-user任务没有assistant_message_id，旧worker对其生命周期不兼容；升级必须停止旧worker，不能靠旧程序“接着消费”。
- **038–040**带来TTL/删除guard和A9原子报告合同；旧二进制不知道新回执/报告语义，不能只因部分DDL可读就认为可靠性等价。APPLIED/UNKNOWN不得回退成“未发生”或自动重做。
- **041–044**主要为新增JSONB、触发器和索引；#330旧Reader在新库实际读性能对照已通过。但这不是整旧二进制写入/启动认证，尤其不授权旧runner处理新schema。

支持的优先恢复方式是：保留备份和已提交ledger，使用同版本migrator从回执续跑、同版本worker幂等恢复。配置关闭新付费功能可逆；**二进制原地降级、逆向DDL没有认证**。需要退回旧系统时，必须另做停写、边界快照恢复及切换后新事实/外部Effect对账；不能丢掉切换后的APPLIED/UNKNOWN历史后重新执行动作。

本次对新建合成数据库做 `pg_dump -Fc`，在另一新库 `pg_restore`；Authority/Journal计数、历史digest、generation、posting及旧记录digest一致，index点检通过，migration重放无变化。它没有覆盖真实文件、安装包密钥、Persona/P8文件、远端Mem0、正在执行的Effect、备份中的隐私擦除或PITR。因此是**数据库级恢复证据**，不能称为完整Alice备份/回退演练。

## 发布前否决项

| 能力 | 代码/隔离证据 | 实际产品/切换判断 |
|---|---|---|
|可信HTTP→当前Memory→支持状态→Character|实现，真实模型/实际输入/隔离PG通过；保留失败|实验入口可用，非全产品接管|
|全量旧资产迁移|有分批legacy workflow及本次物理保留|raw Mem0/Profile/Dream/correction/pending清单、来源映射和差异仍未完成|
|完整来源审计/自动修复|本次有限scope持久来源点检VERIFIED、posting修复|全域持续水位、自动修复仍开放|
|备份/回退|新合成DB异库恢复通过，旧runner失败明确|实际资产备份、文件/密钥/效果对账、PITR和切换后回退未认证|
|Host/WebUI/QQ|有正式合成HTTP grant；v1API存在|产品凭据、UI迁移和群披露边界阻断|
|多scope/模型空间/长期运行|保留既有测试/百万合成索引；本次短并发|长压测、冷存储、升级退休、容量仍开放|
|隐私删除|Observation限期/删除guard及执行真相分离保留|全域Memory删除与备份擦除语义未完成|
|当前Alice版本|只读release-checkout Git元数据仍为5064c29|没有已验证的活跃进程build证明；不据此假定真实运行版本或迁移路径|

结论：堆叠历史和隔离SQL升级可以按依赖顺序集成审查；**没有达到允许真实Alice切换的发布条件**。后续真实迁移/部署必须取得单独授权并满足上述预检，不能用PR全部绿灯代替。
