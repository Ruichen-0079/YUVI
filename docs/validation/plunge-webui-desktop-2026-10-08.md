# Plunge WebUI：打开 QQ / SnowLuma 与启动脚本

沿用独立分支 `feat/plunge-webui-20261008`，基于 WebUI 交付提交 `4ed96cf`。不修改 `apps/web` 或 Core，不合并 main。

诊断页新增“打开 QQ”“打开 SnowLuma”。启动器识别现有 OneBot 配置所在的 SnowLuma 安装；QQ 支持唯一的系统安装或同级/桌面 AppImage，以及显式 `--qq` / `--snowluma` 路径。路径仅由本机启动器配置并以 0600 保存，管理接口只接受固定应用枚举，不接受命令、参数或路径；现有 loopback/token/Origin/Host 保护继续生效。子进程不继承 Alice 管理令牌、模型配置环境或 Node 调试 preload。

SnowLuma 已运行时检查实际控制台（包括端口占用后的相邻端口），打开其自有认证页面；不附带密码或令牌。未运行时使用包内 Node、现有安装目录与 index.mjs 启动一次。并发请求合并；启动 PID 留在私有 state，跨 WebUI 重启可识别尚未就绪的自启动实例。Alice 已连接但控制台不可访问时拒绝再次启动。QQ 使用其原生单实例唤起，并限制短时间重复启动请求。应用独立存活，不跟随 Alice 关闭。

ZIP 新增 `start-webui.sh`：与 start.sh 接受相同部署参数，等待页面就绪后请求桌面浏览器打开。重复运行时打开现有界面而不再启动 Alice。无桌面浏览器时仍可手动使用本机 URL。

## 验证

- Server TypeScript build、启动器 Node syntax check、shell syntax check、diff whitespace check 通过。
- Server 全套：589 条通过、221 条跳过；跳过项不计为已验证。
- 桌面启动/管理保护/QQ 传输定向测试：14 条通过。覆盖缺失及相对路径拒绝、字面路径、秘密环境不继承、并发启动合并、已运行 SnowLuma 不重复启动、启动后的实际 URL，以及 UNKNOWN/重连不重发。
- 从更新 ZIP 解压目录通过 start-webui.sh 启动真实 Alice；QQ READY，保存模型继续 ACTIVE。
- 可见 Chromium 在真实诊断页点击打开 QQ，再点击打开 SnowLuma；弹出的实际页面为 `SnowLuma 控制台`、URL `http://127.0.0.1:5100/`。既有配置首选 5099，但原进程实际因占用使用了 5100，入口正确识别。
- 原有 QQ 主进程及 SnowLuma 主进程 PID 保持不变，未启动第二个 SnowLuma；QQ 保持 READY、pending/queued=0，应用打开操作零原生发送。
- 浏览器无脚本错误，390px 诊断布局无横向溢出；更新截图在 DOM 脱敏后输出。
- 实际应用 API 无令牌返回 401，未知应用返回 404；外站 Origin 的启动操作由保护测试验证拒绝。
- 重复实际调用 start-webui.sh 正常退出，仅请求打开既有界面，没有第二个 Alice。

真实 SnowLuma 冷启动未关闭现有服务来验收；冷启动使用实际子进程及 HTTP fixture 验证，真实环境验证的是现有运行实例复用。原始浏览器结果/日志留在操作员私有状态目录，不进入 Git/ZIP。
