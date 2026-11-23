---
id: 5444945b-4af9-40d8-b66b-54bf84682204
slug: skill-watch-design
title: "技能观察周报（Skill Watch）设计"
revision: 1
scope: workspace
workspace_id: e41eb0fb-c367-43cf-a99d-6dc5239a5694
status: active
domain: infra
category: design
landed: proposed
sources:
  - source_id: "file:AGENTS.md"
    source_type: file
    locator: AGENTS.md
    captured_at: 1795396396310
    content_hash: c5cc6ac8fc415a9f19720cac610e47951baf55ad9311dfbc8a087e1b9d93c4e8
  - source_id: "file:skills/using-agentboard/SKILL.md"
    source_type: file
    locator: skills/using-agentboard/SKILL.md
    captured_at: 1795396396310
    content_hash: fa2e262e1e17cb8d5b92f9194230d206b74f2e46608b72e2399ee464df8c33e4
  - source_id: "file:scripts/check-bom.mjs"
    source_type: file
    locator: scripts/check-bom.mjs
    captured_at: 1795396396310
    content_hash: 24e3d1efb9b5307f59d3d0bcaa788cfc405d7e036d1698aba7ea6e2667185dde
  - source_id: "agent:codex-sessions-scan"
    source_type: agent
    locator: "agent:codex-sessions-scan"
    captured_at: 1795396396310
    content_hash: c5cc6ac8fc415a9f19720cac610e47951baf55ad9311dfbc8a087e1b9d93c4e8
evidence:
  - source_id: "file:AGENTS.md"
    locator: "AGENTS.md:8-20"
  - source_id: "file:skills/using-agentboard/SKILL.md"
    locator: "skills/using-agentboard/SKILL.md:38-56"
  - source_id: "file:scripts/check-bom.mjs"
    locator: scripts/check-bom.mjs
  - source_id: "agent:codex-sessions-scan"
    locator: "cmd:python -u work/probe7.py"
    snapshot: "7d window: 59 jsonl sessions, 48 subagent-origin, 11 top-level, scan 1.4s. Real skill reads via tool-call args: using-agentboard 48, executing-task 18, writing-task 16, win-tasks 10, systematic-debugging 6, iso-explode-film 5, handoff 5. Naive full-text grep inflates pdf to 165 (system prompt skill table). Skill roots: 30 global .agents/skills + 81 D:\\WorkSpaces\\skills + 8 project skills = 119 SKILL.md. zst archives in window: 0."
content_hash: d282ce4553d0e4ffb627458a12c2d6adff0a89a029142875df59a8ef4f316d54
expires_at: null
created_at: 1795396403659
updated_at: 1795396403659
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 技能观察周报（Skill Watch）设计

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）D:\WorkSpaces\任务看板

## 目标与边界

每周一次回顾近 7 天全部 Codex 本地会话，产出两类结论：

- A 线：跨会话重复的人工流程 → 新技能候选，仅提案。
- B 线：现有技能使用中的缺陷 → 按分级授权修订 SKILL.md。

不做：不改 AGENTS.md 与全局规则；不改看板服务端数据；不删除技能（只进退役候选清单）；不纳入 ChatGPT 云端对话（本地无原文，仅摘要）。

## 数据源

