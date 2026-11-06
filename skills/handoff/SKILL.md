---
name: handoff
description: 把当前 AgentBoard 工作交接给另一个 agent/会话，或暂停时留下可续接上下文（卡评论 + 知识页 + 真实状态）。触发词：交接、handoff、换人接手、暂停工作、留下上下文。不适用：普通收尾（用 executing-task 的 done）或给已完成卡补记录（仅在用户明确要求时按本技能例外处理）。
---

# AgentBoard Handoff

交接产物只有两类：**任务卡评论**（谁做到哪、下一步做什么）与**项目知识页**（设计点 / 技术点 / 注意点）。不创建交接文档，不把「今天做了什么、什么还没做」写进知识库。

## 工作区边界（强制）

本节优先于本技能其余步骤；冲突时以本节为准。

- **调用即绑定**：技能启动第一步按 `using-agentboard`「工作区边界（强制）」的「调用即绑定」绑定当前工作区。主路径 `kb list-spaces --current`；歧义/无匹配时按该节兜底比对处理，仍无法确定就停下问用户，不猜。
- **默认只在当前工作区内读写**：文件路径必须落在当前工作区根之下；工作区外默认只读。跨工作区任何写入（文件、卡、知识、服务、DB、分支）都必须取得当轮显式授权，并先说明影响面。
🔴 CHECKPOINT · 🛑 STOP：跨工作区写入未取得当轮同意即停手，不写文件、不写卡、不写知识页。
- **越界前自检三问**：① 这个路径 / 任务卡 / 服务实例属于哪个工作区？② 它和当前工作区是同一个吗？③ 若不是，用户是否明确授权过？三问答不全即停手。
- **卡归属校验**：`kb show` 的 `workspace_id` 与绑定工作区不一致即停手，不写入、不流转状态。
- **权威来源**：本节细则以 `using-agentboard` 的「工作区边界（强制）」为准；冲突时以它为准；定位不到即停手报「权威文档缺失」，不按记忆或猜测执行。

### 交接产物的落点

- 两类产物都只写当前工作区：任务卡评论落在绑定的 workspace 上；知识页默认 `--scope workspace --workspace <workspace-id>`。
- 保存知识时 `--scope` 只取 `workspace`（当前工作区，默认）或 `common`（公共范围，仅在用户明确要求时用，此时不带 `--workspace`）；不存在 `project` 取值。
- 需要引用其他工作区的上下文时，只做只读引用：贴路径 + 注明来源工作区 id，不复制粘贴成当前工作区的正式产物。
- 交接完成后在输出里明确写出「本次交接涉及的工作区 id + 路径」。
- 用户要求独立交接文件时，路径必须落在当前工作区内；要求写到工作区外，先走上面的授权流程。

## 停止在跑的子智能体（先消息，后强停）

交接通常伴随「停掉还在干活的人」。顺序固定，不许跳步。**先确认宿主是否提供成员管理能力**：不同运行时工具名不同（如 `list_agents` / `send_message` / `wait_agent` / `interrupt_agent`，或 `TaskOutput` / `SendMessage` / `TaskStop`）。没有对应工具时不得假装已停或已收到回报，改用看板占用 + 子代理自身回复作为事实来源，并在汇报里写明「本宿主无法强停/无法枚举成员」。

1. **清点**：宿主有成员列表工具 → 取 `running` / `provisioning` 成员；没有 → 用 `kb list-tasks --workspace <当前工作区> --status 进行中` 列出占用卡与 `claimed_by`（跨工作区只读盘点才用 `--all`）。两者都只用于确认谁真的在写东西。
2. **先发消息让他们自己收尾**：用宿主可用的消息工具（`send_message` / `SendMessage`）逐个要求回报四件事，明确「收到后不要再改代码、不要再提交」：
   - 当前卡与实际进度（改了哪些文件、到哪一步）；
   - 已核实结论与**未验证项**；
   - 他们掌握的设计点 / 技术点 / 注意点（用于写项目知识页）；
   - 阻塞与下一步建议。
3. **等回报**：有等待工具（`wait_agent` / `TaskOutput`）就等；没有就要求成员在回复里给总结，不空等、不编造。
4. **只有在消息发不出去或必须立刻停**时才强停：消息失败（成员不存在 / 工具报错），或用户要求「立刻停」而成员长时间不回 → 才用强停工具（`interrupt_agent` / `TaskStop`）。
   - 强停后必须复核成员状态是否转为 inactive（有列表工具时）；并在汇报里写明「哪个成员被强停、强停前是否收到过总结、哪些内容因此仍然缺失」。
5. **释放占用**：按下面「Choose the truthful task state」处理；释放动作与「停会话回合」是两件事——`kb fail` 只放卡，不会停在跑的回合，两者都要做。只放卡不判失败用 `kb release <issue-id>`（REL-3：只有当前占用者可执行，退回「待规划」并清空占用，自动带本地 claim 的 fence；非占用者 / fence 过期 / 未被占用退出码 2），或直接 `kb done`/`kb fail` 收尾。

