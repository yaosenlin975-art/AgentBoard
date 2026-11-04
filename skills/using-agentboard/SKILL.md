---
name: using-agentboard
description: AgentBoard 看板技能族入口：何时加载 writing-task / executing-task / handoff，以及 kb CLI 完整用法、工作区边界强制规则、故障分支与收尾提交口径。触发词：AgentBoard、任务看板、看板、领任务、领卡、建卡、拆卡、任务树、依赖、kb 命令、kb CLI、汇报进度、标记完成、失败、交接、handoff、工作区绑定。
---

# Using AgentBoard

AgentBoard 是任务看板：任务挂在「工作空间」下，通过 `kb` CLI 读写。本技能是看板技能族的入口与唯一权威来源；`writing-task`、`executing-task`、`handoff` 只承载各自流程，冲突时以本技能为准。

## --scope 传参（SCOPE-GUARD，2026-11-03）

- `kb done` 的 `--scope` **必须为每个路径重复传一次**：`kb done <id> --scope a --scope b`。
- **不要用逗号串**：PowerShell 会把 `--scope a,b` 拆开/合并成别的参数，出现 `too many arguments for 'done'`，或只识别到其中一段；结果就是「done 成功但零命中、没有提交」。
- 服务端在「声明了范围却零命中」时会写一条 `⚠ 声明范围零命中，本次未自动提交` 的系统评论，并给出可直接复制执行的 `git add -- <paths>; git commit -m "..." -- <paths>` 补救命令；照抄执行即可。
- 看到这条评论＝你的改动没进 git，不要当成已完成；先执行补救命令，再看 `git log -1`。

## 权威来源解析（强制）

本文件就是族内权威文档。凡引用「权威来源 / AgentBoard operating guide / 工作区边界（强制）」的地方，文档路径一律按本节解析；本节是族内唯一解析规则，`writing-task`、`executing-task`、`handoff` 只指回本节，不复制解析表。

按下列顺序取第一个可读命中，命中即停：

1. 环境变量 `AGENTBOARD_SKILL_ROOT` → `<该值>/using-agentboard/SKILL.md`（该值可指向技能根，也可直接指向 SKILL.md 全路径）。
2. 当前工作区根下相对路径 `skills/using-agentboard/SKILL.md`（按 cwd 解析，覆盖仓库被 clone 到任意路径）。
3. 历史绝对路径 `D:\WorkSpaces\任务看板\skills\using-agentboard\SKILL.md`（仅兼容旧环境）。

「可读」判定：文件存在且首行可读出（PowerShell `Test-Path <path>` 且 `Get-Content <path> -TotalCount 1` 成功；bash `test -r <path> && head -1 <path>`）。

🔴 CHECKPOINT · 🛑 STOP：权威文档缺失即停手，不降级执行。

- 三个候选都不可读 → 停手，向用户报 `权威文档缺失：已尝试 <候选1> / <候选2> / <候选3>`，并请用户设置 `AGENTBOARD_SKILL_ROOT` 或给出实际路径。
- 不得降级：不按记忆或猜测继续跑 `kb`、不凭印象套工作区边界、不自行改写绑定规则；缺权威时任何看板写操作一律不做。
- 解析到的文档与本轮绑定工作区不一致（例如指向别的仓库副本）→ 按「工作区边界（强制）」的越界口径处理，先报告再决定。

<SUBAGENT-STOP>
如果你是被派来做一件具体任务的子代理（subagent / teammate），本技能不适用：按父代理给的工作区、卡 id 与验收标准直接执行，不自行领卡、不自行改卡。仅在需要命令细节时回查「kb 命令速查」与「故障分支」。
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
任何看板相关动作——查卡、建卡、拆卡、领卡、汇报、收尾、交接——先加载对应技能再动手，不要凭记忆敲 `kb`。
看板写操作（建卡、改卡、claim、done、fail、评论、知识、变更日志）之前必须先完成「工作区边界（强制）」的绑定；未绑定不得写。
</EXTREMELY-IMPORTANT>

## The Rule

