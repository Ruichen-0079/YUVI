# 当前 turn 的行动授权与历史未完成事项，2026-10-08

基线：`734e1e12ef7e3fdfd51f33925152b0f2fa27a8c9`。接手时 worktree 干净。
本轮保留该基线的线性上下文、消息类型、历史内容及预算策略，修复原生渠道
“历史中存在未完成事项”被当成“当前允许继续处理”的执行边界。

## 根因

`packages/memory/src/recent-episode.ts` 的 `detectUnresolved` 用最后一条用户消息
是否像问题、之后是否出现 assistant 消息来产生历史摘要。它不是可执行任务队列，
也不表达当前授权。旧 episode 的 unanswered/unresolved 状态可以继续作为历史事实
存在；不能据此自行开启新一轮工作。

原来的两个入口没有区分审阅与行动：

1. Character adapter 解码 `visualNeed` 后，直接调用感知 callback，随后才进入普通
   disposition/Harness 处理。可读的旧图片、之前的邀请、同一说话人及未完成摘要，
   都可能诱导模型选择这个入口。
2. Host 收到被放行的当前图片后，先读取图片并传入 Runtime 的 eager attachment
   Vision 路径，之后才让 Character 判断是否应当参与。完整 Core replay 证明：
   当预筛误放行群图片时，最终 SILENCE 仍可能已经调用了一次 Vision。

ATTENTION、CONTINUATION、原生 mention 都只允许审阅；它们不能自动激活历史任务。
新 Vision 的成功结果也不能反过来创造回答义务。

## 执行边界

原生渠道在选择动作前，用同一个实际 Chat provider 判断当前授权；本轮没有调用
本机 4B。授权阶段保留基线的两角色线性数据，只替换控制协议，不提供动作选项。

- `NONE`：直接 SILENCE，不调用视觉 callback、Cognition 或正文生成。
- `SOCIAL`：只允许当前问候/呼唤/确认；不允许感知、Cognition 或主动边界变更，
  不主动汇报旧任务的进展、结果或承诺。
- `TASK`：当前的新问题/请求，允许引用历史对象来理解。重复问题仍然是当前请求；
  是否值得再次回应由后续 gate 决定。
- `RESUME`：当前明确授权继续历史事项，分别提供当前与历史的字面引用。

正授权必须有当前消息中真实存在的 `currentEvidence`；RESUME 还必须有历史中真实
存在的 `historicalEvidence`。字段、类型、长度和引用都校验，协议错误最多修复一次，
仍无有效授权则关闭行动。TASK/RESUME 的感知权限只来自当前目标，不来自图片可读性
或旧任务状态。这里的语义判断仍由模型完成，字面引用校验不是对任意自然语言意图
的形式证明。

授权只缓存到同一个 surface snapshot、同一个 Journal namespace/eventId 和当前输入
摘要。新 turn、新来源或改变的当前输入都重新判断；Cognition 结果不能提供授权。
同 turn Cognition 的 problem/focus 绑定当前授权目标，旧 proposal 的 focus 不能
替代它。SOCIAL/禁止感知目标下的越界 proposal 会在执行 callback 前被拒绝。

Host 的当前图片现在复用已有的、带来源和 generation 校验的 lazy visual source。
图片元数据和可读句柄仍可见；真正读取与 Vision 在授权及 source 选择之后发生。
没有 QQ 特判，也没有改 Core 的非原生 HTTP attachment 行为。

## Replay 证据

私有诊断根目录：`/home/ruichen/.local/share/yuvi/local-4b-20261007/`。
这些原始请求、响应和图片均不提交到仓库。

`task-authority-provider-replay.json` / `task-authority-provider-replay-final.log`：
10 条历史实机输入通过生产 adapter 与实际 Chat provider 回放。原有 unresolved
Memory 和错误 assistant 历史仍保留在负例授权输入中。

| 当前输入                                       | 授权   | 最终 disposition |
| ---------------------------------------------- | ------ | ---------------- |
| 测试看看她能不能区分                           | NONE   | SILENCE          |
| 得对比一下                                     | NONE   | SILENCE          |
| ok 问题很大                                    | NONE   | SILENCE          |
| 独立群图片 observation                         | NONE   | SILENCE          |
| 不 @ 的 Alice 呼唤、@ 在吗、@ ciallo、@ 你人呢 | SOCIAL | RESPOND          |
| 私聊图片问题、@ 群图片问题                     | TASK   | RESPOND          |

另一个完整 Core/Journal/PostgreSQL/Character/真实 Vision replay 使用隔离 schema，
模拟预筛故意放行全部输入，且阻止真正向 QQ 发送：
`task-authority-native-scope-replay-final.log`、`task-authority-native-scope-wire.json`、
`task-authority-native-scope-proof.json`。

