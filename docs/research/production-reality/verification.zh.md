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

2026-10-13/14，DeepInfra `deepseek-ai/DeepSeek-V4-Flash-0731`；相同模型、合成 Persona、输入序列、temperature=0、max_tokens=2048、声明窗口 65,536。复用 R5 fetch recorder，正常 Server 启动；Memory 读写禁用，单独比较 Conversation 连续性。每次 Character Gate/Body 真正调用远端模型，没有 scripted 答案。官方页面当前声明窗口 1,048,576；实验没有替真实安装调整窗口。[Provider 模型规格与价格](https://deepinfra.com/deepseek-ai/DeepSeek-V4-Flash-0731)。

| 30 轮任务                          | #326 最终输入/回答                       | 新路径最终输入/回答                              | Provider estimated cost（旧/新 USD） |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| 首轮短事实                         | 都包含代号；都答对并否认执行授权         | 同样成功；**不证明质量提升**                     | 0.00732732 / 0.01252584              |
| 首轮长原文后部事实，首答要求不复述 | 代号未进入最终 Gate/Body；回答未确定代号 | 完整原文进入 Gate/Body；正确答出代号且无执行授权 | 0.00775056 / 0.01359744              |

旧路径首轮短事实由 L1 情节摘录保住，不能推广“所有长对话都失忆”。长原文样本揭示 L1 截取与 DirectContext 缩减共同留下的缺口。新路径每组依旧 60 次调用，**没有降低 Gate 成本**；它增加可用历史，当前输入用量/费用上升。只验证了两组独立序列，不声称模型普遍可靠或 Context 最优。远端 temperature=0 不保证确定性。

[短事实对照](evidence/model-comparison.json)、[长原文对照](evidence/long-tail/model-comparison.json)包含精确 SHA/dirty、模型、合成输入/最终回答、输入 digest/角色/长度、首轮来源是否出现、usage/缓存/延迟/finish reason；逐调用 CSV 同目录。长原文新运行 dirty=true，因为报告/分析脚本尚未提交；该 SHA 的生产代码已提交，未修改运行配置或在线 Alice。

另有一个已完成首轮后被实验费用解析器终止的运行（SSE 中间 usage=null），两次远端调用保留在本机，[中断回执](evidence/harness-interrupted.json)的用量完整、估算费用 0.00012834 USD。修正 Harness 后才执行完整对照，不把 Harness 错误冒充模型失败；两次启动被 Character 文件/数据库所有权保护拒绝，没有模型调用。公开费用是 Provider estimated_cost，未知/失败费用不伪造成 0，非最终账单。四组完整系列 240 次调用估算合计 0.04120116 USD，加上 Harness 中断两次共 242 次、0.04132950 USD；实验总预算 0.25 USD、每系列 60 次上限。

正常入口测试在只读 #326 checkout 重放（仅替换 child cwd）：首轮实际一次非流式 Chat，而不是 Gate/正文两次，按新生产合同失败。[拓扑反例](evidence/entry-baseline.json)。新分支冻结测试检查正常入口、30 轮输入、P8 损坏、429 后重启原话，以及真实 read_text 后 PARTIAL；[安全输入摘要](evidence/entry-input-summary.json)。这些属于确定性产品装配证明，不能合并成真实模型自主工具成功。

本机 `pnpm check`、`pnpm build`、全仓默认 `pnpm test` 与带真实 PostgreSQL 的全仓回归通过。第一次 durable 回归发现旧故障注入测试依赖硬编码 36 条；现在按真正独立的 L0/L1 读取时点注入，仍检查不同原文版本及持久来源。远端最终 CI 结果单独归档；未完成项保持 OPEN。

原始轨迹仅留本机受保护目录 `~/.local/state/yuvi-production-reality-20261013`。公开资料只含合成数据；没有真实 persona、Authorization、Provider 密钥或私人 Memory。