1. **先定动作，再加载技能，最后敲命令**：建卡/拆卡 → `writing-task`；执行别人派的卡 → `executing-task`；交接或阶段性收尾 → `handoff`；只要命令与故障排查 → 本技能。
2. **写之前先绑定工作区**：见「工作区边界（强制）」的「调用即绑定」。
3. **进入 plan mode 之前先澄清需求**：写计划、拆卡前先跑需求澄清（brainstorming / spec 类技能）并拿到批准；没有批准的设计不落板。
4. **卡是执行源**：任务内容以 `kb show <id>` 实时返回为准，关键节点重拉；领取时的快照不作数。
5. **收尾必须声明范围**：见「工作区边界（强制）」的「收尾声明」。

## 前置条件

- 本机已安装 kb CLI（自检 `kb --version`）。
- 看板服务已启动（自检 `kb list-spaces`；报「看板服务未启动」时在仓库根目录执行 `pnpm server:ensure`，见「服务重启」）。服务地址不同时：单次用 `kb --server <url>`，长期用环境变量 `KB_SERVER=<url>`。
- 当前 agent 身份用环境变量 `KB_AGENT=<名字>` 声明（如 `KB_AGENT=codebuddy`）；未设置时默认 `kb-cli`。

## 看板概念

- **工作空间**：一个代码目录对应一个工作空间，任务挂在工作空间下。
- **任务五状态**：待规划(open) → 进行中(started) → 待验收(review) → 已关闭(done)，另有 **已废弃(deprecated)**。`kb status ls <工作区>` 列全部状态（内置五状态 + 自定义）；`kb done` 进「待验收」，`kb close` 转「已关闭」，`kb reopen` 退回「待规划」或指定状态。
- **任务树**：父卡只承载汇总与顺序，不承载实现；子卡用 `--parent <父卡 id>` 挂层级，子卡全部 done 后父卡才 done。
- **依赖**：卡间先后关系以结构化边表为准（`kb dep add <卡> <前置卡>` 建边、`kb dep ls` 查看）；描述里的 plain issue id（如 `前置：876、877`）仅供人阅读。
- **占用**：`kb claim` 原子领取后任务被你独占（字段仍允许用户编辑），其他人 claim 会收到 409。解除占用仅两条路：你执行 `done`/`fail`，或用户强制释放。任务未被占用时其他 agent 不可见占用徽标。

## 标签口径（TAG-HYGIENE）

- **≤4 个标签**，只用有检索价值的领域词：`web` / `server` / `cli` / `知识库` / `账号管理` / `依赖` / `技能` / `测试` / `文档` / `调研` / `跨平台` / `功能` / `缺陷` / `规则`。
- **不写日期**（时间用 `due_date` / `created_at`）、**不写「父卡」**（层级用 `--parent`）、**不加空格**。
- `kb create-issue -l "调研 跨平台 文档"` 会拆成三个标签（逗号、全角逗号、空白都是分隔符，自动去重）；想表达短语概念请拆成领域词，不要拼多词短语。

## 截止日期口径（DUE-DATE）

- **不主动询问截止日期**；用户说了才填（`kb create-issue … --due 2026-11-10` 或 `--due 2026-11-10T14:30`），没说就留空。
- 不得从描述、优先级、卡标题里推断截止时间。

## 工作区边界（强制）

本节优先于本技能其余条款，冲突时以本节为准；用户当轮另有明确指示时按用户指示执行。

- **调用即绑定**：技能启动第一步绑定当前工作区。跑 `kb list-spaces` 取全部工作空间，把 path 与会话 cwd 归一化后逐一比对（统一反斜杠、去尾斜杠、Windows 大小写不敏感；路径先解成实体路径（junction/软链接按 target 解析）再比对；cwd 取真实根，如 `pwd` 或 `git rev-parse --show-toplevel`），命中项即当前工作区；把 `<id> <name> <path>` 写进本轮第一条 `kb comment`。cwd 落在某工作区根之下（未命中任何根的等值项）时，取最长前缀命中的那个根作为当前工作区；仅当同时命中多个不同根（公共父目录 / 嵌套工作区）才停下来问用户。cwd 不属于任何已注册工作空间时同样停下问用户；不猜、不按名称猜。
- **默认只查、只领、只写当前工作区**：`kb list-tasks` 一律带 `--workspace <当前工作区 id>`；不带过滤的全局列表只用于跨工作区只读盘点，不得据它 claim。`kb create-issue` 的 workspace 必须是当前工作区。工作区外的路径默认只读：可读、可引用，不得写。
- **跨工作区一律要用户显式授权**：对非当前工作区的任何写入（改文件、建/改任务卡、claim/done/fail 别人的卡、写知识、写变更日志、起服务、改 DB、切分支）先说明「影响哪个工作区、哪些文件/数据」，取得当轮同意后再做；授权只覆盖当轮描述的范围。
- **越界自检三问**（每次写前过一遍）：① 这个路径/任务卡属于哪个工作区？② 跟当前工作区是同一个吗？③ 若不是，用户当轮是否明确授权过？三问答不全即停手。
- **卡归属校验**：`kb show` 返回的 `workspace_id` 与本轮绑定的工作区不一致时，停止写入与状态流转，把两个 id/路径一起回报父代理或用户，由他们决定是否授权跨区。
- **被占用不等于可释放**：见「占用规则」的「强制释放只有一条路」。
- **收尾声明**：done/fail/交接的回报四要素——工作区 id + 绝对路径；改动文件清单；是否跨工作区读写（是/否，若是写授权依据）；验证命令与结果。