## 写入由调用者本人完成

- 任务卡评论与项目知识页**由调用者自己写**，不另派子智能体代写交接产物（避免二手转述丢失结论）。
- 可以读子智能体的回报、代码、测试输出作为素材；素材必须真实，不得编造。

## Identify the task

🔴 CHECKPOINT · 🛑 STOP：工作区未绑定或存在多个候选即停手，不进入第 1 步。
**启动强制动作：** 先按 `using-agentboard` 的「权威来源解析」确认权威文档可读（不可读即停手报「权威文档缺失」，不降级执行），再按「工作区边界（强制）」绑定当前工作区，再进入第 1 步；后续步骤只在该工作区内进行。
交接前按 `using-agentboard` 的「开工前必读（项目上下文）」读三样：当前工作区知识（`--scope workspace`）、公共范围知识（`--scope common`）、最近变更日志；判据同该节——`category=open` 或 `landed=proposed|partial` 的页不得当成已实现事实。细节见该节，不在此复制。

1. **确定范围**：用户点名了卡就用那张；id 必须是完整 36 位 UUID（任务 id 前缀不解析，CLI-02），用户给短 id 时先索要完整 id，不猜。用户说「交接整个项目 / 暂停所有工作」时不虚构单卡，按「多卡交接」处理（见下）。
2. Determine the caller's agent identity from the runtime or explicit `KB_AGENT` setting. Do not assume the CLI default.
3. 单卡正常交接仅当该卡状态为进行中且 owner = caller；否则不改状态、不评论、不释放，只报告实际状态。
4. Narrow exception：用户明确只要求给某张已完成卡补交接记录时，允许写评论；有可复用设计点/技术点/注意点才写知识页（没有则不写，并在评论注明），不得 `claim`/`done`/`fail`，状态与 owner 保持不变。
🔴 CHECKPOINT · 🛑 STOP：`kb show` 的 workspace 与绑定工作区不一致即停手。

## 一、任务卡评论（进度与下一步的家）

单卡交接：在**该卡**上写一条评论，包含

- 实际进度：改了哪些文件（`:行号`）、做到哪一步；
- 已核实结论与**未验证项**（分开写，未验证不得写成通过）；
- 阻塞（含 `kb dep ls` 的未解除 blocker 与被阻塞者）；
- 下一步的具体动作；
- 提交号（有则写；没有提交的改动要写明「未提交，需接手者先 `git status` 核对」）。

多卡交接（用户要求暂停全部工作）：**逐卡写评论**，每卡一段，不复用同一段文字；不要在知识库建一张「总体交接」页。
`Get-Content -Raw handoff.md | kb comment <issue-id> --stdin`（PowerShell 不支持 `<` 重定向；标题/长文含双引号时用单引号或 `--stdin`，CLI-01）。

## 二、项目知识页（只写设计点 / 技术点 / 注意点）

内容口径以 `using-agentboard` 的「知识页写什么（内容口径）」为准（本节只讲交接场景的落点，不复制口径）；两处冲突时以该节为准。

- **写什么**：架构与模块边界、关键契约与状态机、数据库/迁移/存储口径、验证套路与坑（含「为什么这样修」「怎么验才算验过」）、已知不可行路径。
- **不写什么**：今天完成了什么、哪些卡关了、剩余待办清单、某人的进度——这些属于卡评论与看板状态，不属于知识库。
- **粒度**：按**领域**分页（如「服务端与数据」「前端与交互」「测试与门禁」「坑与注意点」），不要按日期或按人分页；已有同主题页优先**修订**（`--expected-revision`）而不是新建同义页。
- **slug**：语义化、稳定（如 `agentboard-server-data`、`agentboard-frontend-ux`、`agentboard-testing-gates`、`agentboard-pitfalls`）；**不使用** `handoff-<issue-uuid>` 命名，也不新建「交接文档」类页。
- **重复判定**：写前先 `kb knowledge list --scope workspace --workspace <ws-id> --status all --include-expired` 找同主题页（`--scope` 必填；跨公共知识加一次 `--scope common`）；存在则修订（贴 `--expected-revision`），无则新建。`KNOWLEDGE_EXISTS`(409) 时按 slug 找回落。
- **新建必须带分类与来源/证据**：`kb knowledge create ... --domain accounts|knowledge|board|chat|ui|infra --stdin --sources-file sources.json --evidence-file evidence.json`（缺 `--stdin`/`--sources`/`--evidence` 任一即退出 1，缺 `--domain` 即 400；一次性把已有 md/txt 建成页可用 `kb knowledge import <file> --domain … --category …`，sources 自动构造）。`--domain` 必填（KB-CR-1，空串/非法值同样 400）；`--category design|solved|pinned|open` 缺省落 `open`（KB-CR-1 起不再兜底 `legacy`），仍应显式传。设计类同时给 `--landed proposed|partial|landed`。

