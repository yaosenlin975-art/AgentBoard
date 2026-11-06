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

## 工作区边界（强制）

本节优先于本技能其余步骤；冲突时以本节为准。

- **调用即绑定**：技能启动第一步按 `using-agentboard`「工作区边界（强制）」的「调用即绑定」绑定当前工作区。主路径 `kb list-spaces --current`；歧义/无匹配时按该节兜底比对处理，仍无法确定就停下问用户，不猜。
- **默认只在当前工作区内读写**：改动文件、临时文件、脚本输出路径都必须落在当前工作区根之下；工作区外默认只读。跨工作区任何写入（文件、卡、知识、服务、DB、分支）都必须取得当轮显式授权，并先说明影响面。
🔴 CHECKPOINT · 🛑 STOP：跨工作区写入未取得当轮同意即停手，不写文件、不改卡。
- **越界前自检三问**：① 这个路径 / 任务卡 / 服务实例属于哪个工作区？② 它和当前工作区是同一个吗？③ 若不是，用户是否明确授权过？三问答不全即停手。
- **卡归属校验**：`kb show` 的 `workspace_id` 与绑定工作区不一致即停手，不写入、不流转状态。
- **权威来源**：本节细则以 `using-agentboard` 的「工作区边界（强制）」为准；冲突时以它为准；定位不到即停手报「权威文档缺失」，不按记忆或猜测执行。

### 执行环境归属校验

🔴 CHECKPOINT · 🛑 STOP：运行环境（端口/服务实例/DB 路径/`APPDATA`）不属于当前工作区即停手，不执行。
- 执行前先核对端口、服务实例、DB 路径、`APPDATA` 等运行环境是否属于当前工作区。发现目标实例属于别的项目（例如别的仓库起的服务、正式业务库），先停下报告，不执行。
- 每一步动文件前确认目标路径在当前工作区内；需要临时文件时放当前工作区的临时目录或系统临时目录，不要落到其他工作区。
- 明确禁止：不得为跑通脚本去改其他工作区的文件；不得杀掉或重启不属于当前工作区的进程；不得对其他工作区执行 git 写操作（commit、reset、checkout、push 等）。

## Roles and assignment

- The parent agent owns planning, assignment, acceptance, and summary. It delegates actual board operations and implementation to one or more child workers (at most 3, per 「并行执行」).
- A worker executes only the specific issue ID and workspace assigned by the parent; it never touches another worker's card. Multiple workers may run in parallel only under 「并行执行（最多 3 路）」 (hard cap 3, disjoint target files). Do not recursively delegate, search for unrelated work, or claim a task by guessing.
- If the parent is only requesting a plan, do not claim or execute an issue.
- Follow dependencies recorded as issue IDs. Check referenced issues with kb show. If a prerequisite is not ready or the dependency order is unclear, report the blocker to the parent before claiming or proceeding.

## 并行执行（最多 3 路，强制）

默认一卡一 worker；父会话在准入通过后可同时推进最多 3 张卡，单卡流程（claim → 执行 → 收尾）不变。

- **并发上限硬性为 3**（含父会话自己执行的那张）：第 4 张一律排队，不得因为「卡小 / 看起来简单」而超限。
- **准入：目标文件集不相交**。领取前逐卡列出「目标/禁止文件」清单并两两做交集；交集非空 → 排队串行。目录前缀按重叠计，样例：`apps/web/src/components/settings/**`、`apps/server/src/db/repos/knowledge.ts`、`apps/server/src/api/routes.ts`、`packages/cli/src/index.ts` 任一两两不得同时在飞。
- **一卡一 worker，worker 不跨卡**：每个 worker 只 claim 自己那张、只改本卡文件、只提交本卡路径；不得帮别的 worker 收尾、改卡或顺手修它范围内的文件。卡面确实要求动归属别的卡 / 别的 agent 的文件或目录时（同一工作区内也算），动手前在相关卡 `kb comment` 留一行 `改动声明：<文件> ｜ <YYYY-MM-DD HH:mm 本地> ｜ <意图>`，并把这行原文带进收尾回报；没这行就改别人的地盘，视同越界。
- **领取纪律**：`kb show <全长 UUID>` 核对 status 与 claimed_by；已被他人占用且租约未过期 → 跳过，不抢。僵尸租约按 `using-agentboard` 口径处理，需用户授权才能强制释放，本技能不自行释放。close/done/fail 一律全长 UUID，禁止短码。
- **失败隔离**：任一 worker 遇到阻塞（目标文件有他人未提交改动、卡被占用、测试失败非自身改动引起）→ 只停这一路（`kb fail` 或评论 + 保持占用），其余 worker 继续跑完并各自收尾；不得因一个失败整批中断，也不得把该失败记到其它卡上。
- **提交纪律**：每卡单独提交，由 `kb done --scope` 只提交本卡声明路径；禁止 `git add -A`，禁止手动 `git commit` 兜底。提交后核对 `git show --stat <hash>` 只含本卡文件；混入他卡或未声明文件即停手报告，不带病继续。
- **收尾纪律**：每卡 `done` 后立刻 `kb show` 回读，确认 status=待验收；汇总里的每个数字（并发数、完成/失败数、提交数）都必须能追到逐卡回读记录，不得估算，并且每个数字后面各附一行可重算命令，如 `待验收 3 —— 复算：kb list-tasks --workspace <id> --status 待验收 --json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).items.length"`（列表类命令 `--json` 返回 `{items,next_offset}`，复算取 `.items.length`），按命令重算，不引用他人转述。
- **输出纪律**：worker 只回「卡号 / 结果 / 提交短 hash / 一句话阻塞」，禁止贴测试日志、整段 diff 或大段命令输出；父会话汇总按同一格式逐卡一行。单轮输出失控会直接废掉整轮（此前一次推 5 张卡的日志把窗口撑爆），宁可不并行也不放大输出。
- **并发不等于抢占**：同一工作区若已有别的会话在飞、且改同一批文件，即使本技能允许 3 路，也必须降级为串行或跳过；跨工作区并行需按工作区边界逐区授权，不得借并行绕过。