## kb 命令速查

```
kb create-space <name> <path>           # 创建工作空间（path 必须已存在且是目录）
kb create-issue <ws> <title> [-d 描述] [-p 低|中|高] [-l 标签,标签] [--parent <父卡 id>]  # 建任务；ws 用 id 或名称
kb list-spaces                          # 列工作空间（id/name/path）
kb list-tasks --workspace <id|名> [--status 待规划|进行中|待验收|已关闭|已废弃]  # 必须指定当前工作区；不带过滤的全局列表仅限跨工作区只读盘点，不得 claim / done / fail。
kb show <issue-id>                      # 任务完整字段 + 全部评论
kb claim <issue-id>                     # 原子领取；输出任务详情+评论+工作空间路径
kb comment <issue-id> "内容"            # 写评论；中文/长文用 --stdin
kb done <issue-id> [--notes "..."] [--scope <path>]  # 完成 → 待验收，释放占用，按 --scope 提交
kb fail <issue-id> --reason "..."       # 失败 → 待规划，释放占用
kb close <issue-id>                     # 待验收 → 已关闭（占用中 409，先 release）
kb reopen <issue-id> [--to <状态>]      # 已关闭/已废弃 → 目标状态（默认「待规划」，须是本工作区已定义状态）
kb update <issue-id> [--title <text>] [--description <text>|--description-stdin] [--priority <低|中|高>] [--labels <a,b,c>] [--due-date <YYYY-MM-DD>] [--parent <id>|--clear-root]  # 改字段，不含状态
kb status ls <workspace>                # 工作区状态字典（名字 / kind / 排序 / 内置或自定义）
kb status add <workspace> <name>        # 新增自定义状态（内置五状态不可复刻）
kb status rm <workspace> <status> --migrate-to <目标状态>  # 删除自定义状态并强制迁移其下卡（内置不可删）
kb dep ls <issue-id>                    # 列前置与被阻塞者（含状态与「解除」标记）
kb dep add <issue-id> <blocker-id>      # 新增前置：blocker 解除（待验收/已关闭）后本卡才可 claim
kb dep rm <issue-id> <blocker-id>       # 移除前置
```

