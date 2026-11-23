---
id: 5444945b-4af9-40d8-b66b-54bf84682204
slug: skill-watch-design
title: "技能观察周报（Skill Watch）设计"
revision: 2
scope: workspace
workspace_id: e41eb0fb-c367-43cf-a99d-6dc5239a5694
status: active
domain: infra
category: design
landed: partial
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
  - source_id: "file:skill_watch.py"
    source_type: file
    locator: "C:/Users/31633/.codex/skill-watch/skill_watch.py"
    captured_at: 1795400162709
    content_hash: 1a50924eae6961ff8ce053af2fa79120fac6754f2b1f8c63ae63e9168657243b
evidence:
  - source_id: "agent:codex-sessions-scan"
    locator: "cmd:python -X utf8 C:/Users/31633/.codex/skill-watch/skill_watch.py inventory"
    snapshot: "2026-11-23 first run. Roots raw 38/79/8, realpath UNIQUE 111, junction aliases 14, probes iso-explode-film/using-agentboard/win-tasks OK. extract --days 7: sessions 63 = 11 top-level + 52 subagent, archived_skipped 0, signals A1=1 A2=9 A3=0 A4=0 B2=1 B4=0 B5=0, skill_reads distinct 20 and pdf=0 after tightening skill_refs_in to require an existing absolute path (was 2)."
  - source_id: "file:skill_watch.py"
    locator: "C:/Users/31633/.codex/skill-watch/skill_watch.py:225-245"
  - source_id: "file:skill_watch.py"
    locator: "C:/Users/31633/.codex/skill-watch/skill_watch.py:630-710"
  - source_id: "file:AGENTS.md"
    locator: "AGENTS.md:8-20"
content_hash: 8afacbe08e1c1c77948454334efde4005587af6c23f31d34ddc2e8c4e126ca82
expires_at: null
created_at: 1795396403659
updated_at: 1795400174913
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 技能观察周报（Skill Watch）设计

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）D:\WorkSpaces\任务看板

状态：已落地（landed=partial）。自动修订分支（runs≥4）与跨周账本一致性尚未被真实运行触达，其余按实现回写。

## 目标与边界

每周一次回顾近 7 天全部 Codex 本地会话，产出两类结论：

- A 线：跨会话重复的人工流程 → 新技能候选，仅提案。
- B 线：现有技能使用中的缺陷 → 按分级授权修订 SKILL.md。

不做：不改 AGENTS.md 与全局规则；不改看板服务端数据；不删除技能（只进退役候选清单）；不纳入 ChatGPT 云端对话（本地无原文，仅摘要）；不新建技能文件（新建会触发任务看板 AGENTS.md 四处同源清单，只出提案卡）。

## 数据源