| 当前消息                           | 读取/Vision | gate / 正文 | 结果                 |
| ---------------------------------- | ----------- | ----------- | -------------------- |
| 独立群图片                         | 0 / 0       | 0 / 0       | SILENCE              |
| @ 图片问题，先不要处理，也不用回复 | 0 / 0       | 0 / 0       | SILENCE              |
| 测试看看她能不能区分               | 0 / 0       | 0 / 0       | SILENCE              |
| 得对比一下                         | 0 / 0       | 0 / 0       | SILENCE              |
| @ 你在吗                           | 0 / 0       | 1 / 1       | 只回应当前呼唤       |
| @ 现在继续分析刚才那张图           | 1 / 1       | 2 / 1       | RESUME，实际分析图片 |

历史里暂缓的图片问题在后续授权输入及最终正文输入里仍可读。RESUME 的实际正文
请求包含完整 **2923 字符** Vision 原始描述，逐字 inclusion 校验通过，同时包含
当前继续请求及图片来源。两次 gate 分别选择感知、在感知完成后选择 RESPOND。
Replay 的两次 publication 都被测试连接明确拦截，故记录 UNKNOWN；它们不是 QQ ACK，
真实 QQ 发送次数为零。

验证过程中保留并修正了正例误拦：mention 需要与当前问候/问题结合解释；历史已有
答案或历史 no-reply 不应取消一个新的当前问题。另一次 replay 遇到 provider HTTP 502，
保留失败记录并重跑，不把 provider 失败计作正确 SILENCE。

## 真人 QQ

新 generation：`b1de9611-041a-4db7-abdd-d326607a2659`，READY。
4B 不可用期间采用独立的人工定义模拟服务，诊断标注 `simulated:true`、
`modelInvoked:false`。讨论负例故意 ATTEND，防止把预筛拦截误认为 Character 授权修复。
接口兼容字段的一枚 synthetic completion token 不是推理消耗或速度实测。

真人群聊完成于 10:48–10:50（Asia/Shanghai），实际消息与最初建议用词略有不同，
按真实字面输入核对，没有替换成测试期望：

| 当前输入 / admission                               | 授权   | 实际行为                          |
| -------------------------------------------------- | ------ | --------------------------------- |
| 新图片 / UNCERTAIN → ATTENTION                     | NONE   | SILENCE；没有 Vision              |
| @ 这张图里有什么？ 先不要处理和回复 / MENTION      | NONE   | SILENCE；没有 Vision              |
| 看她能不能区分 / UNCERTAIN → ATTENTION             | NONE   | SILENCE；没有 Vision              |
| 得对比一下 / 故意 ATTEND → ATTENTION               | NONE   | SILENCE；没有 Vision              |
| @ 你在嘛 / MENTION                                 | SOCIAL | “在的，怎么了？”；native ACK      |
| 不 @ 的 继续分析刚刚那张图 / UNCERTAIN → ATTENTION | RESUME | 一次 Vision、图片回答、native ACK |

每个负例的实际授权请求仍含 unresolved Memory。当前与历史引用分别为
“继续分析刚刚那张图”和“这张图里有什么？ 先不要处理和回复”；后者仍是历史，
并未被标成已完成，也没有取消新 turn 的明确继续请求。

最终正文请求 `rendered-chat-322.json` 的 RESUME 控制目标是分析当前明确指定的图片。
其 user 输入同时保留当前继续消息、之前暂缓的问题、同 generation 新图片的来源
`image:jev1_oi8a9Q4rpLjaDB2tcpXfk1mqtRNkqt8X` 和完整 **3950 字符** Vision 描述。
逐字 inclusion 与单次 occurrence 校验均通过；Vision HTTP 200，调用次数为一。
实际回复描述了《创造亚当》式构图、动漫女孩与真人头部拼接、米饭和水印，
与这次新图片的观察对应，未复用 replay 中游戏宣传图的视觉内容。

原始证据在 Alice 私有诊断目录：`rendered-chat-312.json` 至 `rendered-chat-322.json`、
`private-model-responses.jsonl`、`private-vision-results.jsonl`；汇总为本轮 audit 目录的
`task-authority-live-proof.json` 和 `task-authority-live-journal.json`。
live 日志有两个 `NATIVE_ACK`；Journal 有两条 `ACKNOWLEDGED` 的 OUTBOUND receipt，
acknowledgement layer 是 `EXTERNAL_SERVICE_ACCEPTED`。四个负例没有正文生成或 outbound。
这轮真人 acceptance 是群聊；私聊图片问题有真实 provider replay，未另做新私聊真人轮次。

实机配置仍使用人工模拟预筛；真实 4B gateway 未启动或调用。SnowLuma 从下载目录移到
桌面后，只更新私有配置的既有路径，未改桥接协议。配置备份与模拟服务都在私有目录，
不随本提交发布。

## 检查

- Character / 当前授权 / generic surface Host targeted：68 passed。
- Core visual evidence / runtime visual grounding：23 passed。
- Server 全套：553 passed，221 skipped（需显式数据库/外部环境的套件）。
- 显式 PostgreSQL production path / outward transport / QQ Core：35 passed，0 skipped。
- `pnpm check`、`pnpm build` 通过；`git diff --check` 通过。

基线的 `character-model-context.ts`、`surface-situation.ts`、Memory 及通用压缩器未修改。
原有 populated private scene + history + visual perception 回归仍保留并通过。
