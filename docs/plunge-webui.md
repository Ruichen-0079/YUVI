# Plunge ZIP WebUI

这是独立 Alice / Plunge 的本机管理界面。代码在 `apps/server/plunge-webui`，不使用 `apps/web`，无 CDN。ZIP 提供 Linux x64 Node 24、Runtime bundle、静态资源及启动器，使用已有独立 Alice composition、Memory schema 和 SnowLuma 配置；不包含任何账户、密钥、数据库或私人对话，也不启动另一个 Character。

## 启动

解压后运行（部署主机需有原本的 SnowLuma、模型和 Memory 服务）：

```sh
cd Plunge-WebUI-linux-x64
./start.sh --character /absolute/path/alice.json --plunge /absolute/path/plunge.json --port 6135
```

需要自动打开浏览器时，使用同目录的 `./start-webui.sh`，首次启动参数与 `start.sh` 相同。已经启动时再次运行 `./start-webui.sh` 会打开现有 WebUI，不启动第二个 Alice。

“插件与诊断”页面提供“打开 QQ”和“打开 SnowLuma”。启动器从既有 OneBot 配置定位 SnowLuma；QQ 可识别唯一的系统安装或 SnowLuma 同级/桌面的 QQ AppImage。有多个 QQ 安装时需明确选择。也可以首次启动时指定并保存：

```sh
./start-webui.sh --character /absolute/path/alice.json --plunge /absolute/path/plunge.json \
  --qq /absolute/path/QQ.AppImage --snowluma /absolute/path/SnowLuma
```

QQ 使用客户端的原生单实例唤起。SnowLuma 已运行时直接打开实际控制台端口（支持默认端口被占用后的相邻端口）；未运行时使用 ZIP 自带 Node 启动该目录的 `index.mjs`。SnowLuma 保持自己的登录认证，控制台 URL 不附带密码/令牌。Alice 已连接但控制台不可访问时不启动重复实例。应用不随 Alice 关闭而退出；应用私有日志为 `state/qq.log`、`state/snowluma.log`。只调用启动器固定的路径，管理 API 不接受任意命令，也不把 Alice 管理令牌或 Node 调试 preload 传给应用。

首次切换应先正常关闭旧 Alice 进程，保留 SnowLuma 与其他 Character。不要同时运行同一个 QQ adapter 的两个实例。已有 Character/database ownership 校验保持启用。启动器记住部署路径，此后直接 `./start.sh`；Ctrl+C 正常关闭。只重启 Alice，使用同一 ZIP 启动命令即可应用待重启配置。

打开 `http://127.0.0.1:6135/plunge`，输入 `state/admin-token` 文件中的令牌。令牌和日志权限 0600；令牌只驻留页面内存，刷新后重新解锁。所有 Alice API（包括历史 legacy 读取入口）要求本机、Bearer 管理令牌及同源请求，校验 Host 防止 DNS rebinding。监听强制 127.0.0.1，CSP 禁止远程资源和嵌入。不要共享令牌。

## 功能与真实边界

- 运行概况：独立 Character、实际 authored 身份/人格/response requirements、QQ 连接及队列、最近活跃会话、Memory 管道、实际 Provider 状态。
- 模型：复用 Product 配置 parser、Registry、revision conflict、配置 Journal admission 和 Runtime reload。支持六项模型能力、Provider 参数、温度、context window、embedding dimensions、voice、已实现 adapter、顺序 fallback。密钥不回显；空白保留已有密钥。明确 ACTIVE / RESTART_REQUIRED / APPLY_FAILED 与路由观察状态。Embedding 空间变化待重启。模型应用在 QQ ingress 串行边界执行，已接收的 QQ turn 先完成。
- QQ：现有 PRIVATE / MENTION / REPLY / ALIAS / Attention 候选分支和续聊窗口可调整。冷却限制候选机会，仍记入 ambient receipt，不制造 SILENCE，也不强迫回复。发送引用开关控制现有 reply segment。允许列表存盘、待重启后生效；不会偷偷放宽运行中授权。普通群聊 Attention 需已有服务。没有随机“活跃度”分数，也没有尚未接入 QQ 的主动发消息滑块。发送侧没有原生 @ 参数，因此不提供该控制。
- Memory：读取同一 Alice repository 和已有 semantic retrieval。旧 direct-table CRUD 被管理入口禁用。语义管理只使用 P8 correction protected command，Core 检查所有者、scope、固定 invariant、冲突与命令 receipt。P8 改的是语义解释，不是记忆原表。当前稳定关系解释目标为 `relationship.current`；其他 targets 按 Core 实际权限校验。Finalized pending 和现有 Dream/ingestion diagnostics、记忆 evidence/source 元数据可读。普通 maintenance 表修改入口不开放。
- Prompt Inspector：在真实 ChatModel generateReply / streamReply 边界捕获输入，使用已有 producer-owned offsets 提取组成，保留完整消息原文和 ChatInput。捕获授权、候选、修复、Cognition 后续、Vision evidence 与最终流式请求；展示 authored / runtime / historical evidence 区别。同时显示真实模型返回中的 authorization / disposition，以及调用失败代码，便于区分 NONE → SILENCE 与网络错误。没有输入时显示空状态。Adapter 默认参数与 wire JSON 归 Provider 实现；Inspector 不伪称 ChatInput 为 HTTP wire。最多 12 个完整请求，按整条请求淘汰，内存约 2 MB（单条超过限制仍保留完整）。重启清空，不持久化私人请求。
- 诊断：有界 QQ trace（READY、SILENCE、ACK、超时、失败、Attention 等）和 Alice Runtime event。UNKNOWN 不盲目重发。完整原始日志留在私有 state 文件。QQ 初次连接失败与后续断线均以 0.5 秒起、最长 30 秒的退避重新握手；成功后重置退避。重连不会重试 OneBot 发送，UNKNOWN 保持不重发；最近 256 个具有完整原生身份的输入指纹在本进程内跨重连保留，并在异步处理前占位，防止近期原样回放再次触发发送。此指纹缓存有界、非持久化，不能把它声称为任意时间/跨进程 exactly-once。浏览器断网后只重连只读状态，绝不自动重提交配置/P8/重连命令。页面提供受保护的手动 QQ 重连，等待当前接收队列边界后执行。

Alice 的 authored 人格是 immutable composition，固定 invariant 不提供可伪造的编辑框；已有 USER_REVISABLE 修正必须经 P8。界面不会编辑运行时上下文或重建 Memory。

## 开发与打包

```sh
pnpm --filter @companion/server... build
node scripts/plunge/package.mjs /absolute/output/path
```

设置 `PLUNGE_NODE_PATH` 可选择已准备的 Linux x64 Node >=22 standalone distribution，`PLUNGE_NODE_LICENSE_PATH` 指向该发行包的 LICENSE；交付包实际包含 Node 24.20.0。构建校验 bundle 的外部模块；只允许 Node builtins 及三个可选 native addons。ZIP 不含 node_modules，无需 pnpm/联网安装。平台支持为 Linux x64；其他平台需提供对应 Node 并重新打包。
