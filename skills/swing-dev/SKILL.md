---
name: swing-dev
description: 机动开发巡检班次：把各工作区「待规划」且无需人工参与的任务尽量做完。用户说「跑一班机动开发」「机动巡检」「把待规划清一清」或 /swing-dev 时使用。不适用：单卡执行（用 executing-task）、需求未澄清或方案未批准（先 brainstorming）、纯咨询与只读盘点（直接回答）。
---

# 机动开发巡检班次（swing-dev）

一次调用 = 一个班次。父智能体只做调度、分派、验收、报告；实施全部由 worker 子代理完成。最多 3 个 worker 同时各执行一张父代理明确派发的卡。同一工作区可有多个 worker，前提是目标文件集与 owner 不冲突。

## 班次参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 工作区范围 | 全部 | 点名工作区 = 只扫点名区；明确说「某区不动 / 先别动」= 该区整班次剔除、其余照扫 |
| 卡数上限 | 12 | 只计 done 的完成卡；fail 与跳过不占额度；「连班」模式 = 不设上限，持续到无可做卡收班 |
| 熔断 | 连续 3 fail | 单 slot 相邻 3 个 fail 熔断（跳过不计数也不重置）；熔断 slot 不换实例续命；3 个 slot 全熔断则停班 |
| 并发 | ≤ 3 worker | 宿主并发上限拒绝 → 当前单卡分派排队，任一 slot 释放后重试；宿主没有子代理能力 → 停班并报告，不由父代理实施 |
| 复用预算 | 连续 2–3 张卡 | 同一 worker 实例连续执行卡数上限；超预算或回报出现上下文吃紧迹象 → 新实例接管该 slot（身份不变，账本更新 agentId） |

用户显式指定的值覆盖默认。

## 绑定账本

父代理全程按 slot 维护：身份（`KB_AGENT=swing-wN`）↔ worker 实例（agentId）↔ 当前工作区 ↔ 当前卡（完整 UUID）↔ 目标文件集 ↔ 状态（在飞 / 已收 / 熔断 / 僵死嫌疑）↔ quota reservation ↔ 已做卡单。同一工作区可同时绑定多个 slot；slot 可在已授权工作区间调度。换代只更新 agentId，slot 身份不变；续做仍由原 slot 身份持有的卡时保留该 claim。账本用于续派、文件 owner 检查、配额预占、僵尸核对与班次报告。

## 班次流程

### 0. 班次启动确认

🔴 CHECKPOINT · 🛑 STOP：首次扫描前向用户展示本班次参数（范围 / 上限 / 熔断 / 并发 / 复用预算，未指定项用默认值）与目标工作区清单，确认后进入自主循环，此后仅停班事件再停。用户发起指令已含明确参数（如「跑一班，××区不动」「连班」）时视为已确认，不再追问。

### 1. 环境自检（班次启动必做，结果写进报告开头）

1. `kb list-spaces`；退出码 1（服务不可达）→ 🛑 停班，报告「看板服务未启动」，不做任何卡。
2. `GET http://127.0.0.1:8787/api/version` 读 `db_path`（有 `db_scope` 一并读）；把实际 db 路径写进班次报告开头，禁止默认「就是中心库」。查不到 → 记为「db 路径未确认」，不得当作已确认。
3. 对每个目标工作区跑 `git -C <path> rev-parse --is-inside-work-tree`：输出 `true` = 走 `../using-agentboard/references/workspace-and-git.md` 的 GIT-ON-DONE；非 git 仓库或命令失败 = 走无提交降级路径，报告开头逐区写明「非 git 仓库，本班次无自动提交」。
4. 以上三项未记录前，不得进入扫描。

### 2. 扫描（禁用旧快照）

