---
name: executing-task
description: 执行父代理明确派发的 AgentBoard 卡（读最新状态、原子 claim、过程汇报、完成/失败收尾）；目标文件不相交时最多 3 张卡并行。触发词：执行卡、领卡、做任务、claim、收尾、executing-task。不适用：拆卡/建卡（用 writing-task）、未被派卡的自主找活（用 swing-dev）。
---

# Executing AgentBoard Work

Read and follow the AgentBoard operating guide before board operations. 该文档的定位按 `using-agentboard` 的「权威来源解析」执行（本技能不复制解析表）；解析不到 → 🔴 停手报「权威文档缺失」，不降级执行。

**无卡不动手（RULE-1）**：只执行已存在并被 claim 的卡；开工前核对卡号与卡面，提交信息必须带卡号；发现改动落在卡外先停下补卡或回报，不得先改后补（口径见 `using-agentboard` 的「The Rule」）。

**派工前查占用（RULE-2）**：开工前 `kb show <全长 UUID>` 核对 `claimed_by` 与同文件 owner；发现他人占用或同文件已有他卡在飞即停手，先在卡上 `kb comment` 留言协调，不抢改、不并行。

The assigned AgentBoard issue is the current execution source. Project code, design documents, logs, and test results are evidence; do not require a plan file, ledger, task brief, or local plan workspace.

本技能默认执行被指派的一张卡；并行推进多张卡时按「并行执行（最多 3 路）」一节执行，单卡流程不变。

## 工作区边界与执行环境（强制）

通用边界（调用即绑定、默认只写当前工作区、跨区授权、越界三问、卡归属校验）一律按 `using-agentboard` 的「工作区边界（强制）」执行，本节不复制；冲突时以该节为准，定位不到即停手报「权威文档缺失」。

本技能额外要求（执行环境归属）：

🔴 CHECKPOINT · 🛑 STOP：运行环境（端口/服务实例/DB 路径/`APPDATA`）不属于当前工作区即停手，不执行。
- 执行前核对端口、服务实例、DB 路径、`APPDATA` 是否属于当前工作区；目标是别的项目（别的仓库起的服务、正式业务库）→ 停下报告。
- 临时文件放当前工作区临时目录或系统临时目录；不得改其他工作区文件、不得杀/重启外部进程、不得对其他工作区做 git 写操作（commit、reset、checkout、push 等）。

## Roles and assignment

- The parent owns planning, assignment, acceptance, and summary, delegating board operations and implementation to at most 3 child workers (per 「并行执行」). A worker executes only the issue ID + workspace assigned to it, never touches another worker's card, and does not recursively delegate or claim by guessing; parallel runs are allowed only under 「并行执行（最多 3 路）」.
- worker 回合结束/回到 inactive 不等于卡完成；续做同一张还是续派下一张由父代理按 `swing-dev` 第 7 节「续派判定」以 `kb show` 的 `status` 为准决定，worker 不自行判断下一张。
- If the parent only requests a plan, do not claim or execute; follow dependencies recorded as issue IDs (`kb show`), and report an unready or unclear prerequisite to the parent before claiming.

## 并行执行（最多 3 路，强制）

默认一卡一 worker；父会话在准入通过后可同时推进最多 3 张卡，单卡流程（claim → 执行 → 收尾）不变。

