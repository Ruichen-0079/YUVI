# 重放入口

从仓库根目录执行。数据库必须是自行创建的隔离实例；脚本对端口和数据库名另有硬限制，不能用于真实 Alice。测试会建立随机 schema，正式 admission/投影/检索完成后清理该 schema。手工计划是协议对照，不是模型语义能力证明。

```bash
DATABASE_URL=postgres://ruichen@127.0.0.1:31508/yuvi_pr_20261013 \
YUVI_EVAL_OUTPUT=/absolute/protected/output.json \
YUVI_EVAL_LIMIT=5 \
pnpm exec tsx docs/research/compositional-retrieval/experiments/evaluate.ts
```

另一次冻结集用 `YUVI_EVAL_FIXTURE` 指向 `ground-truth-unseen.json`，并设置 `YUVI_EVAL_FIXTURE_COMMIT=11040dc`。`YUVI_EVAL_REAL_VECTORS=true` 才会调用实际 embedding；须通过现有 Provider 配置提供合法凭据、模型和 512D 配置。默认没有付费调用；不要把凭据写进命令历史或公开结果。向量模式有 250 次请求上限，原始缓存只保留本地。

`scale.ts` 仅接受既有合成 scale 数据库，需显式 `YUVI_SCALE_OUTPUT` 和 `YUVI_BASELINE_CHECKOUT`（只读 #330 worktree）。它可能应用迁移、复制负载 scope 和回填索引，不能当只读探针。`concurrency.ts` 写入合成负载；`cold.ts` 只查询，不会自动重启数据库或清理全机缓存。规模路径与具体机器绑定，先阅读脚本和性能报告，再按隔离环境修改。

正常模型实验复用 `docs/research/evidence-continuity/experiments/accepted-dialogue.py`；本目录 `runtime-*.json` 是依次使用的输入/重放片段，不是彼此独立的完整运行。已有 harness 的命令参数、保护目录和 Provider 预算继续生效。`migrateIsolatedOnResume`/`prepareLexicalIndex` 仅用于同一隔离 schema 从 #330 升级，保留正式权威记录；`clearShortContext` 使用正式 L1 失效、停止/重启隔离 Server，再以新会话提问。自然纠正 PARTIAL 是正式失败，不应改预期或重新种入答案。

`grounding.ts` 需显式 `YUVI_GROUNDING_OUTPUT` 和 `YUVI_GROUNDING_CHECKOUT`，重放 #329 已提交的真实 Qwen 观察并调用当前合法 Chat 路由；它不是重新观察图片或完整 A9 验收。

```bash
python3 -m unittest discover -s docs/research/compositional-retrieval/experiments -p grading_test.py
python3 docs/research/compositional-retrieval/experiments/summarize.py \
  /absolute/protected/experiment-root \
  docs/research/compositional-retrieval/evidence
```

总结器要求完整的原始实验目录布局，保留所有失败，不进行多次采样择优。公开输出只允许合成内容、来源 ID、候选、实际输入摘要和费用；不要在真实数据上执行后直接提交结果。
