---
name: writing-task
description: 把已批准的需求/设计拆成有序的 AgentBoard 任务卡（验收标准、依赖、父子层级、落板顺序）。触发词：拆卡、建卡、写任务、任务树、依赖、验收标准、writing-task。不适用：单步小改、需求未批准（先 brainstorming）或只需执行已派卡（用 executing-task）。
---

# Writing Task

Use this skill when an approved spec or request needs multiple implementation steps. AgentBoard issues are the authoritative execution plan. Do not require a plan Markdown file, ledger, task brief, or local checklist as the source of work. 单步小改、需求未批准、或只是执行别人派的卡时不要用本技能。Project design docs, source files, logs, and other project artifacts may be cited as evidence.

**无卡不动手（RULE-1）**：本技能是实现性改动的唯一建卡入口；没有对应卡就先建卡，派工前先确认卡已存在，同一内容已有卡就认领/追加、不重复新建（口径见 `using-agentboard` 的「The Rule」）。

Read the AgentBoard operating guide before preparing board work. 该文档的定位按 `using-agentboard` 的「权威来源解析」执行（本技能不复制解析表）；解析不到 → 🔴 停手报「权威文档缺失」，不降级执行。

## 工作区边界（强制）

本节优先于本技能其余步骤；冲突时以本节为准。

- **调用即绑定**：技能启动第一步按 `using-agentboard`「工作区边界（强制）」的「调用即绑定」绑定当前工作区。主路径 `kb list-spaces --current`；歧义/无匹配时按该节的兜底比对（实体路径 + 最长前缀）处理，仍无法确定就停下问用户，不猜。
- **默认只在当前工作区内读写**：计划产物与文件路径必须落在当前工作区根之下；工作区外默认只读。跨工作区任何写入（文件、卡、知识、服务、DB、分支）都必须取得当轮显式授权，并先说明影响面。
🔴 CHECKPOINT · 🛑 STOP：跨工作区写入未取得当轮同意即停手，不写文件、不建卡。
- **越界前自检三问**：① 这个路径 / 任务卡 / 服务实例属于哪个工作区？② 它和当前工作区是同一个吗？③ 若不是，用户是否明确授权过？三问答不全即停手。
- **卡归属校验**：`kb show` 的 `workspace_id` 与绑定工作区不一致即停手，不写入、不流转状态。
- **权威来源**：本节细则以 `using-agentboard` 的「工作区边界（强制）」为准；冲突时以它为准；定位不到即停手报「权威文档缺失」，不按记忆或猜测执行。

### 计划产物的落点

- 计划首行 `工作区：<name>（<id>）<path>`（取自 `kb list-spaces --current` 或兜底比对的真实值）写进**卡描述首行**——`kb create-issue … -d` 的第一行或事后 `kb update <id> --description-stdin`；缺这行视为计划未完成。默认不新建计划文件。
- 仅当项目已有约定（如 `Docs/` 计划目录）才落盘成文档，且只放在当前工作区内，写绝对路径并断言前缀命中当前工作区根。
- 计划里涉及其他工作区的步骤，必须单独成段标注「跨工作区步骤（需用户授权）」，写明目标工作区 id/path 与影响面；不得混写进常规步骤。
- 交付计划时写明本次计划涉及的工作区 id + 路径；发生跨工作区动作则写出授权依据。

## Roles and scope

- The parent agent owns design, planning, assignment, acceptance, and summary. It prepares exact issue titles and descriptions, then delegates AgentBoard creation or comments to a child agent.
- The child assigned to board operations uses only the explicitly provided workspace and issue IDs. It creates or comments on plan issues as directed. Creating a planning issue does not require claiming it.
- Do not choose a workspace, issue, or task to claim by guesswork. If the workspace or target issue is missing, prepare the proposed plan without a board write and ask for that identifier.
- Do not create separate test-only issues. Put requested or project-required verification in the issue that owns the implementation.

## Prepare the plan

