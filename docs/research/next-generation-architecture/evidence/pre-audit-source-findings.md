# 独立源码调查记录：先于独立旧审计报告对照

基线 main：46a24878536d537021c49d50c5ce004d93489628。第二阶段冻结后调查源码；本文件保存第三阶段主要判断，再开始阅读独立旧审计、闭环记录及 PR 321 的当前架构重释。Future 本身已包含实现与审计摘要，因此不声称双盲。

## 全产品地图

- 入口与体验：Tauri 桌面三种窗口、托盘和进程监督；React 产品设置/对话/桌面角色/字幕与独立开发控制台；Fastify HTTP、SSE、WS。
- 交互：文本及语音接收凭证→Journal→Conversation→Runtime 当前轮→来源、近期上下文、L1/L2、P8→Character gate→可选 Cognition 多轮能力→Character reentry gate→正文流→发布/语音/呈现效果→最终记忆入库。
- 身份：CharacterDefinition 与 instanceId 分开；独立构造存储根、Journal namespace、数据库 owner；Person 资料与声学模板及人工绑定分开；未知声音不会擅自归入已知人的记忆。
- 状态：PostgreSQL Journal、Conversation、L1、Memory、lineage、ingestion、dream、profile lifecycle、effects；Mem0 另一个服务持久化；Person/P8 corrections/voice binding/proactive policy 存于本地文件；声学模板在 Python generation manifest；前端呈现和播放状态另有生命周期。
- 模型：统一配置模型目录、能力路由与 fallback；Chat/reasoning/proactive/vision/STT/TTS/embedding；原生流、取消及调用凭证；本地与远程供应商。
- 自主：分钟级定时检查→NO_OP/REQUEST_TEXT→短主动正文；抑制、同意、当前轮、播放和呈现硬门。没有看到可跨重启履约的语义 obligation reducer。
- 能力：显式授权的单个本地文本读取；composition 注册的插件能力与生命周期；默认发现空列表，不等于完整插件生态。
- 多模态：本地 CPU STT/声纹分簇，独立 Person 绑定；PTT/hands-free/VAD；TTS 分段播放、打断/字幕与 GPU 休眠；按需屏幕视觉、有限证据轮，不是持续场景理解。
- 部署/运营：打包私有 PostgreSQL、Mem0/STT sidecar、秘密存储、所有权/生命周期/端口与发行检验；Linux CI 为主，Windows/macOS 不能由设计目标推断已验收；本机 dashboard 有界事件与脱敏，持久调用/上下文凭证。
- 研究：Future 的行为规范、偏好数据与后训练计划；提示缓存/主动行为基准脚本、离线控制测试、持久 conformance CI；没有找到生产学习更新器或实际后训练数据/训练流水线。

## 主要独立发现

1. 来源/执行闭环强于语义认识闭环；允许低风险开放解释影响选择同时保持事实证据边界，可能比继续增强证据物化更有产品价值。
2. Profile 的 COMPLETE 是确定性证据集合完整，不是理解/矛盾解决；narrative=null，semanticConflictAssessment=NOT_ASSESSED；A4 明确 NOT_USED。
3. 普通 RESPOND 两次 Chat；升级则初 gate、Cognition executor、后 gate、正文。先实验统一模型原生流及可选升级，不直接永久双模型。
4. 旧 LLM extractor 实际不调用 reasoner；Mem0 最终写 infer=false；dream 从用户陈述规则提取。当前语义瓶颈不是缺模型连接。
5. 用户×个体 scope 是隐私隔离资产，但不能作为未来所有世界认识/个体成长/公共共同经历的唯一地址。所有权、关于谁、可向谁披露应独立。
6. outcome 在 L1 可以是最后助手话语，不能等同外界结果；effect APPLIED 也有各层含义，网关接受/播放开始不能等同任务成功。需要结果事件，而非把词语 outcome 升格。
7. 配置更长窗口仍有 24576 working-token 硬顶，字符保守预算；压缩 marker-preserved 不保证语义约束保留。预算应实验驱动、关注撤回与反证。
8. 全量 Profile 源 4096 行 bound 是诚实 PARTIAL 防护，也可能成为长寿个体瓶颈，应研究增量有效证据集合，不能简单调大。
9. 部分删除/forget 路径不等于跨 Conversation、Journal、快照、派生认识的消影响；跨文件/多服务恢复与分叉身份是长期连续性能力，而不只是运维附录。
10. 目前工程测试主要证明控制/持久正确性；真正个体目标需要有机会条件的纵向行为评估与真实共同活动。

## 可复现证据

experiments/control-and-state.mjs 调用实际编译产物，确定性 scripted model。验证调用次数、证据物化状态、4096/4097 分界、LLM extractor 0 次调用、窗口硬顶与示例压缩撤回信息丢失；未评估实际模型质量或延迟。workspace pnpm -r test 完成；另有全量 TypeScript check 先缺 Cubism 生成产物，准备后通过。