逐已授权工作区：`kb next --workspace <id> --limit <n> --json`（OPT-10）一次取得「待规划 · 无占用 · 前置全部解除」候选与派活字段（`parent_issue_id` / `blockers` / `blocked` / `siblings_by_label`）；需要整区全状态盘点时用 `kb list-tasks --workspace <id> --status 待规划`。启动时扫描所有目标区；worker 回报或空 slot 需要补位时，现场重扫对应工作区与已授权 ready 池。worker 一次只接一张卡，不预发整区队列；同区其他 worker 在飞时仍可分派文件集不重叠的卡。

**相邻卡取数口径**：worker 回报后按第 7 节现场回读 `kb show`、`kb next --json` 与 `kb dep ls`；候选、状态、依赖、claim 与决策锁均以当次输出为准，不引用扫描快照。

### 3. 排除（硬规则，命中即跳过并记原因）

对候选卡执行 `kb show <id>`，读描述、标签、评论与状态（`status`）；候选来自 `kb next`（已按 待规划/无占用/前置全解除 预过滤），规则 4 的占用与规则 6 的前置仍须现场复核一次（扫描与派发之间可能被他人 claim / 新增依赖）：

1. 该卡 `status` 在状态字典里对应 `kind=blocked` → 跳过（阻塞待人工解除）。**只按 kind 判定，不看标签/标题/描述关键词**：`blocked-external`、待决策之类字样本身不构成排除。班次启动时按工作区取一次阻塞状态集合，后续用 `kb show <id> --json` 的 `status` 比对：
   ```powershell
   kb status ls <工作区 id> --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const items=j.items||j;items.filter(s=>s.kind==='blocked').map(s=>s.name).join('\n')"
   ```
   集合为空 = 该区没有阻塞类状态；有自定义阻塞状态（如「等外部确认」）时其名字会列在输出里。无人值守班次不替用户拍板：用 `kb decisions --state open`（或 `--state open --issue <id>`）排除所有 open 决策；`--stale` 只用于报告过期决策，不能用于排除。
2. 验收要求真人参与：目视、听感、人工点击、真机操作、截图对比评审 → 跳过（需人工验收）
3. 涉及生产密钥、对外发送/发布、push 远端、数据库迁移 → 跳过（需授权）
4. 占用者非空 → 跳过（他人占用）；目标文件与其他在飞卡重叠 → 跳过（同文件单 owner，不得并行）
5. 父卡存在未终态（非已关闭）子卡 → 跳过（父卡只汇总）
6. `kb dep ls <id>` 显示前置未解除 → 当前候选不可派，报告 blocker id 与状态；worker 不自行挑选或 claim blocker。父代理可按 `executing-task` 的滚动续派规则将合格前置作为一张新卡单独派发；跨区、被占或命中本节排除项的 blocker 不派。
7. 本班次已 fail 过的卡不再重试

排除判定以卡面语义为准，不按关键词字面命中：卡面模板用语（如「所需人工步骤」「引用迁移」）不构成排除；「人工」排除只指验收需真人执行，「迁移」排除只指数据库迁移。

相邻卡取数口径（排除侧）：

- 规则 4 的「占用者非空」只看 `claimed_by` 不看 `status`：`进行中` 且 `claimed_by` 为空 = worker 掉线遗留卡，属可续做卡，不得按「他人占用」跳过（按第 7 节状态分支处理）；排除判定一律用当次命令回读、不吃扫描旧快照——`kb show <id> --json` 看 `status` / `claimed_by` / `decision_locked`，`kb dep ls <id>` 看前置是否已解除。

### 4. 排序

优先级（高 > 中 > 低）→ 同级创建时间旧者优先。候选集取自各已授权工作区 `kb next --json` 的 `items`，跨区合并后按本节排序。

本节排序只用于从 ready 池初次取卡或重新扫描后的候选顺序。worker 回报后的续派只按 `executing-task` 的「worker 完成后的滚动续派」选择，不按本节重排；本技能不重复定义下游、前置或 ready 池的续派优先级。

### 5. 分派

