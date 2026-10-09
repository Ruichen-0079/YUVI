# 生产智能损失探针

只读加载锁定源码，模型/存储依赖由离线 fixture 替代。没有真实模型质量评测、没有远端模型请求、没有真实删除或 QQ 发送。

- `main.ts`：实际 `executeProductionCognition` 的相同输入 CONTINUE；实际 MemoryService + Runtime + production Character 的否定 forget 删除与失败说明；相同正文 stop/length 在真实 Runtime 中的接受与历史差异。
- `plunge.ts`：实际 Character 投影与 scene 摘录；实际 QQSocialAdapter 的超时历史；实际 QQ codec 的双图和长文本限制；实际 production Character port 的分类失败→SILENCE。
- `main-results.json`、`plunge-results.json`：本轮运行结果。fixture 控制模型输出，不证明模型经常返回这些输出。

`inputComparators` 只是 A 忠实历史 / B surface 投影 / C 保留历史投影的局部信息对照，不是完整参数一致的模型请求。D 仅 main 部分场景通过 Runtime；其余探针直接调用组件，不宣称完整部署验收。

## 复现

准备两个只读检查目录，锁定：

```text
main:   b5abb06c9dcdd846fa20152c401eff88aac57205
plunge: adff0c70648b42a3a15ea45609adae1c45b31fc5
```

可以在另一个临时目录 clone 仓库并 checkout 对应 SHA，或使用 git archive。main 检查目录需要安装该 lockfile 的 pnpm 依赖；QQ 检查目录只需源码。Node 24，esbuild 使用 main 的安装。

```bash
node /path/to/experiments/run.mjs /path/to/main-checkout /path/to/plunge-checkout
```

runner 将 `@companion/*` 和 `#repo/*` 解析到本次选中的检查目录；第三方依赖复用 main 安装，并检查分支 bundle 未混入 main 产品源码。生成的 `.generated-*.mjs` 放在探针目录，不修改生产文件。结果 JSON 在此目录覆盖写入；探针目录应可写。除外部依赖替代和显式生产 Character 注入外，不改源码函数。

本轮环境：Node `24.19.0`，esbuild `0.25.12`。脚本全部断言通过。为修正探针适配和 bundler 依赖解析而重复启动过；未追加全量测试或把这些启动算成额外模型样本。没有运行真实 PostgreSQL/OneBot，也没有复测与本轮变更无关的全量工程测试。
