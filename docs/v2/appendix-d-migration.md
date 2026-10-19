# 附录 D　数据保护与迁移

> 原则：
>
> - V1 的数据只读、永不修改，至少保存两份（其中一份离开这台机器）；
> - V2 只从恢复出的副本导入；
> - 本文的命令是**草案**，由你在自己的机器上审读后执行。本次规划没有接触任何真实用户数据。

## D.1 资产清单

| 资产                            | V1 中的位置                                                                                                   | 内容                               | 能否重建                                         | 导出方式                         | V2 中的去处                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------- |
| 对话                            | PostgreSQL：`conversation_sessions`、`conversation_messages` 及回复组件表                                     | 你与 YUVI 的全部对话               | **不能**                                         | `pg_dump`                        | 经历（你的话）与行为（YUVI 的话），保留原时间与原 id                  |
| 生活日志                        | `journal_*`（迁移 013）                                                                                       | 收到的输入、载荷、保留状态、父事件 | **不能**                                         | `pg_dump`                        | 经历 / 行为；保留状态原样映射到 `retention`                           |
| 效果账本                        | `effect_*`、`native_control_*`                                                                                | 动作的意图、尝试、结果             | **不能**（是真实发生过的事）                     | `pg_dump`                        | 行为与 `delivery` 经历；`UNKNOWN` 保持 `UNKNOWN`                      |
| 记忆                            | `memories`、`memory_evidence_admissions`、`recent_episodes`、`entities`、`relations`、`finalized_ingestion_*` | V1 抽取的关于你的事实、情节        | 部分能（可由对话重新抽取，但历史版本只有这一份） | `pg_dump`                        | 想法，作者标记为“V1 系统”，`origin=v1_import`；不当作 YUVI 现在的认识 |
| P8 纠正                         | `p8_corrections`                                                                                              | 你对人设或认识的纠正               | **不能**                                         | `pg_dump`                        | 控制事件（`persona_edit` 或纠正）                                     |
| Profile                         | `profile_*`                                                                                                   | 物化的画像快照                     | 能（派生）                                       | `pg_dump`（仅存档）              | 仅存档，不导入                                                        |
| R5 记忆权威（如已安装发行候选） | `memory_authority_*`，Host / Person 表（迁移 026–045）                                                        | 命题级记忆及其纠正关系；身份激活   | 部分能                                           | `pg_dump`                        | 想法（保留取代关系）；Person 绑定作为控制事件                         |
| Mem0 集合                       | PostgreSQL 中由 `mem0_pg_collection` 配置的 pgvector 表（可能在另一个库，按配置确认）                         | 向量化的记忆                       | 能（向量可重算；文本可能有独有内容）             | `pg_dump` 对应的库 / 表          | 文本作为 V1 想法导入；向量不导入                                      |
| 声纹库                          | local-stt 数据目录下的 `speakers.json` / `speakers.npz`（及其分代目录）                                       | 说话人声纹与绑定                   | **不能**（需要重新录音）                         | 复制文件                         | 第五阶段原样给语音客户端使用                                          |
| 主动策略                        | 运行时环境目录中的 `proactive-policy.json`                                                                    | 同意与抑制设置                     | 能（但代表你的意愿）                             | 复制文件                         | 控制事件（同意设置）                                                  |
| 产品设置                        | `product-settings.json`；Tauri 配置目录中的 `settings.json`                                                   | 模型路由、界面设置                 | 能                                               | 复制文件                         | 参考，不导入                                                          |
| 密钥                            | 系统钥匙串                                                                                                    | API 密钥                           | 能（重新填写）                                   | **不导出明文**                   | 在 V2 中重新配置                                                      |
| Live2D 模型                     | data 目录中的导入模型                                                                                         | 你导入的形象资源                   | 视来源而定                                       | 复制目录                         | 第五阶段使用                                                          |
| 人设                            | Plunge 分支 `docs/personas/alice.md`；运行时的人设配置                                                        | Alice 的作者设定                   | 仓库中能；运行时的修改不能                       | 复制文件 + git                   | 自我描述第 0 版                                                       |
| QQ 历史                         | SnowLuma 侧的本地消息库                                                                                       | 群聊与私聊历史                     | **不能**                                         | 按 SnowLuma 的导出方式（需确认） | 经历（群 / 私聊场景），需你决定保留范围                               |

**需要你确认的事实：**