- 只给空闲 slot 派卡；每次只派 1 张卡并发送完整 36 位 UUID、标题、工作区 id/name/path 与本卡范围。按第 7 节为刚结束任务的 slot 续派；其他空 slot 从全部已授权工作区的 ready 池按第 4 节排序取卡。
- 同一工作区可派给多个 slot；用 slot 账本和 `kb list-tasks --workspace <id> --all-status --full --json` 找到在飞卡，再逐卡核对目标文件集与 owner；文件不重叠才并行。文件冲突的候选排队，继续检查其他候选；不得整区独占、整区串行或给 worker 一次发多卡队列。
- worker 提示必须自包含：本卡完整 UUID、标题、工作区 id/name/path、本卡验收范围、slot 身份、执行规则与安全红线、该项目规则入口（工作区根 AGENTS.md / CLAUDE.md）；不得让 worker 自行从候选池选卡。
- slot 身份固定为 `KB_AGENT=swing-w1` / `swing-w2` / `swing-w3`，设置方式按宿主：Git Bash `KB_AGENT=swing-w1 kb claim <id>`；PowerShell 先 `$env:KB_AGENT='swing-w1'` 再 `kb claim <id>`。同一 slot 换卡或换实例都不换身份；只有同一张进行中卡由原 slot 续做时保留现有 claim。
- 卡数上限只计实际 done。派卡前预占 1 个 reservation，并确保 `done_count + active_reservations < 卡数上限`；reservation 覆盖已派发或排队、尚未回读分类的任务。仍由该 slot 执行的卡继续占 reservation；done 回读确认后转为 done，fail / 跳过 / claim 失败经状态回读后释放，fail / 跳过不计 done。决策等待中且 claim 仍由该 slot 持有时保留 reservation；`LOCKED` 且 claim 已释放后记录锁定并释放 reservation，不 fail。连班模式不设上限但继续记 reservation。达到上限或 `done_count + active_reservations` 已满时停止补派，先让在飞卡收尾；失败释放额度且 done 未达上限时可补派下一张。
- 每次派发、续做、终止或换代时更新账本：slot 身份、agentId、工作区、当前卡 UUID、目标文件集、状态与 quota reservation；卡面提示以 `kb show <id>` 全文为准。

### 6. worker 执行循环

**状态回读硬规则（不可跳过，适用于父代理与 worker；定义见 `../using-agentboard/references/workspace-and-git.md` 的「done 返回」）**：

- `done` / `fail` / `close` 之后必须核对同一张卡的 `status`（预期：待验收 / 待规划 / 已关闭），取值与兜底一律按上述定义执行（优先命令输出的 `状态:` / `--json` 的 `status`，异常补 `kb show --json`，仍不符按未完成记账并记入第 9 节「尝试但未成功」栏）。
- `close` / `done` / `fail` 与其它子命令同口径：接受完整 36 位 UUID 或 ≥8 位唯一前缀（`packages/cli/src/issueRef.ts` 共用 `normalizeIssueRef`；7 位报「任务 id 前缀至少 8 位」退出 1，多命中退出 2）。班次内部命令可用短前缀，但卡面、依赖边与提交信息仍写完整 UUID；命令报「任务不存在」「409」时把 stderr 原文抄进班次报告与卡内 `kb comment`，禁止改写成「已完成 / 已关闭」。

逐卡：

1. worker 只处理父代理本次明确派发的一张卡。按 slot 设置 `$env:KB_AGENT='swing-wN'`（或 Git Bash `KB_AGENT=swing-wN`），先 `kb show <完整 UUID>` 与 `kb dep ls <id>` 复核状态、claim、决策锁和前置：新卡或父代理明确重新派发的无主进行中卡才运行 `kb claim <完整 UUID>`；原 slot 已持有的进行中卡直接续做，不重复 claim。成功 claim 后重读 `kb show <id>`，复核描述、验收标准与评论里用户最新要求。
   - 退出码 2 → 按 stderr 文案记录占用 / 状态 / blocker / 决策锁原因并回报父代理；worker 不换卡、不选 blocker、不重试 claim，也不 release 他人占用。父代理回读状态后决定是否派发另一张卡。
   - 退出码 1（服务不可达 / 参数错误）→ 停该 worker，回报父代理；输出含关联知识页提示 → 先读提示页再实施。worker 不自行换卡。
