"""Build the PR research index (CSV/JSON) from the cached GitHub API responses.

Usage: python3 classify.py <cache_dir> <out_dir>
Themes and research classes are assigned by title/branch rules, then corrected
by the manual OVERRIDES table, which records the reviewer's judgement for PRs
whose rule-based class would be misleading.
"""
import csv, json, os, re, sys

cache, out = sys.argv[1], sys.argv[2]
rows = json.load(open(os.path.join(cache, 'index_rows.json')))

THEMES = [
    ('过程', r'agentbus|canary|AgentBus'),
    ('因果账本/权威', r'journal|authority|effect|evidence|host|lineage|grant|observation|reachability|boundar'),
    ('记忆', r'memory|mem0|recall|retriev|dream|episod|mrl|embedding|correction'),
    ('身份/人格', r'\bp8\b|p8-|identity|persona|profile|people|person'),
    ('Character', r'character'),
    ('认知/能力', r'cognition|capabilit|mcp|reasoning|read-text'),
    ('主动性/注意', r'proactive|\bp6\b|p6-|attention|scheduler|should-speak|behavior policy|gaze policy|silent'),
    ('具身/呈现', r'embodied|presentation|live2d|lumi|companion|presence|subtitle|expression|smile|overlay|framing|cubism'),
    ('语音', r'\bstt\b|stt|tts|voice|speech|vad|barge|microphone|dots|audio'),
    ('视觉', r'vision|visual'),
    ('Provider', r'provider|routing|model binding|openai-compatible|fallback|deepinfra|glm|stream contract|chat stream'),
    ('平台/打包', r'desktop|tauri|supervisor|tray|packag|release|linux|windows|portable|installer|postgres|install|host-env|lifecycle|surface|secret|xdg|cache roots|astra|campaign'),
    ('产品界面', r'webui|\bweb\b|\bui\b|dashboard|settings|i18n|typography|readme|product'),
    ('结构', r'refactor|structural|extract|relocat'),
    ('规划/文档', r'docs|roadmap|future|audit|baseline|spec|eval|dataset|closure'),
    ('CI', r'\bci\b|ci:'),
]

def theme(r):
    t = (r['title'] + ' ' + r['head']).lower()
    for name, pat in THEMES:
        if re.search(pat, t, re.I):
            return name
    return '其他'

def default_class(r):
    if r['state'] == 'closed':
        return 'D'
    if r['state'] == 'open':
        return 'B?'
    return 'B'

# Manual research classification: class letter + short note.
# A = original research proposition, B = verified engineering, C = unverified
# hypothesis / unwired contract, D = exposed-problem or superseded route,
# M = maintenance/process. "B?" = open, engineering evidence but not merged.
OV = {}
def ov(nums, cls, note=''):
    for n in nums:
        OV[n] = (cls, note)

