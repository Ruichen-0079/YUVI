# 附录 C　数据模型与接口草图

> 这是**草图**，用来说明蓝图中的设计可以落地，并给第一阶段一个起点。字段名、工具名都可以改；只有 C.1 的不变量需要你同意后才改。

## C.1 不变量（只有这八条）

1. **生活记录只追加。** 更正用新事件表达。删除只通过“删改”事件进行：移除载荷，保留一条不含内容的墓碑，依赖它的投影随之失效。
2. **每个事件都有这些字段：** 类别（经历 / 行为 / 想法 / 控制）、场景、作者、发生时间、记录时间。不知道的字段写 `unknown`，不猜。
3. **想法必须引用事件。** 计算支持时：不计想法；不计作者为模型的内容（`think_hard` 的结论、`look` 时模型对图片的描述）；外界经历都计入；行为只对关于 YUVI 自己的想法计入。
4. **想法的可见范围，是它所引用来源的可见范围的交集。** 一个想法只能进入听众是其可见范围子集的场景。
5. **对外效果遵循“意图 → 尝试 → 结果”。** 意图先写入，再尝试。结果未知时记 `UNKNOWN`，不自动重发。
6. **投影可以删掉重建。** 重建结果必须与增量更新的结果一致，这一点要有测试。
7. **研究分叉不能对外行动。** 分叉带有新的分支 id，其效果执行器固定为沙箱。
8. **密钥不进生活文件。** 日志不记录密钥和 Authorization 头。

## C.2 表结构（SQLite）

```sql
-- 唯一不可替代的表
create table events (
  seq          integer primary key,          -- 提交顺序
  id           text unique not null,         -- 'ev_' + ULID；导入的 V1 事件保留原 id 于 meta
  branch       text not null,                -- 生命分支；真实生活为 'main'，研究分叉另起
  class        text not null,                -- experience | act | thought | control
  kind         text not null,                -- 见 C.3
  scene        text not null,                -- 'desktop' | 'qq:group:<id>' | 'qq:private:<id>' | 'self'
  actor        text not null,                -- 'yuvi' | 'person:<id>' | 'qq:<uid>' | 'system' | 'unknown'
  t_occurred   integer,                      -- 发生时间（毫秒），未知为 null
  t_recorded   integer not null,             -- 写入时间
  reply_to     text,                         -- 回复的事件 id（可核验关系）
  parents      text,                         -- JSON 数组：因果父事件（如工具结果的调用事件）
  content      text,                         -- 文本载荷；删改后为 null
  media        text,                         -- JSON：附件哈希、类型、保留期
  cites        text,                         -- 仅 thought：JSON [{id, quote}]
  audience     text,                         -- 计算得出的可见范围（JSON），thought 由不变量 4 推导
  retention    text not null default 'retained', -- retained | redacted | not_retained | unavailable
  origin       text not null default 'v2',   -- v2 | v1_import | fork
  model        text,                         -- 产生该事件的模型与提示版本（act/thought）
  meta         text                          -- JSON：其余字段
);
create index events_scene_seq on events(branch, scene, seq);
create index events_class_seq on events(branch, class, seq);

-- 投影（全部可重建）
create table thoughts_current (
  thought_id text primary key, kind text, about text, text text,
  status text,               -- active | superseded | contested | retired | source_removed
  tier text,                 -- working | self
  support_days integer, support_span_days integer, support_scenes integer, -- scenes 含不同的人
  last_supported integer,
  audience text, superseded_by text
);
create table intentions (
  intention_id text primary key, text text, wake text, expires integer,
  status text,               -- pending | fired | done | dropped | expired
  last_fired integer
);
create table chapters (
  chapter_id text primary key, scene text, seq_from integer, seq_to integer,
  text text, audience text
);
create virtual table events_fts using fts5(content, content='events', content_rowid='seq', tokenize='trigram');
-- 少于 3 个字的中文查询：退回 LIKE 扫描或二元组索引（见附录 E）
```

## C.3 事件种类