知识页字段（服务端要求 `sources`/`evidence` 各 ≥1 条）：`sources[]` = `source_id`（1–200，如 `file:apps/server/src/index.ts`）、`source_type`（`file|url|agent`）、`locator`（相对路径 / URL / agent 名）、`captured_at`（epoch ms）、`content_hash`（sha256 hex，按真实字节算）、`snapshot?`（仅 url / agent 来源可带，≤2 KiB 真实摘录；file 来源带了服务端直接拒「本地代码来源只保存路径和 hash」）；`evidence[]` = `source_id`（须精确指向同次写入的 sources 之一）、`locator`（仓库相对路径 + 可选行号区间，如 `apps/web/src/x.ts:125-137`；非文件证据只用 `cmd:` / `issue:` / `agent:` 前缀，不写 `file:12-30` 这类无路径裸行号畸形条目）、`snapshot?`（只放简短摘要或 diff 片段，禁止整段工具报告 JSON；file 来源的证据不带）。同一 evidence 不重复登记，同一提交多条只保留一条。口径以 `using-agentboard`「知识页写什么（内容口径）」的「证据书写口径」条为准，两处冲突时以该节为准。长 JSON 用 `--sources-file` / `--evidence-file` 传，正文用 `--stdin`。`body_md` ≤100,000 字符。

写完必须回读：`kb knowledge show <page-id> --scope workspace --workspace <ws-id>` 确认 page id / scope / revision / 内容；回读失败就如实报「未保存」，不得声称已保存。

## Choose the truthful task state

🔴 CHECKPOINT · 🛑 STOP：命中「已完成任务补交接」例外时，只写评论（及可选知识页），禁止 claim / done / fail。

按 1→5 顺序取第一条命中，只决定目标状态，不执行动作：

1. **已完成任务补交接（例外）**：状态为待验收/已关闭且 owner 为空 → 写评论；有可复用结论才写知识页，状态与 owner 不变。
2. **正常交接且任务已完成、自检通过**：caller 占用中，评论已写并回读，且已按 `using-agentboard` 的 CLOSE-RECORD 处理收尾物——可复用结论写工作区知识页（新建必带 `--category`；无则 notes 显式声明「未沉淀知识页：<原因>」）+ 变更日志一律写 + notes 带知识页/变更日志 id 与声明 → `kb done <issue-id> --notes-stdin --scope <path>`（`--scope` 逐条传；无文件改动则不传并在 notes 写明）。卡面含新增 REST 路由 / WS 事件 / 定时器 / CLI 命令 / DB 迁移时必须过 RULE-3：证明外部可触达（真实 app 断言 / 事件实发 / ticker 实跑），或在卡面写明接线归属并建 `blocks` 边，两者都没有不得 `done`。只 done 到待验收，不等于关闭。
3. **用户结束本 worker 或转交未完成任务**：评论已写 → `kb fail <issue-id> --reason '交接待续：已完成…；剩余…；未验证…；阻塞…；见本卡评论与知识页 <slug/page-id>（未沉淀则写「未沉淀知识页：原因」）'`。reason 必须自包含，不能让卡被释放后无迹可查；只想放卡不判失败时可 `kb release <issue-id>`（当前占用者专属，退回待规划）。
4. **交接执行失败或必需自检失败**：`kb fail <issue-id> --reason '...'` 写具体失败或阻塞，并按「不完整交接」汇报。
5. **继续正常工作或在等用户决策**：需要用户拍板时走 `ask-user`（`kb ask` 落决策，默认宽限 180 秒；夜间无人值守用 `--grace 0`）；返回 `LOCKED` 时把确切问题与 `next_step` 写进交接评论后停手，不要只靠「保持占用」等回复。

### 执行前守卫（每次 `done`/`fail` 都必须过）

🔴 CHECKPOINT · 🛑 STOP：`done`/`fail` 前占用或状态已变即停手。

- 重拉 `kb show` 确认 caller 仍占用且卡仍为进行中；不通过则不做任何状态流转。
- 所有权/状态已变，或必需写入失败 → 只报实际持久化状态，不修改他人 claim、不强制释放。

## Output files

- 日常交接**不创建** `Docs/交接文档.md` 或任何交接文件。
- 用户明确要求独立文件时，只建在指定位置，且遵守上面路径规则；不主动删除旧文件。
- 每次交接结束必须写一行：本次涉及的工作区 id + 绝对路径 + 是否发生跨工作区读写（是/否；若是，写授权依据）+ 已验证的命令与结果（未验证的明确标「未验证」）。缺这行视为交接不完整。
