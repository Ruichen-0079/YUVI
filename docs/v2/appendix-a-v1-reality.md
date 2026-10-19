# 附录 A　V1 现实与数据流

> 本附录给出蓝图第一部分所依据的代码事实。链接固定到具体提交：
>
> - `main`：`0d894cc7`（2026-10-09）；
> - R4/R5 堆叠最新端：`a1b89423`（#322–#337，均未合并）；
> - Plunge 分支：`adff0c70`（未合并）。
>
> 链接中的行号以这三个提交为准。

## A.1 三条线：哪些在 main 上，哪些不在

| 线                                                        | 状态         | 内容                                                                                                                                                                                                         | 对 V2 的意义                                                      |
| --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `main`                                                    | 已合并       | 运行时、legacy 记忆 + Mem0、L0/L1/L2 + Dream、Character gate + 正文、P8、Life Event Journal、效果账本、Profile、Supervisor、Tauri、Live2D、语音                                                              | 当前真实可运行的系统                                              |
| R4/R5 堆叠（`fix/r5-crash-ownership` 一线，PR #322–#337） | 开放、未合并 | 撤除关键词情绪；修复 800 字截断与心跳丢文；自然语言纠正；PostgreSQL 记忆权威（迁移 026–045）；会话原文交给 Character；沉默与失败回合也形成记忆；检索排序与证据支持；Host/Person 激活；Linux 发行候选与冷恢复 | 很多修正方向正确，但都建在 V1 的结构上；发行候选使用 fixture 模型 |
| Plunge（`feat/plunge-webui-20261008`）                    | 未合并       | QQ/SnowLuma 接入、Alice 人设、带作者的线性模型上下文、QQ 预过滤（本地小模型）、本地管理 WebUI                                                                                                                | 线性上下文与 QQ 适配器值得移植；预过滤不移植                      |

R4/R5 堆叠各 PR 的主题：

- **#322** 后端边界修复，撤除关键词情绪，修复“Don't forget”被当作删除；
- **#323** 实测模型损失（心跳丢正文、800 字截断、`length` 整体拒绝）；
- **#324** 有依据的纠正（R4）；
- **#325–#326** R5 记忆权威；
- **#327** 生产 Character 统一，会话原文按模型窗口传入；
- **#328** 已接纳输入同事务入库，沉默与失败回合也能形成记忆；
- **#329–#333** 观察留存、检索排序、组合检索、证据支持与相关分离；
- **#334–#335** WebUI 与原生 Host 身份；
- **#336–#337** 发行候选：干净安装、冷恢复、Supervisor 死亡后恢复。