- **并发上限硬性为 3**（含父会话自己执行的那张）：第 4 张一律排队，不得因为「卡小 / 看起来简单」而超限。同一工作区若已有别的会话在飞、且改同一批文件，即使允许 3 路也必须降级为串行或跳过；跨工作区并行需逐区授权，不得借并行绕过。
- **准入：目标文件集不相交**。领取前逐卡列出「目标/禁止文件」清单并两两做交集；交集非空 → 排队串行。目录前缀按重叠计，样例：`apps/web/src/components/settings/**`、`apps/server/src/db/repos/knowledge.ts`、`apps/server/src/api/routes.ts`、`packages/cli/src/index.ts` 任一两两不得同时在飞。
- **一卡一 worker，worker 不跨卡**：每个 worker 只 claim 自己那张、只改本卡文件、只提交本卡路径；不得帮别的 worker 收尾、改卡或顺手修它范围内的文件。卡面确实要求动归属别的卡 / 别的 agent 的文件或目录时（同一工作区内也算），动手前在相关卡 `kb comment` 留一行 `改动声明：<文件> ｜ <YYYY-MM-DD HH:mm 本地> ｜ <意图>`，并把这行原文带进收尾回报；没这行就改别人的地盘，视同越界。
- **领取纪律**：`kb show <全长 UUID>` 核对 status 与 claimed_by；已被他人占用且租约未过期 → 跳过，不抢。僵尸租约按 `using-agentboard` 口径处理，需用户授权才能强制释放，本技能不自行释放。close/done/fail 一律全长 UUID，禁止短码。
- **失败隔离**：任一 worker 遇到阻塞（目标文件有他人未提交改动、卡被占用、测试失败非自身改动引起）→ 只停这一路（`kb fail` 或评论 + 保持占用），其余 worker 继续跑完并各自收尾；不得因一个失败整批中断，也不得把该失败记到其它卡上。
- **提交纪律**：每卡单独提交，按 `using-agentboard` 的「收尾与提交（GIT-ON-DONE）」由 `kb done --scope` 只提交本卡声明路径；禁止 `git add -A` 与手动 `git commit` 兜底。提交后核对 `git show --stat <hash>` 只含本卡文件，混入他卡或未声明文件即停手报告。
- **收尾纪律**：每卡 `done` 后按 `using-agentboard`「收尾与提交」的「收尾状态回读」核对 `status=待验收`；汇总里每个数字（并发数、完成/失败数、提交数、各状态条数）都必须能追到实跑输出并各附一行复算命令，看板计数类优先用 `kb stats --workspace <id>` 一次取全，不估算、不引用他人转述。
- **输出纪律**：worker 只回「卡号 / 结果 / 提交短 hash / 一句话阻塞」，禁止贴测试日志、整段 diff 或大段命令输出；父会话汇总按同一格式逐卡一行。单轮输出失控会直接废掉整轮（此前一次推 5 张卡的日志把窗口撑爆），宁可不并行也不放大输出。
- **并发不等于抢占**：见「并发上限硬性为 3」的末句（同区撞文件降级串行、跨区逐区授权）。

## Claim the assigned issue

🔴 CHECKPOINT · 🛑 STOP：工作区未绑定或执行环境归属校验未过即停手，不进入第 1 步。启动时先按 `using-agentboard` 的「权威来源解析」确认权威文档可读（不可读即停手报「权威文档缺失」），再绑定工作区并完成执行环境校验。
开工前按 `using-agentboard` 的「开工前必读（项目上下文）」读三样：当前工作区知识（`--scope workspace`）、公共范围知识（`--scope common`）、最近变更日志；claim 后再核一次目标区域是否已被他人改过；判据同该节——`category=open` 或 `landed=proposed|partial` 的页不得当成已实现事实。细节见该节，不在此复制。

1. Confirm the exact issue ID from the parent. CLI 接受 ≥8 位唯一前缀（实测 `kb show 230c15de` → 详情，exit 0；7 位 → 任务不存在，exit 1；多命中 exit 2），但**卡面、依赖、提交信息一律用完整 36 字符 UUID**（8-4-4-4-12）；父代理只给短前缀时先 `kb show <前缀>` 解析出完整 id 再记录，不猜。Run kb show <issue-id> and read the current description, status, comments, and workspace. Then run kb dep ls <issue-id>: unresolved blockers mean the issue cannot be claimed yet. **状态门禁**按 `using-agentboard` 的「claim 状态门禁」执行（接受「待规划」或「进行中且无人占用」；其余状态、他人占用、决策锁均退出码 2），并以其分支文案区分三类原因；仍以 `kb show` 的真实 status / claimed_by 为准，别把状态拒绝误判成他人占用。
2. Claim only that issue with kb claim <issue-id>. A successful claim is exclusive. Use the returned workspace path.
3. 被 blocker 挡住时（退出码 2，文案「存在未完成的前置任务」）→ 报告父代理并停手；**不得** release 他人占用，**不得** 用 `kb dep rm` 或自行补边解锁；等 blocker 到「待验收/已关闭」后再 claim。🔴 CHECKPOINT · 🛑 STOP：遇到未解除 blocker 即停手，不 claim、不 release 他人占用、不删边解锁。不按本卡「一次性 claim」重试，也不改选别的卡。
4. If `kb claim` exits 2, read stderr text and branch (文本模式原因写 stderr；`--json` 时错误体是 stdout 的 `{"error":{"code","message","details"}}`，退出码不变 — CLI-04): 「已被 … 占用」→ occupied; 「状态不可领取（当前=…）」→ status gate; 「存在未完成的前置任务」→ blocked; 「决策锁」→ open decision. Stop and report the exact conflict to the parent; do not retry, choose another issue, or force-release another agent's claim. 释放自有占用用 `kb release <issue-id>`（退回待规划，不算失败）；他人的占用只能等 `done`/`fail`，或用户授权后走 REST 强制释放。Claim 成功后先 `kb show` 重读再实施。

