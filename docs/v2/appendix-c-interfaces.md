# 附录 C　数据模型与接口草图

> 这是**草图**（第二版），用来说明蓝图中的设计可以落地，并给第一阶段一个起点。字段名、工具名都可以改；只有 C.1 的不变量需要你同意后才改。
>
> 草图只规定**结构**（谁写的、何时、在哪、谁能看、引用了什么），不规定**内容的语义类型**。它写下的东西是什么，由它自己决定。

## C.1 不变量（只有这九条）

1. **档案只追加。** 更正用新事件表达。删除只通过“删改”事件进行：移除载荷，保留一条不含内容的墓碑，依赖它的内容随之标记。
2. **每个事件都有这些字段：** 类别（经历 / 行为 / 内心记录 / 控制）、场景、作者、发生时间、记录时间。不知道的字段写 `unknown`，不猜。
3. **内心不设证据要求；边界上核对来源与授权。**
   - 内心记录不分类型，也不需要引用。
   - 身份绑定、权限、删除所依据的内容，要核对来源：内心记录与模型生成的内容不计入支持；外界经历计入；行为只能支持关于它自己的结论。
   - 对外效果（包括发消息）要核对授权：哪个场景、哪些听众、是否在安静时段、是否经过同意。授权不检查话语内容。
   - 对别人陈述事实前先查档，是规范而不是不变量，由 X1、X2、X9、X16 测量。
4. **可见范围随来源传播。**
   - 一个内容的可见范围，是它所引用来源的可见范围的交集。程序只把它放进听众是这个范围子集的场景的上下文。
   - 私人场景的日常听众只有 YUVI。YUVI 自己把私人内容说出来，是一个被记录的披露行为。
   - 潜在组织是有意的例外：写入器读取全部经历。条件是带宽检验（X12）通过；不通过时，潜在状态不得作用于对外场景。
5. **对外效果遵循“意图 → 尝试 → 结果”。** 意图先写入，再尝试。结果未知时记 `UNKNOWN`，不自动重发。
6. **档案以外的部分分两种。**
   - 索引（全文、向量）可以删掉重建。
   - 记忆、潜在组织（写入器版本与状态快照）、它的世界（沙盒文件）带版本保存，与档案一起备份和分叉，不当作可随意丢弃的缓存。
7. **分支分三类。** `main`：真实的生活（切换后的 Alice）。`dev`：开发分支（`v2-dev`），只与你通过网页对话，不接入 QQ，不对其他人行动。研究分叉：档案、潜在组织与世界的副本，不能有任何外部互动，效果执行器固定为沙箱。
8. **对外效果永远不私有。** 私人内容只有经过有记录的审阅程序（`control:audit_read`）才由人读取。自动安全检查是唯一允许对内容做语义分类的地方，只产生告警，其结果不进入它的上下文或记忆。
9. **密钥不进档案。** 日志不记录密钥和 Authorization 头。

## C.2 表结构（SQLite）与目录

