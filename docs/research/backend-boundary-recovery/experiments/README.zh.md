# 复现与真实模型对照

从仓库根目录执行。Node 24、现有 workspace 依赖和 Python 3 是本次使用环境。依赖安装请遵守仓库既有要求；本轮没有增加产品依赖。

## 确定性回归

```sh
pnpm check
node docs/research/backend-boundary-recovery/experiments/replay-regressions.mjs . after /tmp/yuvi-after.json
node docs/research/backend-boundary-recovery/experiments/replay-regressions.mjs . before /tmp/yuvi-before.json
```

`before` 创建并销毁脚本自己的临时 Git worktree，固定到 `0d894cc70d42ebba0df132924f5ea181c062b431`。先独立安装 frozen lockfile 依赖、编译原版，再覆盖回归**测试文件**，执行失败预期。不同版本不共享 workspace package 链接，不把新 Core 与旧 Server 拼接。安装使用 `--ignore-scripts`；必要的 Cubism 构建由 `pnpm check` 显式执行。本次初次尝试因环境 pnpm 11 的 dependency-build policy 失败，调整后完成原版复现。

最终回归测试比最早的逐项 before 记录多了一些正向与所有权案例，故不同文件的总数不相等。不要用相减计算提升率。

容量性质测试：`apps/server/src/read-text-observation.property.test.ts`，种子 `0x0d894cc`，64 个 UTF-16 前缀/Unicode 组合。真实 WS 异常排列：`apps/server/src/routes/websocket-ownership.integration.test.ts`，种子 `3211010`，16 次排列。所有断言都是合同、路由和信息保留断言，不是回答质量评分。

## 边界记录重算

```sh
python3 docs/research/backend-boundary-recovery/evidence/build-boundaries.py .
python3 docs/research/backend-boundary-recovery/evidence/annotate-sample.py .
node docs/research/backend-boundary-recovery/evidence/check-boundaries.mjs .
node docs/research/backend-boundary-recovery/evidence/check-boundaries-self-test.mjs .
```

重新生成台账会使用当前 HEAD 的 source blobs；它不是自动审计新逻辑。发生生产变化必须重新人工审查 `reviewed-boundaries.json`，然后重跑对应测试。检查器拒绝源 blob、基线图谱摘要或原始 ID 缺失，但不能识别作者把未经审查逻辑错误地标成已验证。

79 个确认的顶层路由来自旧 Compiler API 中 `buildServer → register* → app.get/post/...` 的实际目标。其语义仍待逐项验证。其他记录保留为风险候选，不能将候选数量当成真正运行边界数量。平台条件、动态注入和私有部署均保留 OPEN。

## 真实模型 Harness

```sh
node docs/research/backend-boundary-recovery/experiments/run-live-model.mjs . --plan /tmp/yuvi-model-plan
node docs/research/backend-boundary-recovery/experiments/run-live-model.mjs . --run /tmp/yuvi-model-results
```

运行模式需要通过会话环境提供以下配置，密钥不要放进命令行、版本库或实验报告：

| 变量                                                                         | 意义                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| `YUVI_AUDIT_MODEL_API_KEY`                                                   | OpenAI-compatible API 的凭据               |
| `YUVI_AUDIT_BASE_URL`                                                        | API 根 URL，无 query 或 inline credentials |
| `YUVI_AUDIT_MODEL`                                                           | 固定模型及可获得的版本标识                 |
| `YUVI_AUDIT_INPUT_PRICE_PER_MILLION` / `YUVI_AUDIT_OUTPUT_PRICE_PER_MILLION` | 可选价格；用量缺失时仍记 UNKNOWN           |
| `YUVI_AUDIT_SERVER_URL`                                                      | C 场景的独立本地、专用测试 Server，可选    |
| `YUVI_AUDIT_SERVER_ATTESTATION`                                              | C 场景配置证明 JSON 路径，可选             |
| `YUVI_AUDIT_DASHBOARD_TOKEN`                                                 | 专用 Server 的已有开发令牌，可选           |

`--plan` 不读取密钥、不发送请求。`--run` 缺凭据直接失败，绝不换成 scripted model。

A 使用真实 Runtime、Server Character 与 PromptBuilder；忠实历史 direct、当前 Character gate、移除 gate 的可逆反事实分别运行。Conversation 是真实 InMemory 实现，Memory 明确关闭；这不是全持久化部署。人格相同，模型、temperature=0、最大输出=2048 锁定；框架指令和信息投影的差异保留，正是比较对象。

B 使用真实临时授权文件、生产 Cognition/Observation/下一轮消息。设置 `YUVI_AUDIT_DATABASE_URL` 时，实际建立 PostgreSQL Journal receipt、Host grant、effect admission/store/dispatch；不设置则使用明确标记的测试宿主替身。宿主只授权本次创建的单个文件，不能据此宣称普通产品授权 UI 已接通。比较没有观察、完整观察和工具取得观察三种输入；模型自行选择能力，拒绝调用也是结果。可用 `YUVI_AUDIT_FILE_LENGTHS='[256,16001]'` 指定边界，用 `YUVI_AUDIT_FILE_CANONICAL=true` 提供与正常入口一致的语义上下文。

C 仅在真实专用 Server 启用，用新隔离用户与两个会话，先可信纠正，再查询 records/semantic，最后保留实际 promptPreview 与回复。配置证明至少包含：

```json
{
  "model": "固定模型",
  "temperature": 0,
  "persona": "与 Harness 中 persona 完全一致",
  "sourceSHA": "专用 Server 提交",
  "memoryModel": "实际 Memory 模型",
  "isolatedAuditData": true
}
```

这是操作者提供的配置证据，Harness 不伪称独立验证服务器全部内部路由。禁止指向日常并发 Alice：promptPreview 是 Runtime 的 latest projection，可能被其他请求替换。记录查询不一定等同当前 Mem0 backend；无结果先调查管理投影，不自动判断未写入。C 的服务端内部调用量、Memory 模型成本和队列状态仍需实际 instrumentation。该运行产生真实测试记忆，Harness 不自动删除，也不声称恢复。

同一 Harness 可以对两个独立 checkout 运行 before/after。复用同一模型版本、采样、人格和权限；temperature=0 不保证远端模型完全确定。报告全部输入、归一化业务输出、调用记录、可获得 token 用量与延迟，不要求或记录隐藏思维链。输出目录可能包含测试正文，请按自己的资料权限管理。

盲评至少覆盖：否定/引用/纠正是否理解；权限是否虚增；结尾缺失是否诚实；失败是否准确；跨会话纠正是否被引用。先遮蔽版本与路径标签，再人工打分；单次输出、调用减少、合同通过均不能自动证明智能改善。原 #322 首次交付实际模型调用为 **0**。2026-10-10 后续实机实验已运行；结果、原始轨迹存储规则、客观评价及限制见 [真实模型结果](../../runtime-model-value/README.zh.md)。本轮没有另找模型做主观自评，也没有完成独立人工盲评。

可选 `YUVI_AUDIT_PERSONA_FILE`、`YUVI_AUDIT_CASES_FILE`、`YUVI_AUDIT_REPETITIONS`、`YUVI_AUDIT_MAX_TOKENS`、`YUVI_AUDIT_TIMEOUT_MS` 控制 Persona、任务和重复样本；`YUVI_AUDIT_SKIP_FILES=true` 只跑普通对照。输出目录强制 0700，记录每次请求正文、流事件、供应商 usage/费用及源码摘要，不记录授权头。凭据仅从环境传入，禁止提交输出目录。启动一个 Harness 期间不要并发使用同一 runner 的生成文件。