ov([1], 'B', 'Windows-first 开发基线；6 月唯一 PR，之后 08-25 被 Linux-first 取代')
ov([2], 'B', '巨型集成：桌面/Tauri/Live2D/TTS + Mem0 M0/M1；先前 7 月以前工作的唯一入口')
ov([3], 'D', '被 #4 干净重建取代')
ov([4], 'D', 'Mem0 接入实时对话（infer=true 路径）；一周后被 #9 关闭 infer，整体路线在 R5 中被取代')
ov([5,6,7], 'B', 'Windows 桌面 Supervisor / 凭据 / 打包；之后 Windows 整体延期')
ov([8], 'D', 'Mem0 Python sidecar 打包（PyInstaller）；Windows 路线后延期，Mem0 本身在 R5 被替代')
ov([9], 'B', 'P3：MemoryEvent 证据模型；“Memory 只记录发生了什么，不改写关系/情绪/人格”；关闭 Mem0 infer=true')
ov([10], 'B', 'scope 失败闭合')
ov([11,12,13,14,15,17], 'B', 'P4：面向外部 Mem0 sidecar 的崩溃安全/幂等投递账本；工程可靠但服务于后被替代的存储')
ov([16], 'M', '/tmp 工具链路径事故')
ov([18], 'D', 'Windows 私有 PostgreSQL 所有权；随 Linux-first 延期')
ov([19], 'M', 'CI 缓存')
ov([20], 'D', '44 条 AgentBus 评论循环卡在 Windows 进程身份证明；关闭为 DEFERRED')
ov([21,23,25,27,29,32,33,36,37,39], 'B', 'P7 Provider 合同（取消、回退、错误语义）；通用基础设施')
ov([22,24,26,28,30], 'B', 'P5 呈现/播放正确性')
ov([31,34,35,38], 'D', 'P6 Web 侧规则化“语义行为”/静默注意（计时器、冷却）；权威后在 Atom 08/10 迁回 Runtime')
ov([40,43,45,49], 'B', 'P7-8 设置/诊断真实性（AgentBus 交付）')
ov([41], 'B', 'P6-E0B：助手发起回合，无合成用户消息、无主动写记忆')
ov([42,44,46,47,48], 'D', 'P6-E 主动文字微切片（同意→投影→握手→惰性客户端→首次效果）；后被 Runtime 调度器取代')
ov([50,52,53], 'D', 'AgentBus v2 canary/实验，关闭为历史产物')
ov([54], 'B', '关键转折：放弃 Windows 私有 PG 扩张，Linux-first 持久化基线')
ov([55,56], 'D', 'P6 自动主动候选（12s 空闲/30s 冷却/每空闲期一次）；后被 Atom 10 取代')
ov([57], 'C', 'Runtime NO_OP|REQUEST_TEXT 控制前导；真实 V4 模型协议 MALFORMED')
ov([58,62], 'B', 'OpenAI 兼容 Provider（DeepInfra）')
ov([59,60], 'C', '主动性提示词修补；V4 仍未通过 hard-open 用例')
ov([61], 'C', '为补偿模型协议遵循不足，拆成 Llama-70B 决策 + V4 写作的双模型；3 次/用例的小样本')
ov(list(range(63,67))+[69,70,71,72,73,74,75,77,78,79,80,81,83,84,85,86,89], 'M', 'Structural R：App.tsx/RuntimeOrchestrator 机械拆分，语义不变')
ov([67,68,87], 'D', '当前状态文档快照，关闭为过时')
ov([76], 'M', 'CI Windows 打包门槛')
ov([82], 'A', 'Future 01–08（08-28）：持久本地伴侣、连续性、沉默、Character/Cognition 分工、训练阶段；混合了研究命题与技术建议')
ov([88], 'M', 'README 刷新')
ov([90], 'B', '本地 Qwen3-Embedding 512 维 MRL；Recall@5 0.875 的实测检索基础设施')
ov([91], 'B', '语音转写进入持久用户回合')
ov([92,93,94,95,98,99], 'C', 'P8-1A..1F 纯合同包：身份/证据解释/纠正；当时未接入生产（见 #283）')
ov([96], 'D', '过早合并，被 #97 回滚')
ov([97], 'D', '回滚 #96')
ov([100,101,102,111], 'C', 'Character ABI 2A–2D 纯合同')
ov(list(range(103,111))+[112,113,114,115], 'C', 'Character Harness 5A–5L：为一个从未出现的后训练 Character 模型准备的边界')
ov([116,117], 'M', 'Phase 5 收尾文档')
ov(list(range(118,134))+[135,136,138,140,141,142,144,148,149,150,151,152,153,154], 'C', 'Phase 6 Cognition 6A–6AC：一天内约 30 个原子，仅一个 read_text_file 能力；收尾时生产仍走旧 ChatProvider')
ov([134,137,139,145,147], 'D', '并行代理产生的重复 6M/6W PR，关闭')
ov([143], 'C', 'Memory vNext（Grok 代理）：L0/L1/L2、Dream、联想侵入、压缩原语；上下文预算补偿为主，Dream idle 从未在生产触发')
ov([146,162,163,166,171], 'D', '代理侧分支（sol/grok/luna）被关闭或拆分迁移')
ov([155], 'M', 'Phase 6 收尾文档')
ov(list(range(156,162))+[164,165,167,168,169,170]+list(range(173,197)), 'C', 'Phase 7 具身效果生命周期：约 35 个 PR 把一个 soft-smile 表情 token 接到 Runtime 生命周期')
ov([172], 'D', '被 #173 取代')
ov([197], 'M', 'Phase 7 收尾文档')
ov([198,199,201,211,212,213], 'B', '本地 STT（sherpa-onnx）与桌面麦克风')
ov([200,202,205], 'D', '诊断/重复/历史图表，关闭')
ov([203], 'A', '关键转折：Memory-first 运营路线；完整 Temporal/Continuity 仅在真实失败证明后建设；训练（阶段 9–13）延期到真实长期使用之后')
ov([204,206,207], 'C', 'Phase 8 行为规范/评估/偏好数据治理：为未执行的训练计划准备')
ov([208], 'B', '运营落地审计（B1–B3 阻断）')
ov([209,210], 'B', 'POSIX 开发运行、打包 PG 持久化')
ov([214,215], 'B', 'Chat（DeepSeek V4 Flash）+ Cognition（GLM-5.3-Flash）默认装配')
ov([216,217,218], 'B', '真实性修正')
ov([219], 'C', '首次把 NEED_COGNITION 接入生产；未做真实模型验收（代理环境无凭据）')
ov([220], 'B', '托盘生命周期')
ov([221,227,228,229,230], 'D', 'Windows 托盘 Quit 诊断循环（DIAG229/230，19 次提交）；Windows 延期')
ov([222], 'C', '“校准版”生产人格提示词（v7–v10 校准证据未入库）')
ov([223], 'D', 'Vision→Character 图像回合，被 Campaign E 按需视觉取代')
ov([224], 'C', 'P8 主档投影（被取代证据降级）；Profile 后来无产品读方')
ov([225], 'D', 'Web 状态机语音模式，被 Atom 14 取代')
ov([226], 'B', 'Supervisor 有界关停')
ov([231], 'M', 'Atom 01–21 计划文档')
ov([232], 'C', 'CharacterDecision：要求模型输出 addressing 等解释标签；生产将桌面回合预设为 DIRECTED_TO_YUVI')
ov([233,239,241], 'B', 'STT 观测≠用户消息；捕获纪元；实时 VAD')
ov([234], 'B', 'Runtime 拥有 Character→Cognition→再进入；SILENCE 不写助手行（自身沉默选择不入历史）')
ov([235], 'B', '从 Windows 循环得出的“无信息增益两次即停”规则')
ov([236], 'B', 'Linux-first CI')
ov([237,243], 'C', 'Runtime 主动策略/单调度器：硬门槛 + 30s/120s 计时 + 一次模型判断')
ov([238,240,242,244,246,247,248,252,253,264,266,267], 'B', 'Linux 桌面/Supervisor/表面/Secret Service：真实 KDE 验收')
ov([245], 'B', 'Atom 12 多说话人归因：assertor/subject/provenanceClass/rawText 保留（单测级）')
ov([249,250], 'B', '身份提及解析、声纹→Person 可信绑定')
ov([251], 'B', '语音模式 + 打断')
ov([254], 'B', '设置界面')
ov([255,256], 'D', '超时加大假设/设置迁移，阻断或取代')
ov([257,258,259,261,262], 'B', 'Product WebUI 基线')
ov([260], 'B', '主待办保留规则 + 反过度工程门槛；视觉改为按需一次性 grounding')
ov([263], 'C', 'soft-smile 经 Main 到 Live2D（ParamMouthForm=1 临时值）')
ov([265], 'B', '输出语言偏好')
ov([268,269], 'M', 'Campaign A 收尾文档')
ov([270,271,272,274,275,276,277,278,279,280,281], 'B', 'Campaign B–I / Linux 发布门：真实安装与生命周期验收')
ov([273], 'B', 'Campaign E 按需视觉 grounding（真实截图 1 次；VLM 验收因无模型跳过）')
ov([282], 'M', '仓库更名')
ov([283], 'B', '关键证据：生产 Character 此前从提示词文本重建 P8/Memory，合同包未真正接线；本 PR 接通')
ov([284], 'C', 'Chat-only 核心；主动“说话分数”阈值；默认规则记忆提取；L1 折叠旧对话')
ov([285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,317,318,319,320], 'B', 'v0.1.0–v0.1.2 产品化与 Linux 发布')
ov([315], 'D', '被主线修复取代')
ov([316], 'B', '撤除旧 CharacterStyle 提示词权威（“1-3 sentences”）')
ov([321], 'A', '持久功能性自我（PR 关闭，仅 E7/E8 保留到 research-methodology）')
ov([322], 'B?', '后端边界修复；撤除关键词 CurrentAffect 预解释；“Don\'t forget”被误解为删除')
ov([323], 'B?', '实测模型损失：心跳丢正文、发表文本被截 800 字、length 被整体拒绝；n=3 真实模型对照')
ov([324], 'B?', 'R4：自然语言纠正此前零候选或旧事实仍当前；重启后 3/3 使用新值')
ov([325,326], 'B?', 'R5 PostgreSQL 权威记忆（命题级当前投影、无规则回退）；大量合成负载证据')
ov([327], 'B?', '生产真实性：测试此前在 mock 下绕过 Character；把已接纳会话原文按模型窗口交给 Character')
ov([328], 'B?', '已接纳输入与 Journal/会话/摄取决定同事务；沉默/失败回合也能形成记忆')
ov([329,330,331,332,333], 'B?', '观察留存原子化、检索排序/组合检索/证据支持判定；真实模型小样本')
ov([334,335], 'B?', 'WebUI/原生 Host 身份与首次 Person 激活')
ov([336], 'B?', 'R5 RC：干净 Debian12 VM 首装→身份创建→形成/纠正→系统重启召回→整机冷恢复；真实模型 B 阻断')
ov([337], 'B?', 'Supervisor 死亡后的 systemd/cgroup 收容与恢复；14 类矩阵；仍为 fixture 模型')