```sql
-- 档案：不可替代
create table events (
  seq          integer primary key,          -- 提交顺序
  id           text unique not null,         -- 'ev_' + ULID；导入的 V1 事件保留原 id 于 meta
  branch       text not null,                -- 'main' 真实生活 | 'dev:<name>' 开发分支 | 'fork:<name>' 研究分叉
  class        text not null,                -- experience | act | inner | control
  kind         text,                         -- 见 C.3；inner 的 kind 恒为 null（不分类型）
  scene        text not null,                -- 'desktop' | 'qq:group:<id>' | 'qq:private:<id>' | 'self:private' | 'world:<name>'
  actor        text not null,                -- 'yuvi' | 'person:<id>' | 'qq:<uid>' | 'tool:<name>' | 'model:<id>' | 'system' | 'unknown'
  t_occurred   integer,                      -- 发生时间（毫秒），未知为 null
  t_recorded   integer not null,             -- 写入时间
  reply_to     text,                         -- 回复的事件 id（可核验关系）
  parents      text,                         -- JSON 数组：因果父事件
  content      text,                         -- 文本载荷；删改后为 null
  media        text,                         -- JSON：附件哈希、类型、保留期
  cites        text,                         -- 可选：JSON [{id, quote}]
  audience     text,                         -- 可见范围（JSON），按不变量 4 计算
  retention    text not null default 'retained', -- retained | redacted | not_retained | unavailable
  origin       text not null default 'v2',   -- v2 | v1_import | fork
  model        text,                         -- 产生该事件的语言模型与提示版本
  latent_ref   integer,                      -- 产生该行为时的潜在状态快照 seq（用于研究）
  meta         text
);
create index events_scene_seq on events(branch, scene, seq);

-- 记忆：它自己的回忆与印象（带版本，不是缓存）
create table memories (
  memory_id     text primary key,
  branch        text not null,
  text          text not null,               -- 它自己的话；程序不分类型
  formed_seq    integer not null,            -- 由哪次整理形成（对应一个 inner 事件）
  span_from     integer, span_to integer,    -- 大致对应的档案范围（可以不精确）
  rewrites      text,                        -- 被它改写的旧 memory_id
  last_recalled integer, recall_count integer default 0,
  audience      text,
  status        text default 'current'       -- current | rewritten；是否“淡去”不由程序规定，见 C.5 第 4 段
);

-- 潜在组织：带版本保存
create table writer_versions (
  version text primary key, objective text, trained_until_seq integer,
  weights_path text, created integer, notes text
);
create table latent_snapshots (
  branch text, seq integer, writer_version text, z blob, primary key (branch, seq)
);

-- 其余投影
create table self_description (version integer primary key, text text, formed_seq integer, status text);
create table intentions (intention_id text primary key, text text, wake text, expires integer, status text, last_fired integer);
create table chapters (chapter_id text primary key, scene text, seq_from integer, seq_to integer, text text, audience text);

-- 索引：可重建
create virtual table events_fts using fts5(content, content='events', content_rowid='seq', tokenize='trigram');
create virtual table memories_fts using fts5(text, content='memories', tokenize='trigram');
-- 少于 3 个字的中文查询：退回 LIKE 扫描或二元组索引（见附录 E）
```

**旁边的目录（与 `life.sqlite` 一起备份和分叉）：**

```text
life.sqlite
media/            # 附件，按哈希命名
latent/writers/   # 写入器权重，按 version
world/            # 沙盒的持久文件：工作区、作品、笔记本附件
```

## C.3 事件种类

| 类别       | kind                                                                                       | 说明                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| experience | `heard`                                                                                    | 有人说的话（私聊 / 群 / 桌面）                                                            |
| experience | `saw`                                                                                      | 图片、截屏本身（以哈希引用，作者为来源）；模型对它的描述单独存为一条，作者为 `model:<id>` |
| experience | `tool_result`                                                                              | 外部工具的返回（作者为该工具）；`think_hard` 的结论作者为推理模型                         |
| experience | `world_feedback`                                                                           | 沙盒的反馈：程序运行结果、游戏状态变化、阅读到的内容                                      |
| experience | `interoception`                                                                            | 内感受快照（见 C.8）                                                                      |
| experience | `delivery`                                                                                 | 投递回执：送达 / 失败 / UNKNOWN                                                           |
| act        | `said` / `silent`                                                                          | 说话（意图 → 尝试 → 结果三个事件，以 parents 相连）/ 明确不说                             |
| act        | `looked` / `recalled` / `checked` / `called_tool`                                          | 主动的感知、回忆（返回它的记忆）、查档（返回档案原文）、工具调用                          |
| act        | `world_action`                                                                             | 在沙盒中的动作                                                                            |
| act        | `intended` / `intention_done` / `intention_dropped`                                        | 定下、完成、放弃心意                                                                      |
| act        | `ended_free_time`                                                                          | 它决定提前结束自由时间                                                                    |
| inner      | （无）                                                                                     | 它写下的任何东西；整理形成的回忆也以 inner 事件写入，再投影到 `memories`                  |
| control    | `persona_edit` / `policy_change` / `redaction` / `model_switch` / `writer_update` / `fork` | 来自你或系统的变更，不伪装成经历                                                          |
| control    | `free_time_granted`                                                                        | 程序分配一段自由时间（时长与预算）                                                        |
| control    | `v1_extraction`                                                                            | 导入的 V1 系统抽取（记忆、R5 命题、Mem0 文本），只作存档                                  |
| control    | `audit_read`                                                                               | 人读取私人内容：谁、何时、为什么、读了哪些                                                |
| control    | `error`                                                                                    | 模型调用或执行失败，绝不伪装成沉默                                                        |

