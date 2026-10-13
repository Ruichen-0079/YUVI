# 验收方法与证据

## 确定性生产路径

`apps/server/src/production-reality-entry.integration.test.ts` 启动正常 `apps/server/src/index.ts`，连接隔离 PostgreSQL，使用真实 HTTP Provider adapter、Conversation、Journal、Effect 和 Character。HTTP 模型响应是依赖 fixture，不是质量证据。

30 轮中第一轮随机事实只来自用户；检查每轮 Gate/Body 两次调用及最后一轮实际 Messages。再破坏隔离 P8 文件、注入正文 429、重启隔离 Server，检查静态人格与原话。在单文件合法授权下，Reasoning fixture 自主控制帧触发一次真实 read_text，随后预算停止；检查观察到正文的 PARTIAL 输入和单次 Effect。脚本固定控制帧不证明真实模型自主选择。

通过 `YUVI_PRODUCTION_PATH_TEST_DATABASE_URL` 显式启用。数据库限制为自己的 loopback 31508 `yuvi_pr_*`，或 CI disposable `yuvi_smoke`/`yuvi_conformance`。所有 schema、配置目录和 Server 子进程由测试创建/清理。权限不足的匿名轮不读取或写入私有 Memory；这里不冒充产品 Host 授权验收。

`YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY` 或 conformance archive 保存 `entry-input-summary.json`：Git SHA、dirty 状态、每条输入角色/字节数/digest、指定合成来源是否实际出现。无 Authorization、Provider 凭据或私人原文。

跨进程配置测试实际导入 Runtime/Provider/Server/Supervisor/factory；Packaged 测试验证显式 PostgreSQL 不依赖 Mem0 manifest。旧测试若曾把 fixture 的普通正文当 Gate，则修为正式控制响应；不恢复架构绕过。

## 保留的失败

初次 30 轮正常入口测试失败：虽然模型窗口还有空间，预选 DirectContext 的固定比例已经丢失首轮事实。移除这次提前分配，最终统一渲染预算后通过。P8/失败轮/部分读取与此测试分别检查，不能仅凭内部函数被调用判成功。

## 真实模型与最终回归

本节由真实执行后更新；未运行项保持 OPEN。原始轨迹仅留本机受保护目录，公开资料只包含合成摘要、客观评分和逐调用用量。不以 scripted Provider 的固定答案证明语义改善。
