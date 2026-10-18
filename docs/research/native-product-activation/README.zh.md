# Native Desktop Host 与首次 Person 激活

基线：[#334](https://github.com/Ruichen-0079/YUVI/pull/334)，`8e6f3ca09ae758612b8ae85b5f4dc4ced275bbb1`。接手工作树干净，原分支为 `feat/product-memory-host`；新增 `feat/native-product-activation`，没有改写 #333/#334、合并或部署。再次核对 #334 远端 HEAD 未变，三个工作流均成功。

本批使用 **Rust 保管受限 Product Host、明确操作的 Tauri IPC**。Linux `.deb` 解包出的真实 Tauri/WebKitGTK 窗口已经完成：确认本机所有权、显式启用 R5、创建/选择 Person、聊天形成事实、纠正和历史、应用及 Runtime 重启召回、续期、切换、退出和撤销。普通页面不接触 operator/controller/Host 凭据。HTTP 浏览器继续使用 #334 的原有 Cookie 合同。

**测试 A 是真实原生产品运行，但语言 Provider 是严格生产协议的网络 Fixture。测试 B 未运行：没有收到获准使用的独立真实 Provider 配置路径，没有扫描现存安装或读取 Alice 凭据。不能据此宣称真实语言理解已通过，也不能切换真实 Alice。**

## 架构选择

| 维度 | A：可信同源本机 UI | B：原生受限代理，本批选择 |
| --- | --- | --- |
| 平台 Origin | 要把 WebView 导航到另一个本机服务，并管理远程文档能力 | 保持打包 UI；接纳精确的 `tauri://localhost`、`http://tauri.localhost`、`https://tauri.localhost` |
| 现有浏览器 | 同站 Cookie、SSE、WS 易复用 | 保留完整浏览器路径；仅原生请求进入 IPC |
| 凭据 | HttpOnly Cookie 仍需要服务 Origin、端口与生命周期可信 | Cookie 和本机 owner 材料只在 Rust；页面只得到身份元数据与允许的产品结果 |
| 首次使用 | 仍需另一条原生可信控制链确认本机所有权和 Person | 原生确认框直接约束创建、选择和配置变更 |
| 导航/恶意页面 | 动态 HTTP Origin 加上 IPC 权限，需要额外的远程文档绑定 | 精确文档 Origin、窗口标签、显式 capability；拒绝外部导航和新窗口 |
| XSS | 能使用当前网页授权；HttpOnly 不能防止已获权页面调用 API | 能使用当前 Person 的受限产品操作；不能提取凭据，创建/切换/运维仍需原生确认 |
| 网络 | 增加静态资源服务、监听端口、导航、Cookie/CSRF/CSP 管理 | 固定 Runtime、固定操作；没有任意 URL/方法/头的 HTTP 代理 |
| 流式与维护 | 复用浏览器网络，但引入另一套 UI 服务发布与升级边界 | SSE Channel 与固定 `/ws` 原生连接；需要维护明确的操作白名单和取消所有权 |

Tauri 的平台 Origin、能力边界及自定义命令默认行为见 [Capabilities](https://v2.tauri.app/security/capabilities/)、[CSP](https://v2.tauri.app/security/csp/)。[localhost 插件](https://v2.tauri.app/plugin/localhost/)明确提示本机服务的安全成本。本批选择 B 是结合现有打包窗口、Supervisor、Cookie Host 和升级路径的工程判断，不把 localhost 当作身份。

`build.rs` 显式列出应用命令，生成 allow/deny 权限；没有依赖“注册命令就默认可调用”。私有产品命令只给 `main`/`webui` 的本地文档。Rust 再验证实际窗口标签和 URL。`companion`/`subtitle` 不获得私有产品能力；没有 remote capability。开发 Origin 仅在 debug 构建显式匹配，release 不接受任意本机端口。

## 产品调用链与首次使用

1. 打包窗口可以在 Runtime 未就绪时显示首次使用界面，不会回退到 6121 或其它安装。
2. 原生系统确认本机应用所有权，生成只属于此配置目录的随机 owner 材料。网页不能用 `confirmed:true` 替代这一步。
3. 未选择 R5 的配置显示“启用本机记忆”；原生确认后只修改现有配置权限内的后台选择，复用现有 Supervisor/存储启动序列。不会自动搬迁旧记忆或认领已有 Person。
4. 创建只需要名字。Native 将冻结的名字、稳定 command handle 先 fsync，再通过受信任 Supervisor 调用已有 `HostProductPersonCommandEffects`。Person 与应用回执仍由 ProductStore/A9 原子提交。
5. ProductStore 增加 `nativeOwnerByPersonId`，只列出此 owner 明确创建且属于当前 Persona 的身份。既有 People 不自动归给当前操作者；owner 材料丢失也不能用 Person ID 认领。
6. 选择来自受信任列表的 Person，再次原生确认。先撤销旧客户端，之后内部单次配对并签发受限 Host；页面不拿配对码、Cookie 或 Bearer。
7. 正常 Main 聊天使用原生 SSE，进入正式 Server/Character/Journal/Worker；Memory 页面复用 `MemoryKnowledgeClient` 和 `/memory/v1`。相同窗口可以切换聊天、当前认识、历史及来源。
8. 应用退出保留合法会话以便重启恢复；“退出身份”撤销当前 Host 并清除本机客户端会话，保留该 owner 的身份列表。再次进入必须明确选择/确认，旧凭据不会恢复。

同一桌面配置中的主窗口和设置窗口共享当前 Person。切换是整个该桌面实例的切换；另一个独立应用实例应使用自己的明确配置目录。并不支持把普通 session ID 当作 Person 绑定。

启用时，已有明确数据库配置会继续走其受信任配置；没有数据库配置时选择现有的受管私有 PostgreSQL 启动流程。启动任务按配置版本检查 currentness，并在进程内串行，避免旧 Mem0 启动任务覆盖用户刚确认的 R5 设置。完整发行包的私有 PG 首装组合仍须单独验收，见限制。

## 关键权限与生命周期

- 复用 #334 的 Product Host、一次性短码、Host grant、Person authority generation、Journal 身份和 SQL 权限；没有新 Memory Authority、队列、语义模型或执行账本。
- Supervisor 的原生控制请求仍要求私密 controller 证明并拒绝浏览器 Origin/Referer。Runtime 必须由当前 Supervisor 拥有且健康，并以随机挑战证明其 Host 身份。原生会话固定到 namespace/instance/Persona/Origin，不能借请求 Scope 换身份。
- Native HTTP 只允许健康/状态、限定聊天、限定 Memory 查询和权限生命周期操作；没有运维 API 透传、任意头、重定向或任意上游地址。正常网页不获得 operator token。
- 凭据在原生私有目录原子持久化，Unix 目录 0700、文件 0600。页面只收到 status/body/content-type，`Set-Cookie` 不返回 JS。owner 元数据也从 Product settings 的可见快照中移除。
- 私人请求准入前核对 Host 状态；只为未撤销、仍可续期的授权轮换。轮换和 HTTP/SSE/WS 握手串行化。不会为普通聊天自动重放请求，也不会在 UNKNOWN 后用新 command handle 重做创建。
- SSE/WS 固定端点，Channel 按窗口/请求归属取消，身份 generation 防止旧响应显示。WS 只允许 `user.message`；不允许订阅全局 operator dashboard 流。旧连接不能借重连恢复已撤销身份。
- 原生退出先持久化 `suspended`，再尝试服务端撤销。服务中断时显示“继续完成退出”，本机私人请求持续拒绝；不是假装已完成撤销。Runtime 恢复不会自动重新启用旧会话。
- Person 文本资料变化沿用原来的 authority-generation 语义；真正绑定变化仍使旧 grant 失效。Native 创建不抢占全局 primary Person。
- Memory 开关仍由服务器执行。UI 的权限 Context 只是投影，不能赋予权限；跨 Person Scope、DTO 身份覆盖和运维访问不会因 IPC 获权。

CSP 从 `null` 收紧：限制脚本、连接、frame、object、base 和 form；保留必要的样式、字体、图像、WASM 与 IPC。公共 Live2D 资源使用只读、无凭据、绑定受管 Runtime 的原生资源协议，脚本只放行精确 Core 路径。实测允许该公共路径、拒绝内联注入；没有把资源协议做成私有 HTTP 代理。

## 实测与证据

测试应用是 **Tauri CLI release 构建的 `.deb` 中解包出的可执行文件**，不是 Chromium、MiniBrowser 或 Rust mock。WebDriver 仅驱动真实 WebKitGTK；本机确认框由精确窗口/PID 的键盘操作确认，测试同时验证 PID 的隔离 XDG 目录。没有用于跳过确认的生产开关。

运行环境：Linux x86_64 / CachyOS，XWayland，WebKitGTK；使用软件渲染规避本机 DMA-BUF 环境失败。没有把 Wayland/GPU、Windows WebView2、macOS WKWebView 或真实 Avatar 渲染算作通过。

- [原生结果](evidence/native-result.json)、[数据库最终结果](evidence/database-evidence.json)、[Fixture 模型输入/输出](evidence/model-transcripts.json)、[产物来源](evidence/provenance.json)。
- [真实原生当前认识](evidence/native-memory.png)、[原生历史与来源](evidence/native-history.png)、[重启后新会话召回](evidence/native-restart-recall.png)。
- [HTTP 浏览器兼容回归](evidence/browser-compatibility.json)。其中 native 状态只描述该浏览器测试自身；原生证据在独立文件。
- [失败与修复记录](evidence/attempts.json)。失败不删除、不改写为成功。

实际完成的原生场景包括：从 legacy 配置经原生确认启用 R5；创建成功但控制面回执丢失、应用重启后用原冻结命令恢复，只有一份 Person 回执；正常聊天形成事实；自然纠正与 superseded 历史；读写关闭；非法 Scope/控制面；CSP 注入拒绝；公共资源加载；WS 聊天与取消；过期续期及旧 token 失效；同端口健康假进程不能取得凭据；Runtime/应用重启后在新会话中召回；Person 切换；退出中断后的 tombstone；旧 WS/SSE/HTTP 拒绝；明确退出后的合法重新进入。

数据库使用显式隔离 31518 实例、每次独立 schema/合成 Person/Persona、非超级用户 application role。事实只由原生聊天经 Worker 形成；直接 SQL 用于验收查询及“过期”故障，不预写事实/答案。成功后保存不含凭据的证据并清理该次 schema/role；测试 keyring 使用唯一 namespace，结束时仅清理该 namespace。

| 反向边界 | 证据 |
| --- | --- |
| 其它网页不能创建或冒充 native Host | 真实控制面无凭据/非法 Origin 拒绝；native 文档/窗口单测；明确 capability |
| 导航/恶意文档不能取得敏感命令 | 真实窗口外部导航拒绝，原生 Origin 检查，禁止新窗口和 frame |
| 不暴露 controller/operator/Host 材料 | JS 元数据与模型输入检查；HttpOnly Cookie 不进入 `document.cookie`；无凭据返回命令 |
| Host 不跨 Runtime/Persona | 绑定校验、真实同端口假进程、Host/Person PG 回归 |
| 不同 Person 私有读取隔离 | 真实 Scope 403、切换后旧 cookie 401、旧 UI 清理 |
| WS 不能绕开 Memory 关闭/撤销 | 真实 native socket + 正式 Server + SQL 事实计数；旧连接取消/拒绝 |
| SSE 重连不能恢复失效授权 | 真实旧 Cookie 的 SSE 401；native stream generation 单测 |
| Runtime 重启不误连其它进程 | 真实停机、占同端口的健康假服务、拒绝发出凭据、受管 Runtime 恢复 |
| 旧异步响应不显示到新 Person | 原生切换清理 + HTTP/SSE generation 故障单测 |
| 重复配对/并发续期不复活旧权限 | 真 PostgreSQL Product Host 回归、内部单次消费、原生轮换及旧 token 401 |
| 未获权 JS 不能访问运维 | 原生未确认 owner 时 service action 拒绝；产品代理拒绝运维路径；运维另需原生确认 |
| 修改 Scope/主体字段不能扩大访问 | Server 自有身份/Authority PG 回归、HTTP 浏览器与 native 反向请求 |

### 本地检查

具体计数、命令和 CI 更新写入 [validation.json](evidence/validation.json)。`pnpm check`、`pnpm build`、完整数据库回归 `pnpm test`、Rust 测试、打包测试与独立浏览器/原生产品测试分别记录；skip 不算通过。

首轮 CI 在 `953a2dc` 暴露旧打包断言：启动代码不得出现任何 `DATABASE_URL` 字样。新增 R5 分支需要只读检查已有显式数据库配置，因此最终本地全量回归也复现这一失败。修复仅更新该断言：允许读取，继续拒绝生成/覆盖 URL；数据库选择的行为仍由 Rust 分支测试覆盖。失败记录及运行链接保留于 [ci-first-attempt.json](evidence/ci-first-attempt.json)，没有更改生产权限或重写原生验收结果。

复跑必须使用显式隔离数据库、绝对输出目录、独立工具目录及实际解包二进制路径：

```sh
YUVI_PRODUCT_HOST_TEST_DATABASE_URL=postgres://TEST_USER@127.0.0.1:31518/yuvi_pr_native \
YUVI_PRODUCT_HOST_ACCEPTANCE_ROOT=/absolute/isolated/native-evidence \
YUVI_NATIVE_TOOLS_ROOT=/absolute/test-tools \
YUVI_NATIVE_APP_BINARY=/absolute/unpacked-deb/usr/bin/yuvi-desktop \
pnpm exec tsx scripts/accept-native-product-host.mts --run
```

工具目录需提供 `bin/tauri-driver` 与 `usr/bin/WebKitWebDriver`；本机驱动的 ICU 兼容库位于工具目录内，未替换系统库。需要可用的 Linux 图形会话、xdotool、Secret Service 与 secret-tool。测试只向白名单系统环境传值，不继承任意 Provider/QQ/安装配置环境。

## 升级、恢复及正式切换阻断

没有 Migration 046，继续使用现有 045 schema。新增的是 ProductStore 的 owner 关联、Native 私有会话/待确认创建/退出 tombstone，以及已有设置 schema 的 `postgres` 后端选择。重复应用/启动按冻结 handle、A9 回执与当前配置恢复，不用普通会话 ID 推导 Person。

升级前需要配套保存 PostgreSQL、ProductStore/Person 代际及应用回执、Native owner 文件和对应配置/系统凭据。owner 文件不能当普通日志上传。丢失 owner 关联不能靠输入 Person ID 恢复权限；恢复数据库或凭据的不一致会安全拒绝，不承诺自动认领。不要把旧 #325 二进制启动当作新 schema/新配置的安全回滚。

本批 `.deb` 是原生壳的开发验收包，构建时显式跳过默认 dependency preparation，使用已经构建的 frontend；实际交互附着于正式隔离 Supervisor/Runtime。它不是经过签名、全依赖离线安装、升级/回退或发布验收的发行包。无显式数据库时新增的私有 PG 选择覆盖了现有 PG 生命周期和启动策略测试；完整发行 payload 下的 R5 私有 PG 零依赖首装仍未单独实测。

仍阻止真实 Alice 切换的门槛：

- **真实模型测试 B**：需获准使用的独立 Chat/Reasoning Provider 配置。没有真实语言成功/失败或真实费用成绩；Fixture 固定 usage 不是计费证据。
- Windows/macOS 的打包、Origin、系统凭据、流式及重启验收；Linux Wayland/GPU、真实 Core/Avatar、音频/其它尚未列入受限代理的能力。
- 全依赖发行组合、零依赖私有 PG 首装、备份/恢复与安全升级回退。原生壳运行通过不能替代这些门禁。
- 本批不解决 #333 中真实模型 `4A87 → 4A88` 引文失真、正确记忆未完整解释等语言问题；未放宽可信来源约束。
- 全量旧资产迁移、QQ PRIVATE/GROUP、全域删除、生产 PITR、多 Scope 长期负载、更多检索与 Truthfulness 仍沿用之前的开放状态。没有自动打开 Evidence Support 默认配置。

## 堆叠集成就绪度

| PR | 本轮判断 |
| --- | --- |
| #322–#332 | 保持原依赖链，未重审其全部验收；不能由本批 native 通过推导全量切换就绪 |
| #333 | 存储纠正收敛已完成且本轮未修改；真实模型引用质量仍独立开放 |
| #334 | 浏览器 10 组兼容回归继续通过；本批接替其原生入口断点，没有 retarget 或改写 |
| 本批 Draft | Linux 原生身份/首次 Person/R5 确定性纵向切片已通过；上述模型、跨平台、发行与数据门槛未解除 |

未合并任何 PR，未接触 Alice 的数据库、凭据、QQ 或安装配置，未对真实安装执行启动、重启、迁移或部署。