| 源 | 路径 | 用途 |
| --- | --- | --- |
| 会话原文 | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` | 唯一证据源 |
| 技能清单 | `C:\Users\31633\.agents\skills`；`D:\WorkSpaces\skills\<分类>`；`D:\WorkSpaces\任务看板\skills` | 三处递归 SKILL.md，运行时动态发现，不硬编码 |
| 账本 | `C:\Users\31633\.codex\skill-watch\state.json` | 跨周状态 |

`.jsonl` 为近 7 天未压缩形态，`.jsonl.zst` 为归档；7 天窗口内归档数为 0，只读 `.jsonl`。

## 记录解析契约

- `payload.type == "session_meta"` → `cwd`、`parent_thread_id`（非空即子代理）、`id`。
- `payload.type == "message" && role == "user"` → 人工指令原文。
- `payload.type in ("function_call","custom_tool_call")` → `name` 与 `arguments`/`input`。
- `payload.type in ("function_call_output","custom_tool_call_output")` → 错误信号。
- `event_msg/task_started` → turn 边界。

技能读取判定只取 tool-call 参数与 user 消息中的 SKILL.md 提及。全会话裸 grep 会把系统提示里的技能清单算成读取，一律不采信。

## A 线信号

| 编号 | 信号 | 判定 |
| --- | --- | --- |
| A1 | 人工指令模板重复 | user 消息归一化（剥盘符路径、UUID、数字、日期、空白）后跨会话相同 ≥2 组 |
| A2 | 动作序列重复 | 每 turn 工具名序列滑窗 3-gram，跨会话相同 ≥2 次 |
| A3 | 一次性脚本重复落盘 | 写入路径命中 `\.(py|ps1|mjs|sh)$` 且位于 `work/`、`scripts/`、`.tmp`，同名或内容相同 ≥2 次 |
| A4 | 分类库缺技能 | 读了 `*-router` 且该会话无任何后续技能读取 |

排除项：AgentBoard 每轮加载 `using-agentboard` 属合规流程不计重复；子代理会话内重复属派发扇出，A1/A2/A3 只统计顶层会话；同会话内重试归 B 线。

评分 `score = 独立顶层会话数 × 覆盖工作区数 × 每次人工步数`；≥3 独立顶层会话且无现成技能覆盖才提案。

## B 线信号

| 编号 | 信号 | 判定 | 授权 |
| --- | --- | --- | --- |
| B1 | 引用失效 | SKILL.md 内路径/命令在真实文件系统或 PATH 中不存在 | 直接改 |
| B2 | 加载后报错 | 技能读取后 5 turn 内出现 Traceback / not recognized / ModuleNotFoundError / 退出码非 0 | 直接改 |
| B3 | 触发漏检 | user 消息命中技能触发词但全会话无该技能读取记录 | 提案 |
| B4 | 纠正性语言 | 读取后 user 消息含「又/还是/上次/之前说过/不是让你/错了」 | 提案 |
| B5 | 重复澄清 | 读取后紧跟 ask-user 调用 | 提案 |
| B6 | 规则冲突 | 两份 SKILL.md 指令互斥 | 只报告 |

评分 `score = 严重度(B1/B2=3, B3/B4=2, B5=1) × 复现次数 × min(被读次数,5)`；≥4 进入本周修复队列。

## 流水线

1. L0 抽取（Python，无 LLM）：`skill_watch.py extract --days 7` → `findings.json`，每条信号带 `thread_id` 与字节 offset。
2. L1 判定（LLM）：只读 `findings.json`，聚类、A/B 归类、打分排序。
3. L2 复核（LLM）：按 offset 回读原始 turn 片段确认，不重扫全库。
4. L3 落地：B1/B2 改 SKILL.md（先 grep 全部调用点，改后复验）；A 线与 B3–B6 建看板卡提案；写周报与账本。

## 写权限与配额

- 单次运行最多改 2 个 SKILL.md，其余排队进账本 `queue`。
- 每个改动附 ≥2 条带 `thread_id` 的证据，无证据不改。
- 改前备份到 `C:\Users\31633\.codex\skill-watch\back\<ISO周>\`；复验失败即回滚。
- 措辞、触发词、流程、偏好类一律只提案。

## 生命周期账本

`state.json` 字段：`runs`、`weeks[]`（周标识、各类信号计数、改动清单）、`skills{}`（`reads`、`zero_read_weeks`、`last_changed`）、`queue[]`、`retire_candidates[]`。

`zero_read_weeks >= 4` → 进 `retire_candidates`，只报告不删。

## 冷启动分档

第 1 次运行只出报告与账本，零写操作，供阈值校准。第 2–3 次只提案。第 4 次起允许自动修 B1/B2。档位由 `state.json.runs` 决定，脚本自增。

## 定时任务参数

cron 型，`FREQ=WEEKLY;BYHOUR=21;BYMIN=0;BYDAY=SUN`，执行环境 local，项目挂任务看板（`ddc258c6-dd75-4a3c-94e9-27471ee45e95`）。

## 文件契约

- `C:\Users\31633\.codex\skill-watch\skill_watch.py`：L0 抽取 + B1 静态校验 + 账本。
- `C:\Users\31633\.codex\skill-watch\findings.json`：本周信号。
- `C:\Users\31633\.codex\skill-watch\weeks\<YYYY-Www>.md`：周报。

脚本与账本放 `~\.codex\skill-watch\` 而非仓库内，也不得放进 `~\.codex\skills\`：后者是指向 `C:\Users\31633\.agents\skills` 的 junction，备份副本会被技能清单扫描命中并污染 inventory。仓库内不放是因为运行期 cwd 不固定，且避免把个人工具纳入产品 lint 与便携包清单。

## 验收标准

- `python skill_watch.py inventory` 列出三处根共 119 个 SKILL.md，含 `iso-explode-film`。
- `extract` 输出的 `skill_reads` 中 `pdf` 计数为 0（裸 grep 污染回归探针）。
- `extract` 分别统计顶层与子代理会话数，子代理不参与 A1/A2/A3。
- `verify` 对不存在引用能报出条目，对现存引用零误报（抽样 3 份技能人工核对）。
- 首跑不产生任何 SKILL.md 写入，`state.json.runs == 1`。

## 未验证项

- A1 归一化相似度阈值与 A2 的 3-gram 长度未做假阳性率标定，首跑后按实际命中调整。
- B3 触发词匹配依赖 SKILL.md `description` 中的触发词，非结构化，覆盖率未知。
- 跨周账本一致性未经两次真实运行验证。

