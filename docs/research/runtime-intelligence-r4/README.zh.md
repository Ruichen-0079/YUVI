# R4：Memory 纠正的持久闭环与剩余表达问题

日期：2026-10-10。此轮优先完成 P0 存储与检索链路；**没有完成全部 R4 验收**。Character 的 A/B/C 消融与自主 Capability 端到端实验尚未进行，不宣称 P1 改善。

## 本次结论

三组独立随机事实、两个中文自然纠正变体和一个英文变体，均完成 **A 写入 → 新会话召回 A → B 纠正 → 正式 ledger complete → 清空实验 L1 → 新会话使用 B → 隔离 Server 重启 → 新会话使用 B**。后三步各为 3/3；模型均指出 A 已失效。历史 Journal、Conversation、旧 Mem0 记录没有删除。

引用和假设两个反向案例未写入纠正，之后仍回答 B。另一个 Person 的同名 A 不受影响，重启后仍回答 A。两条无明确撤回的冲突自述保留为两个来源，真实模型拒绝擅自确定唯一答案。

**表达状态仍有残留**：首次后端写入拒绝试验中，模型说“已记下”，但 ledger 实际 `terminal_failed`。补强表达约束并暴露正式写入状态后，下一次真实失败回合明确说明未收到回执，不能声称持久成功。但最终只读召回又额外说历史保存未确认，尽管已有完成记录。当前值 B 回答正确，保存状态的自然语言表达没有全面验收。不能用一个成功的失败回合证明永远不会错误确认。

## Git、实际服务与隔离

本次核对：#322、#323 均 OPEN。#323 HEAD `c3f7f06cb5a728d05bc78137af3d7178a774c8f6`，base 为 #322 分支，三个工作流 SUCCESS。R4 worktree 从该 HEAD 建立；PR base 为 `fix/runtime-model-value-20261010`。

实际在线 Alice 的独立安装包 manifest 仍为 `5064c29fa85da959b6a5b29a1655bfdadb2a6a3d`，其运行进程和路由经过本次只读检查。未重启、替换、部署，未修改在线配置、人物或私人记忆。

实验使用端口 31504、独立 PostgreSQL 数据库 `yuvi_runtime_r4_20261010`、独立 Character `r4-isolated`、Persona scope `character-instance:r4-isolated`、随机 `r4-synthetic-*` subject。使用已有 Mem0/512 维本地 embedding 服务，所有实验读写都有独立 scope；未重建成功的工具执行循环。Persona 是部署版本的 authored 文本副本，版本和哈希见 [environment.json](evidence/environment.json)。没有私人关系/经历注入。

本次实际路由：DeepInfra OpenAI-compatible，Chat `deepseek-ai/DeepSeek-V4-Flash-0731`，Reasoning `zai-org/GLM-5.3-Flash`。实验 recorder 将所有模型请求设为 temperature=0、max_tokens=2048，同时保存原始参数与实际参数。Memory 语义提取本身使用这两个参数和 20 秒超时。

## 失败开始于哪里

旧版本的 `LlmMemoryExtractor` 即使配置 `MEMORY_EXTRACTOR=llm`，仍走规则 fallback；Server 的 `FinalizedIngestionService` 又使用默认规则 policy，未接上配置的 extractor。自然纠正可在 candidate 阶段变成零。

本次原版本实机重放：Conversation 已保存纠正原文，初始 A ledger complete，纠正 ledger skipped / `no-factual-memory`，Mem0 仍只有现行 A。最终回答却说 B，因为 RecentEpisodicMemory 包含纠正原文。这是 L1 掩盖 LTM 失败，不能算持久纠正成功；没有将此基线回答记成“旧 A 复现”。此前 R3 的旧 A 回答证据保留在原报告。

此外，仅生成新候选还不够：reserved metadata 会过滤自由传入的 `yuviClaimSupersedes`；Mem0 `infer=false` 是 keyed 原文写入，不会自动找到、更新或失效旧记录。原 facade 和 canonical 检索也不能依靠向量 top-k 完整看到纠正链，Dream 派生记录可能继续携带旧事实。

首次接入真实语义提取还触发一个生产边界：在回复 publication 已 admission 后等待远端提取，使正在等待的外向 invocation grant 超过 ticker 检查窗口，回复被拒绝发布。试验保留了 HTTP 500；没有放宽 authorization，而是将可选语义提取移到已有 completed Conversation → 异步 ingestion/recovery 路径。普通回复和 streaming 的确定性回归均验证该路径。

## 生产修复

