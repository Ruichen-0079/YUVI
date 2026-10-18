# Product Host → R5：本机浏览器纵向闭环与桌面切换边界

2026-10-18。生产实现 `39ad543`；回归与产品验收 `c54a1d6`；后续补充配对签发期间 Person generation 改变的竞态回归。直接继承 #333 的 `d268a2c5db024a253f5835a91b8617d7deb05593`，不改写 #333，也不重复目标 A。

**可用范围：可信本机 Desktop Supervisor → 正常 production Runtime/Character → 本机 HTTP 浏览器 WebUI/Main → 正式 R5。打包 Tauri WebView 的非 HTTP Origin 尚未接通安全 Cookie 身份，完整原生桌面切换仍开放。** Rust/打包测试通过不等于原生桌面产品交互通过。

## 接手与复用

接手工作树 `/home/ruichen/Projects/yuvi-product-memory-host`，分支 `feat/product-memory-host`，HEAD 与 origin 的 `fix/memory-formation-convergence` 均为 `d268a2c`；`origin/feat/evidence-support-integration` 的 `c1c507d` 是祖先。#333 仍 OPEN，三个工作流通过。无移植、rebase、reset、clean 或历史改写。

接手时 22 个已修改文件、6 个未追踪文件；tracked diff 为 496 additions / 85 deletions。已保存 tracked binary patch、未追踪文件 tar 和 status 到本机私有断点目录。首轮 `pnpm check` 通过。

复用了全部已有方向：045 migration、ProductHost/路由、ConversationHostIdentity 接口、KnowledgeReader/RetrievalEvidence 过滤、Supervisor HTTP/HMAC secret 传递、Tauri command、MemoryKnowledgeClient 浏览器封装、Authority Memory 页面、健康与聊天接入、显式 endpoint-file 配对脚本。没有另建 Authority、Queue、语义模型或执行账本。

## 完成的边界与修复

- Supervisor 配对入口必须持有 control token；拒绝 Origin/Referer/Sec-Fetch-Site 浏览器调用，必须确认为 owned、healthy Runtime。Runtime 再验证派生 controller secret、本机 IP 和无浏览器来源。原生调用只接受 bundled WebUI 或配置的本机 dev Origin；其他窗口/外来文档拒绝。controller/operator 凭据不返回网页。
- Person 来自可信控制者选择的已存在、具有 authority generation 的 Person；Persona 和 Journal namespace 来自实际 Host。配对码随机 256 bit，DB 只存 SHA-256，绑定 Person generation / Persona / instance / namespace / exact Origin，五分钟有效，行锁内单次消费；grant 签发再次核对配对码的原始 Person generation，拒绝中途身份替换竞态。浏览器不能签发、更改 scope 绑定或靠 sessionId 获得 Person。
- 浏览器只得到 HttpOnly Cookie；SameSite=Strict；HTTPS 时 Secure。本机 HTTP 是本轮明确支持的部署。每次 HTTP/SSE/WS 身份验证都检查 exact Origin（GET 可验证 Referer）、grant 有效期、撤销、Person generation。产品 Cookie 不可转换成普通 Host Bearer；双凭据拒绝。产品 Host 不可用时残留 Cookie 不能静默退为匿名。
- grant 一天；续期上限固定为配对后 30 天。过期但仍处于续期窗口的 Cookie 可明确续期；续期轮换随机 token 并用 Set-Cookie 更新，旧 token 立即失效。撤销、Person generation 改变或绝对续期到期后不能靠续期恢复。资料文字修改与身份 generation 撤销沿用已有不同语义。
- 重新配对先锁住并再次核对旧 token，再按稳定 grant ID 撤销旧客户端；并发续期导致 token 改变时拒绝本次切换，配对码保持未消费以便重试。失效或属于其他 Runtime 的 Cookie 不会静默忽略，需先明确清理浏览器站点凭据。Person/Persona 对应独立本地聊天 session 选择；服务端 session 所有权仍是最终边界。切换时清空页面数据并中止旧 Main 生成，过期异步响应不能恢复先前 Person 的 Memory。
- `memory_enabled=false` 在服务器强制 HTTP/SSE/WS 的 read/write=false；接受来源与真正 R5 提交继续检查 grant/Memory 权限。普通聊天来源校验独立于长期 Memory 开关；关闭记忆仍可聊天，撤销则同时拒绝私人来源和 Memory。浏览器不能用 DTO 中 true 覆盖服务器限制。
- `/memory/v1` 的 scope 必须恰好等于认证 Person/Persona；current/timeline/detail/relations 在 LIMIT 前按自己的 grounded private principal 过滤。relation 两端均需可披露。retrieval page/detail 按 exact reader 过滤；processing 的 semantic job 与 index record 分别查归属；ingestion 查真正 accepted conversation source 的 Journal 所有权。overview、migration 和其他 operator 接口不给产品 Cookie。
- 产品 Host 模式下，原来仅靠 localhost 的管理权限改为所有 runtime mode 都需独立 operator credential；Cookie 不等于管理权限。未启用产品 R5 的既有管理兼容行为保留。
- Schema gate 要求 045 的真实 migration receipt 和新增表 SELECT/INSERT/UPDATE 权限。旧 application role 必须由迁移操作者显式补授权；不会在启动时自行扩权。
- WebUI 真正调用 MemoryKnowledgeClient `/memory/v1`。健康状态未知/失败不退回 Legacy；显示读取失败、空的授权视图、当前/历史状态、来源 lineage、纠正关系和实际 retrieval evidence。写入完成由 Worker/Authority 数据及状态证明，不用聊天成功冒充。