## Claim the assigned issue

🔴 CHECKPOINT · 🛑 STOP：工作区未绑定或执行环境归属校验未过即停手，不进入第 1 步。
**启动强制动作：** 先按 `using-agentboard` 的「权威来源解析」确认权威文档可读（不可读即停手报「权威文档缺失」，不降级执行），再按「工作区边界（强制）」绑定当前工作区并完成执行环境归属校验，再进入第 1 步。
开工前按 `using-agentboard` 的「开工前必读（项目上下文）」读三样：当前工作区知识（`--scope workspace`）、公共范围知识（`--scope common`）、最近变更日志；claim 后再核一次目标区域是否已被他人改过；判据同该节——`category=open` 或 `landed=proposed|partial` 的页不得当成已实现事实。细节见该节，不在此复制。

1. Confirm the exact issue ID from the parent. It must be the full 36-character UUID (8-4-4-4-12) — issue id prefixes never resolve (`kb show 4908a07e` → 任务不存在, CLI-02); if the parent gave a short id, ask for the full one instead of guessing. Run kb show <issue-id> and read the current description, status, comments, and workspace. Then run kb dep ls <issue-id>: unresolved blockers mean the issue cannot be claimed yet. **状态门禁**：claim 只对「待规划」有效；status 为进行中/待验收/已关闭/已废弃时会被拒（退出码 2），当前 CLI 文案已区分「状态不可领取（当前=…）」与「已被他人占用」；仍以 `kb show` 的真实 status / claimed_by 为准，别把状态拒绝误判成他人占用。
2. Claim only that issue with kb claim <issue-id>. A successful claim is exclusive. Use the returned workspace path.
3. 被 blocker 挡住时（退出码 2，文案「存在未完成的前置任务」）→ 报告父代理并停手；**不得** release 他人占用，**不得** 用 `kb dep rm` 或自行补边解锁；等 blocker 到「待验收/已关闭」后再 claim。
4. If `kb claim` exits 2, read stderr text and branch (there is no structured error code in `--json`; 404/400/500 all collapse to exit 1 — CLI-04): 「已被 … 占用」→ occupied; 「状态不可领取（当前=…）」→ status gate; 「存在未完成的前置任务」→ blocked. Stop and report the exact stderr conflict to the parent. Do not retry the claim, choose another issue, or force-release another agent's claim. Note: there is no `kb release` command; release only via `done`/`fail` or a user-authorized REST call.
5. If the issue is not ready to claim or its current owner/status conflicts with the assignment, report that state to the parent instead of choosing another issue.
6. After claiming, reread the issue with kb show before starting implementation. Use its latest state and the AgentBoard guide's failure handling.

🔴 CHECKPOINT · 🛑 STOP：遇到未解除 blocker（退出码 2）即停手，不 claim、不 release 他人占用、不删边解锁。

## Execute and report