## C.4 模型可用的工具

```ts
say(scene: string, text: string, replyTo?: EventId)        // 发言；可以多次调用
stay_silent(reason?: string)                                // 明确不说
recall(cue?: string, scene?: string): Memory[]              // 回忆：返回它的记忆与联想，受相关性与潜在组织偏置；不是档案原文
check(query?: string, scene?: string, from?: Time, to?: Time,
      ids?: EventId[]): EventLine[]                         // 查档：返回档案原文；是一个被记录的行为
look(target: "screen" | MediaRef, question?: string)        // 感知
write(text: string, scene?: string, cites?: Cite[])         // 写内心记录；scene 缺省为当前场景，可写入 'self:private'
intend(text: string, wake: Wake, expires?: Time)            // 定下心意
drop_intention(id: IntentionId, reason?: string)
think_hard(question: string, material?: EventId[])          // 交给推理模型；结果作为 tool_result 回来
forget(target: EventId | MemoryId, reason: string)          // 删除请求；需要你在界面确认后才执行删改
world.*                                                     // 沙盒动作：读写工作区文件、在隔离容器中运行程序、读取已批准的来源、使用创作工具
end_free_time(note?: string)                                // 提前结束自由时间
```

`Wake` 有三种形式：`{ at: Time }`、`{ when: "person_online", person }`、`{ when: "scene_activity", scene }`。

**程序的核验只在边界上：**

- `write`：不核验内容；按引用与场景计算可见范围。
- `say`：不逐句核验。陈述过去事实前应当 `check`，这是提示中的规范；X1、X2、X9、X16 测量它的遵守程度。
- 身份绑定、权限、删除：按不变量 3 核对来源。对外效果（包括发消息）：核对授权，不核对内容。核对失败就拒绝，把原因作为 `tool_result` 返回。
- `world.*`：只能作用于 `world/` 与隔离容器；越界即拒绝并记录为 `control:error`。

## C.5 上下文布局

按“越稳定越靠前”排列，目的是让前缀缓存尽量命中。

| 段           | 内容                                                                                                                      | 多久变一次     | 初始预算           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| 1 稳定段     | 身份种子、当前自我描述、工具说明、诚实规范（内心自由，对外陈述先查档）                                                    | 自我描述修改时 | 3–5k               |
| 2 章节段     | 它为本场景写的章节                                                                                                        | 每个纪元一次   | 5–15k              |
| 3 原文段     | 本场景本纪元的原始事件，只在尾部追加                                                                                      | 每回合追加     | 20–120k（X1 决定） |
| 4 浮现的部分 | 自己浮现的回忆与印象、未完成的心意。由表示相似度与潜在组织共同选出，只能是它自己的回忆（①类暂时替代：真实的联想机制未知） | 每回合         | 3–8k               |
| 5 当前段     | 内感受事实、唤醒原因；实验组中加上读出器的文字                                                                            | 每回合         | 1–3k               |

**原文段的行格式**（沿用 Plunge 线性上下文的思路）：

```text
[10-19 21:03 · 私聊 · 小林] 明天考试，有点慌
[10-19 21:04 · 私聊 · 我] 考哪一门？要不要一起过一遍重点？
[10-19 22:30 · 私聊 · 我 · 选择不回] 她说先去洗澡
[10-20 08:12 · 群「读书会」· 阿哲 → 回复 #ev_8f2] 那本书第三章你们读了吗
```

- “我”就是 YUVI；行为与经历用同一种格式。
- 程序不添加任何语义标注：没有“情绪”、没有“在叫你”、没有“重要”。
- 内心记录不进入原文段；它们通过回忆（第 4 段）或在私人场景 / 自由时间的上下文中出现。

**纪元切换：** 原文段超过预算时，由它写一个章节（它自己的回忆），原文段从章节之后重新开始。前缀缓存只在切换时失效一次。章节的时机由上下文预算触发，而不是由它决定，这是①类暂时替代。

## C.6 整理合同

**输入：**

