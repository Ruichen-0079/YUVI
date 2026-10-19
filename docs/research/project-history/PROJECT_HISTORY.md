# YUVI 项目思想与技术演化史（2026-05-10 — 2026-10-19）

> 研究日期：2026-10-19。只研究历史，不修改产品代码。
>
> 证据基线：
>
> - `main` = [`0d894cc7`](https://github.com/Ruichen-0079/YUVI/commit/0d894cc70d42ebba0df132924f5ea181c062b431)（2026-10-09）；
> - 开放堆叠的最新端 = `fix/r5-crash-ownership` [`b36d6179`](https://github.com/Ruichen-0079/YUVI/commit/b36d6179770e90cf0ae0a6fee0ba86f856085f6f)（PR #322–#337，均未合并）；
> - QQ/Alice 分支 = `feat/plunge-webui-20261008` [`adff0c70`](https://github.com/Ruichen-0079/YUVI/commit/adff0c70648b42a3a15ea45609adae1c45b31fc5)（未合并）；
> - 研究归档 tag = [`research/qq-alice-20261007`](https://github.com/Ruichen-0079/YUVI/tree/research/qq-alice-20261007)（默认 fetch 不会取得）。
>
> 标注约定：**[A]** 原始研究命题；**[B]** 已有可靠工程证据；**[C]** 提出或实现过但未证明必要性/有效性；**[D]** 已暴露问题、反复返工或被取代。完整 PR 清单见 [PR_RESEARCH_INDEX.md](PR_RESEARCH_INDEX.md)。

---

## 0. 先给结论：实际发生了什么

1. **记录中的 YUVI 比感觉中短得多。** 第一次提交是 2026-05-10，最后一次活动是 2026-10-19，总共约五个月。真正的密集开发只有 2026-08-02 到 10-19 这 11 周。其间 `main` 上有 898 个提交，336 个 PR；PR 中 287 个合并、33 个关闭、16 个仍开放。`#51` 是 AgentBus 的 issue，不是 PR。仅 08-31 一天就创建了 70 个 PR。
2. **研究命题在仓库里出现得比“初心”晚。** 05-10 的 `AGENTS.md` 和 08-02 的术语表都把项目定位为“受 Project AIRI 启发、本地优先、事件驱动的 **AI 伴侣运行时**”。08-28 第一次写出“持久本地 AI 伴侣”的长期路线。“人工个体、岁月感、第一人称生活实感”直到 **09-19** 才以文档形式出现。之后不到一周（09-24），这些说法就被改写为“因果历史”这一更窄的工程表述。这不等于你此前没有这些想法，只说明仓库没有记录它们（见第 4 节归属问题）。
3. **三类工作交替出现，彼此很少真正结合。**
   - 第一类是建造“身体”：桌面、语音、Live2D、打包、Linux 发布。
   - 第二类是建造“治理/合同层”：authority、atom、Journal、effect、证据血缘。
   - 第三类是短暂的“哲学爆发”：08-28、09-19、09-20、09-24、10-09。哲学文档每次都要求“先把地基打牢”，于是又引发一轮更大的地基工程。
4. **几个研究性机制都从未真正开始。** 记忆动力学（强化、衰减、复现、保留重要性的遗忘）、情绪/欲望的慢变量动力学、未完成事项（承诺/期待/意图）、经历导致的倾向变化，以及研究方法文档中的 E1–E8 实验与长期轨迹回放设施，都没有实现，最多停在设计文档里。
5. **真正获得验证的，主要是“忠实保存发生过什么”所需的基础设施。** 包括：
   - Journal 接收凭证；
   - 说话者/主体/来源归因；
   - 事实纠正与保留历史；
   - 崩溃下的 `UNKNOWN` 语义；
   - 单机 Linux 打包与整机冷恢复。

   这些都是持久个体的必要条件，但它们只证明“历史被可靠地保存并重新提供给模型”，**没有证明“过去改变了未来的理解与选择”**。

---

## 1. 时间线总览

| 阶段                      | 时间          | 主要载体                                                  | 想解决的问题                                                                   | 结局                                                               |
| ------------------------- | ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 0 起点：AIRI 式伴侣运行时 | 05-10 — 06-22 | 37 个直接提交 + PR #1                                     | 能跑的事件运行时、仪表盘、记忆管线                                             | 形成“助手式用户画像记忆”范式                                       |
| 1 身体与外置记忆          | 08-02 — 08-15 | 直接提交 + PR #2–#19                                      | 流式对话、TTS、Live2D、Tauri、Mem0、Windows 打包、崩溃安全写入                 | 身体可用；Mem0 的推理一周内被关闭；Windows 打包深陷所有权证明      |
| 2 多代理治理与主动性切片  | 08-15 — 08-26 | PR #20–#62，AgentBus                                      | P6 主动发言、P7 Provider 合同、Windows 私有 PG                                 | #20 卡死后关闭；08-25 转 Linux-first；主动性靠计时器加一次模型判断 |
| 3 路线图与合同原子化      | 08-27 — 09-01 | PR #63–#215                                               | 结构还债、Future 01–08、P8/ABI/Harness/Cognition/Embodiment 合同、Memory vNext | 一天 70 个 PR；大量纯合同未接入生产；09-01 退回 Memory-first       |
| 4 产品化与发布            | 09-01 — 09-13 | PR #216–#320                                              | Atom 03–21、Campaign A–I、Astra、v0.1.0–v0.1.2                                 | Linux 日常可用；#283 揭示此前合同多未接线                          |
| 5 研究意图与哲学          | 09-12 — 09-24 | main 直接提交（09-12、09-19）+ 平台分支（09-24）+ PR #321 | v0.1.3 后转入研究（雏雁/鸿雁杯）、北极星、持久功能自我                         | 09-24 改写为“因果历史”；Life Layer 等被排除                        |
| 6 持久因果历史地基        | 09-22 — 10-07 | 平台分支提交，10-07 快进并入 main（无 PR）                | Journal 接收、证据落地、effect outbox、Profile、多角色核心                     | 一个月工程；研究阶段仍未开始                                       |
| 7 QQ/Alice 社会表面       | 09-?? — 10-08 | 私有历史 + Plunge 分支 + 归档 tag                         | 群聊中的自然参与、人格隔离                                                     | 原插件源码不可达；线性上下文原则出现；未合并                       |
| 8 独立研究审计            | 10-09         | 5 份 docs/research 报告                                   | 生产智能损失、后端价值、持续内部状态                                           | 指出“来源/执行强于语义”                                            |
| 9 记忆权威与发行候选      | 10-10 — 10-19 | PR #322–#337（堆叠、开放）                                | 纠正生效、R5 PostgreSQL 权威、证据支持、原生激活、冷恢复                       | 干净首装到冷恢复全流程实测；真实模型验收被阻断                     |

---

## 2. 分阶段重建

每个阶段按“问题 → 方案及理由 → 实际发生 → 暴露的问题 → 方向改变 → 学到什么”组织。

### 阶段 0（05-10 — 06-22）：受 AIRI 启发的伴侣运行时与助手式记忆

**问题。** 先有一个可运行的本地伴侣后端：事件总线、Provider 抽象、记忆、提示词构建和控制台。

**方案及理由。** 初始提交 [`4bffc50d`](https://github.com/Ruichen-0079/YUVI/commit/4bffc50d21ff454466c9c75f2b2513334002715a) 写下了至今未改的 [`AGENTS.md`](../../../AGENTS.md)：

- “AI Companion Runtime … inspired by Project AIRI”；
- 第 4、5 条规则：“Memory should never be raw chat logs dumped into prompts / must be retrieved, ranked, compressed, and reconstructed before prompt injection”；
- 第 12 条规则：生产桌面不得依赖 Node.js、PostgreSQL 等。

`docs/memory.md` 的第一句同样是“Memory is not raw chat log injection”。

**实际发生。** 05-15 到 05-27 的约 30 个提交（均无提交说明正文），把记忆做成了一个**用户画像事实库**：

- 五类记忆（working/episodic/semantic/emotional/procedural）；
- Letta/MemGPT 式的 `core/recall/archival/working` 层；
- LLM 抽取器（05-17 设为默认）与候选审查；
- 时间规范化（“今早”→绝对日期）；
- 按类别的 TTL 保留策略；
- 规则化的取代/矛盾建议。

[`d96edbc0`](https://github.com/Ruichen-0079/YUVI/commit/d96edbc0) 规定“我今早吃了芒果蛋糕”这类**普通日常经历默认拒绝存储**，即使用户明说“记住”，也只保留约七天。[`806862c1`](https://github.com/Ruichen-0079/YUVI/commit/806862c1) 加入关键词规则的 `CurrentAffect`：对**用户**当轮情绪贴标签（“User appears frustrated…”），再注入提示词。

06-21/22 的 [PR #1](https://github.com/Ruichen-0079/YUVI/pull/1) 建立了 Windows-first 开发基线。随后的几个直接提交修了几处记忆问题：显式记忆请求、拒绝助手复述、用户纠正与取代。七月没有任何提交。

**暴露的问题（后来才看清）。**

- 这套记忆的目标是“为助手提供有用的用户事实”，与“岁月感”方向相反：它主动丢弃日常经历。
- `CurrentAffect` 用关键词替模型判断情绪。直到 10-10 才在 [#322](https://github.com/Ruichen-0079/YUVI/pull/322)（[`c1475dae`](https://github.com/Ruichen-0079/YUVI/commit/c1475dae)）中退役，理由是它会把“Explain the word anxious”误判为焦虑。
- `AGENTS.md` 的“必须压缩重构、不得直接给原始记录”从此成为每个编码代理读到的宪章，而且五个月从未更新（详见 [HISTORICAL_DEBT.md](HISTORICAL_DEBT.md) D1）。

**学到什么。** **[D]** 助手式“用户事实库 + 规则预解释”不是研究对象所需要的记忆。**[B]** 时间规范化、纠正取代、事件时间与记录时间分离，这些仍是有效的技术知识。

### 阶段 1（08-02 — 08-15）：身体、外置记忆与崩溃安全

**问题。** 让伴侣有“身体”：流式回复、语音、Live2D、透明桌面窗口，并把记忆从规则库换成更“智能”的外部系统。

**方案及理由。**

- 08-02 至 08-04 的直接提交：持久会话与上下文恢复、Provider 中立流式、GPT-SoVITS 可打断流式语音、Lumi 口型、**Tauri 透明伴侣窗口**（[`6f04dce`](https://github.com/Ruichen-0079/YUVI/commit/6f04dce)）、“Neuro-style”凝视跟随、状态感知的存在动画。
- [`018e1cf`](https://github.com/Ruichen-0079/YUVI/commit/018e1cf) 引入 **Mem0**：Python FastAPI sidecar、Ollama embedder、PGVector。仓库中**没有任何关于为什么选择 Mem0 的论证**，`docs/mem0-memory-foundation.md` 只描述了怎么接。
- [PR #2](https://github.com/Ruichen-0079/YUVI/pull/2)（+58,913 行）一次性把这些带入 main。

**实际发生。**

- [#4](https://github.com/Ruichen-0079/YUVI/pull/4)：Mem0 接入实时对话（回复前检索，回合后异步写入）。
- [#5–#8](https://github.com/Ruichen-0079/YUVI/pull/8)：Windows 桌面 Supervisor、凭据管理器、打包 Node 运行时、PyInstaller 打包 Mem0，共 33 个提交。
- [#9](https://github.com/Ruichen-0079/YUVI/pull/9)（08-11，“P3 Runtime-ready Memory”）是这一阶段思想上最重要的 PR。它引入 `MemoryEvent` 证据模型，区分 `recordedAt/observedAt/occurredAt`，并写下一条贯穿以后所有版本的原则：**“Memory stores evidence about what happened. It does not authoritatively mutate Relationship, Affect, Persona, Interest, or Commitment state … Assistant self-interpretation is not allowed to become authoritative long-term memory.”** 同一个 PR 让普通回合**不再走 Mem0 的 `infer=true`**。也就是说，引入 Mem0 一周后，它的核心能力（LLM 事实抽取）就被关掉了，Mem0 实际上成了带 Python 进程的向量库。
- [#11–#17](https://github.com/Ruichen-0079/YUVI/pull/14)（P4）为“把已完成回合写入 Mem0 sidecar”建造了一整套分布式系统：持久摄取账本、父/子记录、CAS/租约/版本栅栏、幂等日志、`reconcile_required`、协调器调度、重试预算。
- [#18](https://github.com/Ruichen-0079/YUVI/pull/18)：Supervisor 自管 PostgreSQL 16 集群（PID 复用、ACL、凭据管理器）。

**暴露的问题。**

- 外部进程式记忆系统要求大量崩溃安全、所有权和打包工程，而它提供的语义能力（infer）被自己关掉了。
- Windows 打包把注意力引向进程身份证明（见阶段 2 的 #20）。

**学到什么。**

- **[B]** “证据不等于解释、助手自述不得成为权威记忆”在 #9 就已成形，是最早、最稳定的原则之一。
- **[B]** P4 的 `UNKNOWN`/对账语义后来被 A9 effect 账本复用。
- **[D]** Mem0 路线在技术上可用，但其价值从未被比较验证；到 10 月，R5 正在用自建 PostgreSQL 权威取代它。

### 阶段 2（08-15 — 08-26）：AgentBus 治理、规则化主动性与 Linux 转向

**问题。** 让伴侣能“主动说话、知道何时沉默”，并在多代理并行开发下保持质量。

**方案及理由。**

- **AgentBus**（约 08-18 起）：浏览器中的 GPT 通过 Firefox 扩展在 PR 评论里写 `[GPT_SPEC]`、`[GPT_REVIEW]`、`[GPT_MERGE_REVIEW]`、`[FINAL_GATE]`、`[GPT_CONTINUATION]`；Codex 写 `[CODEX_REPORT]`、`[CODEX_AUDIT]`。issue [#51](https://github.com/Ruichen-0079/YUVI/issues/51) 是传输信箱。此后 PR 标题变成整句规格（如 [#44](https://github.com/Ruichen-0079/YUVI/pull/44)、[#48](https://github.com/Ruichen-0079/YUVI/pull/48)）。
- **P6 主动性**被切成很多微单元：
  - [#31](https://github.com/Ruichen-0079/YUVI/pull/31) 语义行为仲裁器（P0–P3 优先级、TTL）；
  - [#34](https://github.com/Ruichen-0079/YUVI/pull/34) 生命周期凝视；
  - [#38](https://github.com/Ruichen-0079/YUVI/pull/38) 静默主动注意（空闲延迟、冷却、每个空闲期至多一次）；
  - [#41](https://github.com/Ruichen-0079/YUVI/pull/41) 助手发起回合（无合成用户消息、无主动写记忆）；
  - [#42](https://github.com/Ruichen-0079/YUVI/pull/42)→[#44](https://github.com/Ruichen-0079/YUVI/pull/44)→[#46](https://github.com/Ruichen-0079/YUVI/pull/46)→[#47](https://github.com/Ruichen-0079/YUVI/pull/47)→[#48](https://github.com/Ruichen-0079/YUVI/pull/48)：同意、投影、握手、惰性客户端、首次真实效果；
  - [#55](https://github.com/Ruichen-0079/YUVI/pull/55) 自动候选：12 秒空闲、30 秒冷却、每个空闲期一次；
  - [#57](https://github.com/Ruichen-0079/YUVI/pull/57) Runtime `NO_OP|REQUEST_TEXT` 判断。

**实际发生。**

- [#20](https://github.com/Ruichen-0079/YUVI/pull/20) 是 Windows 打包私有 PostgreSQL 的 schema bootstrap：27 个提交、44 条 AgentBus 评论，两天内反复 `CHANGES_REQUIRED`/`ACCEPT`/`REPAIR`。卡点是“如何在 Windows 上证明某个 PID 确实是自己启动的 PostgreSQL”（CIM 查询 10 秒超时）。许多审计记录写明“pnpm 不可用、测试未运行”，却仍给出 PASS 或 BLOCKED。08-25 关闭为 DEFERRED。
- [#54](https://github.com/Ruichen-0079/YUVI/pull/54)（08-25）是第一次明确的撤退：Linux-first，使用外部/系统 PostgreSQL，放弃 #20 的状态机。
- 真实模型上，DeepSeek V4 无法稳定输出控制前导（[#58](https://github.com/Ruichen-0079/YUVI/pull/58)/[#59](https://github.com/Ruichen-0079/YUVI/pull/59)），还在“明显应该开口”的用例中返回 `NO_OP`（[#60](https://github.com/Ruichen-0079/YUVI/pull/60)）。[#61](https://github.com/Ruichen-0079/YUVI/pull/61) 于是改为双模型：Llama-3.3-70B 做 `NO_OP|REQUEST_TEXT` 标签决策，V4 写正文。每个用例 3 次，3/3 通过。

**暴露的问题。**

- 主动性的本体是**计时器、门槛和一次分类**，而不是由内部状态引起的倾向。模型只在规则已经放行时做一次二分类。
- 一个协议遵循问题（模型能力不足）直接变成了双模型架构。
- AgentBus 把“规格—实现—审计—评审—最终门”的流程放大到每个微小改动，治理语言（authority、frozen、fail-closed、SHA-fenced）从这里开始成为项目的思维语言。

**学到什么。**

- **[D]** 用 Web 端规则模拟“注意与主动”这条路线，后来在 [Atom 08](https://github.com/Ruichen-0079/YUVI/pull/237)/[Atom 10](https://github.com/Ruichen-0079/YUVI/pull/243) 迁回 Runtime，本质未变。
- **[B]** “用户优先、助手发起回合不伪造用户消息、主动回合不写记忆”这几条边界是对的。
- **[D]** Windows 打包与多代理流程的教训，后来沉淀为 [#235](https://github.com/Ruichen-0079/YUVI/pull/235) 的“连续两次无新证据即停止”规则。

### 阶段 3（08-27 — 09-01）：Future 01–08、合同原子化与 Memory vNext

**问题。** 结构债太重（`App.tsx` 与 `RuntimeOrchestrator` 是巨型文件），也缺少长期语义架构。

**方案及理由。**

- [#63–#89](https://github.com/Ruichen-0079/YUVI/pull/81)：“Structural R”机械拆分，语义不变。
- [#82](https://github.com/Ruichen-0079/YUVI/pull/82)（08-28）建立 `docs/future/` 01–08，即 **Future Doc 的第一版**（详见第 3 节）。它把长期目标写为“持久本地 AI 伴侣，而非普通智能体框架或工作助手”，同时引入一组技术主张：
  - Character 模型做表达、注意、沉默和粗粒度 `NEED_COGNITION`；
  - 独立的强 Cognition Core 做推理；
  - Character Harness；
  - 一张“每个关注点只有一个权威”的表；
  - 阶段 8–13 的行为规范 → 基座模型比较 → QLoRA SFT → DPO → A/B → 偏好数据飞轮。

**实际发生。** 08-29 到 09-01，代理按“最小原子”实现了这些文档，并行度极高。08-31 一天创建 70 个 PR、合并 58 个：

- P8-1A..1F（[#92](https://github.com/Ruichen-0079/YUVI/pull/92)–[#99](https://github.com/Ruichen-0079/YUVI/pull/99)）：身份、证据解释、显式纠正的纯合同包。[#96](https://github.com/Ruichen-0079/YUVI/pull/96) 过早合并，又被 [#97](https://github.com/Ruichen-0079/YUVI/pull/97) 回滚。
- Character ABI 2A–2D 与 Harness 5A–5L（[#100](https://github.com/Ruichen-0079/YUVI/pull/100)–[#115](https://github.com/Ruichen-0079/YUVI/pull/115)）。[#115](https://github.com/Ruichen-0079/YUVI/pull/115) 明说：在“后训练的 Character 模型”确定前不实现具体适配器。也就是说，整个 Harness 是为一个**尚不存在、后来也没有出现**的模型设计的。
- Cognition 6A–6AC（约 30 个 PR，另有 5 个重复 PR 被关闭）。最终只有一个 `read_text_file` MCP 能力回合。收尾文档 [#155](https://github.com/Ruichen-0079/YUVI/pull/155) 承认“当前 `/message` 与流式生产行为仍走旧 ChatProvider”。
- Embodiment 7A–7AL（`phase7/` 38 个 PR）：effect 身份、回调栅栏、准入、状态迁移、事件构造、追踪绑定……第一个由 Character 驱动的表情是 **soft-smile**（[#185](https://github.com/Ruichen-0079/YUVI/pull/185)）。约 35 个 PR 把这一个表情 token 接上了完整的 effect 生命周期。
- [#143](https://github.com/Ruichen-0079/YUVI/pull/143)（Grok 代理，分支 `grok/memory-vnext-architecture`）：**Memory vNext**。L0 = 近期原话（DirectContext），L1 = 30 分钟窗口的近期情节账本，L2 = MemoryEvent/Mem0 证据。另有 Dream 整合（按复现、显式重要性、显著性触发）、联想侵入、结构化压缩（未在运行时启用）、薄时间投影（发生时间与记录时间分离，长间隔不被压成“刚才”）。它比较了 RecMem、memU、Mem0 v3、LLMLingua、Zep/Graphiti/MemOS，选择“改编算法、不引入第二权威”。

**暴露的问题。**

- 合同包基本**没有接入生产**。九天后的 [#283](https://github.com/Ruichen-0079/YUVI/pull/283) 写道：“Production Character reconstructed P8/Memory semantics from prompt text”。
- L0/L1/L2 的直接动机是**上下文预算**（DirectContext 只有 6 轮/6000 字符），不是研究需求。Dream 的 idle 触发在生产中从未发生（10-09 [后端价值审计 F6](../backend-intelligence-value/YUVI-Backend-Intelligence-Value-Audit.zh.md)）。

**方向改变。** 09-01 的 [#203](https://github.com/Ruichen-0079/YUVI/pull/203) 做了诚实的收缩：

- Memory vNext 的薄时间投影就是当前时间基础；
- DirectContext + L1 + L2 是“连续性捷径”；
- 完整 Temporal/Continuity 只在**真实失败被证明后**再建；
- 训练（阶段 9–13）延期到长期真实使用之后；
- DeepSeek V4 只是可替换的基础设施，不是角色身份。

同日的 [#204](https://github.com/Ruichen-0079/YUVI/pull/204)/[#206](https://github.com/Ruichen-0079/YUVI/pull/206)/[#207](https://github.com/Ruichen-0079/YUVI/pull/207) 写下了行为规范、评估和偏好数据治理文档，但对应的训练计划从未执行。

**学到什么。**

- **[D]** 在没有使用者、没有消费者的情况下先把语义合同切成原子，会产出大量“正确但无人调用”的代码。
- **[C]** Memory vNext 的分层是工程折中，不是研究结论。
- **[A/B]** #203 的“先用已有上下文，等真实失败再建专门机制”是项目里少见的、由证据驱动的收缩。

### 阶段 4（09-01 — 09-13）：Atom、Campaign 与 Linux 发布

**问题。** 让 YUVI 在作者的 CachyOS/KDE 机器上真正可日常使用。

**实际发生。**

- [#231](https://github.com/Ruichen-0079/YUVI/pull/231) 写下 Atom 01–21 计划，随后逐个实现：
  - [#232](https://github.com/Ruichen-0079/YUVI/pull/232) CharacterDecision：addressing × reply × proactive；
  - [#233](https://github.com/Ruichen-0079/YUVI/pull/233) STT 观测 ≠ 用户消息；
  - [#234](https://github.com/Ruichen-0079/YUVI/pull/234) Runtime 拥有 Character→Cognition→再进入，SILENCE 不写助手行；
  - [#237](https://github.com/Ruichen-0079/YUVI/pull/237)/[#243](https://github.com/Ruichen-0079/YUVI/pull/243) 主动策略迁回 Runtime，单调度器，硬门槛 + 30s/120s；
  - [#245](https://github.com/Ruichen-0079/YUVI/pull/245) 多说话人归因：assertor/subject/provenanceClass，保留原文；
  - [#249](https://github.com/Ruichen-0079/YUVI/pull/249)/[#250](https://github.com/Ruichen-0079/YUVI/pull/250) 身份提及解析、声纹→Person 可信绑定；
  - [#251](https://github.com/Ruichen-0079/YUVI/pull/251) 语音模式与打断。
- Windows 托盘 Quit 的诊断循环（[#226](https://github.com/Ruichen-0079/YUVI/pull/226)–[#230](https://github.com/Ruichen-0079/YUVI/pull/230)：DIAG229/230，19 个提交，MSAA/COM 自动化）后，[#236](https://github.com/Ruichen-0079/YUVI/pull/236) 把 CI 改为 Linux-first，删掉了全部 Windows 作业。
- Campaign B–I（[#270](https://github.com/Ruichen-0079/YUVI/pull/270)–[#279](https://github.com/Ruichen-0079/YUVI/pull/279)）：
  - 本地 STT、dots TTS；
  - **按需视觉 grounding**（[#273](https://github.com/Ruichen-0079/YUVI/pull/273)：Character 表达需要后，截一次屏、调一次 Vision、回到同一回合；没有常驻 VLM）；
  - 表达性伴侣、可复现的安装/卸载验收、TTS 显存休眠。
- Astra 与 v0.1.x（[#285](https://github.com/Ruichen-0079/YUVI/pull/285)–[#320](https://github.com/Ruichen-0079/YUVI/pull/320)）：v0.1.0（09-09）、v0.1.1（09-10）、v0.1.2（09-12/13）在 Debian 12 ABI 基线上发布。
- [#283](https://github.com/Ruichen-0079/YUVI/pull/283) 补上了 P8/Memory/语音/Cognition 的生产接线。
- [#284](https://github.com/Ruichen-0079/YUVI/pull/284) 把主动判断改为“说话分数 + 阈值 + 固定间隔”，并把默认记忆抽取设回**规则**。

**暴露的问题。**

- CharacterDecision 要求模型输出 `DIRECTED_TO_YUVI|NOT_DIRECTED|AMBIGUOUS` 这类解释标签。而生产端口把所有桌面回合**预设**为 `DIRECTED_TO_YUVI`（10-07 [QQ 研究](https://github.com/Ruichen-0079/YUVI/blob/research/qq-alice-20261007/QQ-Alice-research-2026-10-07.md)第 5 节）。
- SILENCE 不进入历史，于是“我选择了沉默”这一经历本身不被记录。
- 记忆抽取在 LLM 与规则之间反复切换（05-17 默认 LLM → 09-08 默认规则 → R5 禁止规则回退）。

**学到什么。**

- **[B]** Linux 单机日常使用、语音链路、按需视觉，这些工程经验是可靠的。
- **[B]** “观测不是用户消息”“说话者聚类不是人”“断言者/主体/来源分离”这几条归因原则，是后来“忠实记录”原则的工程前身。
- **[D]** 大量产品化 Atom 与研究目标关系很弱。

### 阶段 5（09-12 — 09-24）：研究意图、北极星与“因果历史”

**问题。** 产品基本可用之后，YUVI 要回答“它究竟是什么”。

**实际发生。**

- **09-12**，[`e4d90d7b`](https://github.com/Ruichen-0079/YUVI/commit/e4d90d7b) 写下 v0.1.3 计划：**“make v0.1.3 the final foundation-building release before YUVI development becomes research-driven for 雏雁 / 鸿雁杯 work.”** 之后的研究活动列为：**“Memory Dynamics research: reinforcement, decay, recurrence dynamics, importance-preserving forgetting; learned/adaptive active-attention; Character/social-model post-training”**。这是仓库里**最早、最直接**记录“记忆动力学”研究意图的地方。
- **09-19**，[`4278eb36`](https://github.com/Ruichen-0079/YUVI/commit/4278eb36b1a01acde82dde27b806dca996739972) 写下 [Artificial Person North Star](../../future/00-artificial-person-north-star.md)：持久人工个体、岁月感、第一人称生活实感；“Yuvi should not repeatedly query her life. She should live inside it.”；Life Layer / Mind Layer、情绪作为动力而非标签、欲望作为行动前的张力、认知预算、人格惯性、演化的自传、可替换机械下的同一段生命。
- **09-20**，[PR #321](https://github.com/Ruichen-0079/YUVI/pull/321)：持久功能性自我。区分“重建的身份”与“因果状态连续性”，提出自我惯性、行动所有权、可证伪研究序列和失败判据。
- **09-24**，[`6f06d8ba`](https://github.com/Ruichen-0079/YUVI/commit/6f06d8ba)/[`07509e47`](https://github.com/Ruichen-0079/YUVI/commit/07509e47) 在 `codex/v0.1.3-platform-completion-20260922` 上做了“Future 整合”，产出新的 [north-star.md](../../future/north-star.md)：研究问题改为“经历如何对未来注意和选择产生持久、可归因、可纠正、可跨模型迁移的改变”；岁月感降级为评估目标；“There is no mandatory latent self, generic Life Layer, or mandatory collection of psychological organs”；“最小充分架构优先”。整合记录 [v0.1.3-future-consolidation.md](../../validation/v0.1.3-future-consolidation.md) 列出 13 项决定，其中包括：
  - 显式 COMMITMENT/EXPECTATION/INTENTION 优于模拟欲望；
  - 不设通用 Life Layer；
  - 自生成语言永远不能作为自身倾向的证据；
  - 学习型 Z 降级为可选的选择器研究。

  旧的 00–08 序列被宣布为“历史资料”。

- 10-07，#321 被关闭，只把 E7（惯性与合理修正）和 E8（自身行动与观察到的后果）两项实验保留到 [research-methodology.md](../../future/research-methodology.md)（[`46a24878`](https://github.com/Ruichen-0079/YUVI/commit/46a24878)）。

**怎么看这次改写。**

- **[B/A] 方法论上是实质进步：**
  - 因果检验（改变历史应改变选择，改变无关历史则不应）；
  - 消融与纠正；
  - 防止自我叙事循环；
  - 显式基线（B0…B3/O_text/O_selection）先于学习型状态。
- **代价是研究对象被悄悄收窄：**
  - 北极星中最有特色的内容（慢变量、张力、人格惯性、遗忘但保留影响）被移入“评估目标”或禁止项；
  - “记忆动力学”这个词从主线文档里消失了；
  - 这次整合发生在 Codex 开发分支上，文风与该分支其他代理文档一致（见第 4 节）。**没有证据表明“禁止 Life Layer”是你本人逐项认可的判断。**

### 阶段 6（09-22 — 10-07）：持久因果历史地基（分支开发后快进并入，无 PR）

**问题。** 按 09-24 的路线，v0.1.3 成为 “Durable Causal History Foundation”。

**实际发生。** 这一个月的工作都在 `codex/v0.1.3-platform-completion-20260922` 分支上完成；main 一直停在 09-19 的北极星提交，直到 10-07 才一次快进 66 个提交（[main-consolidation-2026-10-07.md](../../validation/main-consolidation-2026-10-07.md)）。全程没有 PR 和评审，只有 `docs/validation/` 中的记录。

- A0 权威基线；A2 多轮 Cognition 收容；A4 规范化上下文组装；A5 稳定前缀；A6/A7 插件生命周期与可执行注册表。
- **A8**：Life Event Journal。把会话、语音、视觉、产品控制、Runtime 控制、主动同意、声纹控制、外部主动回合、独立 TTS 各自的入口全部改为“先写 Journal 接收凭证”（[a8.2-ingress-closure.md](../../future/a8.2-ingress-closure.md)）。
- **A10.1**：证据落地。[v0.1.3-a10.1a](../../validation/v0.1.3-a10.1a-llm-memory-grounding.md) 复现了一个真实存在的代码路径缺陷：**在旧的 LLM 抽取路径（`MEMORY_EXTRACTOR=llm`）上，一个编造无关偏好的确定性桩模型，能让系统以“用户说过”的名义写出 durable-core 记忆，并带有伪造的 sourceTrace**（测试复现；没有证据表明生产中实际发生过）。后续的 legacy 写入、Mem0、Dream 派生都要求可追溯的 Journal 祖先。还加了本地 Profile 物化器与新鲜度生命周期。
- **A9**：effect intent outbox；`INTENT→ATTEMPT→OUTCOME`；崩溃歧义记为 `UNKNOWN`，不盲目重放。**A10.2/A10.3**：控制者血缘、历史上下文清单。**A11**：可注入故障的一致性测试。
- 10-07 [`49150e62`](https://github.com/Ruichen-0079/YUVI/commit/49150e62)：独立 Character 组合（Yuvi 与 Alice 的人格、记忆、关系、执行状态隔离）。

**暴露的问题。**

- v0.1.3 原定是“研究前的最后地基版本”，结果花了一个月，接着又是 R5 的十天。研究阶段始终没有开始。
- [Profile 物化后没有产品读方](../backend-intelligence-value/YUVI-Backend-Intelligence-Value-Audit.zh.md)；P8 适配器拒绝把证据自动升格为理解，却也没有任何产生“理解”的部分。

**学到什么。**

- **[B]** Journal、归因、`UNKNOWN` 是可靠的工程成果，A10.1a 复现的伪造归因路径说明它们是必要的。
- **[D]** “先把地基修完再做研究”这一原则在实践中不断推迟研究，自身从未被检验。

### 阶段 7（9 月 — 10-08）：QQ/Alice 社会表面

**问题。** 让一个独立人格（东方爱丽丝 / Alice）在 QQ 群聊中自然参与。

**证据状况（重要）。**

- QQ 插件以 ZIP 发布（tag `qq-snowluma-v1.0.0`，tag 指向 09-19 北极星提交）。
- 构建它的源码提交 `7dcf4b01`、`e8a09719`、`dbb4b984` 在公开仓库**不可达**，[本地审计](https://github.com/Ruichen-0079/YUVI/blob/feat/plunge-webui-20261008/docs/validation/plunge-local-audit-2026-10-07.md)称它们只存在于作者本机的工作树/不可达对象中。
- 10-07 的 [QQ-Alice 研究](https://github.com/Ruichen-0079/YUVI/blob/research/qq-alice-20261007/QQ-Alice-research-2026-10-07.md)与 [Multi-Character 研究](https://github.com/Ruichen-0079/YUVI/blob/research/qq-alice-20261007/YUVI-Multi-Character-research-2026-10-07.md)只保存在单独的 tag 中。

**实际发生。**

- 旧插件用 `PERSONA` 替换为 “You are QQBot … with your own social memory”。这句话本身不能建立任何记忆分区。
- 10-07 的研究做了几件事：
  - 指出生产 Character 把桌面回合预设为 `DIRECTED_TO_YUVI`；
  - 指出 DirectContext 把历史压成 `User:/Assistant:`，丢失作者；
  - 指出 Memory vNext 按单一主体过滤掉群聊中他人的消息；
  - 建议“**结构化 envelope + 带 speaker 的原文**：结构保住可证实的关系，原文保住玩笑、黑话、否定、反讽与语用信息；模型推断的‘这是给 Alice 的’只能作为假设，不能覆盖 reply/mention”；
  - 提出“参与机会（有锚点、可撤销、会过期）”取代“欠回复压力/计时器”。
- Plunge 分支（10-07/08，未合并）用薄 SnowLuma 适配器接入独立的 Alice Core。普通群消息只成为凭证和场景观测，不成为回合；私聊、@、回复、延续可进入 Character 门。还接入了本地 Qwen3.5-4B 预过滤器。
- **[`734e1e12`](https://github.com/Ruichen-0079/YUVI/commit/734e1e12) `character-linear-context.v1`**：
  - 按时间顺序呈现带作者的频道消息；
  - 区分 `[SELF_SENT: ACKNOWLEDGED]`、`[SELF_DRAFT: publication UNKNOWN]`；
  - 视觉标为“perception，不是参与者发言”；
  - 把规范 JSON、版本号、来源 ID 从模型视图中移除，只留给审计；
  - 一个真实样本从 9,885 字符降到 4,642 字符。

  真实回放结果混合：`ok 问题很大` → SILENCE；`Alice 你在吗` → RESPOND；但仍出现插入不当和视觉误判。

**学到什么。**

- **[A]** “程序忠实记录事实（身份、时间、顺序、引用、附件、来源、权限），语义理解交给模型”这一原则，在这里第一次有了清晰的工程表达与实证动机（详见第 5 节专题二）。
- **[D]** 用 4B 预过滤和准入规则替主模型判断“该不该看见”，与该原则存在张力。
- **[D]** 这一阶段大量原始证据没有进入公开仓库。

### 阶段 8（10-09）：五份独立研究审计

10-09 发布到 [docs/research/](../README.md)：

- [下一代架构](../next-generation-architecture/README.md)；
- [持续内部状态基础](../persistent-internal-state/README.md)；
- [生产智能损失](../production-intelligence-loss/README.md)；
- [后端智能价值](../backend-intelligence-value/README.md)；
- [后端完整性](../backend-completeness-audit/README.zh.md)。

与本研究直接相关的结论：

- 生产中普通 RESPOND 需要 **2 次 Chat 调用**（JSON disposition gate + 正文）；升级到 Cognition 需要 N+3 次。
- 程序误解语义：“Don't forget” 被解释为删除（F3）；QQ 控制协议失败被合成为“成功的沉默”（F6）。
- Dream 是规则整合，生产中没有 idle 输入；Profile 没有读方。
- “来源/执行强于语义”。
- 持续内部状态报告指出，上一轮从零设计“适合回答怎样造出可长期合作的产品，没有充分回答什么样的持续过程能够发展成一个个体”，并写明“**用户对研究排序的批评成立**”。这是仓库中少数能看到你本人立场的地方。

### 阶段 9（10-10 — 10-19）：记忆权威与发行候选（开放堆叠 #322–#337）

**问题。** 10-09 审计证明生产中“记忆没有真正起作用”，例如纠正不生效、长输入尾部丢失。

**实际发生。** 16 个堆叠 PR，全部未合并：

- [#323](https://github.com/Ruichen-0079/YUVI/pull/323)：SSE 心跳后的正文被丢掉；已发表的会话文本进入下一轮时被逐条截到 800 字；`length` 正文被整体拒绝。修复后，同模型、temperature=0 下尾部事实召回从 0/3 到 3/3。
- [#324](https://github.com/Ruichen-0079/YUVI/pull/324)（R4）：自然语言纠正此前产生**零候选**，或旧事实仍是当前事实。修复后，新会话/重启后 3/3 使用新值。但模型在写入被拒时仍会说“已记下”。
- [#325](https://github.com/Ruichen-0079/YUVI/pull/325)/[#326](https://github.com/Ruichen-0079/YUVI/pull/326)（R5）：PostgreSQL 权威记录、命题级当前投影、类型化关系、向量 outbox；新路径禁止关键词/规则回退；百万向量合成负载。
- [#327](https://github.com/Ruichen-0079/YUVI/pull/327)：此前测试在 mock 下**绕过 Character**；现在总是装配 Character，并按模型窗口把已接纳的会话原文交给它。
- [#328](https://github.com/Ruichen-0079/YUVI/pull/328)：用户输入与 Journal/会话/摄取决定同一事务提交，**即使 Character 沉默、取消或失败也能形成记忆**。
- [#329](https://github.com/Ruichen-0079/YUVI/pull/329)–[#333](https://github.com/Ruichen-0079/YUVI/pull/333)：观察报告与 A9 终态原子提交；先排序再截断；组合检索；“证据支持”与“相关性”分离（完整答案 12/24→19/24）；同来源兄弟纠正收敛。
- [#334](https://github.com/Ruichen-0079/YUVI/pull/334)/[#335](https://github.com/Ruichen-0079/YUVI/pull/335)：WebUI 与原生 Tauri 的受限 Host 身份；首次运行时可信创建 Person。
- [#336](https://github.com/Ruichen-0079/YUVI/pull/336)：自带 Node/PostgreSQL/pgvector/SQL 001–045 的 Linux 文字桌面包。在**全新 Debian 12 VM** 上完成：所有权确认 → R5 初始化 → 创建 Person → 聊天中形成记忆 → 纠正 → 系统重启后召回 → 整机冷备份 → 另一台 VM 恢复（旧 Host 401，未决 attempt 不伪造 APPLIED）。
- [#337](https://github.com/Ruichen-0079/YUVI/pull/337)：Supervisor 被 SIGKILL 后的孤儿进程问题。改用 systemd transient service/cgroup v2 收容，14 类故障矩阵通过。

**这些测试证明了什么，没有证明什么。**

- **[B] 证明了**：单机上，一个可信身份的事实形成、纠正、历史保留，可以穿越进程重启、系统重启和异机恢复而不丢失、不重复执行，并被重新放进模型上下文。这是**数据连续性和身份连续性的基础设施**成立。
- **没有证明**：
  - 模型以外是否存在任何“倾向”的连续性；
  - 过去是否改变了未来的注意、判断或选择（只有“记得事实 B”）。
- 发行候选中的模型是 **fixture**。#335–#337 都写明“真实模型测试 B 未运行，缺少获准的独立 Provider”。真实模型实验散见于 #323/#324/#327/#331/#332，每组 3 次左右，费用以美分计，**只能证明链路可用，不能证明质量**。

---

## 3. Future Doc 的思想演变

`docs/future/` 共有六个关键版本：

| 版本                               | 提交                                                                                                                                    | 性质                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 08-28 后结构伴侣路线 01–08         | [`d37c0756`](https://github.com/Ruichen-0079/YUVI/commit/d37c0756) / [#82](https://github.com/Ruichen-0079/YUVI/pull/82)                | Codex 撰写；语义所有权表；Character/Cognition；训练阶段 |
| 09-01 Memory-first 重定基线        | [`2256cf26`](https://github.com/Ruichen-0079/YUVI/commit/2256cf26) / [#203](https://github.com/Ruichen-0079/YUVI/pull/203)              | 收缩；连续性改为“由失败驱动”；训练延期                  |
| 09-12 v0.1.3 Platform Completion   | [`e4d90d7b`](https://github.com/Ruichen-0079/YUVI/commit/e4d90d7b)                                                                      | 地基收尾后转入研究（雏雁/鸿雁杯），点名记忆动力学       |
| 09-19 Artificial Person North Star | [`4278eb36`](https://github.com/Ruichen-0079/YUVI/commit/4278eb36b1a01acde82dde27b806dca996739972)                                      | 最完整的哲学图景；文件至今未改，但被宣布为历史          |
| 09-20 PR #321 持久功能性自我       | [#321](https://github.com/Ruichen-0079/YUVI/pull/321)                                                                                   | 关闭；E7/E8 保留                                        |
| 09-24 因果历史整合                 | [`6f06d8ba`](https://github.com/Ruichen-0079/YUVI/commit/6f06d8ba) / [`07509e47`](https://github.com/Ruichen-0079/YUVI/commit/07509e47) | 当前“权威”；收窄研究对象，加强可证伪性                  |

### 3.1 YUVI 最初希望实现什么？

按仓库证据如实回答：

- **05-10 — 08-02**：一个受 AIRI 启发的本地 AI 伴侣运行时，有记忆、语音、Live2D 和桌面应用（`AGENTS.md`、[terminology.zh-CN.md](../../terminology.zh-CN.md)）。Project AIRI 自身以“赛博生命/角色灵魂容器”为愿景，可视为“人工个体”意向的外部来源，但这只是推测，仓库里没有引述。
- **08-28**：持久本地伴侣——稳定身份、有证据的关系、时间感、跨间隔的连续性、未完成的注意、选择性主动与有意义的沉默、可替换能力、具身表达、专属 Character 模型与独立强认知。
- **09-12**：地基完成后，研究记忆动力学、自适应主动注意和角色后训练。
- **09-19**：持久的人工个体，“过去改变未来”“生活在其中而非查询它”。

所以，“不是做更好的聊天机器人”这个立场在 **08-28 以后**的文档中是明确的。在此之前，记录中的项目确实更接近一个功能齐全的伴侣/助手。

### 3.2 贯穿始终的核心命题

能在多个阶段、多个作者笔下反复出现，并经受住改写的：

1. **助手自己的生成不得成为关于世界或关于自己的权威证据。** 出现在 #9（08-11）、P8-1F（08-30）、Memory vNext 的认知分离（08-31）、09-24 第 9 项决定，以及 R5。这是最稳定的命题。
2. **记录发生了什么，与解释它意味着什么，必须分开。** 出现在 #9 的 MemoryEvent、P8 的证据→解释、Atom 12 的 claim、09-24 的 Journal 与派生，以及 10-08 的线性上下文。
3. **沉默/不行动是合法的输出。** 08-28 的 meaningful silence，P6 的 `NO_OP`，Character 的 `SILENCE`，北极星的 “Existence does not require constant output”。
4. **身份不随模型更换而改变。** 08-28 的可替换能力，09-01 的 “DeepSeek 只是基础设施”，北极星 §12，09-24 的 model-replacement。
5. **时间是真实的。** 包括：不把相对时间写进长期记忆、发生时间与记录时间分离、长间隔不被压成“刚才”，以及（03 文档中的）“no fake off-screen life”。

### 3.3 被澄清、深化或修正的思想

- “连续性”：08-28 设计为独立权威（未完成线程、承诺、残留），09-01 改为“由失败驱动”，09-24 改为显式的 COMMITMENT/EXPECTATION/INTENTION + 派生 OPEN_THREAD。**澄清是有价值的**（承诺需要可验证的接受与完成条件），但三次改写都没有落地。
- “持久自我”：09-19 的生活图景 → 09-20 #321 的“因果状态连续性、自我惯性、行动所有权” → 09-24 的“经历对选择的可归因影响”。**深化**在于加入了可证伪的干预实验；**修正过度**在于把“内部状态是否必要”从开放问题变成了默认禁止。
- “记忆”：从“用户事实库”（5 月）→“证据，不是关系/情绪/人格”（08-11）→“分层上下文”（08-31）→“带血缘的证据索引”（09-24）→“命题级当前认识 + 纠正 + 支持判定”（10 月）。**这是唯一持续深化并被实测推动的主题。**
- “训练”：从“阶段 9–13 必然训练”（08-28）→“真实使用后再说”（09-01）→“训练示例不能冒充亲历”“SFT 不证明持久自我”（#321、09-24）。这一修正正确。

### 3.4 实际上只是技术实现建议的部分

以下内容在文档中以“架构”或“权威”的口吻出现，本质上是**当时**的技术选择：

- 小型 Character 模型 + 强 Cognition 模型的双模型分工，以及 `NEED_COGNITION` 协议。动机是“Character 做更少理性工作”，并期待一个后训练模型。它也是对 V4 协议遵循不足的补偿（#61）。
- Character ABI/Harness 的版本化合同、5A–5L 的监督与恢复。
- “每个关注点只有一个权威”的表格本身，以及 P6 `NO_OP|REQUEST_TEXT` 的“冻结”。
- L0/L1/L2、Dream、联想侵入、压缩。
- Mem0、PostgreSQL + pgvector、Tauri、Supervisor、systemd、Linux/KDE 优先、Debian 12 ABI 基线。
- 阶段 8–13 的 SFT/DPO 路线、行为规范与偏好数据集格式。
- 09-24 的 B0/B0p/B1/B2/B3/Z 比较设计。这是**有价值的实验设计**，但同样是技术方案，不是研究目标本身。

### 3.5 原本临时、却逐渐被当作不可动摇前提的部分

- **`AGENTS.md`**：05-10 的脚手架宪章，五个月未改，却每次会话都被代理当作“必须遵守的指令”读入。“记忆必须压缩重构、不得给原始记录”“生产不得依赖 PostgreSQL/Node”是其中两条，前者与后来的忠实记录原则冲突，后者与 R5 发行包直接矛盾。
- **“Runtime 是唯一权威”“Memory/P8 是 X 的唯一权威”**：08-28 为防止多代理互相覆盖而写的所有权表，后来变成每个 PR 的必读咒语（“no second Runtime/ToolOrchestrator/authority”）。它防住了混乱，也让任何“统一状态影响多种行为”的设想天然显得越权。
- **P6 冻结**：一个 08-25 才落地的一次性主动文字路径，被写成“必须原子迁移、证明等价”的冻结合同。
- **“先完成地基再研究”**：09-12 写下，09-24 被另一套地基替换，10 月又被 R5 替换。
- **09-24 的禁止项**（无 Life Layer、无合成激素、无任何心理标量）：它们是一次代理整合的“路线选择”，后来被当作“经过论证的科学结论”引用。10-09 的持续内部状态报告已指出这一点。

### 3.6 仍未实现、可能有重要价值的设想

- 北极星 §8 **时间印象**（“这个项目逐渐变得认真了”“现在需要的背景解释比以前少了”）和 **遗忘细节但保留影响**。
- §5–6 **慢变量调制**（影响注意、可回忆内容、投入意愿、主动阈值）与 **欲望作为张力**（先改变认知，有时才行动，有时仍沉默）。
- §7 **认知预算**（疲劳、兴趣、重要性、不确定性决定是否动用昂贵推理）。
- §9 **多时间尺度的人格惯性**（越接近“我是谁”，需要越多证据才能改变）。
- #321 / E7 / E8：**自我惯性与合理修正**；**自身行动与独立观察到的后果改变以后的处理**。
- 09-24 的 **COMMITMENT/EXPECTATION/INTENTION**（未完成事项对未来的压力）。
- QQ 研究的 **参与机会**（可撤销、有证据锚点，取代计时器式的“想说话”）。
- 09-12 点名的 **记忆动力学**（强化、衰减、复现、保留重要性的遗忘）。

---

## 4. 归属：哪些是你的思想，哪些是代理的方案

**能确定的事实：**

- 336 个 PR 全部由 `Ruichen-0079` 账号创建，但正文风格、分支前缀和提交身份显示几乎都是编码代理产出：
  - 来自 `codex/` 分支的 PR 131 个，`phase7/` 38 个，`atom/` 21 个；
  - `grok/`、`luna/`、`sol/` 等代理分支；
  - AgentBus 的 GPT/Codex 评论；
  - 提交身份 `codex@openai.com`、`opencode@local`，以及多个邮箱。
- “Chen sihan”（gmail）身份的 21 个提交集中在 10-07 之后的研究和修复，看起来也是某个代理环境的身份，**不能据此判定为你本人的手写内容**。
- PR 评审几乎为零：336 个 PR 只有 2 个 review、0 条行内评论。人工意志主要通过以下方式体现：合并/关闭的选择、“Do not merge”门、关闭 #321 时保留 E7/E8 的评论、研究报告里转述的“用户已澄清”“用户对研究排序的批评成立”，以及本次任务的说明。

**判断：**

- **较可信地属于你的思想：**
  - 不做普通助手、要做一个会随生活变化的个体（08-28 起反复出现，你在本任务中再次确认）；
  - 记忆动力学作为研究主题（09-12）；
  - 北极星的核心意象（岁月感、第一人称生活实感，“不要查询生活，要活在其中”）——文风与其他代理文档明显不同，且包含中文概念；
  - 持久功能自我的问题意识（#321，后来被你部分保留）；
  - 忠实记录、理解交给模型（本任务明确陈述，10-07/08 的工作与之一致）。
- **较可能属于代理的方案：**
  - 所有权/authority 表与“atom”切分方式；
  - Character Harness/ABI 的版本化细节；
  - Phase 7 effect 生命周期；
  - Memory vNext 的 L0/L1/L2（Grok）；
  - 09-24 整合的禁止项；
  - 各种 Campaign/Atom 编号。
- **不确定：**
  - 05-10 的 `AGENTS.md`（可能由你给代理的初始提示生成）；
  - 08-28 的 Character/Cognition 双模型构想（可能来自你与 GPT 的讨论）；
  - 09-24 整合是否经过你的逐项认可。

**无法访问的资料：**

- 你与 GPT/代理的对话（项目的大部分需求可能在那里）；
- 七月的工作；
- QQBot/插件原始源码提交；
- Alice 实际运行轨迹（私有目录）；
- 本地多个工作树中未推送的内容。

以上判断都受这些缺失限制。

---

## 5. 专题追溯

### 专题一：历史连续性与持久自我

**生产中，“过去”通过哪些通道影响“现在”？** 依据 main 与开放堆叠的源码审计（10-09 两份审计，以及 #327/#328 的说明），只有以下几条：

1. 近期会话原文：
   - DirectContext 默认 6 轮/6000 字符；
   - #284 起按模型窗口计算；
   - #323 之前，已发表文本进入下一轮时被逐条截成 800 字。
2. L1 近期情节：30 分钟窗口的规则摘要，含 `taskState`/`unresolved` 提示。
3. L2 检索到的事实：legacy、Mem0 或 R5 的命题。
4. P8：作者写的人格 + 显式纠正 + 从证据重建的关系描述。Profile 物化后没有读方。
5. 主动策略状态，例如“安静五分钟”的抑制。

全部通道最终都化为**本轮提示词中的文本**。没有任何状态会在提示词之外改变模型如何理解、注意或选择。

**判断：**

- **[A]** “过去应持续影响未来的理解、判断与行动”是 08-28、09-19、#321、09-24 一以贯之的问题。
- **[B]** 已经实测：事实及其纠正能穿越会话、进程重启、系统重启与异机恢复，并重新进入模型上下文（#324、#326、#328、#336、#337）。
- **[C]** 尚未检验：这是否构成“持久自我”或“倾向的连续性”。研究方法文档的 E1–E8、长期轨迹生成器与回放设施**从未建立**（仓库中无任何实现）；v0.1.5–v0.1.7 均未开始。
- 也要避免反向的过度否定。10-09 的研究正确地指出：如果持久文本状态确实改变了后续计算，它也是一种因果载体；“每轮从文本重建”本身不证明不存在连续性。问题在于**从来没有设计过能区分两者的实验**。
- #321 对旧架构的批评——“从身份 + 检索到的历史 + 当前状态，在每次推理时重建一个稳定的人”——至今仍准确描述了系统。

### 专题二：模型对经历的自主理解（“程序忠实记录，语义交给模型”）

这一原则的形成过程，是一个早期反向规则被实践逐步推翻的过程：

| 时间          | 证据                                                                                                                                                                                                                                                                                                                                | 方向                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 05-10         | `AGENTS.md` 规则 4/5、`docs/memory.md` 首句：不得直接给原始记录，必须检索、排序、压缩、重构                                                                                                                                                                                                                                         | 反向（预加工优先）         |
| 05-24 — 05-26 | 时间规范化在存储前**改写**原句；拒绝日常经历；关键词 `CurrentAffect` 给用户情绪贴标签                                                                                                                                                                                                                                               | 反向                       |
| 08-11         | [#9](https://github.com/Ruichen-0079/YUVI/pull/9)：证据只记录发生了什么，不改写关系/情绪/人格；助手自述不得成为权威                                                                                                                                                                                                                 | 萌芽                       |
| 08-29 — 08-31 | P8：证据→解释分离，但“解释候选必须被显式提供”，**没有任何产生解释的部分**；Character ABI 把一切预处理成带认知状态的语义 section（summary ≤4,000 字符）；Memory vNext 产生规则摘要                                                                                                                                                   | 混合：框架忠实，内容预加工 |
| 09-05 — 09-06 | [#233](https://github.com/Ruichen-0079/YUVI/pull/233) 观测 ≠ 用户消息；[#245](https://github.com/Ruichen-0079/YUVI/pull/245) 断言者/主体/来源/原文保留；但 [#232](https://github.com/Ruichen-0079/YUVI/pull/232) 要求输出 addressing 标签，生产又把桌面回合预设为 `DIRECTED_TO_YUVI`                                                | 混合                       |
| 09-23         | A4：所有 Chat/Cognition 共享一个“规范化语义组装”（IDENTITY → PERSONA → RELATIONSHIP → RECENT → MEMORY → TEMPORAL → SITUATION）                                                                                                                                                                                                      | 统一了预加工格式           |
| 10-07         | [QQ 研究](https://github.com/Ruichen-0079/YUVI/blob/research/qq-alice-20261007/QQ-Alice-research-2026-10-07.md)：结构化 envelope + 带 speaker 的原文；模型推断只能是假设，不能覆盖 reply/mention                                                                                                                                    | 原则成形                   |
| 10-08         | [`734e1e12`](https://github.com/Ruichen-0079/YUVI/commit/734e1e12) 线性上下文：带作者、按时间顺序；SELF_SENT/SELF_DRAFT；感知 ≠ 发言；JSON/来源 ID 不进入模型视图（仅在 Plunge 分支）                                                                                                                                               | 实现（未合并）             |
| 10-09         | 审计 F3（“Don't forget” → 删除）、F6（协议失败 → 伪装沉默）、规则情绪误读否定                                                                                                                                                                                                                                                       | 反证旧路线                 |
| 10-10 — 10-16 | [#322](https://github.com/Ruichen-0079/YUVI/pull/322) 撤除关键词情绪；[#323](https://github.com/Ruichen-0079/YUVI/pull/323) 不再截断已发表原文；[#327](https://github.com/Ruichen-0079/YUVI/pull/327) 把已接纳会话原文按窗口交给 Character/Cognition；[#328](https://github.com/Ruichen-0079/YUVI/pull/328) 沉默/失败回合也保留输入 | 在主链落实（未合并）       |

**判断：**

- **[A]** 这是你提出的原则，有清楚的问题意识：程序做不可验证的语义判断，会替模型丢失、误解或固定信息。
- **[B]** 已有部分实证，但都是小样本：
  - 10-08 回放中，上下文减半，部分沉默/回应判断正确；
  - #323：保留尾部原文后，事实召回 0/3→3/3；
  - #327：长输入尾部事实在旧分支丢失，新分支召回。
- **[D]** 反向路线（规则预解释）已有多个明确失败。
- **尚未落地：** 线性上下文只在未合并的 Plunge 分支上；main 仍使用 A4 的语义 section 组装和两次调用的 gate。
- **原则还需要一个边界：** 程序不可能完全不解释。把声纹聚类绑定为某个 Person、把 QQ 号解析为 Product Person、判断“回复指向哪条消息”，都是解释。可行的划分是：**可验证的关系（谁、何时、回复谁、来源、权限、是否已送达）由程序负责，并在不确定时如实标注为不确定；意义、意图、情绪、是否值得参与由模型负责。** Atom 12/13 中“未解析身份不写入长期记忆”“说话者聚类 ≠ 人”的做法，正是这条边界的好例子。

### 专题三：记忆动力学

| 机制                                    | 首次出现                                            | 状态                                                             |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 显式纠正取代旧事实、保留历史            | 05-24/06-22 规则；P8-1D（08-29）；R4/R5（10-10 起） | **[B]**：R4 后重启/新会话 3/3 使用新值；同源兄弟纠正收敛（#333） |
| 按类别 TTL 过期                         | 05-26                                               | **[D]**：助手式保留策略，与“遗忘细节但保留影响”无关              |
| 复现触发的整合（Dream）                 | 08-31 #143                                          | **[C]**：规则整合；生产中 idle 不触发；没有测量过学习效果        |
| 联想侵入（有冷却、衰减）                | 08-31 #143                                          | **[C]**：只作上下文，没有评估                                    |
| 强化、衰减、复现动力、保留重要性的遗忘  | 09-12 计划点名                                      | **[A]** 研究意图；**从未开始**                                   |
| 测量化整合（无状态标注 → 确定性积分器） | 09-24 measured-consolidation                        | **[C]** 设计；未实现                                             |
| 时间印象（“这件事逐渐变得认真了”）      | 09-19 北极星 §8                                     | **[A]**；未实现                                                  |

结论：仓库中真正运行并被验证的“动态”只有**纠正**。最早的设计还主动丢弃日常经历，导致“岁月感”所需的原材料从一开始就不被保存。这是后来研究最需要补上的空白，而不是最需要继承的成果。

### 专题四：情绪、人格与自主行为

- **情绪。**
  - 唯一进入生产的“情绪”机制是给**用户**贴关键词标签（05-26 → 10-10 撤除）**[D]**。
  - YUVI **自身**的情绪状态从未实现。08-11 #9 规定记忆不改写 Affect；P8 反复写明“no mood/intimacy/relationship score”；09-24 禁止“trust/hormones/needs/fatigue/affinity/desire/emotion scalar”。
  - Live2D 表情由 Character 的语义意图驱动（soft-smile → Campaign F 的表情/姿态），是**无状态的表达**，不是情绪动力 **[C]**。
- **人格。**
  - 一直是作者写的文本：#222 的“校准人格”、#316 撤除的旧 `CharacterStyle`（“1-3 sentences”）、P8 authored invariants，以及 10-08 迁入的 Alice 完整人格。
  - 没有任何人格随经历变化的机制。“人格作为起点而非终身设定”在 #321 中提出，在 09-24/10-07 被保留为“研究可能性”，但明确不改变现有权威 **[A，未实现]**。
- **长期人物认识。**
  - P8 每轮从证据重建关系；Profile 物化器建了，但没有读方；
  - Atom 12/13 能分清“谁说了关于谁的什么”**[B]**，但没有“对一个人的认识随时间变化”的机制。
- **自主行为。**
  - 主动发言 = 计时器/冷却/空闲预算/门槛 + 一次模型判断（P6 → Atom 10 → #284 的说话分数）**[D/C]**；
  - 按需视觉（#273）和 Cognition 的能力请求（#327 中真实模型自行选择读取文件）是**模型自己决定动用能力**的少数实例，**[B]**，但样本很小。
- **程序是否通过规则模拟这些性质，让模型失去了理解与决定的空间？** 是的，在以下几处尤其明显：
  - 主动性：规则决定模型**何时有资格**考虑开口；
  - 用户情绪：关键词决定；
  - 被呼唤：生产预设 `DIRECTED_TO_YUVI`，QQ 用准入规则和 4B 预过滤；
  - SILENCE 不进入历史，于是“我选择了沉默”这一经历被抹去。
- 反过来，09-24 的禁止项也让“给模型一个可用的、持续的内部状态”这条路从未被尝试。两种做法都没有让**模型基于自身经历**形成倾向。

### 专题五：工程实践形成的真实知识与“测试到底证明了什么”

| 实践                       | 证据                                                                                       | 证明了什么                                              | 没有证明什么                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| 干净首装                   | #336：全新 Debian 12 VM，自带 Node/PG/SQL                                                  | 发行物自包含、身份与所有权确认可在空机完成              | 任何认知或连续性属性                                           |
| 真实身份创建               | #335/#336：A9 中 Person 创建，回执丢失后可恢复                                             | 身份是持久的、可恢复的、不被重复创建                    | 身份的“同一性”在心理意义上成立                                 |
| 形成记忆 → 纠正 → 重启召回 | #324、#326、#328、#336                                                                     | 事实与纠正被持久化并重新进入模型上下文；R4 真实模型 3/3 | 过去改变了未来的倾向或选择；fixture 模型下的回答不代表语言质量 |
| 整机冷恢复                 | #336：异 VM 恢复，旧凭据 401，未决 attempt 不伪造 APPLIED                                  | “一段生命不能被随意分叉或伪造成功” 在工程上可落实       | 恢复后的个体与原个体在行为上连续                               |
| 崩溃与进程所有权           | #337：14 类矩阵                                                                            | 单机服务收容与恢复可靠                                  | —                                                              |
| 测试的可信度               | #327：此前测试在 mock 下**绕过 Character**；AgentBus 审计常在无法运行测试的沙箱中给出 PASS | 历史上的许多“测试通过”**低估了生产差异**                | —                                                              |

结论：这些实践是**未来任何持久个体都必须具备的工程知识**（见 [RESEARCH_FOUNDATIONS.md](RESEARCH_FOUNDATIONS.md)），但不能把它们当作连续性假说的实验结果。

### 专题六：需要重新审视的技术选择（摘要，详见 [HISTORICAL_DEBT.md](HISTORICAL_DEBT.md)）

- **Tauri：** 05-10 就写进 `AGENTS.md`（“Future Tauri desktop app”），08-03 落地。它承担透明伴侣窗口、托盘、原生 Host 凭据保管。Windows 上消耗巨大（托盘 Quit、进程所有权）；Linux 上可用。与研究目标基本正交，是“身体”的载体选择，不是研究前提。
- **Mem0：** 没有选择理由的记录；`infer` 一周后被关闭；带来 Python sidecar、打包、崩溃安全投递的大量工程；R5 正在取代它。**属于历史偶然。**
- **L0/L1/L2：** 由 Grok 代理在 08-31 提出。主要动机是上下文预算与成本（当时只有 6 轮/6000 字符），属于**模型窗口与成本限制下的补偿**。“近期原文 + 长期证据”这个二分有价值；“L1 规则摘要”与“Dream 规则整合”属于程序替模型理解的一环。
- **摘要/检索/注入/中间语义层：** Character ABI 的语义 section、A4 规范组装、gate JSON、L1 摘要、P8 关系摘要、Profile 物化、R5 命题级当前认识。前几项是“包装与预解释”；R5 命题级认识是**模型产生的、带来源的派生解释**，方向上更接近你的原则，但仍需检验“派生解释”是否比“原文 + 检索”更好。
- **兼容层与兜底：**
  - legacy/Mem0/R5 三套记忆并存；
  - 规则与 LLM 抽取反复切换；
  - P6 的 Web 与 Runtime 两套权威迁移；
  - CharacterStyle 等旧提示词残留；
  - 多份“当前权威”文档互相引用。

---

## 6. 一句话总结每个阶段学到了什么

| 阶段 | 学到的东西                                                                             |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | 助手式记忆（用户事实 + 规则预解释 + 拒绝日常经历）与研究目标方向相反                   |
| 1    | “证据 ≠ 解释、助手自述 ≠ 权威”很早就成立；外置记忆系统带来的复杂性远大于其被使用的能力 |
| 2    | 计时器 + 门槛 + 一次分类不是自主性；多代理治理会把小问题放大成长期循环                 |
| 3    | 没有消费者的语义合同会大量堆积；为不存在的模型设计边界是浪费                           |
| 4    | 单机 Linux 日常可用是可达的；“谁在对谁说、谁断言了什么”的归因是后续一切的前提          |
| 5    | 可证伪方法很有价值，但不能用它预先关闭研究对象                                         |
| 6    | 地基可以无限延长；伪造归因缺陷证明证据落地确有必要                                     |
| 7    | 模型应看到带作者、按时间排列的原始社会世界，而不是程序的解释框架                       |
| 8    | 生产中的主要智能损失来自程序层的截断、误解与绕过，而非模型本身                         |
| 9    | 事实连续性已可在单机上工程化验证；倾向连续性仍是空白                                   |