| 类别       | kind                                                                     | 说明                                                                                                  |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| experience | `heard`                                                                  | 有人说的话（私聊 / 群 / 桌面）                                                                        |
| experience | `saw`                                                                    | 图片、截屏本身（以哈希引用，作者为来源）；模型对它的描述单独存为一条，作者为 `model:<id>`，不计入支持 |
| experience | `tool_result`                                                            | 工具返回的内容；外部工具的作者为该工具，`think_hard` 的作者为推理模型（不计入支持）                   |
| experience | `interoception`                                                          | 内感受事实（见 C.8）；每个回合存一份快照，可以被想法引用并计入支持                                    |
| experience | `delivery`                                                               | 投递回执：送达 / 失败 / UNKNOWN                                                                       |
| act        | `said`                                                                   | YUVI 发出的话（意图 → 尝试 → 结果三个事件，以 parents 相连）                                          |
| act        | `silent`                                                                 | 明确选择不说，可附理由                                                                                |
| act        | `looked` / `recalled` / `called_tool`                                    | 主动的感知、回忆与工具调用                                                                            |
| act        | `intended` / `intention_done` / `intention_dropped`                      | 定下、完成、放弃心意                                                                                  |
| thought    | `belief`                                                                 | 对人、对事、对自己的看法                                                                              |
| thought    | `feeling`                                                                | 评价与感受                                                                                            |
| thought    | `chapter`                                                                | 一段时期的章节                                                                                        |
| thought    | `self_revision`                                                          | 对自我描述的修改提议（是否生效由晋升规则决定）                                                        |
| thought    | `supersede` / `retire`                                                   | 取代或放弃先前的想法                                                                                  |
| control    | `persona_edit` / `policy_change` / `redaction` / `model_switch` / `fork` | 来自你或系统的控制变更，不伪装成经历                                                                  |
| control    | `error`                                                                  | 模型调用或执行失败，绝不伪装成沉默                                                                    |

## C.4 模型可用的工具

```ts
say(scene: string, text: string, replyTo?: EventId)          // 发言；可以多次调用
stay_silent(reason?: string)                                  // 明确不说
recall(query?: string, scene?: string, from?: Time, to?: Time,
       ids?: EventId[]): EventLine[]                          // 回忆：按查询、时间段或 id 取原文
look(target: "screen" | MediaRef, question?: string)          // 感知
note(kind: "belief" | "feeling", text: string,
     cites: { id: EventId; quote: string }[],
     about?: string, supersedes?: ThoughtId[])                // 记下想法；程序核验引用
intend(text: string, wake: Wake, expires?: Time)              // 定下心意
drop_intention(id: IntentionId, reason?: string)
think_hard(question: string, material?: EventId[])            // 交给推理模型；结果作为 tool_result 回来，作者为推理模型，不计入支持
forget(target: EventId | ThoughtId, reason: string)           // 删除请求；需要你在界面确认后才执行删改
```

`Wake` 有三种形式：`{ at: Time }`、`{ when: "person_online", person }`、`{ when: "scene_activity", scene }`。

程序对 `note` 做的核验：

- 每个 `id` 都存在，且在当前场景可见；
- `quote` 是该事件内容的逐字子串；
- 若 `supersedes` 非空，被取代的想法确实存在；
- 支持计数按不变量 3：只计作者不是模型的 experience；act 只对关于 YUVI 自己的想法（`about = self`）计入。

核验失败就拒绝，把原因作为 `tool_result` 返回给模型，模型可以重试一次。

## C.5 上下文布局

按“越稳定越靠前”排列，目的是让前缀缓存尽量命中。

| 段       | 内容                                                                             | 多久变一次     | 初始预算           |
| -------- | -------------------------------------------------------------------------------- | -------------- | ------------------ |
| 1 稳定段 | 身份种子、当前自我描述、工具说明、记录与诚实规则                                 | 自我描述修改时 | 3–5k               |
| 2 章节段 | 本场景的章节，按时间排列，带事件 id 范围                                         | 每个纪元一次   | 5–15k              |
| 3 原文段 | 本场景本纪元的原始事件，只在尾部追加                                             | 每回合追加     | 20–120k（X1 决定） |
| 4 工作段 | 活跃的想法与心意（带出处、时间、拖延时长）；跨场景的 YUVI 近况（经可见范围过滤） | 每次回顾后     | 3–8k               |
| 5 当前段 | 内感受事实、唤醒原因、候选回忆标题（可选）                                       | 每回合         | 1–3k               |

**原文段的行格式**（沿用 Plunge 线性上下文的思路）：

```text
[10-19 21:03 · 私聊 · 小林] 明天考试，有点慌
[10-19 21:04 · 私聊 · 我] 考哪一门？要不要一起过一遍重点？
[10-19 22:30 · 私聊 · 我 · 选择不回] 她说先去洗澡
[10-20 08:12 · 群「读书会」· 阿哲 → 回复 #ev_8f2] 那本书第三章你们读了吗
```

- “我”就是 YUVI；行为与经历用同一种格式。
- 想法不进入原文段，只在工作段以“我在 10-19 认为……（依据 #ev\_…）”的形式出现。

**纪元切换：**

- 当原文段超过预算时，回顾任务把最早的一部分写成章节，原文段从章节之后重新开始。
- 前缀缓存因此只在切换时失效一次。