# Manual theme corrections where title keywords mislead the rule table.
THEME_OV = {}
def tov(nums, t):
    for n in nums:
        THEME_OV[n] = t
tov([5,16,166,266,267,271,281,301,310,317], '平台/打包')
tov([12,15,324,325,326,330,331,332,333], '记忆')
tov([28,164,165,167,168,172,173,174,175,176,180,181,184,185,293], '具身/呈现')
tov([29,43,45,285], 'Provider')
tov([35,44,46,47,48,237], '主动性/注意')
tov([49,162,218,276,300,307], '产品界面')
tov([52,53], '过程')
tov([63,64,65,66,69,70,71,72,73,74,75,77,78,85,86], '结构')
tov([82,87,88,203,260,268,269,321], '规划/文档')
tov([93,94,95,96,97,98,202,290,334,335], '身份/人格')
tov([101,265,284,316,323,327], 'Character')
tov([118,131,132,140,142,151,152], '认知/能力')
tov([223,308], '视觉')
tov([233,239,277,279], '语音')
tov([236], 'CI')

out_rows = []
for r in rows:
    cls, note = OV.get(r['n'], (default_class(r), ''))
    agent = r['head'].split('/')[0] if '/' in r['head'] else ''
    out_rows.append(dict(number=r['n'], created=r['created'], state=r['state'],
        closed_or_merged=r['merged'] or r['closed'], head=r['head'], base=r['base'],
        agent_prefix=agent, theme=THEME_OV.get(r['n'], theme(r)), research_class=cls, note=note,
        title=r['title'], additions=r['add'], deletions=r['dele'], files=r['nfiles'],
        commits=r['ncommits'], comments=r['ncom'],
        url=f"https://github.com/Ruichen-0079/YUVI/pull/{r['n']}"))
os.makedirs(out, exist_ok=True)
json.dump(out_rows, open(os.path.join(out, 'pr-index.json'), 'w'), ensure_ascii=False, indent=1)
with open(os.path.join(out, 'pr-index.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
    w.writeheader(); w.writerows(out_rows)
from collections import Counter
print(Counter(x['research_class'] for x in out_rows))
print(Counter(x['theme'] for x in out_rows))
print('no-override:', [x['number'] for x in out_rows if x['number'] not in OV])