- `extractor.ts`：通过现有可配置 Reasoning Provider 真实提取。模型仅从 committed Journal 用户原文选取逐字证据和内容；不能生成新事实、身份、权限、时间或旧记录 ID。模型输出经 strict schema、scope、旧来源、时间、principal/binding 和共同原文校验；用户自述仍是 `unverified`，不是客观事实认证。引用/假设/第三人讨论保守拒绝。异常或截断不接纳 fallback 纠正。
- `ingestion.ts` / Server composition：正式 finalized policy 使用配置 extractor，来源来自现有 grounding resolver；提取失败记 `terminal_failed` / `MEMORY_SEMANTIC_EXTRACTION_FAILED`，区别于无事实和未启用。独立的 existing Provider work context 绑定 committed source，不继承已结束的 Chat invocation。
- `provider.ts` / Mem0 provider：增加 host 校验的 typed `supersedes`，经冻结、digest、幂等写入和 effect admission 持久化。保持 `infer=false`，追加纠正证据，**没有使用 update/delete 伪装成功**。
- `correction.ts` / 检索 facade：完整 scoped bounded snapshot + bound host admission 验证后计算当前认识。追踪 A→B→C，即使 top-k 只命中旧 A，也返回当前纠正。旧来源按 ID 仍可读取；以被纠正 Journal 为根的 DERIVED 证据停止冒充现行事实。既有 Profile source reader 使用同一过滤，未新增 Profile 消费架构。
- Runtime：复用 completed Conversation 的 `ingestionRequested`、既有缺失 admission recovery 与 coordinator，延后远端语义工作。live/recovery 对同一源 single-flight；finalizedAt 使用正式 completedAt，避免并发来源 digest 不一致。未更改授权、执行租约、取消和 Publication 校验。
- `/message`：`memory.writeStatus` 读取该 reply 对应 assistant/trace 的正式 ledger，区别 pending/failed/partial/complete。观察失败为 unknown，不能让合法聊天整体失败。该字段是现有状态的投影，**HTTP 200 或 writeMemory=true 都不是持久成功回执**。当前新增投影只覆盖普通 HTTP `/message`，其他 outward surfaces 未新增状态展示。

## 真实实验结果与证据

| 案例               | 确定性结果                                              | 真实模型结果                             |
| ------------------ | ------------------------------------------------------- | ---------------------------------------- |
| 三组 A 初始保存    | 3/3 complete                                            | 3/3 新会话召回 A                         |
| 三组自然纠正 B     | 3/3 correction complete，supersedes 指向自己 scope 的 A | 清空 L1 后 3/3 使用 B、否定 A            |
| 隔离 Server 重启   | 同一 DB/Persona，无进程内纠正缓存依赖                   | 3/3 使用 B、否定 A                       |
| 引用、假设         | 两回合 skipped，未产生纠正                              | 后续仍使用 B                             |
| Person Y           | 独立 scope 的 A retained                                | 重启后仍使用 A                           |
| 无撤回的 C/D 冲突  | 两条独立来源 complete，未擅自 supersede                 | 同时报出 C/D，承认冲突                   |
| 写入拒绝（首次）   | 正式 terminal_failed，A 未被失效                        | **失败**：仍说“已记下”                   |
| 写入拒绝（补强后） | 正式 terminal_failed，HTTP 当时 pending                 | 说明未收到回执；清空 L1 后仅召回原持久 A |
| 最终 HEAD 只读召回 | current B，当前只读回合 receipt skipped                 | B 正确，**仍错误附加历史保存未确认**     |

后端拒绝由隔离 fetch recorder 仅对指定 synthetic scope 的 keyed endpoint 注入 HTTP 400 `VALIDATION_ERROR`，不是声称实机 Mem0 自发故障；模型、grounding、admission、executor、查询和回答均是真实生产路径。查询失败、snapshot 不完整、effect 篡改、跨 scope、提取网络/格式/截断失败由确定性测试覆盖，没有将它们冒充真实模型成功率。

完整链路的合成原文、Conversation 来源、候选、lineage、typed supersession、backend ID、正式状态、admission 与后续 Context 分别见：

- [pipeline.json](evidence/pipeline.json)：来源与正式状态时间顺序；历史原文保留。
- [mem0-wire.json](evidence/mem0-wire.json)：scoped keyed 原文写入、完整快照与检索响应，合并相同结果，保留前后状态。
- [semantic-extractions.json](evidence/semantic-extractions.json)：实际语义提取输入、原始模型输出及 finishReason，包括迭代失败。
- [synthetic-answers.json](evidence/synthetic-answers.json)：HTTP、最终答案、当前记忆、L1 数量、延迟和 receipt。
- [memory-results.json](evidence/memory-results.json)：评分与明确未完成项。
- [model-calls.csv](evidence/model-calls.csv)：120 次调用，实际模型、参数、finishReason、Token、Provider estimated_cost、首字节/首正文/总延迟、输入输出哈希。

