# 后端高风险边界恢复（main 的第一批生产修复）

阅读 [主报告](YUVI-Backend-Boundary-Recovery.zh.md)。

- [合同台账](evidence/high-risk-boundary-ledger.json)：从冻结 Compiler API / 三路图谱派生；候选、真实注册和人工确认调用链分开。
- [机器汇总](evidence/boundary-coverage-summary.json)、[候选消歧与原始缺口](evidence/candidate-disambiguation.json)。
- [基线与独立提交](evidence/baseline-and-commits.json)、[分层样本](evidence/residual-sample.json)。
- [复现与真实模型 Harness](experiments/README.zh.md)。
- `evidence/*before.json` / `*after.json` 是 Vitest 原始结果；最早记录是逐项修改过程，最后另有独立原版 worktree 回放和最终跨包回归。

上一轮 `backend-completeness-audit` 的 Inventory / 三路图谱 / 3,956 条缺口未被删除或改写。本次 `scopeComplete=false`：生产修复完成的是明确的高风险批次，而非六类边界的完整语义审计。真实模型调用为 0。