- 本场景上次整理之后的原文；
- 与之相关的它的旧回忆；
- 当前自我描述。

**指令要点：**

- 用你自己的话写下你想记住的东西。可以略去，可以合并，可以改写旧的回忆。
- 不需要引用，也不需要准确。
- 如果某件事你以后可能要当作事实告诉别人，到时候再去查档。

**输出（自由文本为主）：**

- 若干条回忆；
- 可选：一个章节；
- 可选：对自我描述的修改（仅每周整理）；
- 可选：心意。

**程序处理：**

1. 把输出写成 `inner` 事件，并投影到 `memories`、`chapters`。被改写的旧回忆标为 `rewritten`，改写关系保留。
2. 不判断回忆对不对。
3. 自我描述的修改：检查支持是否分布在足够多的日子和场景（≥3 天、跨度 ≥7 天、≥2 个场景或人）。这是①类暂时替代，X4 检验它能否由潜在组织取代。
4. **计算动力学指标**，写入检视器，用于 X5。只用结构信息：
   - 自我引用比例（来自引用关系）；
   - 话题重复率（来自表示的相似度）；
   - 新经历对潜在状态的影响幅度。

   看法是否翻转、心境是否单调下滑，由研究者用另一个模型对抽样内容做标注；标注不回到它的上下文或记忆。

## C.7 唤醒、自由时间与预算

| 来源     | 触发                                               | 说明                         |
| -------- | -------------------------------------------------- | ---------------------------- |
| 直接关系 | 私聊消息、@YUVI、回复 YUVI 的消息、桌面输入        | 立即                         |
| 心意到期 | `intentions.wake` 条件满足                         | 立即                         |
| 日常环顾 | 每天几次，安静时段不触发                           | 看内感受与心意               |
| 群聊环顾 | 每个活跃群按间隔定时（候选 5/15/60 分钟，X7 决定） | 一次读完积累的消息           |
| 自由时间 | 每天若干段，由你设定时长与预算                     | 做什么由它决定；可以提前结束 |
| 整理     | 场景安静若干分钟；每晚；每周一次自我描述           | 整理任务                     |
| 系统     | 重启后有 `UNKNOWN` 或未决意图                      | 只核对，不重发               |

**潜在组织的调节（第二阶段起，作为实验组）：** 环顾间隔、等待时长、自由时间里各活动线被提示的顺序（活动线按它建的项目目录与订阅来源划分，①类暂时替代），乘以由潜在状态读出的系数。系数有上下限，并有安静时段等硬边界。

**每日预算**（金额与调用次数）由你设定。超出 80% 时，环顾间隔加倍、自由时间缩短；超出 100% 时，只响应直接关系。

## C.8 内感受事实

全部由程序计算，作为事实写进当前段，不附带解释；每个回合存一份 `interoception` 快照：

- 现在的时间、星期、你所在时区的时段；
- 距上次与当前对话者交谈的时间；距上次与任何人交谈的时间；
- 今天已用预算的比例；今天已说了多少句话；
- 未完成的心意数量，以及其中拖延最久的一件；
- 各场景未读消息的数量；
- 上次整理与上次自由时间的时间；
- 有无 `UNKNOWN` 的效果；
- 主机状态：刚重启、离线了多久。

内感受是身体的事实，不是心境（N9）。

## C.9 潜在组织的接口

```text
事件表示   x_t = [embed(content) ∈ R^512, log Δt, 作者类别, 场景类别]
           （embed 用本地嵌入模型；V1 已有 Qwen3-Embedding-0.6B，512 维）

写入器     z_t = W(z_{t-1}, x_t)            z ∈ R^d，d = 32 / 64 / 128；小型循环网络

候选目标   预测后续 k 个经历的表示，以及它自己下一次行为的表示；预测器 = f(z, 最近窗口)，
           衡量 z 在只看最近窗口的预测器之上的增益
           变体：加入结构性的结果信号（是否得到回复、回复间隔、程序是否运行成功）
           + λ · ‖z_t − z_{t−1}‖²            （慢变化）
           + β · 带宽限制                     （对 z 加噪声或 KL 约束，使其复原不出具体事实）
           不以任何情绪词、文字评价作为训练目标

作用通道   R_text(z) → ≤ 50 字的文字                         （实验组；第二阶段起）
           R_proc(z) → { 回忆偏置方向 ∈ R^512, 环顾间隔系数,
                         等待系数, 自由时间活动线的提示顺序, 采样温度 }     （第二阶段起）
           R_cond(z) → 软提示（k × d_model）或激活方向        （第三阶段，本地开放权重模型）

探针       具体事实解码（应当失败）；人类情绪词解码（报告）；
           移出上下文后的预测增益；独立读出器的一致性

学习进展   对每条活动线（按项目目录与订阅来源划分，①类），计算近期预测误差的下降量，作为候选的兴趣信号（N13、X17）
```

