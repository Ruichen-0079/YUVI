# R5 Linux 发布候选：首装与冷恢复切片

交付 Draft PR 为 [#336](https://github.com/Ruichen-0079/YUVI/pull/336)，[本 PR 实际 HEAD 的 CI](https://github.com/Ruichen-0079/YUVI/pull/336/checks) 单独记录，保持人工评审状态。基线是 [#335](https://github.com/Ruichen-0079/YUVI/pull/335) 的 `f9f8c984070b4d030fba05c819598217e36aafd9`。接手工作树干净；在原工作树新增 `release/r5-install-recovery`，保留 #322–#335 历史。没有 merge、retarget、rebase、部署或真实数据迁移，没有访问 Alice 的安装、数据库、Provider 密钥或 QQ。

**已完成 A+B 的有界纵向切片：全新 Debian 12 VM 安装独立发行 payload，真实 Tauri/WebKitGTK 首次使用、R5 事实与纠正、系统重启；完整停机备份，在另一台 VM 恢复并通过原生窗口继续使用。它仍不是可批准正式切换的发行版。** C 的旧二进制升级/失败对账和 D 的多格式旧资产盘点消费者留作下一份依赖任务，不能由本批 SQL 演练代替。

实际原生包来源为 `e7428c2cd5640b3bd0430e9d1b146e5468a86423`。之后提交仅补验收工具、证据与报告；发行产物、报告和 PR HEAD 分别记录，不能混称同一个二进制。产物：`build/desktop/YUVI-R5-0.1.2-e7428c2cd564-linux-x64.tar.gz`，SHA256 `065e9a61ea408020460e22719c9e101fa3bcf37a04a832f1c51b65ca596ea71f`。仍沿用仓库版本 0.1.2，通过完整 Git SHA 标识候选，没有发布 stable tag、签名 Release 或上传备份。

## 安装合同与实际环境

这是 **解包运行的 R5 文字桌面 profile**，不是此前仅解出原生壳的 `.deb`，也不是完整 Avatar/语音包。复用现有 Supervisor、Runtime、Node 下载、Linux Web 构建和 portable launcher；没有新的 Memory、队列或执行账本。

| 内容 | 合同与实测 |
| --- | --- |
| 架构/系统 | Linux x86_64；Debian 12、glibc 2.36；KVM VM、Xvfb/Openbox、真实 WebKitGTK 2.50.6，软件渲染 |
| 包内 | Node 24.20.0、Supervisor、捆绑全部 JS 依赖的 Runtime、SQL 001–045、PostgreSQL 16.15/pgvector 0.8.6、Tauri release 二进制、Web 与离线字体、许可证 |
| 系统依赖 | `install-system-dependencies.sh` 声明 apt 库、Secret Service、字体等；普通用户不安装 Node、pnpm 或 PostgreSQL |
| 不在 profile 内 | Mem0、STT/TTS 模型与服务、授权 Cubism Core、用户资产和 Provider 凭据；不声称 Avatar/语音可用 |
| 普通联网安装 | 空白官方 Debian genericcloud + apt 系统依赖 + 发行压缩包，实测通过 |
| 系统依赖已满足 | 应用 payload 自包含；不依赖开发 node_modules、源码或宿主服务 |
| 离线安装 | 需要另备兼容 OS 包仓库；没有验收完整离线 OS 安装，不能算通过 |
| 图形与密钥 | 需要图形用户会话、可解锁的用户 Secret Service。测试只使用公开的合成密码；没有 plaintext fallback |
| 未覆盖 | Windows/macOS、ARM、其他发行版、真实 Wayland/GPU、签名/自动更新、桌面菜单安装及完整语音/模型分发 |

[发行 manifest](evidence/release-manifest.json)、[二进制构建来源](evidence/build-provenance.json)、[1777 个文件的实际完整性检查](evidence/artifact-integrity.json)。首次 VM 没有 `/usr/bin/node`、`psql`，也没有复制旧配置、Person、PG、node_modules 或源码。包内 Node 驱动正式 launcher，Supervisor 实际拥有 PG 与 Runtime；没有手工启动 Server。包内静态 alice Persona 在新隔离实例中使用，Person 为 `RC Synthetic`，不是 Alice 的真实安装。

官方基础镜像为 `https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2`，本次 SHA512 为 `dc0d7b526a3a9a9265142fe8e903984c03f8d605ac4ba6f14d15d27988a69581fb05fc06cd2a6d79f6eaf68ba9725f2eb38b5ddd64ad166faadad279af776c9e`。latest 会变化，复跑应使用保存的同摘要镜像或重新审查新的官方摘要；脚本不会忽略摘要不匹配。

包展开约 197 MiB。最终空白 VM 的 apt 安装含独立测试工具耗时 145.364 秒；没有把它当作 production-only 安装耗时。原生首次交互整段约 8.31 秒，系统重启后原生验收约 6.22 秒，均是一次合成测量，含 UI 操作，不是稳定启动性能指标。首次恢复验收 93.41 秒，主要包含人工等待 OS 密钥环解锁；不把这段等待当作数据库恢复计算耗时。恢复后单点进程 RSS 相加约 1.05 GiB，包含 PG/WebKit 共享页的重复计数；CPU 数字是进程生存期均值，见 [实际资源样本](evidence/database-restore.json)，未做持续负载基准。

## 首装发现与生产修正

真实安装发现了开发环境预配置掩盖的问题，失败记录保留在 [attempts.json](evidence/attempts.json)。

- PostgreSQL 必须在 Debian 12 基线构建，ELF RUNPATH 使用 `$ORIGIN`；pgvector 禁止构建机 `-march=native`。所有库链接只能在发行根内解引用，不能链接回构建机。补齐 pgcrypto/pg_trgm 扩展检查和许可证。
- Authority 的迁移摘要检查使用打包 SQL 目录，不再假定 monorepo 布局。
- 私有 PG 的 owner 仅迁移/配权；正式 Runtime 切换到 `yuvi_runtime`。初次配权漏掉可写投影视图曾导致语义任务完成、实际事实写入失败。现在显式允许该视图，启动 gate 也检查它。历史 UPDATE/DELETE/TRUNCATE、DDL、Observation 身份/期限重写仍禁止。
- Person-only ProductStore 在没有 primary Person 时保留可信配置中的 Persona，不推导默认 Person；原生绑定不因重启换 Persona。
- 新建 Person 文件通过 `configurationInherited:true` 标明尚未接管 Provider 配置。重启继续使用可信桌面路由，不把 native 密钥复制到文件。显式 Product 配置保存会移除这个标记，包括明确保存空配置；旧的显式配置不会被自动替换。旧安装若已存在空配置，仍须单独盘点，不能猜测其意图并偷偷改写。
- R5 文字 profile 只自动打开主窗口，避免空 Avatar overlay 遮住激活按钮。已配置但服务不可用显示恢复/检查提示，不再让它看起来像尚未启用记忆。
- 测试用原生 WebDriver 的 Inspector 仅显式允许 loopback；不向普通页面增加控制权。截图后端曾失败，改用 OS scrot 拍摄同一个真实原生窗口，未改成 Chromium。

[首装](evidence/result-install.json)、[系统重启](evidence/result-restart.json)、[受限角色与数据库](evidence/database-install.json)、[原生记忆截图](evidence/native-memory-install.png)。Owner 确认、Provider 设置/密钥、R5 启用、Person 创建/选择均走原生确认和正式控制面。事实由聊天经过 Character/Journal/Worker 形成；SQL 仅验收查询，没有预写事实或答案。

## 完整资产与统一恢复点

本批选择 **短暂停写后完整关机、扁平化整台 VM**。没有把几份独立目录复制冒充一致备份，也不承诺跨 OS/账号/密钥环迁移或在线 PITR。

1. 正式 native UI 退出所有 Host。检查所有 `memory_host_grants.revoked_at` 非空，包含已过期但可能续期的产品授权。
2. 等待持久摄取任务完成；未决 A9 不能为 drain 而重做。本实验明确保留一个已派发、没有 terminal 回执的 Provider attempt。
3. 通过原 launcher 的 `prepare-backup` 先 fsync 恢复 gate，再请求受信任 Supervisor 关闭。即使中断，下次启动仍关闭。
4. 确认 PG 无 postmaster、`pg_controldata` 为 `shut down`，保存 45 个迁移回执、64 张 SQL 表的计数/摘要、身份、完成任务和不可变行水位。
5. 干净关机；`qemu-img` 的排他锁拒绝在线磁盘，检查、转换为无 backing file 的 qcow2。加入原启动 seed、应用/Schema/协议版本、文件摘要与 manifest。备份与登记目录要求 POSIX 0700，输出 0600。
6. 恢复到新磁盘后仍保留 gate。外部登记不在历史备份里；必须审查之后的删除、执行事实和源实例状态，并把 clearance 绑定到目标 Linux boot ID。
7. 在发出 clearance **之前**持久化登记失效状态，再由 launcher 记录审查回执、移除 gate。审查不自动启动服务。目标开始写入后，同一历史点的第二次恢复必须拒绝；崩溃中断要求审查，不能猜测继续。

[实际备份 manifest](evidence/backup-manifest.json)、[冷封存与资产清单](evidence/cold-seal.json)、[历史点重复使用拒绝](evidence/old-point-reuse-rejected.json)。实际压缩机器镜像 1,041,235,968 字节；镜像、密钥环、owner、Cookie 与 SSH key 均没有提交到仓库。

| 资产 | 本批恢复边界与覆盖 |
| --- | --- |
| R5/旧兼容 SQL、Journal/Conversation、Worker、A9/回执/UNKNOWN | 同一关闭的 PG 集群及 WAL/控制文件；新实例比较旧行，完成输入不重新摄取 |
| ProductStore/Person/代际/创建回执、Native Owner | 同一机器文件系统与 SQL 恢复点；恢复前后 Person/owner 摘要和创建回执一致 |
| Product Host | 封存前全部撤销；旧 Cookie 实测 401；恢复后须明确选择本人并获取新的受限授权 |
| 静态 Persona/Character、配置、版本、P8 与派生工作 | 整台机器的应用 payload/数据目录和相关 SQL 全部包含；不声称本批填充了所有 P8/迁移/索引任务类型 |
| 系统密钥存储 | 同一 OS 用户的原加密 keyring；仍需原解锁密码，没有按 Person ID 重新认领机制 |
| Observation/删除 | 原期限与删除状态保留在同一个 PG；本实验没有填充过期/已删除 Observation，专门的披露恢复实验仍开放 |
| 数据库外 Legacy/Mem0 等 | 整台 VM 的文件均保留，但本实例没有这些真实旧资产；跨外部磁盘/服务不在本恢复合同内 |

备份期间不提供聊天、摄取、Memory 写入或其它执行，PG 停止后也不提供私人读取。这里选择完整停机，未实现在线只读快照服务。

灾难恢复只恢复到明确历史点。隐私删除不能因为旧历史点存在就当成从未发生。源恢复运行、目标激活、新的执行或删除发生之后，外部登记变为 `*_RECONCILIATION_REQUIRED`；缺少登记、摘要变更、未审查删除/执行、错误 boot、并发 clearance 均拒绝。该登记是由可信操作者保管的备份元数据，不是平行 A9 账本，也不是防止文件所有者手工重建/回滚登记的安全硬件。只能保留唯一的有效登记；丢失或人为分叉必须停止并人工对账。它没有擦除所有旧备份，也没有实现全域删除。

## 另一台 VM 的实际恢复

源 VM `install6` 保持关闭，恢复的是扁平化后的机器镜像，没有引用其旧磁盘或源码。新 VM `restore1` 首次直接启动被 gate 拒绝；错误 boot 的审查也拒绝。完成外部审查后，用真实 Tauri 重新进入原身份。

- 比较原 2 条 Authority、12 条 Journal、46 条 A9 observation 的行摘要，均保留；ProductStore Person/owner/创建回执一致，完成摄取水位未增加重做次数。
- 原 native Cookie 返回 401，没有因恢复复活。
- Fixture 已接受请求后 SIGKILL 正式 Runtime。封存时 `dispatch_started_at` 已写入、terminal 回执缺失，certainty 为 null，属于未决结果，**没有伪称已生成 UNKNOWN terminal 回执**。恢复后没有 APPLIED，新 Fixture 的接受次数仍为 1；不执行真实外部副作用来验证。
- 在同一原生产品入口创建新的聊天会话后正常提问。测试只清除客户端所选会话 ID 再刷新，没有改 Person/Scope/数据库；实际新模型输入没有旧提及/纠正的用户历史，而 system Memory context 含当前 `forest-green`。
- 同一个原生窗口通过 `/memory/v1` 展示 current 和 superseded 历史，实际检索记录可见。

[恢复结果](evidence/result-restore.json)、[逐行比较](evidence/restore-comparison.json)、[原生历史截图](evidence/native-history-restore.png)、[实际 Fixture 模型输入](evidence/fixture-transcripts-restore.json)、[未决派发](evidence/unresolved-at-backup.json)。恢复后的系统 keyring 仍要求解锁；首次通过原 OS 对话框输入合成密码，后续测试工具仅自动输入同一公开 Fixture 密码，不修改或旁路 Secret Service。

## 故障、升级与发布否决矩阵

| 门槛 | 本次结果 | 仍然存在的边界 |
| --- | --- | --- |
| 干净 Linux 首装与原生闭环 | PASS | 仅上述 Debian 12 x86_64 R5 文字 profile |
| 正常退出、应用/系统重启 | PASS | 不是跨平台或长期可靠性结论 |
| PG 端口被其它进程占用 | PASS | 拒绝私有访问、不替换持久端口、不杀其它进程 |
| PG 主版本不匹配 | PASS | 拒绝启动，不重写 PG_VERSION；仅合成故障后恢复原文件 |
| Secret Service 不可用 | PASS | 无私人访问，无 plaintext fallback，无 PG 初始化覆盖 |
| Runtime 已派发后 SIGKILL | PASS | 实际 Provider Fixture 未决 attempt 保留、不重做；不等于所有外部系统的灾难对账 |
| VM 写盘 I/O 错误/只读 | 已记录真实失败 | VM4 的 ext4 journal abort、Host 503；保留样本，未自动 fsck/覆盖。后续 ext4 上的独立空白 VM 重启通过；不能据此宣称磁盘损坏恢复已完成 |
| 完整冷恢复与旧授权 | PASS | 同 OS/user/keyring，源保持关闭；不是任意目录复制、在线备份或 PITR |
| 新写入之后恢复旧点 | 拒绝通过 | 不自动丢弃新事实、A9 回执或删除；人工前向恢复/对账尚待实现 |
| PG SIGKILL 与 WAL 恢复 | PASS | 私人读取先拒绝，正常原生重开后旧行/回执、撤销与新会话 R5 召回通过；不等于磁盘损坏修复 |
| Supervisor SIGKILL 自动恢复 | **BLOCKED** | Runtime/PG 孤儿进程仍存活，新启动拒绝端口 16121；只在核对实验 UID、包路径、数据目录后人工清理并通过原生重开，不能算自动恢复 |
| 耗尽磁盘的有限失败 | PASS | 新建 160 MiB ext4 故障卷，正式 launcher 0.29 秒内以 ENOSPC/exit 1 停止，未启动 PG，原集群不变；这是停机合成状态副本的启动测试，不是首装或写入中耗尽 |
| 写入中耗尽、只读目录与组合故障 | OPEN | 本批没有完成所有阶段与组合；上述真实失败和单项通过不能扩展为完整可靠性保证 |
| main SQL 001–025 → 045 | PASS | 旧合成行保留，重复 0，失败事务回滚；当前 runner，不是旧二进制完整升级 |
| 旧安装包升级、部分迁移/新 A9 后回退 | BLOCKED / C | 不支持任意旧二进制原地降级；保留已证实的 #325 runner `42809` 风险 |
| raw Mem0/Profile/Dream 等盘点与影子迁移 | BLOCKED / D | 本轮没有新增全格式消费者或正式迁移，旧事实不会自动升级为 GROUNDED current |
| 历史备份与合法删除对账 | BLOCKED | 外部登记能阻断旧点，但不是全域隐私删除，Observation 填充恢复实验未完成 |
| 真实模型测试 B | BLOCKED | 没有获准的独立 Provider；未扫描私人配置，Fixture usage 不是实际 Token/费用或语言质量成绩 |
| Windows/macOS、离线安装、签名发行 | BLOCKED | 没有相应真实环境或完整产物验收 |

[PG 终止注入](evidence/result-pg-crash.json)、[原生 WAL 恢复后验收](evidence/result-pg-crash-reopen.json)、[Supervisor 实际阻断](evidence/result-supervisor-crash.json)、[人工清理后的原生重开](evidence/result-supervisor-manual-reopen.json)、[ENOSPC](evidence/result-enospc.json)、[故障卷后原实例重开](evidence/result-enospc-native-reopen.json)。孤儿进程清理脚本仅适用于已记录 PID 的隔离 VM，不是发布产品的自动接管机制；产品仍须补可验证进程所有权与有限恢复。ENOSPC 第一次设置只发生在填盘阶段，未启动应用；大块写入 ENOSPC 时 ext4 仍报告少量可用空间，第二次在新卷补充块大小写入，并以实际应用错误验证，不改写第一份失败样本。

遇到部分迁移或新 Runtime 启动失败：停止全部 Writer/Worker，保留当前磁盘和 SQL/执行回执，核对已提交迁移及 manifest，优先修复/前向启动兼容版本。只有封存点之后没有新执行/删除且通过审查时，才允许本批有界恢复。新 Memory、尤其外部 APPLIED/UNKNOWN 已出现时，不恢复旧数据库来假装回退成功；保留目标回执、Journal 因果引用和人工对账任务。不得把登记手改回 SEALED 或启动 #325 来绕过阻断。

[迁移清单与实际 main 升级](evidence/main-schema-upgrade.json) 包含 45 个文件摘要。本批没有 046，也没有修改 main 已有 001–025。ProductStore 新字段是可选、带 generation digest 的来源标记，旧显式配置语义保留。完整历史版本升级与旧 native 配置的恢复仍需 C 演练。

## 本地、CI 与堆叠集成治理

本地 `pnpm check`、`pnpm build`、带显式隔离 PG 的 `pnpm test` 通过：Vitest 4143 passed / 57 skipped，Node 65 passed；Rust 110 passed；打包 78 passed。6 项 Python 保管/并发故障及 launcher 实进程检查另外执行。skip 是未覆盖，详见 [validation.json](evidence/validation.json)。正式 Server/Character 入口和 PG 权限回归属于这批实际运行；未重新把 #334 Chromium 的旧验收标成新发行包验收。CI 的最终状态记录在 #336 描述及其 checks 页，须核对当前 HEAD；仓库中的本地证据快照不声称 CI 已通过，不拿 #335 的绿灯替代。

CI 的 `check`、Linux persistence 和 Durable Conformance 运行本仓库的正式源码、迁移、Supervisor/Server 与共用打包工具；Durable Conformance 自建隔离 PG/依赖并测试既有 packaged profile。新增 R5 tar profile 使用同一 Node/Supervisor/Runtime/Web builder、另加受审查的 R5 资源和 PG stage，实际消费包内 SQL。CI 没有启动本报告的 Debian12 原生 VM，也没有构建并端到端验收这份 R5 tar；通过 CI 不能替代本文锁定 artifact 摘要的首装/恢复证据。

[PR 完整 HEAD/base 与祖先核对](evidence/pr-stack.json)：#322–#335 的每个 base 都是其 head 的真实祖先，每个 head 都是本候选祖先。#330 保留既有 merge 祖先，不线性重写。没有旧分支覆盖或替换这些协议；本轮只检查堆叠与相关路径，未重新审计十四份 PR 的全部行为。

建议人工按 **322 → 323 → … → 335 → 本 Draft** 审查。每一步重新核对被冻结的 HEAD、base 祖先、CI 与存储兼容性；GitHub 自动改变堆叠 base 后仍应重新审查，不能盲批。合并代码、生成/运行发行包、迁移私人数据是三个独立动作。本轮没有授权其中的真实发布和数据迁移。Supervisor 崩溃恢复、新候选 C/D、真实模型、平台、删除、完整故障/升级门槛未解除，故整个堆叠尚不具备 Alice 正式切换资格。

合并前只读预检示例（逐份替换 PR 与冻结 SHA；任何不一致都停下重新审查）：

```sh
gh pr view 335 --json headRefOid,baseRefName,isDraft,mergeStateStatus
git merge-base --is-ancestor f9f8c984070b4d030fba05c819598217e36aafd9 HEAD
gh pr checks 335
sha256sum build/desktop/YUVI-R5-0.1.2-e7428c2cd564-linux-x64.tar.gz
```

不能单独回退的边界包括新 Schema 对旧 runner 的不兼容、ProductStore generation/Person 绑定、Host 授权代际与撤销、已完成摄取和 Journal 因果引用、不可变 Memory 纠正关系，以及已经派发或 APPLIED/UNKNOWN 的 A9 执行事实。回退代码不能抹掉它们；本批备份/审查仅在上述停机且无恢复点后新事实的边界使用。

其它既有边界也未消失：`4A87 → 4A88` 来源引文失真、未完整解释正确记忆、长中文尾部/高频旧事实检索、全量语义 Truthfulness、QQ PRIVATE/GROUP、Evidence Support 默认开启、全域删除、PITR 与长期多 Scope 负载均不是本批通过项。

## 复跑入口

[实验操作说明](../../../scripts/release-candidate/README.zh.md) 列出独立 VM、实际原生入口、冷封存、备份、审查与恢复命令。使用显式的新 POSIX 路径与合成 keyring；不要将命令中的路径换成真实安装。构建需要干净 checkout、声明的 Debian 12 构建根与依赖；运行发行包的 VM 不挂载该构建根、源码、node_modules 或宿主目录。