- At start, when blocked, at major milestones, and before completion, reread the issue with kb show. Record progress with kb comment at the start, when blocked, and at major phase completions.
- Treat the latest kb show result as authoritative if the user edits the title, description, priority, labels, or comments. 卡面引用别处原文（设计文档、日志、别人的 handoff、其他工作区的文件）时按「工作区 id + 相对路径 + 文件名」写坐标（如 `工作区 e41eb0fb-…：Docs/api.md §退出码`），据此打开原文再动手；只写「见 xx handoff」「参考那份设计」不算引用，打不开原文就停下问父代理，不靠猜补口径。
- If scope or plan details need amendment, explain the proposed change in a comment and reread with kb show; for description/parent/priority/labels edits use the documented `kb update <id> --description-stdin` / `--parent` / `--priority` / `--labels` (or `kb move-issue`), then re-read. Do not invent undocumented subcommands. **本卡改动运行时语义（异常处理、返回值语义、调用契约）而卡面没有「影响面扫描清单」时，先补扫描再动手**：调用点（`grep -rn <符号> apps packages`）／现有断言与用例／验收探针三项用 `kb comment` 落进卡面，然后 `kb show` 重读；没补清单就改行为，视同卡外改动。
- If a user decision is required, follow `ask-user`: run `kb ask` (default 180s grace) instead of parking the claim in a comment; on `LOCKED` stop work at the checkpoint, and use `--grace 0` for unattended runs. **要拍板的取舍必须立项成决策（`kb ask`），不得只散落在评论里等人看见**；接手与派活前先看有没有现成待决：`kb decisions --state open`（超 72 小时未处理加 `--stale`，锁定某张卡加 `--issue <卡 id>`），有 open 决策未答的卡不压新活。Check the latest issue state before acting on a reply.
- Perform only the verification required by the issue, user request, or project rules. Record actual commands and outcomes; do not claim checks that were not run.
- Do not create a separate test issue. Record verification in the implementation issue.
- 每次写文件前过一遍越界自检三问；路径不在当前工作区内即停手，必要时向用户申请授权。
- 进程、端口、DB 归属不明时按「执行环境归属校验」先查后动，不靠猜。
- 描述里把前置写成 plain issue id 时，用 `kb dep add <本卡 id> <前置卡 id>` 补录成结构化边，再用 `kb dep ls <本卡 id>` 复核；补录后若仍有未解除 blocker，按 claim 段的阻塞口径报告父代理，不自行解锁。

## 工作量超出时拆卡（强制，不得硬做完）

开工取证后或执行中断时，出现以下任一情况，必须在继续实现前拆卡：

- 实际改动跨 ≥2 个包或端
- 需要 ≥3 个独立可验收的交付步骤
- 实际改动预计 >8 个文件或 >400 行
- 卡内验收条目 ≥5 条且彼此独立
- 实际工作量超卡面描述 2 倍，或需要卡面未授权的设计决策

操作顺序：

1. 按依赖顺序逐条建子卡：`kb create-issue <ws> '<子卡标题>' -d '<目标/范围/边界/验收>' --parent <本卡 id>`（含双引号时用单引号或 `--description-stdin`）；
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
- **提交口径（GIT-ON-DONE）**：`kb done` 按 `--scope` 声明的路径自动提交，**不要手动 `git commit`**；`--scope` 逐条传（`--scope a --scope b`），只声明真正改动的路径（含新建/删除），漏声明会漏提交，多声明会把别人的改动卷进提交；纯看板任务无文件改动则不传并在 notes 写「本轮无文件改动」。不能自动提交时按 `using-agentboard` 的原因码（`NOT_A_GIT_REPO` / `GIT_NOT_INSTALLED` / `GIT_REPO_UNHEALTHY`）在 notes 说明，不自行改分支策略。
- **done 前置（按 `using-agentboard` 的 CLOSE-RECORD，强制）**：① 本轮有可复用结论（坑、验证方法、接口事实、口径裁决）→ 写工作区知识页，且 `kb knowledge create` 必须带正文 `--stdin` + `--sources`/`--evidence` 各 ≥1、并显式带 `--category design|solved|pinned|open`（缺任一退出 1，不传分类会落成 `legacy`）；一次性把已有 md/txt 建成页可用 `kb knowledge import <file> --category …`；无可复用结论则在 notes 显式声明「未沉淀知识页：<原因>」；② **变更日志一律写**：`kb changelog create --workspace <当前工作区> --title ... --type 新增|修复|调整`（无用户可见变更时正文写「本轮无用户可见变更」）；③ notes 带上知识页 id（未写则带声明）与变更日志 id；④ `--scope` 逐条声明实际改动路径（纯看板任务不写，notes 写「本轮无文件改动」）。缺任一项不 done。
- If the task cannot be completed or required verification fails, run `kb fail <issue-id> --reason '<具体阻塞>'` with the concrete blocker. This returns it to planning and releases the claim.
- If work is awaiting a user decision, use `ask-user` (`kb ask`; `--grace 0` for unattended runs) instead of silently keeping the claim; on `LOCKED` stop and leave the checkpoint. Never mark it done or failed while the decision is open.
- Use only the commands and status transitions documented by the AgentBoard guide. `kb update` / `kb move-issue` exist; never invent other update commands, status fields, or alternate claim behavior. For missing CLI or service failures, follow the AgentBoard guide's specific diagnostic branch; do not guess commands or server ports.
🔴 CHECKPOINT · 🛑 STOP：收尾回报缺工作区 id/路径、改动清单、跨区声明、验证命令与结果任一项即停手，不跑 `kb done`。
- 收尾回报必须包含：所在工作区 id + 路径、改动文件全路径清单（本卡有 `改动声明：<文件> ｜ <时间> ｜ <意图>` 那行的，把原文一并带回）、是否发生跨工作区操作（是/否；若是，列出授权依据）、验证命令与实际输出/结果（回报里每个数字——耗时、条数、比例、行数、通过数——后面各附一行复算命令，按命令重算，不引用他人转述；引述别处原文写「工作区 id + 相对路径 + 文件名」全坐标）。缺任意一项视为执行未完成，不得 `done`。