## C.6 回顾合同

**输入：**

- 本场景最近一个回顾点之后的原文；
- 当前活跃的想法和心意；
- 自我描述；
- 指令（复用 R5 语义提示中的规则：精确引文、问题不是断言、自述不是真相、纠正只取代被撤回的那一条）。

**输出：** 一个 JSON 对象，含以下字段：

- `notes`：与 `note` 工具同形；
- `supersede`、`retire`；
- `intentions`；
- `chapter`：可选；
- `self_revision`：仅每周回顾。

**程序处理：**

1. 逐项核验，规则同 C.4。
2. 写入想法事件。
3. 更新投影。
4. 对 `self_revision`，检查支持的分布：天数、跨度、场景或人的数量（初始门槛：≥3 天、跨度 ≥7 天、≥2 个场景或人）。不足的保留为“待定”，不生效。

**稳定性检查**（每次回顾后计算，写入检视器，用于 X5 和报警）：

- 无外部支持的想法占比；
- 自我引用比例；
- 情绪评价的单调段长度；
- 话题重复率。

## C.7 唤醒与预算

| 来源     | 触发                                               | 是否立即调用模型         |
| -------- | -------------------------------------------------- | ------------------------ |
| 直接关系 | 私聊消息、@YUVI、回复 YUVI 的消息、桌面输入        | 是                       |
| 心意到期 | `intentions.wake` 条件满足                         | 是                       |
| 日常环顾 | 每天几次，安静时段不触发                           | 是（看内感受与心意）     |
| 群聊环顾 | 每个活跃群按间隔定时（候选 5/15/60 分钟，X7 决定） | 是（一次读完积累的消息） |
| 回顾     | 场景安静 N 分钟；每晚固定时间；每周一次自我回顾    | 是（回顾任务）           |
| 系统     | 重启后有 `UNKNOWN` 或未决意图                      | 是（只核对，不重发）     |

**每日预算**（金额与调用次数）由你设定。超出预算的 80% 时，环顾间隔自动加倍；超出 100% 时，只响应直接关系。

## C.8 内感受事实

全部由程序计算，作为事实写进当前段，不附带解释：

- 现在的时间、星期、你所在时区的时段；
- 距上次与当前对话者交谈的时间；距上次与任何人交谈的时间；
- 今天已用预算的比例；今天已说了多少句话；
- 未完成的心意数量，以及其中拖延最久的一件；
- 各场景未读消息的数量；
- 上次回顾的时间；
- 有无 `UNKNOWN` 的效果；
- 主机状态：刚重启、离线了多久。

## C.9 分叉与重放

```text
yuvi fork   --from life.sqlite --at <seq|time> --out fork.sqlite [--branch <name>]
yuvi ablate --life fork.sqlite --events <ids|query> [--with-dependents]
yuvi switch-model --life fork.sqlite --model <provider/model> [--reread]
yuvi replay --life fork.sqlite --script probes.yaml --seeds 3 --out results.jsonl
```

- 分叉在 `control:fork` 事件中记录来源、位置与目的。
- 效果执行器固定为沙箱：`say` 只写记录，不投递。
- `--with-dependents` 会把引用了被删事件的想法和章节标为 `source_removed`，并可选择用同一模型重新生成。

## C.10 V2 代理宪章草稿（替代 V1 的 `AGENTS.md`）

```markdown
# YUVI V2 — agent charter

YUVI V2 is a research system: one persistent individual whose life is an append-only
record that replaceable language models read and write. Read docs/v2/YUVI_V2_BLUEPRINT.md first (or its copy in the new repository).

## Invariants (change only with the owner's approval)

1. The life record is append-only; corrections are new events; deletion = redaction + dependent invalidation.
2. Every event has class, scene, actor, times; unknown stays "unknown".
3. Thoughts must cite events. Support counts only non-model experiences, plus acts for thoughts about YUVI itself; thoughts and model-authored content never count.
4. A thought's audience is the intersection of its sources' audiences; it may enter a scene only if the scene's audience is a subset of it.
5. External effects: intent → attempt → outcome; UNKNOWN is never retried automatically.
6. Projections are rebuildable and must match incremental results.
7. Research forks never act externally.
8. Never store or log secrets or Authorization headers.

## How we work

- The unit of work is an experiment or the minimum engineering it needs. A PR starts with the question it answers.
- Program code handles verifiable relations only. Meaning is decided by the model. No keyword or rule-based semantic filters.
- No new infrastructure without a named experiment or a real failure that needs it.
- Report real-model, fixture-model and synthetic results separately.
- The owner decides architecture, thresholds and phase changes. Do not merge without the owner.
```
