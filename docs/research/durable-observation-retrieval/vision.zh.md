# 真实 Vision 小样本

2026-10-16，在独立 31505 Server 与 31508 PostgreSQL schema，通过正式 `/message`、Character、Provider accounting、A9 和 Observation。仅用合成图片与 Person/Persona。合法现有 DeepInfra 凭据只在本机受保护目录中使用；没有改变安装版路由。

实验显式选择 `Qwen/Qwen3-VL-30B-A3B-Instruct`，Chat/Reasoning 为 `deepseek-ai/DeepSeek-V4-Flash-0731`，temperature=0、max_tokens=2048。选型依据为 [DeepInfra 视觉模型目录](https://deepinfra.com/models/ocr)；这是实验配置，不是对日常 Alice 配置的推断。沿用已有 accepted-dialogue Harness 与 fetch recorder，增加合成图片输入、删除和原数据库恢复执行，不重建模型设施。

[完整结果及失败](evidence/vision-results.json)、[逐调用](evidence/vision-calls.csv)、[模型输入安全摘要](evidence/vision-input-summary.json)。26 次实际调用合计输入 51,256、输出 1,839、缓存输入 8,192 token；Provider `estimated_cost` 合计 **$0.00360273**，不是最终账单。上限每次进程 60 调用、已知估算 $0.10；恢复时累计检查原有估算。价格没有硬编码套算。

两张图分别包含短文字/印章/公式/三柱图，以及 68 行文字、尾部随机标识、日期与橙色圆。第二轮、第五轮（进程重启后）回答正确的日期、印章、形状、最大柱值、页脚和公式。另一 Person 没有得到私人内容。原报告/图片经 API 删除，换新会话再次追问时明确不可用，没有给出页脚。A9 的 STORED 历史与擦除后的无正文 tombstone 仍在。

保留失败：首轮 Chat 把 A 柱称为 shortest，但 Vision 原报告正确指出 B 比 A 矮、C 最高，属于模型在已获得正确证据后的表达错误。长 OCR 被真实 Vision 主动概括，**不是**实际输出超过 4,000 字符的溢出测试；长 OCR 不挤掉结构字段由确定性生产入口 Fixture 验证。第五轮的细节已存在于首次报告，因此没有证明真实模型主动重看“此前未提取”的细节。没有普遍视觉准确率或复杂图表泛化结论。

首次 Harness 删除请求错误携带空 JSON Content-Type，导致删除前停止；修复传输后在同一 schema 恢复，只补执行删除场景，未重复前九轮成功样本。原失败结果与原始 traces 保存在 `~/.local/state/yuvi-durable-observation-20261016/vision-run-1`，公开资料不含凭据、原始请求图片编码或私人数据。
