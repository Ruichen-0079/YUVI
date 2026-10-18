# 双命题纠正 PARTIAL 的具体诊断

[原始合成持久状态摘要](evidence/formation.json)来自#331两个私有实验schema的只读检查；没有查询真实Alice数据库。本批不改变Authority接纳或旧任务状态。

同一来源原文：“之前编辑器代号说错了，现在用的是露川-4A87，栀子-613已经无效。”

1. 两组Journal/Conversation接受成功，用户来源、身份和scope一致。
2. SemanticMemoryPolicy各产生两个命题：“我使用的编辑器代号是露川-4A87。”“栀子-613已经无效。”两者引文都在当前用户原话内，rejected_propositions为空；语义任务一次完成。不是候选为零、prior引文或归属失败。
3. 两者都声明supersedes同一旧命题A。Finalized事件独立写入；其中一条先提交，A成为superseded，另一条的冻结目标过期。
4. 进入 `MemoryDecisionReassessment.apply`。模型连续三次把尚未写入的那条命题判断为 `new`、无targetIds；source证据仍合法、content仍匹配原命题。政策能产生该event，但reassessment.ts要求至少一个supersedes/conflicts/supports关系，因此抛 `MEMORY_REASSESSMENT_UNRESOLVED`。
5. 重评generation耗尽3次，外层delivery最终8次重试后 `MEMORY_WRITE_RETRY_EXHAUSTED`；turn保留1完成/1失败的PARTIAL，未伪造全完成。原semantic job=complete只证明提取完成，不证明写入完成。

两组顺序相反：一组新编辑器B成功，负向历史命题失败；另一组先写“旧编辑器已无效”，B未形成。因此后者不能计作“编辑器存在但检索漏掉”。lineage没有阻止合法引文，正式current状态真实反映已提交内容；不是Mem0 infer或数据库随机丢写。

当前拒绝无关系的重评也有必要的安全责任：若实际是更晚的独立用户事件A→C，不能把旧B当无关new事实偷渡成另一个确定current。所以**不直接放开relation=new，不修改旧回归预期来制造成功**。

下一切片应在现有Authority/Finalized机制内比较：同来源命题集在共同anchor上校验并事务提交，或严格识别“同一Journal来源的兄弟命题已使目标失效”的有界重评。不得把共享Journal的无关命题一起失效，不可引入Correction Manager。必须覆盖B＋旧A失效、多属性纠正、新事实混合修正、并发较晚C、乱序、重复恢复、一次合法一条坏引文，以及COMMIT回执丢失。

还需正式验证：用户后续再次明确澄清的**新来源**可以接纳并形成正确current，同时旧PARTIAL留作历史处理结果，不回填成早已成功。本批只有诊断和既有“无关系stale重评必须拒绝”的生产回归，没有宣称修复或完成该恢复实验。
