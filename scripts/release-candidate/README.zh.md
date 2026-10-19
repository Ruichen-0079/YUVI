# 隔离 Debian R5 候选验收工具

这些工具只针对新建的 `yuvi-rc` 实验 VM。它们不是生产安装自动化，不探测已有安装/Provider，不授权 Alice 部署或真实数据迁移。报告：[实际首装与恢复](../../docs/research/r5-release-candidate/README.zh.md)。

## 构建与普通安装

构建端需要 pnpm/Rust 缓存、bubblewrap、Debian 12 构建根（C/C++/pkg-config、WebKitGTK 4.1 dev、GTK/appindicator/rsvg/xdo/SSL/Secret Service dev）、已锁定 Cargo 依赖。PG 的 Debian 构建还需要 make/curl/bzip2/openssl dev/patchelf；使用 `scripts/conformance/prepare-postgres.sh` 的固定来源和摘要，pgvector 不使用构建机 CPU 特性。builder 属于构建依赖，不会复制到用户运行环境。未证明字节级可重复构建或完全离线构建。

在干净、已提交 checkout 中构建，构建期间不要编辑文件：

```sh
YUVI_LINUX_BUILD_ROOTFS=/absolute/disposable/debian12-rootfs \
  node scripts/desktop-package/build-linux-desktop.mjs
YUVI_LINUX_POSTGRES_HOME=/absolute/debian12-built/postgresql-16.15 \
  node scripts/desktop-package/prepare-linux-r5.mjs
```

将生成的 tar.gz 与预先核对的 SHA256 送到空白 Debian 12 x86_64，解包到新的应用目录。普通在线安装使用 OS apt，图形桌面与可解锁的 Secret Service 是运行前提：

```sh
sudo bash ./install-system-dependencies.sh
./yuvi
```

发行包自带 Node/PG，不运行 pnpm，不指向源码或已有数据库。系统库已满足后的应用运行与完整离线 OS 安装是不同合同；后者未验收。R5 profile 不包含 Avatar Core、语音、Mem0 或任何 Provider 密钥。

## 空白 VM 与原生 Fixture

需要 qemu-system-x86_64/KVM、qemu-img、genisoimage、SSH，实验目录必须在实际执行 0700 的 POSIX 文件系统。保留官方 Debian 镜像及核对过的 SHA512；本次摘要在报告中。不要复用已有 VM、私有数据目录或 SSH key。

```sh
YUVI_RC_LAB=/absolute/private/new-vm \
YUVI_RC_IMAGE=/absolute/verified/debian12.qcow2 \
YUVI_RC_IMAGE_SHA512=OFFICIALLY_VERIFIED_SHA512 \
YUVI_RC_SSH_KEY=/absolute/private/new-key \
YUVI_RC_SSH_PORT=22291 \
  bash scripts/release-candidate/boot-debian-vm.sh
```

通过其显式 SSH 入口将发行包放到 guest `/home/tester/yuvi`。在 guest 使用发行包 `install-system-dependencies.sh --test-tools`；这会单独安装 Xvfb、Openbox、WebKitWebDriver、xdotool、scrot、Python 和 Secret Service 测试工具，不给应用添加系统 Node/PG。准备在 Debian12 编译的 `tauri-driver 2.1.0 --locked` 为 `/home/tester/tauri-driver`。不要使用要求更新 glibc 的宿主二进制。

只复制测试工具，不复制任何已初始化状态：

| 仓库文件 | guest 路径 |
| --- | --- |
| `native-guest-acceptance.py` | `/home/tester/native-install.py` |
| `guest-database-evidence.py` | `/home/tester/guest-db.py` |
| `seal-guest.py` | `/home/tester/cold-seal.py` |
| `run-native-guest.sh` | `/home/tester/run-guest.sh` |

guest 顺序执行：

```sh
bash /home/tester/run-guest.sh install
sudo systemctl reboot
# 用同一明确 SSH 入口重连，验证 boot ID 改变
bash /home/tester/run-guest.sh restart
bash /home/tester/run-guest.sh pg-conflict
bash /home/tester/run-guest.sh major-mismatch
bash /home/tester/run-guest.sh keyring-unavailable
bash /home/tester/run-guest.sh crash
bash /home/tester/run-guest.sh seal
```

脚本启动的是发行包 `./yuvi`，不是 Server harness。Fixture 是 127.0.0.1:18085 的真实协议 HTTP 服务。所有权、设置、Person 通过真实 native 对话框；OS 密钥环只使用公开的合成密码 `synthetic-test-keyring-password`，恢复时如需要会在真正的系统解锁框输入。它绝不能用于真实用户账号。

`major-mismatch` 只暂改此合成实例的 PG_VERSION，并在关闭后恢复原字节；其它持久数据不覆盖。`crash` 仅杀死已核对包路径与 owned 状态的 Runtime PID；Fixture 接受一次请求后挂起，不执行真实副作用。`seal` 先退出客户端，检查所有未撤销 grant 为零、摄取已完成，再通过正式 launcher 封存/关闭并验证启动拒绝。失败输出不是通过；不要删掉失败样本或改写问题来制造结果。

## 全机器冷备份与恢复

复制 guest 的 `cold-seal.json`、`yuvi/install-manifest.json` 到宿主私有输入目录，然后正常关机。以下全部路径必须是这次实验的新路径。不要复制正在写入的磁盘，也不要启用 qemu force-share。

