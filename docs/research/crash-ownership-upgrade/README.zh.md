# R5：崩溃所有权与版本升级（进行中）

基线 #336 `2a0db78064a7f43cc41e6818fdd69eec277141de`，接手干净工作树；原始首装/恢复证据原样保留。没有访问真实 Alice。此文件目前记录实现选择，不表示 VM 验收或升级已经通过。

## Linux 所有权选择

进程组不能约束 PG daemon 的 setsid 生命周期；仅重读 PID/路径/端口/health 无法避免复用与误杀。选择 systemd **用户 transient service**，主进程是正式 Launcher，Supervisor、Runtime、PG、原生窗口和 Web 同属 cgroup v2。普通 Supervisor 仍管理服务、challenge 和权限，OS 只提供生命周期包含与退出清理，不另建身份 Authority。没有 service manager 的 R5 环境拒绝降级为无保护启动。

`Type=exec`、`ExitType=main`、`KillMode=control-group`、`Restart=no`、`TimeoutStopSec=45s`。Supervisor 死亡后 Launcher 退出，OS 对剩余 cgroup 先 TERM，期限后 KILL；Launcher 本身 SIGKILL 同样触发清理。PG 即使脱离进程组也不能凭 setsid 离开 cgroup。正常关闭先停 Writer，再用已 pin 的 pidfd 向私有 postmaster 发 SIGINT（PG fast shutdown），不删除 lock 文件、不按旧 PID 强杀。

依据：[systemd 252 生命周期](https://www.freedesktop.org/software/systemd/man/252/systemd-run.html)、[cgroup 清理规则](https://www.freedesktop.org/software/systemd/man/252/systemd.kill.html)、[PG16 正式 shutdown 信号](https://www.postgresql.org/docs/16/server-shutdown.html)。

同一 canonical state root 使用唯一 unit 名；OS StartTransientUnit 序列化并发 Launcher。包 SHA/根绑定在 unit 描述，主 PID、OS InvocationID、当前 cgroup 同时匹配才能进入真正启动；普通环境变量不能跳过。有效的其它 Launcher/包/实例只拒绝，不自动停止。当前实例 draining 时有限等待；跨 boot 的磁盘 metadata 不授权任何信号。Runtime/PG adoption 另需当前 cgroup，缺少证明的历史 #336 孤儿仍拒绝接管。

`supervisor/lifecycle.json` 仅是审计副本，包含 boot、InvocationID、启动 ticks、cgroup 与包版本；它不是发信号凭据。系统服务管理器与同 OS 用户账户属于可信控制面，不声称抵抗已经控制该账户或 root 的攻击者。外层 systemd-run 等待客户端死亡不改变仍有效的 GUI/service 身份；真正 Launcher MainPID 死亡才触发整个 unit 停机。

## 尚待实测

新发行包的 Debian VM 故障矩阵、原生关键路径、冷恢复回归；真实历史安装二进制升级与阶段失败。真实模型没有获准独立 Provider，继续 BLOCKED。Windows/macOS、隐私删除、全量旧资产迁移仍未通过。旧资产 D 在 A/B 稳定后另做。