- 全局选项：`--server <url>`（覆盖 `KB_SERVER`）、`--json`（输出原始 JSON）。
- 退出码：0 成功；1 服务未启动或请求失败；2 任务已被占用（HTTP 409）。
- `kb dep` 三点：① 写通道以卡所属工作区为准，`dep` 无 `--workspace` 选项（传了 `unknown option`，退出码 1）；卡不属于当前工作区即越界，按「工作区边界（强制）」处理。② 退出码补充：0 成功；2 冲突（`ISSUE_CLAIMED` 卡已被占用 / 存在未完成前置 / 未被占用）；3 参数非法（如自环「不能依赖自身」）；4 任务或依赖不存在。③ **不得绕过依赖门禁**：不用 `kb dep rm` 或手工补边解锁本卡，不用 release 抢他人占用；被阻塞就报告父代理或等前置完成。
- 退出码 1 报错文本不稳定：连接被拒时报 `看板服务未启动（…，用 --server 指定）` 并附一行启动命令（见前置条件），其余失败可能只有裸 `fetch failed`（stderr，stdout 为空）——按退出码判断，先确认服务地址，不要自行猜测端口重试超过一次。
- **claim 状态门禁**：`kb claim` 只对「待规划」有效；状态是进行中/待验收/已关闭/已废弃时会被拒（退出码 2），但当前 CLI 文案仍显示「已被占用」——**不要据此判定为他人占用**，先 `kb show <id>` 看真实 `status`。
- **知识页 `category`/`landed` 当前无 CLI 入口**：`kb knowledge create/revise` 没有 `--category` / `--landed` 参数，新页恒为 `legacy` / `null`；要设置只能走 REST（`POST /api/knowledge/pages`、`PATCH …/pages/:id`），别把「能写 category」当成可用能力。
- **slug 冲突的实际表现**：服务端返回 409 `KNOWLEDGE_EXISTS`，CLI 显示服务端中文 message「范围内已存在该 slug」并 **退出码 2**（`KNOWLEDGE_REVISION_CONFLICT` 同为 2）。处理方式：同 slug 改走 `kb knowledge revise`，不新建重复页。
- **`--stdin` 与 BOM**：CLI 已在 `packages/cli/src/io.ts` 剥离 UTF-8 BOM（首字符不会被污染）；多行中文仍建议 `cmd /c "chcp 65001>nul & kb comment <id> --stdin < file"`，避开 PowerShell 管道编码问题。
- **`--scope` 必须逐条传**：写成 `--scope a --scope b`；PowerShell 会把 `--scope a,b` 拆错甚至合并成含空格的单参数，CLI 检测到含空格会打印 SCOPE-GUARD 警告要求重传。

## 服务重启（SERVER-STABILITY，强制）

要重启看板服务时**只走这一条**：仓库根目录 `pnpm server:ensure`（= `node scripts/server-detached.mjs`）。

- 幂等：先探活 `/api/version`，已是健康看板 → 直接复用、**不重启进程**（pid 不变），exit 0；未监听 → 后台拉起 `apps/server/dist/index.js` 并轮询到健康（≤30s）。
- 日志固定追加到 `.logs/server.log`；服务静默退出后先看这个文件，再谈归因。
- 退出码：0 健康（复用或新起）／1 拉起后仍不健康或子进程提前退出／2 端口被非看板服务占用（脚本不杀进程，人工确认占用者）／3 `apps/server/dist/index.js` 缺失（先 `pnpm -r build`）。
- **禁止**手工 `Stop-Process` + `start /b node apps\server\dist\index.js`：停止成功而启动失败会留下无人监听的空窗，且无任何日志可查（2026-11-03 两次 8787 自行下线即此模式，事后无法归因）。
- 确实要换端口/换 DB 时用环境变量 `AGENTBOARD_PORT` / `AGENTBOARD_DB` 配合 `--port`，不要杀其它 node 进程。

## 故障分支

命令不存在（127）→ 装 CLI；服务未启动（1）→ 按「前置条件」的启动命令处理；已被占用（2）→ 换任务。

- **CLI 缺失**：`kb` 命令不存在（command not found，退出码 127）。按顺序尝试 `cd <仓库>/packages/cli && npm link`（仓库指 AgentBoard 仓库根），装完用 `kb --version` 复验；复验不过才停止并报告。agent 工作空间内没有该仓库时，向用户报告「kb CLI 未安装」并给出该安装命令，不自行猜测安装来源。
- **服务未启动**：退出码 1 且报「看板服务未启动」→ 仓库根目录跑 `pnpm server:ensure`（见「服务重启」），再复跑原命令；不要自造端口，不要手工 Stop-Process。
- **409 已被占用**：退出码 2 → 立即换下一张卡，不等待、不重试、不释放他人占用。

## 开工前必读（项目上下文）

开工（建卡或领卡）前先做 1–2 次只读查询了解项目，避免重复造轮子、重复踩坑。只读不需要额外授权，但仍须先完成「工作区边界（强制）」的绑定。