## Execute and report

- At start, when blocked, at major milestones, and before completion, reread the issue with kb show and record progress with kb comment at the start, when blocked, and at major phase completions. Treat the latest kb show result as authoritative if the user edits the title, description, priority, labels, or comments. 卡面引用别处原文（设计文档、日志、别人的 handoff、其他工作区的文件）时按「工作区 id + 相对路径 + 文件名」写坐标（如 `工作区 e41eb0fb-…：Docs/api.md §退出码`），据此打开原文再动手；只写「见 xx handoff」「参考那份设计」不算引用，打不开原文就停下问父代理，不靠猜补口径。
- If scope or plan details need amendment, explain the proposed change in a comment and reread with kb show; for description/parent/priority/labels edits use the documented `kb update <id> --description-stdin` / `--parent` / `--priority` / `--labels` (or `kb move-issue`), then re-read. Do not invent undocumented subcommands. **本卡改动运行时语义（异常处理、返回值语义、调用契约）而卡面没有「影响面扫描清单」时，先补扫描再动手**：调用点（`grep -rn <符号> apps packages`）／现有断言与用例／验收探针三项用 `kb comment` 落进卡面，然后 `kb show` 重读；没补清单就改行为，视同卡外改动。
- If a user decision is required, follow `ask-user`: run `kb ask` (default 180s grace) instead of parking the claim in a comment; on `LOCKED` stop work at the checkpoint, and use `--grace 0` for unattended runs. `ask-user` 是**唯一提问通道**，优先级高于任何其它提问 / 确认工具：一旦用 `kb ask`，本任务内不得再调用其它 ask 类工具，宽限期间也不得另开通道催问（见 `ask-user` 的「优先级与互斥（硬约束）」）。**要拍板的取舍必须立项成决策（`kb ask`），不得只散落在评论里等人看见**；接手与派活前先看有没有现成待决：`kb decisions --state open`（超 72 小时未处理加 `--stale`，锁定某张卡加 `--issue <卡 id>`），有 open 决策未答的卡不压新活。Check the latest issue state before acting on a reply.
- Perform only the verification required by the issue/user/project rules, record actual commands and outcomes (never claim unrun checks), and keep verification in the implementation issue — do not create a separate test issue.
- 每次写文件前过一遍越界三问；进程/端口/DB 归属不明时按本节的执行环境归属要求先查后动，路径不在当前工作区即停手。
- 描述里把前置写成 plain issue id 时，用 `kb dep add <本卡 id> <前置卡 id>` 补录成结构化边，再用 `kb dep ls <本卡 id>` 复核；补录后若仍有未解除 blocker，按 claim 段的阻塞口径报告父代理，不自行解锁。

## 工作量超出时拆卡（强制，不得硬做完）

开工取证后或执行中断时，出现以下任一情况，必须在继续实现前拆卡：

- 实际改动跨 ≥2 个包或端
- 需要 ≥3 个独立可验收的交付步骤
- 实际改动预计 >8 个文件或 >400 行
- 卡内验收条目 ≥5 条且彼此独立
- 实际工作量超卡面描述 2 倍，或需要卡面未授权的设计决策

操作顺序：

1. 按依赖顺序逐条建子卡：`kb create-issue <ws> '<子卡标题>' -d '<目标/范围/边界/验收>' --parent <本卡 id>`（标题含双引号时用单引号或 `--title-stdin`；`create-issue` **没有** `--description-stdin`，长描述先建卡再 `kb update <子卡 id> --description-stdin`）；
2. `kb comment <本卡>` 写拆分理由、子卡 id 列表与顺序；
3. 本卡保持占用作为父卡（不 done、不 fail），继续 claim 并执行顺序上的第一张子卡；子卡目标文件互不相交时，可按「并行执行（最多 3 路）」把多张子卡分给不同 worker，父卡保持占用、不参与实现；
4. 子卡全部 done 且验收通过后，才 `kb close` 子卡、再对父卡 `kb done --notes "已由子卡 N 完成：…"`；父卡 `close` 前必须所有后代已关闭。

