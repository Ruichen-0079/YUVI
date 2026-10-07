# YUVI

[English](README.md) | [简体中文](README.zh-CN.md)

**面向长期交互的本地优先个人 AI 伴侣。**

YUVI 将对话、语音、长期记忆、身份相关上下文、Live2D 表现与桌面存在整合为一个持续运行的 Companion 系统。

YUVI 不追求成为功能最多的 AI 角色平台，也不把自己定位成通用电脑 Agent。它更关注一个更窄、也更长期的问题：**一个 AI 伴侣如何在长期个人使用中保持有用、可辨认，并且可靠地持续存在？**

<!-- 在这里加入当前产品截图或短 Demo。 -->

## 当前版本

**YUVI v0.1.2** 是当前公开版本。

- Linux x86-64 安装包：`yuvi-v0.1.2-linux-x64-installer.run`
- Linux x86-64 Portable：`yuvi-v0.1.2-linux-x64-portable.tar.zst`
- Release notes 与校验文件：https://github.com/Ruichen-0079/YUVI/releases/tag/v0.1.2-final

Linux 是当前主要发布和验证目标。Windows 仍然是支持的开发与后续打包目标，但目前还没有与 Linux 对等的公开 release 路径。

## YUVI 现在能做什么

### 对话与认知

- 通过 YUVI Runtime 提供持久化文本对话。
- 可配置 Chat、Reasoning、Embedding、STT、TTS 与 Vision 能力路由。
- 支持 Provider fallback，同时避免 Runtime 行为绑定到某一家模型厂商。
- 视觉能力采用显式调用，而不是持续监控桌面截图。

### 语音

- 支持语音识别与语音合成接入。
- Linux release 内包含已打包的 Local STT 支持。
- 提供面向个人使用的声音与说话人 profile 管理。
- 声音匹配与 speaker diarization 仍属于实验能力，不能作为身份认证手段。

### 记忆与人物

- 持久化会话与长期记忆。
- PostgreSQL + pgvector 是当前已经验证的 durable storage 主路径。
- 人物与 profile 上下文以可追溯证据为基础，而不是把隐式推断直接当作人格事实。
- 支持长期记忆检索、维护、过期与 supersession。

### 桌面伴侣体验

- Live2D 桌面呈现。
- 直接导入用户提供的 VTube Studio ZIP 模型包。
- 透明 Companion 与 Subtitle 桌面窗口。
- 窗口位置、可见性、Always-on-Top、锁定与解锁控制。
- 系统托盘控制。
- 首次启动引导。
- 英文与简体中文产品界面。

### 可靠性

YUVI 把长期运行可靠性当作产品能力，而不仅是内部实现细节。Runtime 已建立明确的生命周期所有权、持久化回合处理、幂等、retry/reconcile、崩溃恢复、取消隔离，以及面对不确定外部副作用时的 fail-closed 边界。

## 产品方向

YUVI 长期围绕五类问题组织：

- **Character** —— 稳定、可辨认的身份，而不是一次性的 Prompt。
- **Conversation** —— 自然的文本与语音交流。
- **Memory** —— 由明确证据和归属支撑的长期个人上下文。
- **Perception** —— 在真正需要时才获取环境信息。
- **Runtime** —— 长期可靠地判断、执行并恢复。

Live2D、字幕、语音与 WebUI 都是核心系统外部的表现面，不是新的行为权威来源。

## 系统如何组合

```text
                       +------------------+
                       |  Memory / People |
                       +---------+--------+
                                 |
文本 / 语音 / 图像 ------>   YUVI Runtime   <------ Provider / Model
                                 |
                    +------------+------------+
                    |            |            |
                    v            v            v
                Character    Perception    Actions
                    |
                    v
                 桌面存在
          Live2D · Voice · Subtitle
```

Runtime 拥有执行生命周期与 canonical state transition。Presentation 层不能绕过 Runtime 建立第二套执行权威。

## Local-first 与隐私

YUVI 是 **local-first**，但这并不等于所有能力都必须离线。

Runtime 状态、本地配置与受支持的个人数据路径以用户可控为原则。用户仍可以为 Chat、Reasoning、STT、TTS、Vision 或 Embedding 配置云端 Provider；使用这些 Provider 时，相应请求数据会按照该 Provider 的策略发送到外部服务。

当前 Vision 是显式、一次性的能力，不要求持续截图监控桌面。

密钥只能存在于本地配置中，不应提交到仓库，也不应出现在日志、事件或错误负载中。