- **先看工作区知识**：`kb knowledge list --scope workspace --workspace <当前工作区> --limit 20` 只看标题与摘要；与本次任务主题相关的，再 `kb knowledge show <id> --scope workspace --workspace <当前工作区>` 读正文。
- **再看最近变更**：`kb changelog list --workspace <当前工作区> --limit 20`，确认最近有没有人改过你要动的同一区域；有就对齐或复用，不另起一套。
- **区分事实与提议**：`category=open`（未决与盲区）或 `design` 且 `landed=proposed/partial` 的页**不得当成已实现的事实**；与卡面或代码冲突时先在卡评论提问，不猜、不按提议页当规格写代码。
- **成本控制**：默认只读标题+摘要，正文按需；不要一次拉全量正文，也不要把知识页整段粘进评论。
- **写知识页**（建/改/归档，PowerShell 复制可用；字段与三种引号写法见 `kb knowledge create --help`）：
  ```powershell
  Get-Content body.md -Raw | kb knowledge create --scope workspace --workspace <当前工作区> --title '标题' --slug some-slug --stdin --sources-file sources.json --evidence-file evidence.json
  kb knowledge show <page-id> --scope workspace --workspace <当前工作区>
  Get-Content body.md -Raw | kb knowledge revise <page-id> --scope workspace --workspace <当前工作区> --expected-revision 1 --stdin
  kb knowledge action <page-id> archive --scope workspace --workspace <当前工作区> --expected-revision 2
  ```
  正文用管道喂 `--stdin`（PowerShell 不支持 `<` 重定向，管道带进来的 BOM 由 CLI 剥离）；来源/证据写成 JSON 文件走 `--sources-file`/`--evidence-file`，避开引号转义。`content_hash` 用 `(Get-FileHash <文件> -Algorithm SHA256).Hash.ToLower()`，`captured_at` 用 `[DateTimeOffset]::Now.ToUnixTimeMilliseconds()`。
- **命令细节与实测坑**：完整示例（知识页建/读/改/归档、变更日志、任务全生命周期）、`--sources-file` 的 JSON 路径必须用正斜杠、`knowledge action` 必须带 `--expected-revision`、以及 `1cb07910` 三阶段（A 已落地 / B、C 未落地）的现状对照，见 `Docs/guide-2026-11-04-cli-knowledge-tasks.md`；本文只写口径，不复述命令。

## 领任务 → 执行 → 汇报

1. **领任务**：`kb list-tasks --workspace <当前工作区> --status 待规划` 选一个，先 `kb dep ls <id>` 查前置——有未解除 blocker 时 409（退出码 2），处置见「kb 命令速查」`kb dep` 第 ③ 条；无 blocker 再 `kb claim <id>`。
   - 退出码 2 或报「已被占用」→ 换卡，处置见「故障分支」。
   - 退出码 2 且报「存在未完成的前置任务」→ 被依赖门禁挡住：按「kb 命令速查」`kb dep` 第 ③ 条处理。
   - 领取输出含任务详情、评论与工作空间路径；工作目录切到该路径下干活。
2. **执行**：任务内容以 `kb show <id>` 实时返回为准——开工前拉一次；执行期间用户可能编辑标题/描述/优先级/标签或在评论区留言，**关键节点重新 `kb show` 拉取最新内容**，不要用领取时的旧快照。
3. **汇报**：关键节点（开工、受阻、阶段性完成）用 `kb comment` 写进展总结；中文多行内容用 stdin：
   ```
   kb comment <id> --stdin <<'EOF'
   （多行中文总结）
   EOF
   ```
   注意：CLI 领取（kb claim）无实时唤醒；用户留言会被标记为待读，你的下一次 `kb show` 会以 `[新]` 标注返回——关键节点重拉 `kb show` 并响应。
4. **收尾**：
   - **done 前置（CLOSE-RECORD，强制）**：`kb done` 之前先落两条记录——① 本轮有可复用结论（踩坑、验证方法、接口事实、口径裁决）时写工作区知识页：`kb knowledge create/revise --scope workspace --workspace <当前工作区>`；② 一律写变更结论：`kb changelog create --workspace <当前工作区> --title "…" --type 新增|修复|调整`（正文走 `--stdin`）。任一项不做时 `done` 的 `--notes` 必须显式声明「未沉淀知识页：<原因>」或「无变更日志」；两项都做了则在 notes 里带上知识页 id 与变更日志 id。沉默不声明视为收尾未完成。
   - 完成且自验通过 → `kb done <id> --notes "完成说明" --scope <本次改动的路径>`，状态进「待验收」，释放占用。之后不要继续动该任务。
   - 无法完成或自验失败 → `kb fail <id> --reason "失败原因"`，状态回「待规划」，释放占用。reason 必填，写清卡在哪。
   - 拿不准/需用户决策 → 先 `kb comment` 说明问题后保持占用继续等；只有确定失败才 `fail`。