2. 实施：
   - 遵守该工作区项目规则（工作区根 AGENTS.md / CLAUDE.md）与 `executing-task` 的收尾口径；父代理派发已按 `using-agentboard` 的 SUBAGENT-STOP 例外授权你 claim/done/fail，除此之外不自行改卡；最小改动、复用现有实现、不动本工作区外文件
   - 非 git 仓库（第 1 节判定）：不执行任何 git 命令；本卡自验证据（日志/快照/输出文件）归档到该工作区 `Docs/evidence/swing-<date>/<card-id>/`（或班次参数指定路径），done notes 写「无提交 + 证据路径」
   - git 仓库：实施前查该工作区 git status；本卡目标文件已有未提交改动 → `kb fail <id> --reason '目标文件存在班次外未提交改动，需先收尾'`，回读并报告父代理；父代理决定后续派工（GIT-ON-DONE 按 --scope 提交，scope 外脏文件不受影响，同文件必混入）
   - 需超出卡面范围的设计决策 → 按 `ask-user` 用 `kb ask <id> --grace 0` 立项并立即落锁停手（无人值守不建宽限期），原因写「需设计决策：<具体问题>」。收到 `LOCKED` 后保留决策锁与断点，不 `kb fail`；按 `ask-user` 写断点评论并回报父代理。worker 不自行选下一张。
3. 自验：按卡内验收标准执行；测试从定向开始，项目强制检查或共享基础设施变更才跑全量；如实区分通过 / 未验证 / 失败
4. 完成：`kb done <id> --notes-stdin --scope <路径> --scope <路径>`，完成后按 §6「状态回读硬规则」核对「待验收 + 占用已释放」
   - 提交口径（GIT-ON-DONE）与 CLOSE-RECORD 按 `../using-agentboard/references/workspace-and-git.md` 与 `../executing-task/references/finish-checklist.md` 执行：`--scope` 逐条传、只声明真正改动（非 git 文件也写进 notes）、纯看板任务不传并写「本轮无文件改动」、不手动 `git commit`
   - notes 含：做了什么、自验结果、遗留项、知识页/变更日志 id；非 git 仓库注明「未自动提交 + 证据路径」（按上条归档）；一次收口可用 `kb done <id> --close-record --changelog-title … --type … --knowledge-page … --notes-stdin --scope …`（changelog 先写、失败不落 done，`--knowledge-page` 只挂引用）
5. 无法完成且非待决策 / `LOCKED`：`kb fail <id> --reason '<具体原因>'`，读输出里的 `状态:`（`--json` 读 `status`）确认 = 「待规划」；输出缺失或状态未变 → 补 `kb show <id> --json` 复核，仍不符按未完成记账。决策锁卡不 `kb fail`，按 ask-user 断点停手。
6. 关键节点（方案取舍、阻塞、部分完成）用 `kb comment <id>` 记录；done / fail 已有自动评论，不重复刷屏
7. worker 收尾（含熔断或异常退出前）：未到终态的自占卡按第 5 步 `kb fail` 并回读后再退出；决策锁或 `LOCKED` 卡保留锁与断点，禁止 fail。回报父代理：当前卡 status / claimed_by / decision id、完成 / 失败 / 跳过清单（卡 id + 标题 + 原因）、改动文件清单、验证命令与结果、跨区声明（工作区 id + 绝对路径 + 是否写区外文件）；父代理更新 reservation。

### 7. 回报处理与实例复用（父代理）

worker 回合结束或宿主报 inactive **不等于卡完成**。父代理逐卡回读 `kb show <完整 UUID> --json`；唯一事实源是当前 `status`、`claimed_by` 与决策字段，不按宿主状态、worker 自述或旧队列快照派卡。状态处理：

