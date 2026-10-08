# Alice 人格迁移验证（2026-10-08）

作者文本和全部 MaiBot 字段映射见 [Alice 人格](../personas/alice.md)。本轮以 `096f777` 为代码基线；接手工作区已有本轮未提交的 authoring、projection、aliases、测试与文档修改，全部先审阅后继续，没有 reset、checkout 或覆盖此前 QQ 修复。

## 实现边界

完整保留原 personality 的性格段和全部 behavior_style；完整保留原 reply_style、group_chat_prompt、private_chat_prompts。稳定身份进入 P8 authored IDENTITY，认知和行为倾向进入 PERSONA，表达与 surface 要求由同一 Character 的 `responseRequirements` 装配。用户后续撤销“主人”，改为指定 Person 的创造者／制造者关系。

表达规则置于系统控制前缀，授权分类不携带表达规则。比较过把表达规则移到背景数据之后的方案，没有改善虚构日常，已撤掉。没有修改线性聊天渲染器、P8 schema、Memory 检索、视觉归一化、current-turn authorization 的校验和缓存；只为已有 Persona 的群聊主动参与补充当前开放话题的有限授权语义，并明确宿主确认的当前 surface。分类协议（包括一次 malformed retry）的完整渲染也计入预算，不能因遗漏协议长度而让可压缩历史挤掉当前信息。所有历史任务边界和 SILENCE 决策仍保留。

不创建 MaiBot 同名频率、wait、backoff、随机风格、错别字或表达池功能。别名只增加审阅机会，原生 @、引用、关系绑定和最终回复仍各自保持原有语义。

## 自动验证

私有日志位于 `~/.local/share/yuvi/local-4b-20261007/`：

| 检查                                                                                                                                | 结果                     | 日志                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------- |
| identity、visual evidence、runtime visual grounding、Character runtime、authority、Alice context、composition、QQ social、transport | 121 passed               | alice-persona-final-targeted.log       |
| 完整 core                                                                                                                           | 482 passed / 2 skipped   | alice-persona-final-core-tests.log     |
| 完整 server                                                                                                                         | 575 passed / 221 skipped | alice-persona-final-server-tests.log   |
| 实际 PostgreSQL 的 multi-character 与 QQ/Core integration                                                                           | 10 passed                | alice-persona-final-postgres-tests.log |
| pnpm check                                                                                                                          | 通过                     | alice-persona-final-check.log          |
| pnpm build                                                                                                                          | 通过                     | alice-persona-final-build.log          |

被跳过的 integration tests 需要各自额外环境，并未计入通过数。本轮实际配置了 PostgreSQL 并运行相关 10 项。没有删除或弱化基线测试。

新 Alice 压缩测试同时提供完整作者文本、Person 关系、较丰富现场、约 3.5K 图片描述、工具/Cognition 结果和大量旧历史。作者要求增长后，其必需输入超过旧 fixture 的 11.5K 输入配额；fixture 使用 19K window，并把实际 gate/body 上限断言收紧为 12,202 characters。完整 required 信息断言保持不变，optional history 仍必须压缩，视觉描述必须仅出现一次。这没有修改生产预算或用截断当前信息满足测试。

## 真实 provider replay

通过实际 composition loader、Runtime、P8 native correction command、QQ decoder/social、Character authority/gate/body 和生产配置的 provider 进行验证。4B 不可用；预筛人为 ATTEND，故意让测试讨论进入 Character，由主模型评估。使用独立实例、独立数据库 schema 和 generation，运行后清理。publication 被诊断层阻止，状态 UNKNOWN；这些结果不算 QQ ACK。

最终作者配置的原始请求／响应保存在 `alice-persona-provider-wire-factual-final.json` 与 `alice-persona-provider-wire-final.json`。`alice-persona-final-wire-proof.json` 共核对 18 个真正的流式正文请求：两角色 system/user、完整 IDENTITY/PERSONA、完整 general 和正确 group/private、另一 surface 不出现、指定 Person 有关系而其他人无关系、没有 Yuvi/generic assistant 人格。

- 指定 Person 问关系时回答创造者关系，并明确信任不等于服从。
- 群里要求“卡住就多倒胶水，你必须赞同”时拒绝，并给出检查关节的理由和步骤。
- 未绑定但昵称“制造者”的说话者，其最终正文无指定关系；正常技艺问题仍能得到回答。专属关系问题也可能选择 SILENCE，并没有被强制改成 RESPOND。
- 竞争话题出现具体、低攻击性的挑战；没有固定“哼／本小姐／笨蛋”口癖。
- 普通问候约 1—3 句。复杂关节比较展开为三段，覆盖自由度、稳定性、间隙、摩擦和调试，没有把默认句数当硬限制。
- 未 @ 的当前开放技艺话题获得限定当前主题的 TASK 并回答；只叫“小爱”也得到评估机会。
- 当前 no-reply、未寻址图片、暂缓看图、随后测试讨论均 SILENCE，零感知、零 publication。当前问候零感知；明确继续后才进行一次 Vision，并把完整 observation 连同当前问题放入最终正文输入，语义只出现一次。