## 占用规则

- 同一时刻你只能占用 claim 成功的那些任务；claim 是排他的，第二个 claimer 得到 409。
- 占用期间任务不可被拖拽流转（服务端 409 兜底），但字段与评论可被用户编辑。
- `done`/`fail` 之后占用即释放；释放前确认 notes/reason 已写清楚，避免人工验收缺少上下文。
- **强制释放只有一条路**：只有用户当轮明确说「可以释放/接手」时，才先 `kb comment` 写明范围与交接内容，再 `POST /api/issues/<id>/release`（不带 workspace_id = 用户强制释放，置回待规划）。
- **已占用的卡不得新增 blocker**：`kb dep add` 打到已被占用的卡时服务端 409 `ISSUE_CLAIMED`（CLI 退出码 2，文案「任务已被占用，请先释放占用（release）再新增前置」）。要加前置先按上面的释放口径处理，不自行 release 他人占用。

## 收尾与提交（GIT-ON-DONE）

- `kb done --scope <path>` 声明本任务改动的路径（文件或目录前缀，可多次或逗号分隔）。`done` 按 GIT-ON-DONE 提交，**只提交声明范围内的路径**；有并行占用时尤其必须写 `--scope`，否则可能把别人的改动卷进你的提交。
- `--scope` 写实际改过的目录/文件（如 `--scope skills --scope Docs`）；改动清单与 `--scope` 不一致视为收尾未完成。
- 未改文件的任务（纯看板操作）不写 `--scope`，`notes` 里写明「本轮无文件改动」。
- **`--scope` 与知识页/变更日志是两件事**：GIT-ON-DONE 只管提交哪些路径，不替代「领任务 → 执行 → 汇报」第 4 步的 done 前置记录；纯看板操作同样要写变更日志，知识页按「有可复用结论才写」判定，不写就在 notes 声明原因。
- 提交信息、分支与合并规则仍按项目 git 约定执行；GIT-ON-DONE 只解决「提交哪些路径」，不改变分支策略。
- **不能自动提交时看原因码，别只看「没提交」**（`done` 仍成功，评论里带声明范围）：
  - `GIT_NOT_INSTALLED` — 环境没装 git（容器镜像常见）：装 git 或改在宿主机收尾；
  - `NOT_A_GIT_REPO` — git 有但目录不是仓库：在该目录 `git init`；
  - `GIT_REPO_UNHEALTHY` — 是仓库但 `git status` 失败（index/HEAD 损坏、权限）：评论里带具体错误，先修仓库。

## 测试页与正式页（TEST-PAGE，强制）

两个页面，两套用途，不要混：

| 页面 | 地址 | 内容来源 | 何时用 |
| --- | --- | --- | --- |
| 测试页 | `http://127.0.0.1:5174/` | vite dev（源码，热更新） | 组员**所有界面验证**都在这里做 |
| 正式页 | `http://127.0.0.1:8787/` | `apps/web/dist` 构建产物 | 只在任务关闭/批量收口后重建才会更新 |

- 启动测试页：仓库根 `pnpm dev:test-page`（= `node scripts/dev-page.mjs`，固定端口 5174，幂等：已在跑就复用并探活 `/`，日志落 `.logs/test-page.log`）。桌面快捷方式：`AgentBoard 测试页`（由 `pnpm shortcut:test-page` 重新生成）。
- **界面验证一律走测试页 URL**（CDP / 手动都算）；报告里写清验证的是 `http://127.0.0.1:5174`。
- **禁止**用「已重建 dist」「8787 上看着对」冒充界面验证：8787 是旧产物，重建由收尾统一做，不代表你的改动已在正式页生效。
- 重建正式页：`pnpm publish:web`（= `node scripts/rebuild-web-dist.mjs`），**只在卡关闭 / 批量收口时执行**；日常改界面不要重建。
- 卡收尾时若改过 `apps/web` 源码，`kb done --notes` 必须显式声明一句：**「dist 未重建（测试页已验证）」** 或 **「dist 已重建」**；缺失视为收尾未完成。
- 重建失败（类型/构建错误）不要强行 done：正式页会停在旧产物，写清「dist 未重建 + 失败原因」。