## 实际验证

本轮创建了独立 PG16.15/pgvector cluster，端口 **31518**，只用合成 Person/Character 和自己创建的 `yuvi_pr_product_host`、`yuvi_smoke`。31508 当时被占用，因此未操作它；也未连接生产默认 Runtime 做写入。

[完整本地检查计数](evidence/local-checks.json)：

| 检查                                                                                     | 结果                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm check` / `pnpm build`                                                              | 通过                                            |
| `pnpm --filter @companion/web build`                                                     | 通过；保留 Vite 大 chunk 提示                   |
| 无数据库可选门禁的完整 `pnpm test`                                                       | 通过；不把依赖缺失 skip 算验收                  |
| 所有 6 个 PostgreSQL URL 显式指向独立 31518 后的完整 `pnpm test`                         | Vitest 4135 passed / 52 skipped；Node 63 passed |
| 其中 Memory / Server / Web / Supervisor                                                  | 650 / 744 / 818 / 231 passed                    |
| ProductHost + 既有 Host + security 最后定向回归                                          | 18 passed                                       |
| application role 真数据库检查                                                            | 2 passed                                        |
| `cargo test --lib`                                                                       | 107 passed；编译本轮 Tauri command              |
| `pnpm desktop:package:test`                                                              | 78 passed                                       |
| 真实 Chromium + 正式 Supervisor/Runtime/Character/Worker/Authority/打包静态 WebUI server | 10 组验收通过                                   |

配对签发 generation 竞态修复后重新执行 `pnpm check`、`pnpm build` 及 18 项 Host/security 真数据库定向回归；上表全仓计数保留该次全仓实际输出，不将后来增加的用例补算进去。

52 skips 属于 Providers 1、Memory 3、Server 48 的额外服务/故障场景前提；没有把它们写成通过。正常 Server 启动、独立 Character composition、R5 不变量、已有 sibling correction 与恢复套件均实际启用。CI 的结果以 Draft PR 的当前 Checks 为准，未用本地通过替代远端 CI。

[浏览器验收结果](evidence/browser-acceptance.json)、[实际页面截图](evidence/history-source.png)。验收脚本 `scripts/accept-product-memory-host.mts`：

1. 新建随机 schema、受限 application role 和独立 Character/People 目录，用 production mode 正常 Server entrypoint，由正式 Supervisor 启动并核对 owned。
2. 通过认证 Supervisor 生成配对码，在实际 Memory 页面手动输入，核对 HttpOnly/SameSite，网页 document.cookie 看不到凭据。
3. 正常 Main 的实际 SSE 聊天声明 lake-blue；正式 Journal、accepted-user、Memory Worker 和 Authority 形成事实，实际 Memory 页面显示相同记录。
4. 自然语言纠正为 forest-green；数据库与页面同时证明旧记录 superseded、新记录 current，且可选择查看来源。
5. 关闭并重开 Chromium 的同一磁盘 profile、通过 Supervisor 重启 Runtime；保留合法 Cookie，正常 Character 请求能检索纠正值并生成实际 retrieval audit。
6. scope/subject override 和管理授权签发全部拒绝；memory 开关关闭后，HTTP/SSE 与真实浏览器 WebSocket 均可普通聊天，数据库没有新增 Memory，`/memory/v1` 拒绝读取。
7. 续期更新 HttpOnly token；切换 Person 后旧 scope/history/session 被拒绝，UI 清掉旧 Person 的内容。
8. 等待 revoke 请求实际提交并清除 Cookie 后，拿截获的旧凭据分别请求私人聊天与 Memory，均 401。
9. 对全部浏览器 context 的网络请求计数：operator Authorization **0**，Legacy Memory 请求 **0**；两个事实记录是正式 Authority 结果。

模型网络依赖是**确定性协议 fixture**，并非真实语言质量验收；Character、A9、Journal、Worker 和 R5 均使用正常实现。没有为了通过配对而放宽来源或引文校验。fixture 的成功不证明真实模型能理解任意纠正。

## 保留的失败和修复过程

[失败尝试记录](evidence/acceptance-attempts.json) 保留每次已通过步骤和错误。首次测试把 People 文件放进尚未归属的 Character 目录，被已有 storage owner 正确拒绝；修正测试目录，没有关闭防护。Playwright 的缓存 revision 不一致改用显式已安装 Chromium executable。测试还修正了空输入导致 Send 按钮禁用的等待条件、reload 回到首页后的导航，以及 revoke 未提交就探测旧 token 的时序。

实际产品缺陷包括 memory 开关误阻止普通聊天的通用来源校验、WebSocket 未应用 Memory 开关、聊天 fetch 未携带 Cookie、storage 不可用时 Main render 崩溃、跨 Person 旧异步页面数据，以及健康未知退 Legacy。均修复并在回归/真实浏览器中验证。

## 可复现与正式切换阻断

只允许显式本机独立数据库；脚本拒绝默认生产端口/数据库，绝不查找安装版 endpoint。先在**自己的**数据库应用 migration，并构建 WebUI，再设置 `YUVI_PRODUCT_HOST_TEST_DATABASE_URL`、绝对 `YUVI_PRODUCT_HOST_ACCEPTANCE_ROOT`、可导入的 `YUVI_PLAYWRIGHT_MODULE`，执行：

```sh
pnpm exec tsx --conditions=development scripts/accept-product-memory-host.mts --run
```

本地浏览器可使用 `scripts/pair-product-host.mts --endpoint-file <明确的测试 Supervisor endpoint> --person <合成 Person> --web-origin <实际 WebUI Origin>`。配置/endpoint/profile 含本轮合成测试凭据，只留在受保护本机目录，不进入 Git。Git 中只保留去凭据证据。

正式切换仍被以下项阻断：

- 打包 Tauri 的 `tauri://localhost` / `tauri.localhost` WebView 与 loopback Runtime 不满足目前 Strict Cookie 的同站前提；本轮没有用第三方 Cookie 放宽或给 JS operator token 来掩盖。原生页面明确说明未授权，只能为明确的本机 HTTP WebUI 签发短码。**未完成原生桌面交互与安装包整体验收。**
- 本轮原生可信 Person 选择界面接受已存在的 Person ID；没有交付无 operator 的 Person 创建/管理 UI。普通浏览器不能自行创建身份。
- 已迁移资产、production role 045 授权、备份/回退和正式切换均需后续明确操作；未迁移、重启、部署、配置或接触真实 Alice、她的数据库/凭据/QQ；未合并 PR。
- #333 的 `4A87 → 4A88` 引文失真、真实模型漏解释记忆、全量 R5 旧资产迁移、高频旧事实/长中文尾部检索、更广 Truthfulness、QQ PRIVATE/GROUP、全域隐私删除、完整生产备份与回退、长期多 Scope 负载继续开放。
