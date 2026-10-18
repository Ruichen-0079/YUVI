# 重放方式与实验边界

从仓库根目录运行，仅允许独立31508 PostgreSQL、`yuvi_pr_*`库。`support.ts`建立随机schema、使用正式Authority写入及current解析，固定每题候选作为语义干扰；不会进行新ANN检索，不能拿它报告ANN Recall。调用真正的Reasoning和Character Gate/Body，需显式合法Provider配置；凭据通过受保护环境注入，禁止写进Git/命令历史。

```bash
DATABASE_URL=postgres://ruichen@127.0.0.1:31508/yuvi_pr_20261013 \
YUVI_SUPPORT_OUTPUT=/absolute/protected/result.json \
YUVI_SUPPORT_BASELINE=/absolute/read-only/331-checkout \
pnpm exec tsx docs/research/evidence-truthfulness/experiments/support.ts
```

默认使用初始20题；`YUVI_SUPPORT_FIXTURE`可指向冻结的 `ground-truth-final.json`（追加四题）。`YUVI_SUPPORT_PRIOR`显式复用初始baseline全部答案，避免重复远端调用；不会隐藏新组失败。旧baseline、新Context和Character的版本差异见主报告。每次最多110调用/已知Provider估算$0.10，无无限重试。只有真实模型结果计语义质量；unit/HTTP fixture只证明协议、来源、授权及状态合同。

正常入口复用 accepted-dialogue.py 和本目录runtime-cases.json；后续runtime-no-planner.json通过同一隔离schema `--resume`。所有QA正式失效L1、重启隔离Server、换会话，原始数据留本地。ordinal5/6失败及7修复均保留，不能以多次采样择优作为成功率。

```bash
DATABASE_URL=postgres://ruichen@127.0.0.1:31508/yuvi_pr_20261013 \
YUVI_INTEGRATION_OUTPUT=/absolute/protected/integration.json \
YUVI_STACK_FILE=/absolute/protected/stack.json \
YUVI_PG_BIN=/absolute/postgresql-16/bin \
pnpm exec tsx docs/research/evidence-truthfulness/experiments/integration.ts
```

集成脚本会**新建唯一数据库和恢复库**，执行真实迁移、合成写入、损坏/修复、shadow及备份恢复，最后在恢复副本验证旧runner失败；不会合并Git refs，不自动删除诊断库。stack.json由`gh pr view 322..331 --json headRefOid,baseRefName,...`取得。脚本必须能访问这些提交的Git对象。它不是只读脚本，也不是正式Alice迁移工具。

性能沿用 compositional-retrieval/experiments/scale.ts，指向已确认合成scale DB；本次仅复用READY索引，报告不称重新回填百万。代码没有发布新的合取检索策略。

```bash
python3 docs/research/evidence-truthfulness/experiments/summarize.py \
  /absolute/protected/experiment-root docs/research/evidence-truthfulness/evidence
```

answer-annotations.json是逐条人工判读，绑定确切回答SHA256，不是模型裁判。摘要器校验digest再计算完整回答、归属、未知等指标。所有答案/非完成/错误必须保留，禁止改标签迎合输出。公开数据只允许合成内容、安全输入摘要、usage和计划；真实用户轨迹不得直接提交。
