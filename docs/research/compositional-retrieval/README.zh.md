# 组合检索与回答证据忠实度

基线 #330 `28361e0`，独立分支 `feat/compositional-memory-retrieval`。本批不改变 Authority 历史或 A9/Observation 提交合同，不接触真实 Alice。

首先冻结 [Ground Truth](experiments/ground-truth.json)：合法协议来源形成的确定性存储样本与真实模型语义实验分开。数据包含纠正、冲突、支持、独立 Person/Persona、UNKNOWN、高相关干扰及 development/holdout 查询。事实中的值不会进入检索规划请求。手工 needs 只用于确定性协议对照，不能作为模型理解能力的证据。

归因顺序：来源接纳→权威记录/现行状态→计划来源片段→各通道候选→覆盖选择→Gate/Body 实际 Context→最终回答。跨会话模型实验须正式失效合成 L1 并重启，不靠旧对话补答案。

验收矩阵、实现及实测结果随代码推进更新；当前不宣称组合检索或 R5 整体验收通过。付费查询规划继续默认关闭。
