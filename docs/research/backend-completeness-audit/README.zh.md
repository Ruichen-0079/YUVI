# 复现与证据边界

这是一份**部分审计**。`coverage-summary.json` 的完整性标志为 false。默认检查通过表示清单／证据一致，不表示全仓深审、所有消费者闭合或智能有效。

## 锁定源版本

main 研究 SHA：`fb0e1e62841106c533e4edd1d7e60327dc4315b4`。

报告发布后 HEAD 会变化。用独立 worktree 指向研究 SHA，证据脚本从当前文档目录执行，源代码参数指向该 worktree。无需把审计脚本放进生产包。

```bash
git fetch origin '+refs/heads/*:refs/remotes/origin/*'
git worktree add --detach ../yuvi-audit-baseline fb0e1e62841106c533e4edd1d7e60327dc4315b4
node docs/research/backend-completeness-audit/evidence/check-coverage.mjs --repo ../yuvi-audit-baseline
node docs/research/backend-completeness-audit/evidence/check-coverage.mjs --repo ../yuvi-audit-baseline --require-complete
```

第二条校验预期退出 **2**，因为调查尚未完成；它不是脚本错误。退出 **1** 表示证据无效，如 SHA、分类策略、清单、候选或缺口被改变。退出 **0** 仅表示证据有效且没有请求完整性验收。`--no-write` 可避免改写 summary。

校验器重新读取 `git ls-tree`／Git blobs，不把未追踪 node_modules 当生产源码；若工作树已有生产修改则失败。它检查所有追踪路径、blob SHA、分类策略 SHA、必要字段、语法／格式记录全集、A/B/C 候选存在性、未解决差异、人工区间，以及“无消费者”判断所需的动态检查类别。人工理解不能由校验器证明。

## 依赖与重建顺序

已使用 Node 24.19.0、源仓库安装的 TypeScript 5.9.3／esbuild，Python 3.12.14。Python 审计语法依赖见 `evidence/requirements-audit.txt`。实验另需 numpy。没有运行生产 LLM；没有使用真实 GPU／声纹设备或 PostgreSQL 恢复集成环境。

安装产品 Node 依赖时使用源仓库 lock；这是审计运行环境，不修改生产实现。路径变量由使用者设置，以下均在本报告目录执行。

```bash
node evidence/build-inventory.mjs /absolute/path/to/pinned/source
node evidence/analyze-typescript.mjs /absolute/path/to/pinned/source
python3 evidence/analyze-other-languages.py /absolute/path/to/pinned/source
python3 evidence/curate-review.py /absolute/path/to/pinned/source
node evidence/assemble-evidence.mjs /absolute/path/to/pinned/source
python3 evidence/omission-review.py
node experiments/run.mjs /absolute/path/to/pinned/source
python3 experiments/python-probes.py /absolute/path/to/pinned/source
python3 evidence/record-behavior.py /absolute/path/to/pinned/source
node evidence/check-coverage.mjs --repo /absolute/path/to/pinned/source
node evidence/test-checker.mjs /absolute/path/to/pinned/source
node evidence/seal-artifacts.mjs
node evidence/verify-delivery.mjs /absolute/path/to/pinned/source
```

`curate-review.py` **序列化本轮人工判断，不重新完成阅读**，且拒绝非本轮 SHA。`manual-review.json` 区分完整逐文件深读、针对性区间、剩余问题。不得在新版本自动复用旧判断后宣布闭合。

`build-inventory.mjs` 会先生成全新的未分析清单；结构／人工标志由随后步骤覆盖。分类政策按 Git 技术角色优先：Vendor、文档、测试、生成、SQL、资源、源文件、配置、UNKNOWN。未识别文件进入候选分母。所有已排除记录仍保存；生产引用排除类触发差异。策略修正前的清单冻结在 `initial-source-inventory.json.gz`；固定随机样本从该清单重算，避免抽样因结论调整。

## 三路证据怎样使用

- `entrypoint-traces.json`：自动入口候选在 `entries`，人工链路在 `traces`。关联一个组不表示该组全部取消／恢复条件通过。
- `producer-consumer-graph.json`：自动声明／事件候选在 `states`；已重点调查的 24 类产物在 `reviewedImportantStates`。类型引用不等于模型消费。自动候选的 UNRESOLVED 是有意保留。
- `data-transformation-boundaries.json`：候选记录包含 AST 参数结构／类型、输出类型；字段人工记录在 `reviewedBoundaries`。语法推断的类型不能充当字段保留证明。
- `cross-pass-discrepancies.json`：保留入口、消费、字段和跨集合未锚定差异。导入闭包并非实际运行调用图，动态 Host／跨进程需要另外调查。OPEN_GAP 的原因分类不表示已解决。
- `coverage-summary.json`：按 package／语言／进程分组，并列出每个 pending 文件与 ID。不会用单一成熟度分数压缩实现、可达、消费和效果。