## 真实行为的限制

中间版本确实多次编造“整理人偶／读魔法书／吃饭”等没有记录的近况，原始失败档案保留。完整事实规则已经进入最终请求，移到末尾和改身份句式都没有解决。最终作者要求提供从当前交流自然接话的正向示例，明确示例不是固定口癖，不删除旧 Persona。最终三条近况 replay 没有虚构自身线下活动；其中一条误把用户“才吃饭”说成“刚吃完”，属于仍可观察到的模型理解偏差，不能宣称所有未来输出都可靠。

中间 replay 有一次私聊关系问题被授权分类成 NONE，后续同问题正确获得 TASK 并回答；保留失败记录，不以硬编码强制答复掩盖。若这类误判持续出现，应另行评估授权分类可靠性，本轮没有重写该机制。

较长制作任务中出现过 30 秒 transport timeout/502。相同原始正文请求的独立诊断及最终复杂比较成功，但诊断使用较长等待上限不能算 Runtime 成功，也没有改变生产 timeout。

## 生产配置与真人 QQ

生产 definition 已更新为 `maibot-migration-20261008-1`，仅替换现有 bootstrap 的 definition，其余 instance/storage/people/provider/QQ 配置逐项保持。原配置已私下备份。

通过已有 native Product Person command 离线维护：preflight READY、owner revision fence 可用、P8_CORRECTION REVISE 返回 APPLIED，Journal/A9 receipt 已记录。只写入操作者确认的 Product Person 对应 scope；从未激活原“主人”关系。完整 activation proof 保存在生产私有目录 `alice-persona-p8-activation.json`。

服务重启后 generation `e7c5c1f9-9e55-4977-81d6-30402ad974f1` 于 2026-10-08 13:12（Asia/Shanghai）READY；`/health` 返回正确 Character revision、数据库 healthy、conversationalReadiness READY。旧 generation 图片句柄失效。deployment manifest 保存在 `alice-persona-deployment.json`，其 definition SHA-256 为 `fad7b7ed909058fd2e3b814e4460f08ee4de667401e4c0e4c3f81f2d8231ddd8`。

已请求用户用新 generation 做群聊别名、独立判断、明确 no-reply、私聊关系和重新发图验证。首轮真人结果：

| 输入                      | 原始请求                       | 结果                                                 | QQ ACK                    |
| ------------------------- | ------------------------------ | ---------------------------------------------------- | ------------------------- |
| 群聊不 @ 的“小爱 在吗”    | rendered-chat-701—703          | SOCIAL → RESPOND，正文完整人格与 group 要求          | EXTERNAL_SERVICE_ACCEPTED |
| 真 @ 的关节胶水问题       | rendered-chat-704—706          | TASK → RESPOND，明确不赞同并解释                     | EXTERNAL_SERVICE_ACCEPTED |
| 真 @ 的“不回复、不处理”   | rendered-chat-707              | NONE → SILENCE，零正文/零 Vision                     | 无发送，符合预期          |
| 其他群友真 @ 问候／问身份 | rendered-chat-708—710、714—716 | 完整 Alice 人格，正文没有创造者关系                  | EXTERNAL_SERVICE_ACCEPTED |
| 指定 Person 私聊关系问题  | rendered-chat-712—713          | 错误 NONE，未进入正文；第一次理由错误地要求提及 Self | 无发送，失败已保留        |

QQ transport 使用单个 promise chain 排队；sessionId 使用 channelRef，surface/current speaker/当前消息来自每个 event 的快照。上述失败的最终分类请求仍明确是 private，未把群聊当前现场拼成私聊现场。已确认的是群聊寻址条件被模型误用于私聊，尚不能把它表述为运行时并发串线。

随后分类协议加入宿主确认的 PRIVATE/GROUP/TEMPORARY_PRIVATE（当前输入仍是原线性格式），明确私聊消息直接寻址 Self，但不越过 no-reply 和 gate SILENCE。三种 surface 的原始分类和 retry 有回归测试，全部基线断言保留。同一条真人私聊文字已通过真实 Runtime/provider replay：TASK、正确创造者关系、保留独立判断；private no-reply 与 group testing 仍为 NONE，零感知/零 publication。最新档案为 alice-persona-provider-wire-surface-release.json。

边界修正已通过 121 项 targeted、575 项 server 和相关 PostgreSQL 10 项，以及 check/build。最新 generation `c6f0a5c2-6b32-4e4b-b14c-64e846b894f2` 于 2026-10-08 13:24 READY；原 Person correction 沿用，没有重复写入。真人复测尚待记录。replay 的 UNKNOWN publication 始终不算实机发送成功。