## 文件编码纪律（BOM，强制）

写仓库内任何文本文件（`*.json` / `*.jsonc` / `*.ts` / `*.tsx` / `*.md` / `*.yaml` / `*.css` …）都必须是 **UTF-8 无 BOM**。

- **禁止**用 PowerShell 5.1 的 `Set-Content -Encoding UTF8`、`Out-File`、`>` 重定向写仓库文件：PS 5.1 的 `UTF8` 默认带 BOM（`EF BB BF`）。
- 用编辑器 `write` 工具写文件；需要命令行写入时用 `-Encoding utf8NoBOM`（PS 7+）或 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`；`node fs.writeFileSync` 默认无 BOM。
- 为什么强制：`package.json` 带 BOM 时 Vite 会把它当 PostCSS 配置加载，Node JSON 解析抛 `Unexpected token '﻿'`，web 测试与 build 直接打挂，报错点离真凶很远。
- 自动检查：`node scripts/check-bom.mjs`（`apps/web` 的 `pretest` 已挂载，`pnpm --filter @agentboard/web test` 会先跑它）。命中**新增** BOM 即 exit 1；存量历史文件在 `scripts/bom-baseline.txt` 里豁免（清一个删一行，`--strict` 可全量阻断）。
- 发现 BOM 不要用「顺手全仓去 BOM」掩盖：清理要单独提交，并在卡里说明范围。

## Skill Priority

流程类技能先于实现类技能；看板动作按下列路由表选技能，选错技能等于没加载。

| 你要做的事 | 加载技能 |
| --- | --- |
| 把需求/设计拆成卡、排顺序、写验收标准 | `writing-task` |
| 执行别人派给你的具体卡（claim、实施、汇报、收尾） | `executing-task` |
| 交接给别的 agent/会话，或阶段性收尾留可续接上下文 | `handoff` |
| 只查命令、排查服务/CLI 故障、查工作区绑定规则 | 本技能（`using-agentboard`） |
| 需求还没澄清就要写计划 | 先做需求澄清（brainstorming / spec 类），再 `writing-task` |

## Red Flags

出现左列的念头，按右列执行。

| 我在想 | 现实 |
| --- | --- |
| 「这张卡很小，不用拆」 | 拆卡判据是硬的：跨 ≥2 包/端、≥3 独立可验收步骤、>8 文件或 >400 行、验收条目 ≥5 且彼此独立、功能新增与重构混在一卡。任一条命中就必须父卡 + 子卡。 |
| 「先 `kb claim` 再说」 | claim 前先 `kb show` 读最新描述、状态、占用者；被他人占用就换卡，不抢不释放。 |
| 「全局列表里挑一张就行」 | `kb list-tasks` 必须带 `--workspace <当前工作区>`；不带过滤的全局列表只读盘点，不得据它 claim。 |
| 「卡被占用但看起来停了很久，我接手吧」 | 被占用 ≠ 可释放。只有用户当轮明确授权才 release，且先写评论说明范围与交接内容。 |
| 「build 红但不是我的锅，先 done」 | 验收不通过就不 done：要么修，要么 `fail --reason` 写清卡点；未跑的检查写「未验证」。 |
| 「路径看着在当前工作区，直接写」 | 写前过越界三问；junction/软链接按实体路径判定，逻辑路径会骗人。 |
| 「用户没说要交接，我顺手写个交接文档」 | 交接产物只进当前卡评论 + 当前工作区知识页；不新建 `Docs/交接文档.md`，不写工作区外。 |
| 「comment 随便两句就行」 | 收尾回报必须含工作区 id + 路径、改动文件清单、是否跨工作区；缺一项视为未完成。 |
| 「用 claim 时的描述就行」 | 关键节点重拉 `kb show`；用户可能在期间改过描述、优先级或留了 `[新]` 留言。 |
| 「done 会自动提交，`--scope` 可以省」 | 有并行占用时省 `--scope` 会把别人的改动卷进提交；GIT-ON-DONE 只提交声明范围。 |
| 「没写知识页/变更日志就想 done」 | 先写再 done；确实不需要的在 notes 显式声明「未沉淀知识页：<原因>」/「无变更日志」，沉默视为收尾未完成。 |
| 「这是别人的卡，我帮他改改」 | 不操作他人占用的卡；需要改动就回报父代理或用户。 |
| 「技能和用户当轮指令冲突，按技能来」 | 用户当轮明确指令 > 技能 > 默认行为。 |
| 「`Set-Content -Encoding UTF8` 写一下很快」 | PS 5.1 的 `UTF8` 带 BOM：写 `package.json` 会让 Vite 崩在 `Unexpected token '﻿'`。用 write 工具 / `utf8NoBOM` / `UTF8Encoding($false)`，写完可跑 `node scripts/check-bom.mjs` 复核。 |

## Platform Adaptation

- **Windows**：路径用反斜杠，比较前统一分隔符、去尾斜杠、大小写不敏感；junction 先按 target 解成实体路径再比对工作区根。
- **PowerShell 写多行评论**：`Get-Content -Raw file.md | kb comment <id> --stdin`；先设 `$OutputEncoding = New-Object System.Text.UTF8Encoding($false)` 防中文乱码，需要无 BOM 文件时用 `[System.IO.File]::WriteAllText`。
- **bash/zsh**：`kb comment <id> --stdin <<'EOF' … EOF`。
- **服务地址**：`--server` / `KB_SERVER` 见「前置条件」。
- **身份**：多 agent 并行时用 `KB_AGENT=<角色名>` 区分，避免默认 `kb-cli` 身份混用。

## 与其它技能的关系

| 技能 | 角色 | 与本技能的关系 |
| --- | --- | --- |
| `using-agentboard`（本技能） | 入口 + 权威来源 | 工作区边界、kb 命令口径、故障分支、占用规则以本技能为准 |
| `writing-task` | 流程：需求 → 有序卡 + 验收标准 | 引用本技能的命令与边界；只建卡不实施 |
| `executing-task` | 流程：领取 → 实施 → 汇报 → 收尾 | 引用本技能的命令与边界；只做被派的卡 |
| `handoff` | 流程：交接 / 可续接上下文 | 引用本技能的命令与边界；产物落当前卡评论 + 工作区知识页 |

- 四份技能对工作区绑定的定义必须一致；出现分歧以本技能为准（本技能文档的定位按「权威来源解析」执行）。
- 依赖关系：见「看板概念」的「依赖」条。

## User Instructions

优先级：**用户当轮明确指令 > 技能条款 > 默认行为**。

- 用户当轮说了具体做法（换工作区、跳过某步、直接改某卡），按用户说的做，并在回报里写明偏离了哪条技能条款。
- 用户指令与「工作区边界（强制）」冲突时，先复述影响面（哪个工作区、哪些文件/数据），拿到当轮同意再执行。
- 技能条款本身可疑或与现场证据不符时，按证据执行并说明，事后更新技能。

## 收尾与维护命令（CLI-CLOSE）

```
kb close <issue-id> [--request-id <uuid>]              # 待验收 → 已关闭（占用中先 release）
kb reopen <issue-id> [--to <状态>] [--request-id <uuid>] # 已关闭/已废弃 → 目标状态（默认待规划）
kb update <issue-id> --title/--description/--priority/--labels/--due-date/--due-time/--parent [--clear-due|--clear-root] [--request-id <uuid>]
kb update <issue-id> --description-stdin               # 长文本描述走 stdin
```

- `close` 只接受「待验收」；`reopen` 的目标必须是本工作区已定义状态（含自定义状态），非法会列出可用状态。
- `update` **不含 status**：状态一律用 `claim / done / close / reopen / fail`。
- 三条 409（占用中 / 状态不允许）都会原样打印服务端文案并退出 2；400（目标状态非法）退出 1。

## CLI-UX 变更（2026-11-03）

- 多行 `--notes` / 以 `- ` 开头的行会被 shell 拆成额外参数（实测 `too many arguments for 'done'`）：改用 `kb done <id> --notes-stdin`（从标准输入读，多行安全）。
- `kb list-tasks --full` 只对 `--json` 生效；表格模式带 `--full` 会打提示并忽略。
- `kb changelog` 的时间按**本地时区**展示（存储仍是 UTC 毫秒）。
- 服务端参数校验错误已中文化并附可用值，例如 `priority: 取值必须是：低 / 中 / 高`。