🔴 CHECKPOINT · 🛑 STOP：当前工作区未绑定或存在多个候选即停手，不进入第 1 步。
**启动强制动作：** 先按 `using-agentboard` 的「权威来源解析」确认权威文档可读（不可读即停手报「权威文档缺失」，不降级执行），再按「工作区边界（强制）」绑定当前工作区，定下计划首行的工作区标识，再进入第 1 步。
开工前（建卡前）按 `using-agentboard` 的「开工前必读（项目上下文）」读三样：当前工作区知识（`--scope workspace`）、公共范围知识（`--scope common`）、最近变更日志；判据同该节——`category=open` 或 `landed=proposed|partial` 的页不得当成已实现事实。细节见该节，不在此复制。

1. Confirm the approved requirements and any design decisions that affect interfaces, data, scope, or acceptance.
2. Inspect the relevant project files and established patterns before naming exact files, interfaces, or commands. Mark unknown details instead of inventing them.
3. Split work into independently reviewable deliverables: one issue = one coherent change. Check the five split thresholds in 「拆分子任务（强制）」 before splitting (crosses ≥2 packages/ends, ≥3 independently verifiable steps, >8 files or >400 lines, ≥5 independent acceptance items, mixed 功能新增 + 重构/迁移/配置); any hit → parent issue + child issues via `--parent`, not one big card.
4. For each issue, prepare:
   - Goal and expected result.
   - Included scope and important exclusions.
   - Known files, interfaces, or project artifacts it touches.
   - Ordered implementation steps and any prerequisite issue IDs. Write prerequisites as structured edges: `kb dep add <issue-id> <blocker-id>` (blocker 解除后本卡才可 claim). 描述里可留 plain issue id（如 `前置：<前置卡完整 UUID>（顺序不可交换）`）供人阅读，但**权威来源是边表**（`kb dep ls`）；不要另造依赖字段。任务 id 必须写完整 36 位 UUID——前缀不解析（`kb show 4908a07e` → 任务不存在，CLI-02）。
   - Acceptance criteria and requested or project-required verification, with observable expected results. At least one line per issue carries an observable check, e.g. `验收：POST /api/handoff 返回 201；kb show <完整 UUID> 状态为待验收`.
   - 若该 issue 涉及其他工作区：单独标注「跨工作区步骤（需用户授权）」，写明目标工作区 id/path 与影响面，不混进常规步骤。
5. Self-review against this fixed checklist: (a) every issue states ≥1 observable acceptance line; (b) every prerequisite is recorded as a structured edge (`kb dep add`) and verified with `kb dep ls`; (c) no issue trips a 拆分子任务 threshold without an explicit parent/child split; (d) cross-workspace steps sit under 「跨工作区步骤（需用户授权）」, not in normal steps. Keep implementation choices open where the spec does not decide them.

## 拆分子任务（强制）

以下任一成立，先把工作拆成子卡再派，不得合成一张大卡：

- 改动跨 ≥2 个包或端（`apps/web` + `apps/server`、`packages/*`、`apps/mcp`）
- 需要 ≥3 个独立可验收的交付步骤
- 预估改动 >8 个文件或 >400 行
- 卡内验收条目 ≥5 条且彼此独立
- 同一卡内混有「功能新增」与「重构/迁移/配置」两类性质不同的工作

建子卡：`kb create-issue <workspace> '<子卡标题>' -d '<目标/范围/边界/验收>' --parent <父卡 id> --labels <标签>`（含双引号时用单引号或 `--description-stdin`）；建边：`kb dep add <子卡 id> <前置卡 id>`，建完用 `kb dep ls <子卡 id>` 复核边存在且前置正确；父卡描述里写清子卡顺序（plain issue id 供人阅读，权威来源是边表）。所有 id 用返回的全长 UUID。

父卡只承载汇总与顺序，不承载实现；子卡全部 done 只到待验收，父卡可以 done 汇总，但 `kb close` 要求所有后代已关闭（否则 409），先逐张 close 子卡再 close 父卡。notes 汇总各子卡结论。

## 失败分支（本技能特有）

通用故障（CLI 缺失 127、退出码 1、`kb` 命令与参数口径）一律按 `using-agentboard` 的「故障分支」与「kb 命令速查」处理；本节只补计划这一侧会踩的分支，不复述那份内容。每条按「如果失败 → 一线处理 → 仍失败兜底」执行。