## 开始使用

### 使用 Linux 发布版

下载 **v0.1.2**：

https://github.com/Ruichen-0079/YUVI/releases/tag/v0.1.2-final

当前 Linux x86-64 版本以 Debian 12 / glibc 2.36 为目标环境，并依赖系统 GTK/WebKitGTK 4.1 与 AppIndicator runtime。部分 Provider 密钥、模型与本地服务仍需要用户自行配置。

Live2D Cubism Core 与专有角色资产不会随 YUVI 一起分发。

### 从源码开发

YUVI 当前采用 Linux-first 开发与接近生产环境的验证策略。

主要依赖包括 Node.js、pnpm、用于开发基础设施的 Docker/Compose，以及作为 durable persistence 路径的 PostgreSQL + pgvector。

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

开发地址：

- Server：`http://localhost:6121`
- Web UI：`http://localhost:5173`
- WebSocket：`ws://localhost:6121/ws`

常用命令：

```bash
pnpm check
pnpm test
pnpm build
pnpm smoke
pnpm db:migrate
pnpm smoke:postgres
```

当前安装、开发与生命周期细节见 [快速开始](docs/quickstart.zh-CN.md) 与 [Linux daily use](docs/linux-daily-use.md)。

## 仓库结构

- `apps/server` —— Fastify HTTP/WebSocket Runtime server 与 composition root。
- `apps/web` —— Product WebUI。
- `apps/desktop` —— 适用场景下的桌面 presentation shell。
- `packages/core` —— Runtime 编排与行为集成。
- `packages/memory` —— 持久化会话与长期记忆边界。
- `packages/providers` —— Provider contract、registry 与厂商适配。
- `packages/prompt-builder` —— Provider-neutral prompt assembly。
- `packages/protocol` —— Runtime event 与 schema。
- `packages/config` —— 类型化配置与脱敏边界。
- `docs/future` —— 未来架构与产品规划；不代表已经实现。

## 工程原则

- **Runtime 拥有执行权。**
- **Memory 是证据，不是隐藏的人格真相。**
- **Provider 可替换。**
- **可靠性语义属于产品资产。**
- **优先选择小而保持行为的改动，而不是推测性的架构扩张。**

这些原则的目的，是避免一个长期 Companion 演变成多套相互竞争的 lifecycle 与 state authority。

## 研究方向

YUVI 也希望成为长期人机交互研究的实验平台。

目前感兴趣的方向包括：

- **拟人化对话大模型** —— 让 Companion 的语言更自然、更有社会表达能力和人格一致性，而不只是更像通用 Assistant。
- **个性化 Attention Policy** —— 学习一个长期存在的 Companion 什么时候应该观察、保持沉默或主动发起互动。
- **长期身份与关系连续性** —— 在长期使用中保持一致、可解释的个人上下文。

这些是未来研究方向，不代表 YUVI 已经解决了这些问题。

## Roadmap

近期仍然刻意以产品收口为主：

```text
reliability
  -> desktop closure
  -> UX simplification
  -> documentation
  -> stable releases
  -> deeper companion intelligence
```

未来架构文档位于 [docs/future](docs/future/)。它们只代表规划，不代表当前实现状态。

当前开发主线为 `main`，不等同于新增正式 release。A9、A10 和 A11 的已验证 Core 能力已实现，A12 仍未闭环。[Multi-Character Core](docs/architecture/multi-character.md) 采用稳定 Character binding 与独立 Runtime composition；共享 Product Person 和模型服务，隔离 Memory、Relationship、Profile、近期对话、P8 corrections、proactive 和执行状态。默认 Yuvi 兼容旧数据。[验收](docs/validation/multi-character-2026-10-07.md) 已覆盖真实 PG 持久化及 SIGKILL/restart；完整 Linux packaged conformance 尚未通过，缺少原生 PG16 packaged distribution，Docker PostgreSQL 不能替代该 gate。桌面选择器与 QQ 接入仍是后续工作。

## Inspirations

YUVI 最初部分受到 [Project AIRI](https://github.com/moeru-ai/airi) 以及更广泛的开源 AI VTuber / Companion 生态启发。

YUVI 是独立实现，并逐渐形成了不同的侧重点：长期个人陪伴、连续性、本地优先运行，以及 Runtime 可靠性。

## License

YUVI 源代码与仓库内资产的许可条件以仓库 License 为准。第三方模型、Live2D Cubism 组件与角色资产可能受各自独立许可约束。