1. `decision_locked=true` → 不 `kb fail`、不派发其后继。若 `claimed_by` 仍是当前 slot，按 `ask-user` 等待或续做，保留 claim 与 reservation；若 `claimed_by` 为空，保留锁与断点、记录「锁定/跳过」并释放 reservation，slot 可由父代理重新派发；若由他人占用则不接管。`LOCKED` 后确认 claim 已释放、fence 已 bump，并按 `ask-user` 写断点评论。
2. `status=进行中` 且 `claimed_by` 为当前 slot 身份 → 同一 slot 继续当前卡；保留身份、claim 与 reservation，不派其他卡。
3. `status=进行中` 且 `claimed_by` 为空、无决策锁 → 现场核对依赖、文件 owner 与授权范围；门禁通过后同一 slot 重新派这张卡并 claim。门禁不通过时记录跳过、释放 reservation 并由父代理补位。`claimed_by` 为其他人 → 不抢占、不 release、不 fail；记录占用并释放本 slot reservation。
4. `status=待验收` / `已关闭` → 按状态回读规则计为完成，reservation 转为 done；如 slot 未熔断且尚有 quota capacity，立即复用同一 worker 实例。下一张卡按 `executing-task` 的「worker 完成后的滚动续派」选择；本节不复制或覆盖其优先级。
5. `status=待规划` → 记为未完成，依赖后继不解锁。确认本班次执行过 `fail` 时增加 fail 计数并加入本班次不重试集合；仅 `release` / 跳过不算 fail，也不重置连续 fail 计数。回读后释放 reservation；未熔断 slot 可由父代理派发其他合格卡。其他状态不推断为完成；若该卡仍由当前 slot 占用，保留 reservation 并停该 slot；若无占用则记录跳过、释放 reservation，再由父代理补位。

父代理补位：每次 slot 变空时，立即在本班次卡数上限和 reservation 门禁内按上项处理，不等待其他 worker。按 `executing-task` 现场读取下游、相关前置和已授权 ready 池；无合格候选才让 slot 待命。worker 不自行选卡，包括 blocker、失败或锁定分支。每次派卡前回读 `kb show`、`kb dep ls` 与决策状态，再比较所有在飞 slot 的目标文件集；同区卡文件不重叠即可并行。

1. 每张卡的 done / fail / close 状态未随回报提供、输出不可解析或与预期不符时，跑一次 `kb show <完整 UUID> --json`；逐卡核验，不抽查、不按 worker 自述采信。验证深度按风险定，证据有效即复用，不机械重跑。
2. 连续派卡达复用预算，或回报出现上下文吃紧迹象（回报显著变短、丢细节、自述压缩）→ 换新 worker 实例接管空闲 slot；账本更新 agentId，`KB_AGENT=swing-wN` 与 quota 规则不变。仍持有进行中卡的 slot 只有同一身份续做该卡，不派新卡。
3. 僵尸检测：在飞 worker 超预期时长（重实现卡按 30–60 分钟/卡量级）且占用卡零进度评论 → 判僵死：`kb comment` 说明释放原因 → 仅在班次启动时用户已显式授权自动释放的情况下用 REST `POST /api/issues/<id>/release` 强制释放（不带 workspace 时不要求占用者匹配，服务端落 system 评论「用户强制释放」）。未获授权时记录遗留占用并停该 slot；不代为 `kb fail` 或释放。此规则不构成 `using-agentboard`「强制释放需用户当轮授权」的例外。
4. 连续 3 次 fail → 熔断该 slot；停止派卡、不换实例续命，剩余在飞任务继续按状态规则收尾。

### 8. 待验收卡关闭（逐卡 close + 回读）

只处理本班次实际产出、且回读状态确为「待验收」的卡；不批量关闭、不按计划清单关闭。