- **建卡失败**：`kb create-issue` 非 0 退出或报错 → 一线：退出码 1 按 `using-agentboard` 的「故障分支」判断（退出码 1 报错文本不稳定，可能是服务未启动，也可能只是裸 `fetch failed`），先确认服务地址再决定是否重试一次；127 按「CLI 缺失」装 CLI 后重试一次；`-d` 长文被引号/换行截断 → 改为 `kb create-issue <ws> '<标题>' -p <优先级>` 先建卡，再用 `Get-Content -Raw desc.md | kb update <新卡 id> --description-stdin` 写完整描述（不要写进评论，描述首行是计划锚点）。兜底：仍失败则停止建卡，把完整计划原样回报父代理；不得改用 `using-agentboard` 未记录的其它命令，不得手改服务端数据绕过。
- **拿不到 workspace id**：`kb list-spaces` 与 cwd 比不中、命中多个不同根、或返回空 → 一线：一次问清用户 workspace 的 id、name、path 三项，不猜、不按名字试。兜底：用户未回时只输出完整计划，首行写 `工作区：待定（未绑定）` 并停手——不建卡、不试建一张验证卡、不跨区写入。
- **父卡 id 缺失或挂错**：要写 `--parent` 时 → 一线：父卡 id 未知就先建父卡、拿返回 id 再建子卡；对已知 id 用 `kb show <父卡 id>` 核对 `workspace_id` 与当前工作区一致、且确为本次计划的父卡。已挂错 → 二线：`kb update <子卡 id> --parent <正确父卡 id>` 改挂（或 `kb move-issue <子卡 id> --parent <正确父卡 id>`，以 `--help` 为准），再 `kb show` 复核；并在卡评论记录原父卡 id 与修正时间。兜底：改挂被服务端拒绝或会形成环 → 不删卡重建，回报父代理与用户决定，并在计划里标注该子卡「归属待修正」。
- **跨工作区步骤被拒**：计划含跨工作区步骤而用户未授权或明确拒绝 → 一线：把该步骤从常规步骤移出，单列「跨工作区步骤（需用户授权）」段，写明目标工作区 id/path 与影响面；用户拒绝后从计划删除该步骤，并在父卡描述写 `已移除：<步骤>（未获授权）`，不留可执行形态。兜底：用户改口授权 → 复述影响面、拿当轮同意后单独建卡并在描述标授权依据；授权前该卡不得 claim。

## Record the plan in AgentBoard

🔴 CHECKPOINT · 🛑 STOP：计划首行工作区标识缺失或与绑定工作区不一致即停手，不建卡。
**落板前强制动作：** 确认计划首行「工作区：<name>（<id>）<path>」已写且与绑定的当前工作区一致；不一致先停下问用户，不得按任一方直接建卡。

Follow the CLI and failure handling in the AgentBoard guide. Use only its documented commands:

- For each new work item, create an issue in the exact workspace supplied by the parent. Use the documented form: `kb create-issue <workspace> '<title>' -d '<description>'`; if title/description contains a double quote, wrap with single quotes or use `--description-stdin` (PowerShell otherwise swallows following args, CLI-01). All returned IDs are full 36-char UUIDs; copy them whole (prefixes do not resolve for issues).
- Create prerequisite issues first so their returned IDs can be used as blockers. Record dependencies as structured edges with kb dep add <issue-id> <blocker-id> and verify with kb dep ls; plain issue IDs in descriptions are for human readers only — the edge table is authoritative.
- For detailed multi-line plan content, add it with kb comment <issue-id> --stdin. For an existing issue, read it with kb show first, then add a comment.
- If the plan changes, record the change with kb comment and, for description edits, `kb update <issue-id> --description-stdin` (the CLI does define `kb update`; do not invent new subcommands). Reread with `kb show` afterwards.
- Do not claim an issue just to create or record a plan. Do not modify another agent's claimed issue.
- Return the created or updated issue IDs, their dependency order, and any unresolved questions to the parent. Do not begin implementation unless separately assigned.
