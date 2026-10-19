# R5：Supervisor 崩溃所有权恢复

基线 [#336](https://github.com/Ruichen-0079/YUVI/pull/336) 为 `2a0db78064a7f43cc41e6818fdd69eec277141de`，接手干净工作树，新分支 `fix/r5-crash-ownership`。原始 #336 首装/失败/冷恢复证据没有改写。本切片是 PR A；历史安装升级及失败阶段处理另作依赖 PR B，已经在独立 VM 正常安装并运行 #336 旧发行包，但不能在这里把旧包安装称作升级完成。没有访问真实 Alice、修改生产环境或合并/retarget/rebase 既有 PR。

**#336 的 Supervisor SIGKILL 阻断已由真实发行 VM 关闭：所属 Runtime/PG 由 OS 清理，正常再次启动恢复私人身份与 R5，无需人工清理。** 不认识的进程仍拒绝接管或终止。发行资格仍被升级/旧资产/真实模型/跨平台/删除等门槛阻止。

## 根因与实现

旧 Launcher 先检查端口；Supervisor 自身死亡后无法执行回收，PG 的 daemon/setsid 生命周期也不受普通父子进程和 process group 约束。单独重读 PID、相同 UID/路径、PGDATA 或健康 HTTP 响应不足以授权清理。

Linux R5 文字 profile 现在由 **systemd 用户 transient service** 包含正式 Launcher、Supervisor、Runtime、PG、原生窗口与 Web。现有 Supervisor 继续管理服务、Runtime challenge 与权限，OS 只提供生命周期包含，不另建接管 Authority。用户 service manager/cgroup v2 不可用时拒绝无保护启动。

- `Type=exec`、`ExitType=main`、`KillMode=control-group`、`Restart=no`、`TimeoutStopSec=45s`、`SendSIGKILL=yes`、不委派 cgroup。Supervisor 死亡导致 Launcher 退出，OS 对剩余 cgroup 先 TERM，超时后 KILL。Launcher MainPID 本身死亡也清理整个 unit；PG 的 setsid 不使其逃出 cgroup。
- 同一 canonical state root 使用唯一 unit 名；OS StartTransientUnit 序列化并发 Launcher。包 SHA/安装根绑定在 unit 描述；主 PID、OS InvocationID、当前 cgroup 同时匹配才进入真正启动。普通环境变量不能跳过。仍有效的其它 Launcher/包/实例只拒绝，不自动停止；本实例 draining 时有限等待。
- 正常关闭先停 Writer、后停 PG。Runtime 只用当前 ChildProcess handle 有界 TERM/超时 KILL，不按旧数字 PID/tree 强杀。PG 固定 native helper 在检查前打开 pidfd，再验证同 cgroup、实际可执行文件、精确 PGDATA、随机 cluster identity 和 postmaster.pid；向这个已 pin 的进程发送 PG 正式 SIGINT fast shutdown，12 秒未停则拒绝数字 PID 升级。helper 不是 Tauri IPC 或通用信号代理。
- Runtime/PG adoption 另需当前 cgroup；缺少该证明的历史 #336 孤儿不自动接管。新锁记录 boot ID 与内核 start ticks，旧 boot/复用 PID 只允许退役失效锁文件，绝不授权信号。没有这些字段的旧格式 live holder 保守拒绝；无法检查身份也拒绝。

依据：[systemd 252 service 执行](https://www.freedesktop.org/software/systemd/man/252/systemd-run.html)、[cgroup 清理规则](https://www.freedesktop.org/software/systemd/man/252/systemd.kill.html)、[PG16 shutdown 信号](https://www.postgresql.org/docs/16/server-shutdown.html)。普通 process group 方案不能证明 PG daemon 归属；完全靠持久 PID/challenge 接管还需处理 PG 与信号 TOCTOU，本轮没有为已不可证明的旧进程创建危险 fallback。

`supervisor/lifecycle.json` 只是审计副本，记录 boot、InvocationID、启动 ticks、cgroup、包版本，不是发信号凭据。OS manager 与本机账户是可信控制面，不声称抵抗已控制该账户/root 的攻击者。外层 systemd-run 等待客户端死亡不改变仍有效的 GUI/service 身份；真正 Launcher MainPID 死亡才触发整个 unit 退出。正常前端关闭/正式 `./yuvi stop` 仍走既有控制面。

新增运行前提在 R5 apt 安装脚本声明：systemd、dbus-user-session、libpam-systemd，用户必须有正常图形登录/用户 manager。没有系统 Node/PG 依赖。非 R5 的 Avatar/语音 profile 没有由本批取得新的异常恢复保证；Windows/macOS 也未实际运行。

## 最终发行包与现场

实际最终输入 `1052ac93841642e80bf371d34d949c4ae9d0714b`；tar `build/desktop/YUVI-R5-0.1.2-1052ac938416-linux-x64.tar.gz`，SHA256 `481dfd40a4b3c98666faf7e9e1727663b97e5a36a83d04a9917fe74b5f1d0bfd`。之后提交只补测试工具/证据/报告。此前 `d319b3eda1576b311d4dc98cfeb17827c73abe8d` 的原生实验为先导样本，保留在 evidence 根目录，**不替代最终包实验**。

最终 VM `ownership2` 是新官方 Debian12 x86_64/KVM，按 apt 合同联网安装系统库及单独测试工具，没有复用 PG、源码、node_modules、Person、Owner 或 keyring。内核 `6.1.0-54-cloud-amd64`、systemd 252.39、cgroup v2、Xvfb/Openbox、真实 WebKitGTK 软件渲染。[1778 文件完整性与空状态](evidence/final-1052/integrity.json)、[发行 manifest](evidence/final-1052/release-manifest.json)、[原生二进制来源](evidence/final-1052/build-provenance.json)。不是 Chromium 或预配置开发 Server。

最终包重新完成正常所有权、Provider Fixture/Secret Service 设置、R5 opt-in、PG 001–045 初始化、Person 创建、Character/Journal/Worker 形成事实、自然纠正、原生 current/历史和系统重启。[首装](evidence/final-1052/result-install.json)、[重启](evidence/final-1052/result-restart.json)、[真实数据库与受限角色](evidence/final-1052/database-install.json)。没有 SQL 预写记忆/身份或 operator Harness 创建 Person。

## 故障矩阵

以下均在最终包重跑。`result-managed-*.json` 原样保留 `INJECTED_REQUIRES_NATIVE_REOPEN`，表示注入阶段，不是完整通过声明；通过来自随后独立正常原生重开、SQL 比较和最终冷恢复。每次注入记录内核 PID/start ticks、UID、实际 exe、cgroup、unit InvocationID、boot、数据根、包 SHA 和脚本摘要。fixture 不执行真实外部副作用。

| 要求 | 实际结果与边界 |
| --- | --- |
| 1 Supervisor SIGKILL | PASS：注入前 Runtime/PG 活着，OS 清空 cgroup，正常原生重开；没有人工清理 |
| 2 Launcher MainPID SIGKILL | PASS：整个所属 unit 清理后重开；外层等待客户端不冒充生命周期主进程 |
| 3 Supervisor + Runtime 同时死亡 | PASS：两个 pinned pidfd 注入，PG 清理，旧持久行/身份保留 |
| 4 仅 PG 死亡 | PASS：私人 API 拒绝；正常关闭/再启动 WAL 恢复，原生召回通过 |
| 5 合法用户请求处理中 | PASS：实际原生输入、Fixture 已接受并挂起，Supervisor 被杀 |
| 6 外部派发无终态 | PASS：同一请求接受次数 1，未重派、不伪造 APPLIED；不声称所有外部系统人工对账完成 |
| 7 Memory 纠正进行中 | PASS：仅用独立 SQL 连接持有 scope 行锁，没有写事实；真实用户纠正已进入 Worker。中断后旧 current/历史保留，生产 300s 租约到期后正式重试，最终纠正与原生召回通过 |
| 8 PID 真实复用 | PASS：仅在 VM root 设置内核 PID allocator；旧 Supervisor PID 分配给同 UID、同 Node exe 的无关程序。端口占用拒绝，未杀它；释放该测试程序自己的端口后，它仍存活，新包退役其引用的旧 kernel lock 并完成正常原生聊天 |
| 9 服务停止但 metadata 在 | PASS：SIGKILL 剩余 pointer/lock 不作为信号授权，后续新 invocation 正常启动 |
| 10 无关程序相同端口 | PASS：健康 HTTP lookalike 仍活着，启动拒绝，未启动第二个 PG |
| 11 同用户两个发行实例 | PASS：复制实际发行包到另一根与另一 state；第二实例拒绝端口、未初始化 PG，原 invocation/服务不变 |
| 12 两 Launcher 并发恢复 | PASS：旧 Launcher 死亡/清理后竞争新 unit，恰一接受一拒绝，只有一个 Runtime/PG；正常 stop 后原生重开通过 |
| 13 相似路径/不同归属 | PASS：上面的无关程序使用相似 Runtime 路径、相同 Node、相同 UID 和成功 health，cgroup 不属于本应用；没有接管或终止 |
| 14 reboot/冷恢复的旧 metadata | PASS：新 boot 下正常原生恢复；整机恢复前 gate/错误 boot 拒绝，审查后新 InvocationID/cgroup 使用原身份 |

[Supervisor](evidence/final-1052/result-managed-supervisor.json)、[Launcher](evidence/final-1052/result-managed-launcher.json)、[同时死亡](evidence/final-1052/result-managed-both.json)、[PG](evidence/final-1052/result-managed-pg.json)、[PG 原生重开日志](evidence/final-1052/pg-reopen-navigation-aware.txt)、[纠正](evidence/final-1052/result-managed-correction.json)、[纠正恢复](evidence/final-1052/result-managed-correction-reopen.json)、[派发](evidence/final-1052/result-managed-effect.json)、[并发恢复](evidence/final-1052/result-managed-concurrent.json)、[独立实例](evidence/final-1052/result-managed-negative-active.json)、[实际 PID 复用与 kernel lock](evidence/final-1052/result-managed-pid-reuse-port.json)。复用实验原始 `scope` 文案仍写 pointer；实际选择的是记录过的 Supervisor 旧锁，`oldKernelIdentity` 提供原始 boot/ticks。`pgControlUnchanged` 只指端口拒绝阶段，后面的合法原生聊天当然允许数据库进展。

没有观察到误杀、双 Runtime 写入、重复派发或历史/A9 回执改写。该结论限于所列实验，不是任意故障组合、磁盘损坏、内核/manager 失效或长期负载证明。不能证明的历史进程仍需人工调查，产品拒绝信号是正确行为。

## 原冷恢复协议回归

没有换成简单文件复制。最终包 native logout 撤销所有 grant、drain 摄取，正式 launcher 先写并 fsync gate 再关闭 Writer/PG；控制状态 `shut down`。完整关机后独立 qcow2/seed/manifest，POSIX 私有目录和外部单次登记。新 VM `ownership-restore` 首次启动与错误 boot review 拒绝；明确审查源关闭、删除与执行水位后，外部登记先失效，再发当前 boot 的 clearance。

[冷封存](evidence/final-1052/cold-seal.json)、[机器备份 manifest](evidence/final-1052/backup-manifest.json)、[恢复前拒绝](evidence/final-1052/result-restored-gate.json)、[原生恢复](evidence/final-1052/result-restore.json)、[逐行比较](evidence/final-1052/restore-comparison.json)、[恢复 SQL](evidence/final-1052/database-restore.json)、[第二次旧点拒绝](evidence/final-1052/old-point-reuse.json)、[实际模型输入](evidence/final-1052/fixture-transcripts-restore.json)、[原生历史截图](evidence/final-1052/native-history-restore.png)。旧 Cookie 401，Person/owner/创建回执与旧不可变行一致，已完成摄取不重做；新会话实际 system Memory context 含纠正事实，没有靠旧用户对话偷渡答案。

同 OS/user/keyring 的边界不变，仍需要原 Secret Service 解锁，不支持跨账户/PITR/全域隐私删除。未填充的过期/已删除 Observation、Legacy/Mem0/Profile/Dream 和 P8 动态编辑继续列为未验收。源保持关闭；恢复目标产生进展后不重置登记或启动旧点。

## 本地、失败记录与复跑

最终生产输入的 `pnpm check`、构建及带显式隔离 PG 的全仓测试通过：Vitest **4144 passed / 57 skipped**、Node **69 passed**；Debian12 release/custom-protocol Rust **112 passed**，打包 **78 passed**，恢复 Python 6 项和 launcher 实进程回归通过。skip 仍是未覆盖。[validation](evidence/final-1052/validation.json)。CI 按新 Draft 的实际最终 HEAD 单独记录，不拿 #336 或先导包的绿灯替代。

[先导失败](evidence/attempts.json)、[最终包测试设置记录](evidence/final-1052/attempts.json)：首次全仓 WebSocket 测试固定 20ms 查询持久回执导致失败，改为等待实际 immutable receipt，未放宽结果；纠正验收首次 180s 小于生产 300s 租约，保留失败后按原 TTL 恢复；一次 reload 后未等 Chat textarea 挂载，改为正常选择聊天与等待真实 DOM，未修改应用。原始本地日志在 `build/crash-ownership-validation`。

构建/空白 VM/冷恢复入口继续用 [#336 操作合同](../../../scripts/release-candidate/README.zh.md)。新增工具 `managed-lifecycle-guest.py`、`managed-negative-active-guest.py`、`reused-pid-port-guest.py` 只接受明确的 `yuvi-rc` 合成 VM；最后一个仅 VM root 用来复用 PID，绝不能在宿主或生产运行。guest 工具路径分别为 `/home/tester/managed-lifecycle.py`、`negative-active.py`、`reused-pid-port.py`。原生 driver 调用模式：`managed-supervisor / managed-launcher / managed-both / managed-pg / managed-correction / managed-effect / managed-concurrent`，每次后正常 `reopen-managed`，另外 reboot、seal、restore。不要重跑有单次断言的 effect 或覆盖已有实验材料来伪造成功；使用新 VM。

宿主空间不足只清理本工作树可重建编译缓存；旧合成 VM 完整加密归档并解密校验原磁盘 SHA。最终源已与正式冷备做 `qemu-img compare` 全逻辑扇区相同校验，退役本地重复磁盘，保留原 seed/日志及私有备份；没有 force-share、删除 DB 锁或触碰真实目录。镜像、Cookie、owner、keyring、SSH/归档 key 均不提交。

## 发布否决项与下一切片

原 Supervisor SIGKILL 阻断已关闭，但 **不能切换真实 Alice**。PR B 必须完成真正旧二进制升级、版本兼容、阶段失败和新事实后禁止错误回退；#325 旧 runner `42809` 风险没有被本切片消除。旧资产 D 仍无新增 Mem0/Profile/Dream 格式消费者，不能由旧 SQL 空表或 R5 新事实推导迁移完成。

没有获准独立 Provider，真实模型实验仍 BLOCKED；Fixture usage 不是语言/Token/费用成绩。Windows/macOS、完整 Avatar/语音 profile、Wayland/GPU、隐私删除/PITR、全量迁移、QQ PRIVATE/GROUP、Truthfulness 与长尾检索、多 Scope 长期负载等原阻断保留。建议人工按原依赖链审查 #322–#336，再审查本 PR A 和后续 PR B；合并、发行运行、私人资产迁移仍是独立动作。
