# R5 实验复现

使用现有 R3/R4 Provider 与私有 fetch recorder 基础，未重新实现模型客户端。所有命令从仓库根执行；依赖 `pnpm install`、development conditions、独立 PostgreSQL + pgvector、正常 `pnpm db:migrate`。**禁止指向真实 Alice DB/进程。** 模型参数 0/2048；合法凭据仅在环境传入，不写文件或 Git。

| Harness                     | 作用                                                                                           | 必要隔离/限制                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `semantic.ts`               | 实际 Journal/Finalized/authority/LLM；随机形成、指代纠正、冲突、引用、假设、Person；新进程召回 | DATABASE*URL path 包含 runtime_r5*；YUVI_R5_OUTPUT 私有目录；已配置 Provider/512 embedding  |
| `record-isolated-fetch.mjs` | 复用 R4 recorder，保存实际调用/参数/usage/延迟                                                 | SERVER_PORT=31505、YUVI_EXPERIMENT_TRACE 每次唯一私有目录；留存远端预算60；不加载真实 Alice |
| `load.ts`                   | 正式 PG Schema/index/reader 的 1k..1M 索引负载                                                 | 合成 fixture 绕过 Admission/LLM；不能作为百万次语义写入验证                                 |
| `incremental.ts`            | 百万条背景中正式 authority 增量纠正                                                            | 确定性 Host fixture；只验证写入/状态，不是 LLM质量                                          |
| `crash.ts`                  | 真正 PG immediate stop 中途/回执后重启                                                         | 仅独立31506集群，YUVI_R5_CRASH_PG 后缀强校验；绝不重启共享PG                                |
| `import-legacy.ts`          | 100行 atomic checkpoint 的合成旧DTO导入                                                        | 显式scope/文件/备份确认；可BATCH_LIMIT停止；不访问真实Mem0                                  |

```bash
# 环境均来自隔离配置，不在命令中硬编码凭据。
SERVER_PORT=31505 YUVI_EXPERIMENT_TRACE="$R5_PRIVATE/unique-run-calls" YUVI_R5_OUTPUT="$R5_PRIVATE/semantic" node --conditions development --import ./docs/research/runtime-memory-r5/experiments/record-isolated-fetch.mjs   --import tsx docs/research/runtime-memory-r5/experiments/semantic.ts --final
# 相同输出目录，新进程：semantic.ts --restart
# --resume 恢复原失败任务；--skip-intermediate 减少已知无意义的中间召回。

node --conditions development --import tsx docs/research/runtime-memory-r5/experiments/load.ts   1000000 "$R5_PRIVATE/load.json"
# 已有million数据仅复测：追加 --read-existing --resource
```

完整语义矩阵不带 --final；--final 仅新增一组冻结版本，避免重复大量成功探针。restart 不创建新的来源或把随机 marker 提前传入 Chat，只从持久检索结果回答。Provider unavailable 时保留 pending/failure，质量断言不得跳过这些状态；resume 在未 complete 时停止依赖实验。

本机原始轨迹在 `~/.local/state/yuvi-runtime-memory-r5`（0700），旧R3/R4资料仍复用。新 recorder 禁止已有 trace 目录，修正初期覆盖问题；保留成本只是实验账本，不能视为生产级跨进程原子费用预算。Git 仅发布明确合成的摘要、答案、调用 usage 和负载计划，不包含真实 Alice persona 或私人 source payload。

## Phase 2 Harness

`runtime-phase2.ts` 复用真实 `/message`、Host grants、Journal、Finalized worker，依次 initial / `--resume` / `--restart` / `--quality` / `--final`；`YUVI_R5_OUTPUT` 必须受保护，fixture含一次性Host token，**禁止提交原始输出目录**。启动独立31505 Server，预先配置两个合成有revision的Person、固定合成Character、独立数据库和合法Provider；不可对在线Alice运行。公开报告仅包含挑选出的合成消息/回答、状态与逐调用usage，实际Persona和Provider输入在本机。

`vector-load-phase2.ts [1000000]` 在明确31508/`yuvi_runtime_r5p2_scale` own cluster递增load 10k/100k/1M；直接填索引fixture，非正式语义admission或逐事件写吞吐证明。保留约6GiB磁盘余量，实际HNSW构建约十余分钟。`vector-read-phase2.ts` 对既有fixture走正式 reader/indexer，输出40次热分位、first-call、Recall@8、current状态、执行计划/数据库累计I/O/大小；`YUVI_R5_SCALE_OUTPUT` 指定保护文件。不会给百万条调用LLM。

`online-rebuild-phase2.ts` 使用正式shadow组件，百万scope下同时reader和50个实际Authority事务writer、pause/resume、新组件重开；最后校验全部投影状态。`database-faults-phase2.ts` **会立即停止自己创建的PG进程**，固定own cluster目录、31508/专用DB、postmaster.pid双重检查，禁止适配到共享/正式库。`YUVI_R5_FAULT_ROOT` 明确本机保护目录；故障输入是测试fixture，故障结果不是语义模型实验。COMMIT回执丢失用已真实commit后的transport seam注入，保留unknown→reconcile轨迹。

public evidence只允许无credential的合成结果；scope/Person/Journal必须与Alice隔离。普通memory无工具调用脚本强制语义输出。型号、SHA、dirty状态、参数、失败、重试、token和费用覆盖不足均记录，旧失败不得因复测成功而删除。