三组主矩阵和重启使用 `cfd491f`（生产修复 `7c06b09`）；最终 receipt/失败表达使用 `4c6ce29`（生产修复 `9627816`），精确 SHA/源文件哈希在 environment 中。后者未修改存储和当前认识算法。远端 temperature=0 不保证确定性；3 组纠正和 1 个冲突例只证明这组输入，不能推广为一般语言理解可靠率。

预设上限 120 次调用、目标费用 < $0.50；达到调用上限后停止模型试验。记录到 140,389 Token，Provider `estimated_cost` 合计 $0.006105365；1 次网络失败没有 usage，未知用量不记为零费用保证。费用包括全部失败/无效 bootstrap/中间迭代，不仅最终成功样本。当前官方公开价格：[DeepSeek](https://deepinfra.com/deepseek-ai/DeepSeek-V4-Flash-0731)、[GLM](https://deepinfra.com/zai-org/GLM-5.3-Flash)；实际逐次 Provider usage 优先于页面单价估算。旧 recorder 没有首正文时刻的样本留空。

## 验证与可复现边界

`pnpm test`、`pnpm check`、`pnpm build` 全部通过。Memory 535 passed / 58 skipped，Core 489 passed / 2 skipped，Server 526 passed / 213 skipped；其他 workspace 和 root Node tests 同样通过。另在本次独立 PostgreSQL 上运行 finalized ledger、coordinator、Conversation ancestry 的 67/67 测试，包含跨仓库重建、租约竞争、未知执行结果和恢复；没有把常规运行 skipped 的数据库测试说成已执行。CI 结果以 PR checks 为准。

新增测试覆盖逐字 grounding、假纠正/虚构 target、subject×persona、A→B→C、derived root 失效、历史读取、完整 snapshot、写入失败、未 bind 时不失效、single-flight 来源冲突、异步 admission 对完成回复/stream 的隔离，以及错误/相邻 trace 不会供应完成回执。

复用已有 [R3 harness](../backend-boundary-recovery/experiments/README.zh.md) 与 Server `/message`。R4 只添加 [HTTP 案例 runner](experiments/memory-cases.py) 和原 fetch recorder 的 [隔离适配器](experiments/record-isolated-fetch.mjs)，没有 scripted model 质量替身。复跑必须先准备独立 DB 并迁移、synthetic Character/owner/proactive suppressed 配置、独立 subject 和合法 Provider 环境；不要使用日常 Alice 的 runtimeEnvDir 或默认 scope。原始轨迹留在本机权限 0700 目录；Git 只有合成样本和非敏感摘要。

```bash
# 已配置独立环境；DATABASE_URL、合法 Provider key 由本地环境继承，禁止写入 Git。
export SERVER_HOST=127.0.0.1 SERVER_PORT=31504
export MEMORY_REPOSITORY=postgres MEMORY_BACKEND=mem0 MEMORY_EXTRACTOR=llm
export YUVI_EXPERIMENT_TRACE="$R4_PRIVATE/final-calls"
node --import ./docs/research/runtime-intelligence-r4/experiments/record-isolated-fetch.mjs \
  --conditions development --import tsx apps/server/src/index.ts
# 在另一终端继承同一隔离 DB 环境，工作目录为仓库根：
python docs/research/runtime-intelligence-r4/experiments/memory-cases.py \
  http://127.0.0.1:31504 "$R4_PRIVATE/matrix" initial
# 停止并重启的只能是上述独立 Server，同一 DB/Character，换 recorder 目录后运行：
python docs/research/runtime-intelligence-r4/experiments/memory-cases.py \
  http://127.0.0.1:31504 "$R4_PRIVATE/matrix" restart
```

failure/failure-retry 需要 `R4_FAULT_FILE` 指向 recorder 私有父目录的 `fault.json`；只对精确 synthetic scope 注入，finally 删除。runner 在生成多组成功前不能把 pending 当作成功；需要等待正式 terminal/complete 状态，超时则失败。代码中的 Persona scope 固定为此隔离实例，换 Persona 必须同步修改 fixture，不得借真实 Alice scope 复跑。

## 仍未解决

1. **Memory 保存状态的自然语言表达未全面通过**：失败不再被机器状态掩盖，补强后的故障回合表达正确；历史已完成纠正仍可能被错误描述为待保存。没有在预算用尽后继续改 prompt 并声称验证成功。
2. bounded snapshot 超过 4,096 条/字节界限、语义 prior 超过 64 条或 24,000 字符时安全失败；没有证明大规模长期 scope 的开销和纠正可用率。向量 search 完全未命中关联事实时也不会凭空补一个答案。
3. 纠正 target 必须在用户新原文与旧来源中有共同逐字片段；隐含指代、没有旧片段的复杂撤回、混合引用与自述、多人叙述保守拒绝。模型判断“这是纠正”的语义责任仍存在，不能视为客观事实认证。
4. P1 gate 消融、控制格式优化、自主 Chat→Cognition→Capability→Character 完整实机对照未运行；P2 未开展。