1. 逐卡执行 `kb close <完整 UUID>`（CLI 认 ≥8 位唯一前缀，但流水线记录写全长 id）。close 时占用者就是当前 agent 会自动释放自有占用；被他人占用才 409，按第 7 节第 3 条的授权口径处置，不强行绕过、不改用 `fail` 兜底。
2. 按 §6「状态回读硬规则」核对 `kb close` 输出为「已关闭」（异常补 `kb show <同一 UUID> --json` 以其 `status` 为准）；分类记账：确认「已关闭」→「已回读确认关闭」，close 非 0 或回读状态未变 →「尝试但未成功」，从未发出 close 的卡 →「未尝试」。
3. 三栏数字只能来自逐卡回读记录（每卡：全长 UUID + 回读到的 `status` + 命令退出码与 stderr 原文），禁止用计划、claim 结果、worker 自述或预估填写。

### 9. 收尾（父代理）

1. 收班条件：全部目标工作区扫描无可做卡（完成 / 排除 / 占用 / 熔断线停）且无在飞 worker、无活动 quota reservation。达到 done 上限后停止补派并让已派卡收尾；`done_count + active_reservations` 已满时不新派卡，等待在飞卡逐张回读；失败释放 reservation 且 done 未达上限时可继续补派。未收齐 worker 的占用卡列为「遗留占用卡」；父代理不代 `kb fail`（409）或强制释放（授权按第 7 节第 3 条）。
2. 班次报告（固定结构）：
   - 报告开头：实际 `db_path`（来自 `GET /api/version` 的 `db_path` / `db_scope`）、每工作区 git 判定（仓库 / 非仓库无提交降级）
   - 每工作区三栏硬计数：**已回读确认关闭 N / 尝试但未成功 M / 未尝试 K**；另列完成（done 且回读为「待验收」）n（id + 标题；git 仓库附提交号、非 git 仓库附证据路径）、失败 n（原因 + stderr 原文）、跳过 n（按原因分类计数）、未动（被占 / 超并发未轮到）
   - 每个数字必须能追到逐卡回读记录（全长 UUID + 回读 status + 退出码），追不回的按 0 计
   - 全班改动文件清单；跨区声明（是否写工作区外文件，有则列出）；每卡验证命令与结果（或「未验证：原因」）
   - 剩余阻塞、遗留占用卡；slot 账本终态（每 slot：稳定身份、agentId、工作区、当前卡与目标文件、quota reservation、完成/失败计数、换代、熔断、僵死）
3. 收班自检清单（逐项确认，缺一项不得宣布收班）：
   - [ ] 每张 done / fail / close 都有回读记录（§6 硬规则），状态与预期一致；报告里每个关闭数字都能指到一条记录（全长 UUID + status + 退出码）
   - [ ] 全程无短码进入 close / done / fail；所有报错命令的 stderr 原文已进报告与卡内评论，未被改写成完成
   - [ ] 报告开头已写明 `db_path` 与各区 git 判定
   - [ ] 未回读的卡一律按未完成 / 未尝试计，报告里不存在「计划已关闭」
   - [ ] 卡数上限模式无活动 reservation 后才停班；done 数不超过上限，失败 / 跳过 / 锁定均未计入 done

## 安全红线（父代理与 worker 同守）

- 只写任务卡所属工作区内的文件与看板数据（边界细则按 `using-agentboard` 的「绑定与越界」）；跨区零写入，临时文件只放该区或系统临时目录、班次结束清理
- 不 push 远端、不 force 操作 git、不动生产密钥、不做数据库迁移、不对外发送任何内容；`delete-issue` / `delete-space` 禁用
- worker 不再派生子代理；不新建分支（卡面明确要求除外）
- 不顺手修复卡外问题；发现新问题 → 新建卡或写进班次报告，不扩卡

## 退出条件

- 扫描无可做卡（全部完成 / 跳过 / 占用）→ 正常收尾
- 🛑 done 数达到上限且无活动 reservation（连班模式无此条）/ 🔴 3 个 slot 全熔断 / 🛑 服务不可达 → 收班并出报告
- 用户中断 → 通知 worker 按收尾规则处理自占卡；决策锁 / `LOCKED` 卡保留并不 fail，其他未终态卡按第 6 节收尾，收齐回报再出报告