| 源 | 路径 | 用途 |
| --- | --- | --- |
| 会话原文 | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` | 唯一证据源 |
| 技能清单 | `C:\Users\31633\.agents\skills`；`D:\WorkSpaces\skills\<分类>`；`D:\WorkSpaces\任务看板\skills` | 三处递归 SKILL.md，运行时动态发现，不硬编码 |
| 账本 | `C:\Users\31633\.codex\skill-watch\state.json` | 跨周状态 |

`.jsonl` 为近 7 天未压缩形态，`.jsonl.zst` 为归档；7 天窗口内归档数为 0，只读 `.jsonl`，归档数计入 `archived_skipped` 上报。

技能清单实测口径（2026-11-23）：三根 raw 38 / 79 / 8，按 realpath 去重后 **111 个唯一 SKILL.md**，14 个 junction 别名；`.system` 下 6 个平台自带技能排除在诊断之外。原设计写的 119 未去重，作废。

## 记录解析契约

- `session_meta` 的 `type` 在**记录顶层**，不在 `payload.type`；取 `cwd`、`parent_thread_id`（非空即子代理）、`id`。
- `payload.type == "message" && role == "user"` → 人工指令原文。
- `payload.type in ("function_call","custom_tool_call")` → `name` 与 `arguments`/`input`。
- `payload.type in ("function_call_output","custom_tool_call_output")` → 错误信号与 `exit_code`。
- `event_msg/task_started` → turn 边界。

技能读取判定（实现差异，关键）：只取 tool-call 参数与 user 消息中的 SKILL.md 提及，且**绝对路径必须真实存在**才计一次读取。裸 grep 全会话会把系统提示里的技能表（`r0/pdf/SKILL.md` 一类别名）与脚本自身源码里的路径字面量算成读取，实测造成 `pdf` 虚高到 165；收紧后同一窗口 `pdf` 由 2 归零。

## A 线信号

| 编号 | 信号 | 实现判定 |
| --- | --- | --- |
| A1 | 人工指令模板重复 | `clean_user` 剥 harness 注入块（标签对、AGENTS.md 头、Files mentioned、codex-clipboard、Image attachment）→ `norm_text`（Windows/POSIX 路径→`<P>`、UUID→`<U>`、日期→`<D>`、时间→`<T>`、长十六进制→`<H>`、数字→`<N>`）→ difflib 相似度 ≥0.8，命中 ≥2 且跨 ≥2 顶层会话；标记 `skill_invoked`（模板内已含技能调用即视为现成覆盖） |
| A2 | 动作序列重复 | 每 turn **命令头 2-gram**，命中 ≥3 且跨 ≥2 顶层会话；排除样板技能（出现在 ≥35% turn 的技能，实测 `executing-task`、`using-agentboard`） |
| A3 | 一次性脚本重复落盘 | 写入命令与 `*** Add File:` 提取的文件名（数字→`<N>`）跨 ≥2 会话重复 |
| A4 | 分类库缺技能 | 读了 `*-router` 且同轮及其后无任何非-router 技能读取 |

实现差异：A2 原设计用「工具名 3-gram」，实测无信息量（`exec` 与 `wait_agent` 占绝对多数），改为命令头 2-gram；命令头经 `is_cmd_head` 过滤（PATH 可解析 / PowerShell 动词 / 路径存在），否则 `}` `>` `@` 一类碎片会成串命中。

排除项：AgentBoard 每轮加载 `using-agentboard` 属合规流程不计重复；子代理会话内重复属派发扇出，A1/A2/A3 只统计顶层会话（A4 与 B 线读全部会话）。

评分 `score = 独立顶层会话数 × 覆盖工作区数`；≥3 独立顶层会话且无现成技能覆盖才提案。

## B 线信号

| 编号 | 信号 | 判定 | 授权 |
| --- | --- | --- | --- |
| B1 | 引用失效 | 只查 `citation_spans`（代码块 + 反引号）内带目录前缀（`scripts/`、`references/`、`sub-skills/`、`assets/`、`templates/`、`bin/`、`skills/`、`../`）的文件引用是否存在，候选基准为技能目录 4 层祖先 + `--repo`；`kb` 子命令对 `kb --help` 权威校验；示例句与假设句（`for example`/`e.g.`/`would be`/`could be`/`示例`/`例如`）不算缺陷 | 直接改 |
| B2 | 加载后报错 | 同时满足：错误正则命中（行首锚定）+ `exit_code != 0` + 5 turn 窗口内**唯一** owner 技能且其 `skill_cmds(doc)` 与失败命令首 token 相交 | 直接改 |
| B3 | 触发漏检 | user 消息命中技能触发词但全会话无该技能读取记录 | 提案 |
| B4 | 纠正性语言 | 读取后 user 消息含「又/还是/上次/之前说过/不是让你/错了」 | 提案 |
| B5 | 重复澄清 | 读取后紧跟 ask-user 调用 | 提案 |
| B6 | 规则冲突 | 两份 SKILL.md 指令互斥 | 只报告 |

实现状态：B1、B2、B4、B5 已实现；**B3、B6 未实现**（B3 依赖非结构化触发词解析，覆盖率未知；B6 需跨文件语义比对）。评分 `score = 严重度(B1/B2=3, B3/B4=2, B5=1) × 复现次数 × min(被读次数,5)`，≥4 进入本周修复队列；首班未按评分裁剪，全量进队列。

## 流水线

1. L0 抽取（Python，无 LLM）：`skill_watch.py extract --days 7` → `findings.json`，每条信号带 `thread_id` 与字节 offset。
2. L1 判定（LLM）：只读 `findings.json` 与 `verify.json`，聚类、A/B 归类、打分排序，不重扫会话库。
3. L2 复核（LLM）：按 offset 回读原始 turn 片段确认，不重扫全库。
4. L3 落地：B1/B2 改 SKILL.md（先 grep 全部调用点，改后复验）；A 线与 B3–B6 建看板卡提案；写周报与账本。

## 写权限与配额

- 单次运行最多改 2 个 SKILL.md（`FIX_QUOTA=2`），其余排队进账本 `queue`。
- 每个改动附 ≥2 条带 `thread_id` 的证据，无证据不改。
- 改前 `backup --file <SKILL.md 绝对路径>`（可重复）备份到 `C:\Users\31633\.codex\skill-watch\back\<ISO周>\<技能名>__SKILL.md`；复验失败即回滚。
- 措辞、触发词、流程、偏好类一律只提案。

实现差异：脚本**不自动写 SKILL.md**，`report` 只出周报与队列；修订由自动化会话在配额与证据约束内执行并回填周报「本周改动」。

## 生命周期账本

`state.json` 字段：`runs`、`weeks[]`（week、runs_after、window、sessions、counts、verify、changed）、`skills{}`（`reads`、`zero_read_weeks`、`last_changed`）、`queue[]`（kind、skill、value、file、first_seen_week、hits、threads）、`retire_candidates[]`。

`zero_read_weeks >= 4` → 进 `retire_candidates`，只报告不删。队列按 `(kind, skill, value)` 去重，重复命中只累加 `hits`。同周重跑默认直接返回「本周已跑过」，需 `--force` 才累加；`--dry-run` 渲染 `weeks/<周>.dryrun.md` 且不写账本。

## 冷启动分档

`runs<=1` 只出报告与账本、零写操作；`runs` 2–3 只提案；`runs>=4` 允许自动修 B1/B2。档位由 `state.json.runs` 决定，`report` 自增。

## 定时任务参数

cron 型自动化 `skill-watch`：`FREQ=WEEKLY;BYDAY=SU;BYHOUR=21;BYMINUTE=0;BYSECOND=0`（每周日 21:00 本地），执行环境 local，项目挂任务看板（`ddc258c6-dd75-4a3c-94e9-27471ee45e95`），model `gpt-6.2-astra` / reasoning high，notification `failed_runs_only`。

踩坑：`BYDAY` 必须两字母码 `SU`，写 `SUN` 会被判「no future runs」；`mode=create` 禁止带 `DTSTART`（会把本地挂钟时间转 UTC），需要锚定时刻用 `BYHOUR/BYMINUTE`。

## 文件契约

- `C:\Users\31633\.codex\skill-watch\skill_watch.py`：L0 抽取 + B1 静态校验 + 账本 + 周报，子命令 `inventory` / `extract` / `verify` / `report` / `backup` / `self-test`。
- `C:\Users\31633\.codex\skill-watch\findings.json`、`verify.json`：本周信号。
- `C:\Users\31633\.codex\skill-watch\state.json`：账本。
- `C:\Users\31633\.codex\skill-watch\weeks\<YYYY-Www>.md`：周报。

脚本与账本放 `~\.codex\skill-watch\` 而非仓库内，也不得放进 `~\.codex\skills\`：后者是指向 `C:\Users\31633\.agents\skills` 的 junction，备份副本会被技能清单扫描命中并污染 inventory。仓库内不放是因为运行期 cwd 不固定，且避免把个人工具纳入产品 lint 与便携包清单。

## 验收标准

| 项 | 状态（2026-11-23） |
| --- | --- |
| `inventory` 列出三根去重后 111 个唯一 SKILL.md，含 `iso-explode-film` | 通过（111 + 14 别名，三个 probe 全 OK） |
| `extract` 的 `skill_reads` 中 `pdf` 计数为 0（裸 grep 污染回归探针） | 通过（修正前为 2） |
| `extract` 分列顶层与子代理会话数，子代理不参与 A1/A2/A3 | 通过（63 = 11 顶层 + 52 子代理） |
| `verify` 对不存在引用能报条目、对现存引用零误报 | 通过（6 条全部人工核对为真缺陷） |
| 首跑不产生任何 SKILL.md 写入，`state.json.runs == 1` | 通过 |
| `self-test` 断言全绿 | 通过（7 组） |
| 跨周账本一致性 | 未验证（需第二次真实运行） |
| runs≥4 自动修订分支 | 未验证（仅分档判定有断言） |

首班实测：窗口 2026-11-17→2026-11-23，A1=1、A2=9、A3=0、A4=0、B1=6、B2=1、B4=0、B5=0，队列 7 条，退役候选 0，改动 0 个 SKILL.md。

## 未验证项

- A1 相似度阈值 0.8 与 A2 的 2-gram 长度仅按首班样本观察，未做假阳性率标定；A2 命中的 9 条目前全为 `kb`/`git`/`ConvertFrom-Json` 组合，倾向噪声而非新技能候选。
- B3 触发漏检、B6 规则冲突未实现。
- 自动触发（每周日 21:00）未经过一次真实定时运行，首次定时为 2026-11-29。