不得把超出判据的工作塞进单张卡硬做完，也不得未经拆分直接 done。

## 收尾必须证明外部可触达（RULE-3）

卡里新增了 REST 路由、WS 事件、定时器/ticker、CLI 命令或数据库迁移时，`kb done` 之前必须给出**外部能调到**的证据，二选一：

- **自证接线**：起真实 app（如 `createApp`）打真实请求/事件，断言端点非 404、事件真发出、ticker 真跑；把命令与结果写进 notes。
- **交代接手方**：卡面写明「接线由哪张卡负责」，并用 `kb dep add <接线卡> <本卡>` 建 `blocks` 边；只写一句「后续接线」不算交代。

只写实现不接线、又没交代接手方的，不算完成，**不能 `kb done`**。典型反例：DEC-3 的 REST 路由写完从未挂载、DEC-9 的宽限 ticker 写完从未启动，两张卡都标了完成，最后靠补卡 `aa0b9c69` 才接上线。

## Finish

- When the assigned work meets its acceptance criteria and required verification, run `kb done <issue-id> --notes '<结果>' --scope <path>` (multi-line or quoted notes via `--notes-stdin`). This moves the issue to pending acceptance and releases the claim; it does not mean the issue is closed. Stop work after done and report the issue ID to the parent for acceptance.
- **提交口径（GIT-ON-DONE）**：按 `using-agentboard` 的「收尾与提交（GIT-ON-DONE）」执行——`--scope` 逐条传、只声明真正改动的路径、不手动 `git commit`、纯看板任务用 `--board-only`（MCP `board_only: true`）跳过提交；不能自动提交与 `kb done` 退出码 1 均按该节原因码与补救命令处理，不重跑 `done`。
- **状态核对**：按 `using-agentboard` 的「收尾与提交（GIT-ON-DONE）」中「收尾状态回读」核对 `status=待验收` 与占用已释放，核对步骤不得省略。
- **done 前置（CLOSE-RECORD）**：按 `using-agentboard`「领任务 → 执行 → 汇报」第 4 步执行（知识页 / 变更日志 / notes 带 id / `--scope` 四项缺一不可）。**变更日志有机器门禁（SK-05），以下任一即放行**：① 先 `kb changelog create --issue <卡 id> --title '<标题>' --type 新增|修复|调整 --stdin` 再普通 `kb done`（门禁认 `issue_id=本卡` 的日志，不带 `--issue` 不算）；② `kb done <id> --close-record --changelog-title '<标题>' --type 新增|修复|调整 [--knowledge-page <已有页 id>] --notes-stdin --scope <路径>`（changelog 先写、失败不落 done，notes 自动追加 `close-record:`，正文可用 `--changelog-body` 覆盖）；③ 本次确无用户可见变更 → `kb done … --no-changelog`。三者都没有会 400 `CHANGELOG_ACK_REQUIRED`，done 不执行。**知识页没有门禁**：不会报错，所以「有可复用结论就建页、没有就在 notes 声明原因」必须自己过一遍。
- **设计页回改检查（ARCH-04，强制）**：`kb done` 会检查本卡（含父链）关联的 `design` 知识页；仍有 `landed=proposed` 时 done 直接失败。必须先 `kb knowledge revise <页 id> --landed landed|partial` 回改落地状态，或确认本卡不推进设计时加 `--design-not-advanced`（声明写入 notes）。不得绕过门禁。
- 无法完成/自验失败 → `kb fail <id> --reason '<具体阻塞>'`（回待规划并释放占用）；等用户拍板 → 走 `ask-user`（`kb ask`，无人值守 `--grace 0`），`LOCKED` 即停手，决策未答期间不得 done/fail；只用 AgentBoard 指南文档化的命令与状态流转（`kb update` / `kb move-issue` 存在，别自造命令、状态字段或端口），CLI/服务故障按指南故障分支处理。
🔴 CHECKPOINT · 🛑 STOP：收尾回报缺工作区 id/路径、改动清单、跨区声明、验证命令与结果任一项即停手，不跑 `kb done`。收尾回报按 `using-agentboard` 的「收尾声明」四要素写全（工作区 id+路径、改动文件全路径清单含 `改动声明：…` 原文、跨区声明及授权依据、验证命令与结果及复算命令）；缺任一项视为执行未完成。