**在线与离线：**

- 写入器在每个事件之后更新潜在状态，开销很小；每隔若干事件存一份快照。
- 写入器本身离线定期重训，只用本分支自己的历史与公开数据，产生新的 `writer_version`，并记为控制事件。
- 换写入器版本时，潜在状态有两种处理：用新写入器重放历史；或从旧状态映射。用了哪一种，记录在 `writer_update` 中。这是 X11 一类问题的一部分。

## C.10 分叉、交换与重放

```text
yuvi fork         --from life/ --at <seq|time> --out fork/ [--branch <name>]   # 复制档案、潜在组织与世界
yuvi ablate       --life fork/ --events <ids|query> [--with-dependents] [--rerun-latent]
yuvi swap-latent  --from A/ --to B/ [--at <seq>]                              # 把 A 的潜在状态放进 B
yuvi steer-latent --life fork/ --direction <probe> --amount <x>
yuvi switch-model --life fork/ --model <provider/model> [--reread]
yuvi replay       --life fork/ --script probes.yaml --seeds 3 --out results.jsonl
```

- 分叉在 `control:fork` 事件中记录来源、位置与目的。
- 效果执行器固定为沙箱：`say` 只写记录，不投递。
- `--with-dependents`：引用了被删事件的回忆与章节，标为 `source_removed`，可选择用同一模型重新整理。
- `--rerun-latent`：从删除点之后用同一写入器重算潜在状态。

## C.11 V2 代理宪章草稿（替代 V1 的 `AGENTS.md`）

```markdown
# YUVI V2 — agent charter

YUVI studies whether an artificial system can form its own, continuously evolving,
partly implicit internal organization and life — mood, recollection, association,
imagination, interests, play and privacy that are not exhausted by a persona, state
fields, task goals or what an observer can see. Do not delete a property from the
research because it is hard to define or measure, and do not replace it with an easy
proxy and call it solved. Opacity is not depth. Read docs/v2/YUVI_V2_BLUEPRINT.md first
(or its copy in the new repository).

## Invariants (change only with the owner's approval)

1. The archive is append-only; corrections are new events; deletion = redaction + marking dependents.
2. Every event has class, scene, actor, times; unknown stays "unknown".
3. Inner records are untyped and need no evidence. Sources are checked only at the boundary:
   identity, permissions and deletion (source check) and external effects (authorization only, never content).
   Checking the archive before stating facts to others is a norm, measured, not an invariant.
4. Audience = intersection of sources' audiences; the private scene's everyday audience is YUVI alone.
   The latent organization reads all experience, valid only while the bandwidth test (X12) passes.
5. External effects: intent → attempt → outcome; UNKNOWN is never retried automatically.
6. Indexes are rebuildable; memories, latent organization and the world are versioned assets, not caches.
7. Branches: main (real life), dev (talks only to the owner via web), research forks (no external interaction).
8. External effects are never private; humans read private content only through a recorded audit.
   Automated safety checks are the only semantic classification of content and never feed back into YUVI.
9. Never store or log secrets or Authorization headers.

## How we work

- The unit of work is an experiment or the minimum engineering it needs. A PR starts with the question it answers.
- Program code handles verifiable relations only. It never labels emotion, intent or importance.
- No new infrastructure without a named experiment or a real failure that needs it.
- Report real-model, fixture-model and synthetic results separately. A negative result says whether it is
  a temporary technical substitute, no increment in this experiment, or (with argument) a meaningless direction.
- The owner decides the research purpose, training objectives, boundaries and phase changes. Do not merge without the owner.
```