```sh
python3 scripts/release-candidate/cold-vm-recovery.py backup \
  --disk /private/source-vm/vm.qcow2 --seed /private/source-vm/seed.iso \
  --seal /private/inputs/seal.json --release /private/inputs/release.json \
  --serial /private/source-vm/serial.log \
  --destination /private/backup/point001 --registry /private/custody/registry.json
python3 scripts/release-candidate/cold-vm-recovery.py restore \
  --backup /private/backup/point001 --registry /private/custody/registry.json \
  --disk /private/new-restored-vm/vm.qcow2
```

registry 必须在历史备份目录外，目录 0700；不能将历史 registry 一起回滚。工具保留加密 keyring，恢复仍需原 OS 用户与原解锁密码。没有跨 OS/用户密钥迁移或历史隐私擦除保证。

使用独立 QEMU/SSH 端口启动新磁盘及它自带的 seed.iso，源 VM 保持关闭，不共享宿主目录。`./yuvi` 应先拒绝 `RECOVERY_REVIEW_REQUIRED`。记录目标 `/proc/sys/kernel/random/boot_id`，在外部私有 JSON 中审查：

```json
{
  "backupId": "EXACT_MANIFEST_BACKUP_ID",
  "reviewer": "EXPLICIT_TRUSTED_REVIEWER",
  "basis": "VERIFY_SOURCE_OFF_AND_RECONCILE_POST_POINT_EFFECTS_AND_DELETIONS",
  "deletionReview": "NO_UNRECONCILED_DELETIONS",
  "executionReview": "NO_POST_POINT_EFFECTS"
}
```

有新的执行/删除或无法证明没有时，不能填写这些断言。保留当前状态并进行人工前向对账，不能重置 registry 逃过拒绝。

```sh
python3 scripts/release-candidate/cold-vm-recovery.py clearance \
  --backup /private/backup/point001 --registry /private/custody/registry.json \
  --audit /private/custody/audit.json --output /private/custody/clearance.json \
  --target-boot-id EXACT_RESTORED_BOOT_ID
```

先把 clearance 作为 owned 0600 普通文件送入目标 guest，再在目标执行 `./yuvi review-recovery /absolute/clearance.json`。这只记录审查，不启动服务。工具在发出 clearance 前使历史点失效；失败后可能需要新的人工审查，不能自动重用同一历史点。

复制最新验收工具到已恢复的 guest，运行 `bash /home/tester/run-guest.sh restore`：正常 native 选择旧 Person，检查旧 Cookie 401、旧不可变行与完成摄取、未决 attempt 不 APPLIED/不重做、新会话 actual Memory context、原生 current/历史。第二次历史恢复应被 registry 拒绝。验收通过后通过正式 stop 关闭测试实例。

完成首次恢复且已保存 `cold-seal.json` 后，可以在当前向前运行的恢复 VM 注入单项故障（不会再次恢复旧磁盘）：

```sh
bash /home/tester/run-guest.sh pg-crash
bash /home/tester/run-guest.sh restore
bash /home/tester/run-guest.sh supervisor-crash
```

`pg-crash` 后的独立 `restore` 模式是正常原生重开验收，检验 WAL 恢复/旧状态/撤销/新会话召回，并非重新应用历史磁盘。Supervisor 注入已证实孤儿进程阻止自动重开。只有该隔离实验中，才可复制并审查 `cleanup-supervisor-orphans-guest.py` 后运行；它核对记录 PID、UID、Runtime 配置与 PG 数据目录，人工关闭明确属于本实验的孤儿进程。随后正常重开通过不能解除自动恢复阻断，不要向真实安装套用这个清理脚本。

`full-volume-guest.py` 需要 guest sudo/mount/mkfs.ext4，只使用新的固定 `/home/tester/rc-enospc2.img` 和 mountpoint，拒绝覆盖，160 MiB 上限；原产品必须停止。复制合成状态仅为故障注入，不用于首装验收；实际 ENOSPC/非零退出及原 PG control 不变才通过。首次失败的 `/home/tester/rc-enospc.img` 仍保留。结束后脚本卸载故障卷，不删除证据；重开原生应用另外验收。

证据目录有一个 `revoked-credential.private.json`，只用于旧 Cookie 反向测试，**不得上传整个证据目录**。只选 result/database/Fixture transcript/公开截图与 manifest，排除 Cookie、owner、keyring、数据库镜像、SSH key 和 controller 文件。

## 确定性回归与 SQL 边界

```sh
node --test scripts/release-candidate/*.test.mjs
YUVI_MEMORY_R5_TEST_DATABASE_URL=postgres://TEST_OWNER@127.0.0.1:EXPLICIT_PORT/yuvi_smoke \
  pnpm exec tsx scripts/release-candidate/check-main-schema-upgrade.mts \
  --run --output /absolute/synthetic-main-upgrade.json
```

SQL 工具只接受显式 loopback 合成数据库，使用唯一 schema 并清理自己的 schema。它核对 main 的 25 份 SQL 与候选前缀完全一致，验证升级、重复、旧资产不自动晋升及事务失败；它不代表已安装旧二进制的升级/回退验收。完整版本升级、失败阶段注入、A9 后回退与真实旧资产盘点仍开放。