- 真实的 Alice 运行在哪台机器上、哪个版本？[#323](https://github.com/Ruichen-0079/YUVI/pull/323) 提到安装的是 `5064c29`。
- PostgreSQL 是系统服务、应用私有集群，还是 R5 发行包自带的 PostgreSQL 16？
- Mem0 用的是同一个库吗？
- SnowLuma 的数据存在哪里？

## D.2 导出（第零阶段，由你执行）

```bash
# 0. 记下版本与位置
git -C <V1 安装目录> rev-parse HEAD > export/v1-version.txt

# 1. 停止对外行动，避免导出期间有新写入（按实际部署：systemd 用户服务或 Supervisor）
systemctl --user stop <yuvi 相关服务>

# 2. 数据库：整库自定义格式导出（包含 Mem0 表；若 Mem0 在另一库，同样导出）
pg_dump -Fc -d <yuvi_db> -f export/yuvi.dump
pg_dump -Fc -d <mem0_db> -f export/mem0.dump        # 如适用

# 3. 文件资产（只复制，不移动）
cp -a <stt 数据目录>/speakers* export/voice/
cp -a <runtime env 目录>/proactive-policy.json <runtime env 目录>/product-settings.json export/config/
cp -a <tauri 配置目录>/settings.json export/config/
cp -a <live2d 模型目录> export/live2d/
cp -a <persona 文件> export/persona/
# QQ / SnowLuma：按其导出方式

# 4. 清单与校验
(cd export && find . -type f -print0 | sort -z | xargs -0 sha256sum) > export.sha256

# 5. 两份副本，其中一份离开本机
tar -cf yuvi-v1-archive-$(date +%Y%m%d).tar export export.sha256

# 6. 恢复验证：在临时库中恢复一次，确认可读、行数合理
createdb yuvi_restore_check && pg_restore -d yuvi_restore_check export/yuvi.dump

# 7. 重新启动 V1，继续正常使用
systemctl --user start <yuvi 相关服务>
```

**不做的事：**

- 不删除、不修改 V1 的任何表和文件；
- 不导出明文密钥；
- 不把归档放进任何仓库。

## D.3 导入（第一阶段，在副本上）

导入器读取恢复出的临时库和文件副本，写入一个**新的** `life.sqlite`。导入的每个事件都满足：

- `origin = 'v1_import'`；
- 原表名与原 id 存入 `meta`；
- 时间使用原记录中的时间；
- 没有时间的写 `unknown`。

**映射规则：**

| V1 来源                                       | V2 事件                                      | 说明                                                                                                         |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 用户消息                                      | `experience/heard`，actor 为你               | 场景按会话来源：桌面或 QQ                                                                                    |
| 助手消息                                      | `act/said`，actor 为 yuvi                    | 意图 / 尝试 / 结果三段式在 V1 中不完整，导入为单个 `said`，`meta.delivery = 'unknown'`，除非效果账本中有回执 |
| 日志事件                                      | 按模态映射为 `heard` / `saw` / `tool_result` | 保留状态原样映射；已删改的仍为墓碑                                                                           |
| 效果账本                                      | `act/called_tool` 与 `experience/delivery`   | `UNKNOWN` 保持                                                                                               |
| V1 记忆、R5 命题、Mem0 文本                   | `thought/belief`，`model = 'v1-system'`      | 带上 V1 记录的来源引用（若能映射到导入的事件 id）；否则标 `cites = []`，此时不计入支持，只作历史             |
| P8 纠正                                       | `control/persona_edit` 或纠正                | 作为你的控制变更                                                                                             |
| 沉默                                          | 不生成事件                                   | main 上从未记录；不伪造                                                                                      |
| R4/R5 堆叠上记录的沉默 / 失败回合（如已安装） | `act/silent` 或 `control/error`              | 保持原意                                                                                                     |

## D.4 核对

1. **对账：** 每张源表的行数 = 导入事件数 + 报告中列出的未映射行数。
2. **抽样：** 随机抽取 50 个导入事件，由你对照原记录阅读确认。
3. **引用检查：** 导入的 V1 想法中，能映射到事件 id 的比例；不能映射的列入报告。
4. **一致性：** 用导入的生活文件重建全部投影两次，两次结果必须一致。
5. **报告：** 写入 `import-report.md`，与生活文件放在一起，不入仓库。

## D.5 切换与保留

- **切换时机：** 第二阶段门槛之后，即进入第三阶段时。
- **切换步骤：**
  1. 再做一次增量导出：只导入上次导出之后的新对话与日志；
  2. V1 停止对外行动；
  3. V2 以导入后的生活继续。
- **开发分叉：** 第一、二阶段的 `v2-dev` 分叉不并入 Alice 的主线，作为研究档案单独保存（见蓝图 §3.6 第 6 步）。
- **V1 的保留：** V1 的数据库和文件保留可读，至少保留到 V2 稳定运行半年，并且归档永久保留。
- **删除请求：** 如果你要求删除某段内容，V2 中按删改处理；V1 归档中的同一内容，是否删除由你决定，并记录在 V2 的控制事件中。
