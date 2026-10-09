# 可复现输入与控制探针

```bash
git clone https://github.com/Ruichen-0079/YUVI.git yuvi-audit-source
git -C yuvi-audit-source checkout b307704a0c798fe092966766ad4422a9aaa31262
cd yuvi-audit-source
corepack pnpm install --frozen-lockfile
node /absolute/path/to/this/directory/run.mjs "$PWD"
```

要求 Node 24 和仓库的 esbuild/dependencies。脚本根据 workspace exports 的 development 源定位 main；不导入其他分支。生成 `.generated-backend.mjs` 和 `backend-results.json`；bundle 不纳入 Git。提交的结果记录了运行源码 SHA、Node 版本及真实模型调用数零。复跑时钟和 UUID 会变化，断言不依赖它们。

实际调用 RuntimeOrchestrator、正式 createServerCharacterPort、MemoryService、P8 adapter、Dream assembler/engine/store、speech reserve/finalize/commit 和 executeProductionCognition。显式启用正式 Character，不走 test/mock 省略 Character 的装配路径。

外部依赖明确替换：Chat/Reasoning 是固定输出和请求记录器；Mem0 搜索是注入事实；Conversation/episode/job store 为真实内存实现；P8 correction store 是明确无修正的有效响应；语音输入是两段 STT fixture，接收凭证借用现有 Journal fixture，补充匹配 VOICE_OBSERVATION correlation；read-text effect adapter 返回授权观察 fixture，不实际读文件，不证明持久 effect-store 的执行。Dream 使用已有 committed-source fixture 供给输入，生产 assembler/engine/store 真正运行。没有启动真实 PostgreSQL、sidecar、HTTP/QQ 服务、音频硬件或远端模型。

七组检查：

1. 否定“担心”被焦虑规则命中，原句与错误提示共同到达正式 Character。
2. 有 Memory 证据的空关系候选仍无 meaning；供给有限解释的反事实得到可消费 meaning。解释由探针提供。
3. 生产形状 Dream 调用不触发 idle，传 idleMs 才触发；没有 executor 就不会推进 pending。生产缺 worker 结论另由装配调查支持。
4. 两段语音的 segment confidence 未进 committed transcript，cluster 信息不进正式 Chat，合并文本进入。
5. work 会话普通历史得到恢复，按启动装配固定 default 的 scheduled executor 却读取 default。为可 await，直接调用与真实注册 wake 相同的私有执行方法和当前 generation；未声称启动了完整服务器。零评分避免真实发表。
6. Mem0 的额外事实通过 MemoryService 进入正式 Character（正向对照）。
7. 一项授权工具观察通过生产 Cognition 进入第二次 Reasoning（正向对照）。

[backend.ts](backend.ts) 为探针；[run.mjs](run.mjs) 为单一 checkout bundler；[backend-results.json](backend-results.json) 为原始记录，包括模型输入。数据全部是人为构造的公开测试文本，不含生产对话/凭据。

断言通过证明对应输入和控制事实，不证明自然度、推理质量、真实模型延迟或费用改善。主报告中的四类真实模型对照仍需模型与部署数据。已由旧实验充分证明且生产源未变的事实没有重复运行。