逐条证据见[PR 索引](https://github.com/Ruichen-0079/YUVI/blob/3f6a9393a9d5290d2e924df1c7cf1ab72aa5c382/docs/research/project-history/PR_RESEARCH_INDEX.md)。

## A.2 一次普通回复的路径（main）

入口是 [`handleUserMessage`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts)，依次经过 `executeUserMessage` 和 `handleUserTurn`。

1. **保存与恢复。** `persistUserMessage` → 发布事件 → `restoreDirectContext`（恢复最近对话）→ 需要时附加视觉。
2. **`prepareChatPrompt`：**
   - `detectCurrentAffect`：关键词情绪（[L3710](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L3710)）；R4/R5 堆叠中被撤除；
   - `detectExplicitForgetRequest`：关键词识别“忘记”，并在检索前删除 Mem0 记忆（[L3720](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L3720)）；
   - `buildDirectContext`、`retrieveMemories`（以当前文本为查询）、`assembleHierarchicalMemory`（L1 情节、联想、时间）；
   - `PromptBuilder`：风格 “Warm, concise… 1-3 sentences”（[L3778](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L3778)）；时间提示 “Do not invent events, feelings, or an off-screen life during the gap”（[L3793](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L3793)）；
   - 上下文压缩：工作预算 `min(24_576, 窗口 × 0.75)`（[`context-compression.ts:173`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/memory/src/context-compression.ts#L173)）；
   - `attachSemanticContext`：P8 ABI 各节。
3. **Character 执行**（[`apps/server/src/character-runtime.ts`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/character-runtime.ts)）：
   - 系统消息 = 指令 + `Semantic context:\n` + `JSON.stringify(transportContext)`（[L507](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/character-runtime.ts#L507)）；
   - 第一次调用：`CHARACTER_GENERATION_INSTRUCTION` 要求只返回一个 JSON 处置（[L114](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/character-runtime.ts#L114)）；
   - 第二次调用：`CHARACTER_BEHAVIOR_INSTRUCTION` 生成正文（[L112](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/character-runtime.ts#L112)）；
   - 遇到 `NEED_COGNITION`：先经 GLM 推理（可选 `read_text`），再走认知后的 gate（[L125](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/character-runtime.ts#L125)），最后生成正文。
4. **处置为沉默或终止时**，`reply === null`，直接返回：不保存助手消息，不写记忆，不合成语音（[L2301](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L2301)）。R4/R5 堆叠中的 #328 改为也形成记录。
5. **否则** 发布助手消息，然后写记忆：
   - Mem0 后端：调度 Mem0 回合写入。经最终摄取账本后，由 `MemoryIngestionPolicy` 使用 `RuleBasedMemoryExtractor`，只取用户自己的断言，`infer=false`；
   - legacy 后端：`maybeStoreMemoryInternal`。

   最后视情况合成语音。

`MemoryIngestionPolicy` 的注释写明：“Only user-grounded candidates become events; assistant prose is context and never a source of long-term memory”（[`ingestion.ts:43-47`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/memory/src/ingestion.ts#L43-L47)）。

## A.3 身份与人设

- **系统身份：** `"You are YUVI, a local-first AI companion runtime agent."`（[`character-identity.ts:33`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/character-identity.ts#L33)）。
- **作者不变式：** 生产人设的风格说明按句切成“authored invariants”（[`production-invariants.ts:12`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/p8/src/production-invariants.ts#L12)）。内容是说话方式的规范，例如：“never manufacture familiarity…”“Let familiarity and continuity emerge from supplied Memory/P8 context”。另外定义的角色，人设按每段最多 480 字符切分（[`character-identity.ts:49`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/character-identity.ts#L49)）。
- **没有背景故事。** YUVI 没有自己的过去、兴趣或关系史。
- **Plunge 分支的 Alice 人设**（`docs/personas/alice.md`）是更完整的作者设定，属于需要保护的资产（附录 D）。

## A.4 主动性

- `armProactiveWake`：默认间隔 60,000 ms（[L1700](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/core/src/runtime-orchestrator.ts#L1700)）。
- 硬门槛：未同意、抑制状态为 `UNTIL_ENGAGEMENT` / `EXPLICIT_RESUME`、正在说话、回合进行中等，都会跳过。
- 通过门槛后，`runScheduledProactiveAttempt` → `streamAssistantInitiatedTurn`，由分数 / 决策提供者判断是否开口；`NO_OP` 后退避。
- 早期的 P6 版本由 Llama-3.3-70B 做决策、V4 写作（[#61](https://github.com/Ruichen-0079/YUVI/pull/61)）。

## A.5 存储

**main 上：25 个迁移，36 张表。** 按用途分组：

| 组             | 表                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话           | `conversation_sessions`、`conversation_messages`、`conversation_reply_components`、`conversation_reply_seals`                                                                   |
| 生活日志       | `journal_namespaces`、`journal_events`、`journal_event_parents`、`journal_payloads`、`journal_source_dedup`                                                                     |
| 记忆           | `memories`、`memory_evidence_admissions`、`recent_episodes`、`dream_jobs`、`entities`、`relations`、`finalized_ingestion_turns`、`finalized_ingestion_events`                   |
| 人设与 Profile | `p8_corrections`、`profile_snapshots`、`profile_current`、`profile_lifecycle`                                                                                                   |
| 效果           | `effect_intents`、`effect_attempts`、`effect_observations`、`effect_command_payloads`、`effect_input_exposures`、`native_control_workflows`、`native_control_workflow_children` |
| 上下文使用     | `context_use_manifests`、`context_use_exposures`                                                                                                                                |
| 语音           | `reply_speech_plans`、`speech_segment_descriptors`、`speech_audio_results`                                                                                                      |
| 其他           | `character_runtime_owner` 等                                                                                                                                                    |

**生活日志（迁移 013）的设计值得移植：**

- 事件 id 形如 `jev1_…`，带 `commit_seq` 和 `envelope jsonb`；
- 父事件构成 DAG；
- 载荷带模态（TEXT / AUDIO / IMAGE / JSON / TOOL_RESULT）与保留状态（RETAINED / REDACTED / NOT_RETAINED / UNAVAILABLE），文本附 sha256。

**R5 堆叠新增：**

- `memory_authority_records`：只追加，带触发器；分类为 GROUNDED / LEGACY_UNVERIFIED。
- `relations`：supersedes / conflicts / supports。
- `current`：当前投影，状态包括 current / superseded / conflicted / supporting / legacy_unverified / unattributed；带 tsvector。
- 语义任务、索引任务、512 维 HNSW 向量。
- 词法倒排；Host 配对与 Person 激活表。

数据库以外的状态：

- Mem0 的 pgvector 集合；
- 声纹库 `speakers.json/.npz`（[`speaker_store.py`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/services/local-stt/speaker_store.py)）；
- `proactive-policy.json`（[`proactive-policy-store.ts`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/apps/server/src/proactive-policy-store.ts)）；
- `product-settings.json`；
- Tauri 的 `settings.json`；
- 钥匙串中的密钥；
- 导入的 Live2D 模型。

各目录的含义见 [`app-roots.ts`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/desktop-supervisor/src/app-roots.ts)：

- **config：** 用户设置；
- **data：** 记忆、声纹、私有 PostgreSQL 集群等持久状态；
- **cache：** 可重建的内容。

## A.6 进程

Supervisor 管理以下服务：

- `postgres`；
- `runtime`（Fastify 服务端）；
- `mem0`（Python sidecar）；
- `ollama`；
- `local_stt`（sherpa-onnx）；
- `tts_wrapper`、`tts_upstream`。

此外还有：

- Tauri 外壳（Rust，约 7.9k 行；R5 堆叠中约 9.1k 行）；
- WebUI（React，约 5.3 万行）；
- 本地嵌入服务：llama-server + Qwen3-Embedding-0.6B（512 维 MRL）。

**模型分工：**

| 用途               | 模型                                               |
| ------------------ | -------------------------------------------------- |
| Chat               | DeepSeek V4 Flash，经 DeepInfra 的 OpenAI 兼容接口 |
| Cognition          | GLM                                                |
| 主动决策（历史上） | Llama-3.3-70B                                      |
| 视觉               | Qwen-VL                                            |

## A.7 规模

| 范围                 | main         | R5 最新端            |
| -------------------- | ------------ | -------------------- |
| 非测试源码（含 SQL） | 约 16.2 万行 | 约 17.5 万行         |
| 测试                 | 约 10.9 万行 | 约 11.8 万行         |
| 迁移                 | 25           | 45                   |
| `docs/`              | —            | 679 个文件，约 48 MB |

**main 上各模块的源码行数：**

| 模块        | 行数                                                  |
| ----------- | ----------------------------------------------------- |
| web         | 5.3 万                                                |
| memory      | 2.6 万                                                |
| server      | 2.1 万                                                |
| core        | 1.4 万（`runtime-orchestrator.ts` 一个文件 8,106 行） |
| providers   | 8.7k                                                  |
| supervisor  | 7.7k                                                  |
| p8          | 4.4k                                                  |
| protocol    | 2.3k                                                  |
| harness     | 2.1k                                                  |
| effects     | 2k                                                    |
| cognition   | 1.2k                                                  |
| ABI         | 1k                                                    |
| journal     | 0.8k                                                  |
| Python 服务 | 约 6k                                                 |

## A.8 V1 没有的东西（对 V2 最重要）

| 缺失                          | 依据                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YUVI 自己说过的话进入长期经历 | `ingestion.ts` 注释；Dream 整合同样写明 “assistant prose is not evidence”（[`dream-consolidation.ts:613`](https://github.com/Ruichen-0079/YUVI/blob/0d894cc70d42ebba0df132924f5ea181c062b431/packages/memory/src/dream-consolidation.ts#L613)） |
| 沉默被记录                    | `reply === null` 分支直接返回（main）；#328 在堆叠上修正                                                                                                                                                                                        |
| YUVI 自己的情绪               | 只有用户情绪的关键词标签（已撤除）和 Live2D 表情                                                                                                                                                                                                |
| 会变化的人格                  | 人设是静态文本；P8 明确禁止情绪 / 关系标量                                                                                                                                                                                                      |
| 由 YUVI 自己产生的主动性      | 计时器 + 门槛 + 分数                                                                                                                                                                                                                            |
| 模型阅读带作者的原文          | main 上是 JSON 语义上下文；Plunge 分支的线性上下文未合并                                                                                                                                                                                        |
| 反事实实验设施                | 研究方法中的轨迹生成器和回放设施从未建成                                                                                                                                                                                                        |