`typescript-relations.json.gz`／`other-language-relations.json.gz` 是完整原始索引，使用 gzip 只为控制文档体积，未抽样删节点。assembler／checker 支持 `.json` 与 `.json.gz`；可用 `gzip -dc` 查看。`.generated-backend.mjs` 是实验临时 bundle，不提交。

## 独立分支

已取所有 104 个远端 head；`scan-branches.mjs SOURCE` 会重新枚举，远端变化可能产生与本轮不同的结果。冻结结果保存在 build-and-branch matrix。它的树差异是候选筛查，不是活跃／部署证明；新路径扫描不代替独立函数实现比较。

QQ／Plunge SHA：`adff0c70648b42a3a15ea45609adae1c45b31fc5`。
桌面呈现 SHA：`4da346636be7bdaefeeb7617f1530eaedbcd0711`。

```bash
git worktree add --detach ../yuvi-plunge adff0c70648b42a3a15ea45609adae1c45b31fc5
git worktree add --detach ../yuvi-presentation 4da346636be7bdaefeeb7617f1530eaedbcd0711
```

每棵树安装／提供自己的工具依赖，分别调用：

```bash
node evidence/analyze-typescript.mjs /absolute/branch/source evidence/branches/plunge
python3 evidence/analyze-other-languages.py /absolute/branch/source evidence/branches/plunge
node evidence/check-coverage.mjs --repo /absolute/branch/source --inventory evidence/branches/plunge/source-inventory.json --inventory-only
```

桌面呈现对应目录为 `evidence/branches/desktop-presentation`。若需重建分支清单：`node evidence/build-inventory.mjs GIT_REPO OUTPUT_DIR EXACT_SHA`。`finalize-branches.py MAIN_GIT_REPO` 只覆盖各自结构标志和装配定位，不把 main 的人工判断贴到分支。`--inventory-only` 校验不宣称分支消费者／字段／行为完整。

101 个历史 head 的当前活动状态没有部署证据，记录没有删掉；其他函数差异未全面审读。不知道真实 Alice SHA 时，不能把 main／Plunge／历史发布混成一条链。

## 实验与旧证据

`backend.ts` 调实际生产 Cognition、文件读取、观察 normalizer、Character port、WS route／EventBus；输入记录器取代模型，host 持久 effect adapter／socket 等注入点逐项说明。WS 事件通过实际 AssistantMessagePayloadSchema；另用实际 trace registry 验证无效同 trace 事件不会合理地代表取消原工作，反事实仅临时保护该 registry 清理。脚本启动真实 Python dots HTTP Handler／Service，只替换波形生成，用真实 TS Provider 验证跨语言响应；结束时停止该本地子进程。

`python-probes.py` 调实际 STT 分段方法、音频 decode、TTS 验证／取消；ASR／diarizer／昂贵模型依赖注入。没有评价识别质量、人格或语言自然度。

原始结果保留请求、结果、标记、调用计数。fixture wall time 只表示本机确定性执行，不是远端模型延迟；真实推理成本未测。`behavior-coverage.json` 将正常、问题、反事实及证据边界并列，没有覆盖的能力另列 OPEN。

旧实验没有为增加数量反复执行；Git 比较与文件哈希见 `prior-evidence-reuse.json`。它证明生产源码一致，可复用特定事实，不证明旧审计动态覆盖已足够。旧报告是在本轮 Git/AST、主要新边界与正向路径调查后才作限定对照；本轮继承此前会话背景，因此不是盲审。

## 审计方法的已知缺口

当前 TS 调用图不是 alias-perfect，Python 不是完整动态调用解析器，Rust 不是 cargo 实际条件构建，Shell 不是执行证明。YAML／PowerShell／Batch／资源等仍仅元数据索引。B 保留全部 TS 类型／接口／类声明，未按熟悉状态词排除；但未定类型的缓存、闭包和运行时对象仍可能遗漏，producer/consumer 图没有因此被宣布完整。顶层 CLI／发布构建命令、隐式回调和跨进程运行根仍须补人工与实际构建依据。

固定样本可复现，但有大文件未深读；16 个风险候选只有部分追加阅读。check 脚本的腐败测试只是特定防线。阅读区间、候选 ID 和公开缺口让复查可开始，不提供绝对零遗漏保证。
