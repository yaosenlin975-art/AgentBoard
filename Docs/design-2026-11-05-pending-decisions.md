# 待决策区 + ask-user 技能 + CLI 接口：可行性设计

- 状态：设计提案 v2（未实现、未拆实现卡）
- 日期：2026-11-05
- 设计卡：`77fcf859-5303-40e4-8c47-6593b54cc465`（v1）、`3c03ce2e-ccf8-4d95-ab78-03408df0a005`（v2 语义修订）
- 版本：**v2 按用户 2026-11-05 追加语义重写**——提问后 60 秒宽限期，期内回答立即放行，超时才停止任务并回「待规划」+上锁。v1 的「提问即永久锁」不再成立；§3.2 为新的权威时序，其余章节已同步。
- 边界：本文只落 `Docs/**`。未改动 `apps/**`、`packages/**`、`scripts/**`、`desktop/**`，也未在看板建任何实现卡。

---

## 0. 术语先对齐（名称混用是本需求最大的歧义源）

| 术语 | 本文定义 | 不是什么 |
| --- | --- | --- |
| **决策（decision）** | 一条绑定到任务卡的、带候选答案的结构化问题，可长期挂在看板上等人回答。 | 不是聊天里的 `awaiting_input`，也不是审批 `awaiting_approval`。 |
| **待决策（pending decision）** | `state IN ('grace','open')` 的决策行（grace = 宽限中，open = 已锁等待回答）。 | 不是任务状态名，也不是「待规划」的同义词。 |
| **锁（decision lock）** | 「该卡存在 open 决策」这一事实带来的不可领取约束。 | 不是 `claimed_by`（那是执行占用），也不是租约 `claim_lease_until`。 |
| **回答（answer）** | 首次给出答案，使决策从 `grace`/`open` 变 answered；宽限内直接放行，锁后解除锁。 | 不等于「修订」。 |
| **修订（revise）** | 已回答后改答案，追加一条新 revision。 | 不会重新加锁，也不会自动重跑任务。 |
| **占用（claim）** | 智能体领取任务执行，受 fence / 租约约束。 | 与决策锁互斥：锁着的卡不可 claim。 |
| **宽限（grace）** | 提问后的 60 秒窗口：决策 `state='grace'`，卡**不锁**、仍由提问者占用，agent 阻塞等待答案。 | 不是「已锁」，也不是「已回答」。 |
| **停止请求（stop_requested）** | 宽限到期时服务端写入的协作式停止信号，要求 agent 停止该卡任务。 | 不是进程 kill；agent 不检查就无效。 |
| **断点（checkpoint）** | 提问前记录的现场快照（stash SHA、改动清单、下一步、后台进程），用于回答后续跑。 | 不是自动提交，也不是自动清理工作树。 |

> 项目没有 `CONTEXT.md`，`Docs/decisions/` 是既有 ADR 目录。本设计属于「可逆、可讨论」阶段，暂不落 ADR；若批准后进入实现，再按 grill-with-docs 的三条判据决定是否补 ADR。

---

## 1. 现状事实（设计必须建立在这些真实约束上）

| 事实 | 证据 |
| --- | --- |
| `issue` 表已有 `claimed_by / claimed_at / session_id / claim_lease_until / claim_fence / last_heartbeat_at`，但**没有任何决策相关列**。 | `apps/server/src/db/schema.ts:43-55` |
| `claimIssue` 的 SQL 只认 `status IN ('待规划','进行中')` + 「无主或租约已过期」，**不认其它锁**。 | `apps/server/src/services/claim.ts:100-116` |
| 占用租约清扫只清占用字段，**不改状态、不碰其它锁**。 | `apps/server/src/services/claim.ts:158-185` |
| 批量退回待规划只选 `status='进行中'` 的卡，清占用 + bump fence。 | `apps/server/src/services/releaseRunning.ts:86-143` |
| 占用中禁止改状态；无人占用时状态可被直接改。 | `apps/server/src/services/claim.ts:277-287`、`apps/server/src/services/taskHierarchy.ts:29-51` |
| `close` 只接受「待验收」；`reopen` 只接受关闭类状态。 | `apps/server/src/services/issueTransitions.ts:21-54` |
| 依赖门禁只看 `blocks` 前置的 kind，**与占用/锁无关**。 | `apps/server/src/services/dependency.ts:84-87` |
| 内置状态 kind 只有 `open/started/review/done/deprecated`；自定义状态**可以新增**，但 claim SQL 只放行两个固定状态名。 | `apps/server/src/services/workspaceStatus.ts:18-27`、`claim.ts:103` |
| 会话级阻塞 `awaiting_input/awaiting_approval` 的窗口是「心跳延长 15 分钟 + 自进入起 2 小时绝对上限」，由 `sweepAwaitingTurns` 收口。 | `apps/server/src/services/turnAwawiting.ts:21-28,160-211` |
| 服务启动恢复会把运行中会话绑定的卡置回「待规划」并清占用，**不碰决策**（若存在）。 | `apps/server/src/services/sessionManager.ts:603-624` |
| 桌面壳（Tauri v2）目前只有窗口/托盘/单例/服务生命周期，**没有通知插件**。 | `desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/tauri.conf.json` |
| 前端导航是单一枚举 `board/tree/knowledge/log/chat`，侧栏五入口 + 聊天未读徽标。 | `apps/web/src/state/navStore.ts:20-24`、`apps/web/src/components/shell/SideBar.tsx:33-39` |
| 看板列 = 工作区状态字典的名字（含自定义状态），`待规划` 列有独立排序。 | `apps/web/src/components/board/Board.tsx:88-89,141-146` |
| 适配器已有 `AskUserQuestion` → `ask` 事件的精确白名单，用于**会话级**阻塞。 | `packages/adapters/src/codebuddy.ts:18` |
| CLI 有 `claim/done/fail/close/reopen/dep/...`，无任何决策命令；退出码口径 0 成功 / 1 请求失败或不存在 / 2 冲突 / 3 参数非法 / 4 dep 不存在。 | `packages/cli/src/commands/**`、`Docs/api.md`、`skills/using-agentboard/SKILL.md` |

**结论先行**：这套需求**可以落地**，但它不是「加个视图 + 弹窗」的体量。真正的工作量在「锁必须成为 claim/状态流转的第二道门禁」，以及「决策是长期数据，不能套用会话级 15 分钟/2 小时超时」。

---

## 2. 用户 7 条意图逐条判定

| # | 意图（原话要点） | 判定 | 关键理由 / 必须改什么 |
| --- | --- | --- | --- |
| 1 | 新增待决策区 + `ask-user` 技能 + CLI 接口 | **可实现** | 三件产物分别落在：新导航视图（`navStore` 第六入口）、`skills/ask-user/SKILL.md`、`kb` 新命令组。无数据结构硬阻碍。 |
| 2 | 仅长任务后发现需决策时调用，正常沟通时不调用 | **有硬限制（模型自觉）** | 结构上只能做「前置校验 + 频率限制 + 审计」，无法验证「是否真的到了该问的时候」。见 §3.3。 |
| 3 | 待决策区展示 + 右下角弹窗 | **可实现（分两档，但成为 60 秒机制的前置条件）** | 有 Tauri 壳可走系统通知；纯浏览器只能 Web Notification + 应用内提示，可能被系统静音/页面关闭。60 秒内要抢答，通知必须 ≤2s 到达。见 §3.2.5、§3.4。 |
| 4 | 问题与任务卡绑定 | **可实现** | 决策表以 `issue_id` 外键 + 同工作区约束；天然支持一卡多条历史决策。 |
| 5 | 提问后 60 秒宽限；超时则停止任务、卡回「待规划」并上锁，回答才解锁；期内回答立即放行 | **需改数据模型 + 改 claim/状态门禁 + 新增宽限计时** | 全案核心。现有 `claimIssue` 会让任何「待规划」卡被领走；宽限期卡仍被占用，锁只在超时后生效。必须加独立锁源 + grace 状态 + 停止信号。见 §3.1、§3.2。 |
| 6 | 问题必须带具体答案选项 | **可实现（结构强约束）** | 决策表 + 选项表；服务端强制 ≥2 个选项、每个选项带「后果」一句话。CLI 层同样校验。 |
| 7 | 回答后移出待决策区；卡上仍可改答案 | **可实现（需定义权威）** | 用 append-only 的 answer revision；「移出待决策区」= 从 open 列表移除，历史仍可查。见 §3.5。 |

> 只有 **#2 是硬限制**（模型判断不可机器验证）；**#5 是数据模型必改**；其余均可实现，但 #1/#3/#7 各自有明确的边界与降级。

---

## 3. 七个核心冲突：方案、推荐与代价

### 3.1 卡锁定 vs 认领机制

**问题本质**：`claimIssue` 只排除「被占用」和「租约未过期」，一张回到「待规划」的卡对 `claim`、`dispatch`（`apps/server/src/services/dispatch.ts:247`）、`swing-dev` 巡检都是可领的。只改 UI 不加门禁，锁等于没加。

#### 方案 A：新增自定义状态「待决策」（kind=open）
- 做法：给每个工作区加一个状态，卡提问时迁到「待决策」，回答后迁回「待规划」。
- 优点：复用状态字典、看板天然多一列、`claim` 因状态名不在白名单而**自动**被挡。
- 代价 / 硬伤：
  1. `claimIssue` 只允许两个字面状态名（`claim.ts:103`），所以「待决策」卡确实领不走，但**所有按「待规划」名字过滤/统计的地方都会漏掉它**（前端 `Board.tsx:144` 的待规划排序、`kb list-tasks --status 待规划`、巡检选卡）；
  2. 与用户原话「回到待规划」冲突——状态已不是待规划；
  3. 自定义状态可被用户删除/改名（`workspaceStatus.ts:135-161` 删除要迁移），删掉「待决策」会把锁着的卡迁到目标状态，锁语义被销毁；
  4. 回答后回迁会覆盖用户在此期间手动改的状态，产生状态回滚争议；
  5. 「上锁」仍不是状态能表达的（同状态下要区分可领/不可领），最后还是要加字段。
- 结论：**不推荐**。它解决「领不走」但破坏「待规划」语义，且不能替代锁。

#### 方案 B：`issue` 加布尔字段 `decision_locked`（或 `locked_by_decision`）
- 做法：提问时置 1 并回待规划，回答时置 0；`claim` SQL 追加 `AND decision_locked=0`。
- 优点：实现最直白、查询快、UI 投影容易；与现有 `claimed_by` 完全解耦。
- 代价：**双写双源**。锁真相在 `issue.decision_locked`，决策记录在另一张表；任何一条路径漏改（批量退回、启动恢复、删卡、异常中断）都会产生「卡锁着但无决策」或「有 open 决策但卡可领」的漂移，而且漂移后没有权威可仲裁。
- 结论：可作为**投影/缓存列**，不宜作为唯一真相。

#### 方案 C（推荐）：锁 = `issue_decision` 表中的 open 行（行即锁）
- 做法：新增 `issue_decision` 表；`state='open'` 的行存在即锁（**`state='grace'` 的行不是锁**，只是宽限计时）。用**部分唯一索引** `UNIQUE(issue_id) WHERE state IN ('grace','open')` 保证一卡同一时刻最多一条在途决策。
- `claimIssue` 的 UPDATE 追加一条相关子查询：
  ```sql
  AND NOT EXISTS (
    SELECT 1 FROM issue_decision d WHERE d.issue_id = issue.id AND d.state = 'open'
  )
  ```
  `changes=0` 时按「是否存在 open 决策」分流错误码 `DECISION_LOCKED`，文案指向决策 id。
- 优点：
  1. **单一真相**：锁不会漂移，删卡靠 `ON DELETE CASCADE` 自动清，撤回/回答靠状态变更自动解锁；
  2. 部分唯一索引在数据库层阻止「一卡两条 open」，并发提问只可能一条成功；
  3. 不需要给 `issue` 加列（不必考虑 `migrateIssueStatusModel` 重建表的列丢失顺序问题）；
  4. 历史决策天然保留。
- 代价：每次 claim 多一次相关子查询（有 `ix_decision_issue_state` 索引，成本可忽略）；列表投影需要 `EXISTS` 派生列，不能直接读 `issue` 列。
- 可选优化（不改变权威）：在 `issue` 上加 `open_decision_id` 指针列，仅用于列表/详情快速投影，**同一事务写入**，并配一条「指针与 open 行一致性」巡检用例；若不接受双源，就完全用 `EXISTS`。

#### 推荐：方案 C
**一句话结论**：不新增状态，也不把布尔锁字段当权威；**「存在 open 决策行」本身就是锁**，`claim` 用 `NOT EXISTS` 门禁，回答/撤回把行置为 answered/withdrawn 即解锁。

#### 对现有链路的具体影响清单（实现时必须逐项改）
| 链路 | 影响 | 处理 |
| --- | --- | --- |
| `claimIssue` | 锁着的卡当前**会被领走** | 加 `NOT EXISTS` + 新错误码 `DECISION_LOCKED`（409，退出码 2） |
| `dispatch` 派工 | 内部调用 `claimIssue`，自动继承门禁 | 无需另改，但 UI 需把 `DECISION_LOCKED` 显示为「等待决策」而不是「被占用」 |
| `swing-dev` 巡检 | 依赖 `claim` 成功；门禁生效即不会再领锁卡 | 技能文案补一条「`DECISION_LOCKED` 不是故障，跳过」 |
| 看板拖拽 / PATCH status | `updateIssueGuardded` 只在 `claimed_by!=null` 时拦状态；锁卡无人占用，**可被直接改状态** | 在 `updateIssueInHierarchy` 统一加「open 决策存在 → 禁止改状态」；锁卡只允许改标题/描述/标签/截止 |
| `releaseRunning` | 只选「进行中」，锁卡在待规划，天然不进批次 | 加注释 + 用例固化「批量退回不得解锁」；`mode=all` 也不得触碰锁 |
| `sweepExpiredLeases` | 只清占用字段 | **有 `grace` 决策的卡必须跳过**（否则 60 秒内占用被清、别人可领，宽限语义被破坏）；open 卡无占用，不受影响 |
| `recoverOnBoot` | 把会话绑定卡置回待规划并清占用 | 不碰决策行；锁保持 |
| `close` / `reopen` | 锁卡是「待规划」，close 本来就 409 | 无需改；文档写明「父卡收口前必须先回答或撤回子卡决策」 |
| 依赖判定 | 锁卡 status=待规划（kind=open），对下游仍是未解除 | 语义不变；**不把锁当成新的 blocker kind**，避免依赖口径分叉 |
| 删除任务卡 | 决策行随 `ON DELETE CASCADE` 消失 | UI 删除确认里提示「该卡有 1 条未回答决策，将一并删除」 |
| 父卡关闭 | 锁着的子卡停在待规划，未关闭 | 自然 409「存在未关闭后代」；错误文案可补「（含 N 条未回答决策）」 |

---

### 3.2 卡级决策的时序：60 秒宽限期（v2，取代 v1 的「提问即锁」）

**用户新语义（逐字）：**「智能体调用这个 cli 接口时任务卡不会马上锁上而是先等待 60 秒, 这 60 秒内若是用户没有回答则让智能体停止该任务卡的任务并任务卡回到待规划区并上锁, 若 60 秒内用户回答了问题, 则立马放行不需要继续等待」。

三个相位：

| 相位 | 卡状态 | 决策 state | 占用 | agent 行为 |
| --- | --- | --- | --- | --- |
| T0：调用 `kb ask` | 进行中 | `grace`（`grace_until = T0 + 60s`） | 仍归提问者，fence 不变 | 阻塞等待（默认同步，最多 60s） |
| T0..T0+60s 内回答 | 进行中 | `answered` | 仍归提问者 | **立即放行**：不释放、不重领、直接继续 |
| T0+60s 未回答 | 回待规划 | `open`（锁） | 释放、清占用、写 `stop_requested` | 收到停止信号后停手 |

**关键不变式**：锁只在 `state='open'` 时成立；`state='grace'` **不锁**（但卡仍被占用，别人也领不走，所以「不锁」是语义描述，不是安全漏洞）。宽限到期与回答是同一事务里的互斥状态迁移，先到者赢。

#### 3.2.1 60 秒怎么承载：同步阻塞 vs 异步 pending

**方案 A：同步阻塞（CLI 侧短轮询，推荐）**
- 做法：`kb ask` 默认 `--wait 60`；CLI 每 2 秒 GET `/api/decisions/:id`，收到 `answered` 立即打印答案并退出；到 60 秒打印 `LOCKED decision=<id>` 并退出。
- 优点：agent 协议最简单——一次工具调用就得到终局（答案或「已锁」），不需要额外轮询代码；回答延迟 ≤2 秒；超时返回值本身就是停止指令，**语义闭环**；没有漏唤醒。
- 代价：一次工具调用会挂住最多 60 秒。对 agent harness 的单次工具超时预算有硬要求（必须 ≥60s + 余量，否则工具先超时、CLI 被杀，但服务端仍会在 60s 正确落锁）；60 秒内占用一个并发槽位。
- 不采用「单条 HTTP 长挂」：SSE/反向代理/agent 网关的空闲超时常小于 60s，容易半路断连。2 秒短轮询没有长连接，最多产生 30 次轻量 GET，成本可忽略。

**方案 B：异步 pending**
- 做法：`kb ask --no-wait` 立即返回 `{decision_id, state:'grace', grace_until}`，agent 自己短轮询或写完断点后停手，等后续事件唤醒。
- 优点：不占工具槽；适合夜间批处理、明确用户不在场、或 agent 想先落断点再等。
- 代价：失败模式多（漏轮询、轮询进程被杀、上下文漂移、回答后无人接续）；必须额外定义「谁来唤醒、多久轮询、超时后怎么停」。
- 结论：作为**可选降级**保留，不作为默认。

**推荐：A（同步、2 秒短轮询、默认 60 秒）**。理由补充：同步等待让 agent 在答案未定时**不会继续推进**，上下文不存在「等回来已经忘了做到哪」的漂移；异步 B 则有明显的上下文时效问题，只能靠断点兜底。B 只在 `--no-wait` 时启用，且技能要求先写断点再离开。

#### 3.2.2 「让智能体停止该任务卡的任务」怎么落地（协作式，不是 kill）

- **主信号**：`kb ask` 超时返回 `status:'locked'`（退出码 0 + 结构化输出），这本身就是停止指令；技能文案硬性要求 agent 收到后立即停手，不得继续改代码、不得 `kb done`。
- **备用信号**（用于异步/CLI 被杀/会话型 agent）：
  - 服务端在 `grace→open` 的同一事务写入 `issue.stop_requested_at`，并 bump `claim_fence`；
  - 现有心跳响应体增加 `stop_requested` 字段；`kb status <issue>` / `kb stop-check <issue>` 也能读到；
  - WS 推 `issue.stop_requested`，会话型 agent 可复用现有 `ctx.stopRequested` 思路（但不置 `awaiting_input`）。
- **检查粒度**：工具调用之间、每次写文件前、每次提交前。**不要求**打断正在执行的工具（无法安全 kill，也不应假装能）。
- **残留风险（必须承认）**：agent 不检查就继续跑，本地文件仍会被改。服务端能拦的只有看板写入——超时后占用已释放，后续 `done/fail/heartbeat` 全部 409，无法把未完成工作报成完成；旧 fence 的收尾也会 409 STALE_FENCE。文件层只能靠技能约束 + 断点约定 + 下次 claim 前 `git status` 审阅。

#### 3.2.3 停止时的现场与「可续跑断点」

**约定（实现时必须写进技能与 CLI）**：调用 `kb ask` 前准备一份 checkpoint，随提问一起落库：

- `git stash create` 得到的 SHA（**不清理工作树**，仅记录，避免影响同仓库其他 agent 的改动）；
- `git status --short` 与 `git diff --stat` 摘要；
- 已完成步骤 / 未完成步骤 / `next_step`；
- 已跑过的验证命令与结果摘要；
- 后台进程或构建的 PID、命令、日志路径。

落地方式：
- CLI `--checkpoint-file <path>` 或 `--checkpoint-stdin` 把 JSON 存进 `issue_decision.checkpoint_json`，同时渲染成一条卡评论（`kb show` 可见）。
- 服务端只存不改；不自动提交、不自动 stash 清理、不自动杀进程。
- **续跑**：用户 3 小时后回答 → agent 重新 `kb claim` → `kb decision <id>` 读答案与 checkpoint → `git status` 复核脏文件 → 从 `next_step` 继续，不从头再来。若回答后工作树已被别人改动，checkpoint 里的 stash SHA 可用于对比/恢复，但**不自动恢复**（避免覆盖他人改动）。
- 后台进程：ask 前应主动停止长跑构建；无法强制收口，残留 PID 写入 checkpoint 供下次判断。
- 会话型 agent 可额外记录 `created_turn_id`，但**不**把轮次改成 `awaiting_input`，避免两套状态/两套超时。

#### 3.2.4 60 秒够不够：代价与可调参数

- **诚实结论**：60 秒只覆盖「人就在机器旁且通知秒到」的场景。开会、离开、专注助手拦截时**必然超时**，结果是「每个长任务至少被冻结一次」。这是用户明确选择的产品语义，不是实现缺陷，但必须在 UI 与技能里写清楚。
- **代价**：一次冻结 ≈ 一次 stop + 一次 resume（重读上下文、检查脏工作树、可能重跑验证）。决策质量高时可接受；若提问频繁，会放大成「任务反复冻结」。
- **可调参数建议**：
  - 工作区级 `decision_grace_seconds`，默认 60，范围 0–600；
  - 单次 `--grace <s>` 覆盖，服务端 clamp 到工作区上限；
  - `--grace 0` = 立即锁，适合夜间批处理/明确无人；
  - 不提供「检测用户在线自动延长」：无法可靠判定，且违背 60 秒语义。
- UI 必须显示倒计时（卡面、待决策区、通知正文），否则用户不知道还剩多少秒。

#### 3.2.5 抢答通道可达性（60 秒内答上）

- **Tauri 壳**：权限允许且进程常驻时，Windows toast 延迟通常 <1s，窗口最小化也能弹；专注助手可能只进通知中心（不算「秒级可见」）；托盘闪烁/任务栏 attention 可作补充。
- **纯 Web**：页面必须开着；`localhost` 是安全上下文可用 Notification API，但需用户授权；后台标签被节流时可能延迟数十秒；页面关闭即**必然超时**。
- 结论：60 秒把「通知可靠性」从增强项变成**功能前置**。DEC-7 验收必须包含「同机、权限允许时通知延迟 ≤2s」与「权限拒绝/页面关闭时的兜底可见性」。
- 「用户没开着看板」：有壳常驻 → 仍可能收到；纯浏览器关页 → 必然超时，这是物理限制，不能靠服务端弥补。

#### 3.2.6 与永久锁的取舍

- 60 秒后上锁，若一直无人回答，**仍等价于 v1 的永久锁**，而且触发概率更高（60 秒很短），所以翻车点 ① 没有消失，只是更常见。
- 对策（仍然**不自动解锁**）：
  1. 分级提醒 4h / 24h / 72h，起点改为锁生效时间 `locked_at`（不是提问时间）；
  2. 依赖链熔断提示：下游卡/父卡错误文案显式写「因 decision `<id>` 未回答阻塞」；巡检遇 `DECISION_LOCKED` 跳过并计数；
  3. 人工「撤回 / 搁置」：用户在待决策区显式操作并写理由；撤回后解锁，但卡打 `decision_parked` 标记，避免 dispatch 立刻又领走（需用户手动取消或重新派工）；
  4. 绝不自动按默认项继续，除非提问时显式 `--on-expire unlock_default`（默认 `stay_locked`）。
- 因此终局仍是「等人回答才解锁」，只是入口从「提问即锁」变成「60 秒后锁」。

#### 与会话级阻塞的关系
- 两者**并存、不互相替代**：聊天执行器卡住用 `awaiting_input`（15 分钟/2 小时，超时收口轮次）；看板决策的 60 秒宽限是**第三条时序**，不写 `awaiting_json`、不改轮次状态。
- 之所以不复用 15 分钟/2 小时：那是「这一轮还能不能续」的执行超时；60 秒是「用户能不能及时抢答」的产品窗口，超时后卡并不失败，只是回待规划 + 锁，等待回答后再续跑。

---

### 3.3 「只在长任务后调用、沟通中不调用」如何落地

**本质**：这是**判断力问题**，不是接口问题。任何服务端策略只能约束「结构合法」，不能证明「时机正确」。下面四层是能做的全部，末尾如实写残留风险。

#### 手段 1：技能文案硬规则（`skills/ask-user/SKILL.md`）
必须写死「问什么 / 不问什么」：
- **必须问**：不可逆操作（删数据、改对外契约）、范围变更（跨工作区/跨模块）、需要产品取舍且两种实现都合理、缺少凭据/设备/账号这类 agent 无法自行获取的前提。
- **禁止问**：能靠读代码/文档/知识页回答的；用户正在对话中可直接用一句话回的（**直接在聊天里回复，不进决策区**）；纯偏好/审美；一张卡能拆成多个小问题的（禁止打包多问，一次一条决策）；用提问代替执行或逃避验收。
- **硬前置**：必须先 `kb claim` 成功、且当前卡已工作到「无法继续」；调用 `kb ask` 前先写断点（§3.2.3）；`kb ask` 默认阻塞等待 60 秒——收到答案就继续，收到 `LOCKED` 就立刻停手。
- **一次一条**：同一张卡同时最多 1 条 open/grace 决策。

#### 手段 2：CLI 前置检查（可执行、可报错）
`kb ask` 在本地与服务端都校验：
1. 卡必须是**本 agent 当前占用**（`agent_id == claimed_by` 且 fence 匹配），否则 409 `NOT_TASK_OWNER`；
2. 卡状态必须是「进行中」，否则 409 `ISSUE_STATUS_NOT_RUNNING`；
3. 至少 2 个选项，且每个选项必须有 `label` 与非空 `consequence`；重复 label 直接拒；
4. 该卡不得已有 grace/open 决策（部分唯一索引兜底，服务端 409 `DECISION_ALREADY_OPEN`）；
5. 频率限制：同一 agent 同工作区同时最多 3 条 grace/open 决策；每小时最多 6 条新决策（超过 429/409，文案给冷却时间）；
6. 可选 `--session <id> --turn <id>`：服务端校验会话属于本卡/本工作区，并记录 `created_turn_id`。**只记录，不据此判定「够不够长」**；
7. 提问默认同步等待（60 秒），等待期间卡仍被占用；CLI 超时返回 `LOCKED` 后 agent 必须停止，服务端在 `grace→open` 时释放占用并写 `stop_requested`。

#### 手段 3：服务端拒绝策略（防滥用，不防误判）
- 上述 1–5 全部在**同一个 IMMEDIATE 事务**里判定；拒绝时返回机器可判错误码（`ASK_NOT_OWNER / ASK_ALREADY_OPEN / ASK_RATE_LIMITED / ASK_TOO_FEW_OPTIONS`）。
- 拒绝也写审计（见手段 4），便于事后统计「谁在高频提问」。
- 不做「检测到用户在线就拒绝提问」：服务端不知道用户是否在看聊天，强行判断只会误伤。

#### 手段 4：可观测的调用日志
- `issue_decision` 落 `created_by / created_session_id / created_turn_id / created_at / trigger`（`trigger` 由 agent 传枚举：`blocked / scope_change / irreversible / missing_input`）。
- 每次拒绝写一条 `decision_audit`（或复用工作区 changelog 之外的轻量审计表），记录拒绝码、agent、卡、时间。
- `kb decisions --stats --days 7` 输出：新增数、回答率、中位等待时长、按 agent/触发类型的分布——用来发现「某个 agent 在正常对话里滥发决策」。

#### 残留风险（必须诚实写进文档与技能）
1. 「长任务」无法机器判定：`--after-steps` / 轮次步骤数只能证明「干了不少活」，不能证明「该问」；agent 完全可以先做 5 步再问一个本该直接做的事。
2. 技能文案是软约束：模型可能忽略前置；CLI 只能拒绝**结构非法**的提问，拒绝不了「结构合法但时机错误」的提问。
3. 频率限制只压总量，不改善单条质量；过度收紧会让 agent 在真正该问时放弃提问、转而瞎猜。
4. 因此需要**人工可关**：设置项或技能开关允许「本会话/本工作区禁用 ask-user」，并让它退化为「直接 fail 并在卡评论写阻塞原因」。

---

### 3.4 右下角弹窗：有壳 / 无壳两档

**现状**：桌面壳是 Tauri v2（`desktop/src-tauri/Cargo.toml`），依赖只有 `tauri`（tray/icon）、`serde`、`tauri-plugin-single-instance`，**没有 notification 插件**；壳不代理 API、不持有 WS，业务事件在 webview 内的前端。浏览器直连 8787 时没有壳能力。

#### 档 1：有壳（Tauri）
- 做法：`Cargo.toml` 增加 `tauri-plugin-notification = "2"`；`src-tauri/capabilities/*.json` 给 `notification:default` 权限；前端在 `window.__TAURI_INTERNALS__` 存在时用 `@tauri-apps/plugin-notification` 的 `isPermissionGranted / requestPermission / sendNotification`。
- 触发：前端收到 WS `decision.created` 事件时发一条系统通知（标题 = 卡标题，正文 = 问题摘要，点击聚焦窗口并切到该决策）。
- 增强（可选，成本另计）：托盘图标闪烁/气泡、任务栏 attention；在壳的 Rust 侧监听 Tauri 事件发通知可以避免「窗口最小化后 webview 定时器被节流」，但这要求壳承担一部分事件转发，与「壳不代理 API」的既有边界冲突，需单独裁决。
- 权限：Windows 首次会请求系统通知权限；被系统「专注助手」拦掉时通知会静默进入通知中心，不一定弹出——**这是系统行为，应用无法绕过**。

#### 档 2：无壳（浏览器打开 8787）
- 做法：Web Notification API。`http://127.0.0.1` / `localhost` 属于安全上下文（potentially trustworthy），**不需要 HTTPS 也能用**，但仍需用户手势触发 `Notification.requestPermission()`，且页面必须开着（没有 Service Worker + Push 服务端，关掉页面就收不到）。
- 限制：可能被拒绝（默认 `default`，用户不点就永远不弹）、可能被系统静音/专注助手压制、后台标签页定时器被节流导致延迟。
- 降级：一律保留**应用内三件套**——侧栏徽标、主区顶部「有 N 条待决策」条、右下角应用内 toast（可关闭，不自动消失直到回答或手动忽略）。

#### 推荐：两档都做，通知只当「增强通道」
| 场景 | 系统通知 | 应用内提示 | 结论 |
| --- | --- | --- | --- |
| 有壳 + 权限允许 | Tauri 系统通知（点击深链） | 徽标 + toast | 最佳 |
| 有壳 + 权限拒绝/系统静音 | 降级为托盘提示（若实现） | 徽标 + toast | 仍可发现 |
| 浏览器 + 权限允许 + 页面在 | Web Notification | 徽标 + toast | 可用但不保证 |
| 浏览器 + 权限拒绝/页面关闭 | **无** | 下次打开时的未读徽标 + 汇总条 | 唯一可靠通道是应用内 |

**v2 新增的 60 秒硬要求**：宽限期只有 60 秒，通知必须做到「同机、权限允许时 ≤2 秒到达」，否则这套功能在多数场景下退化成「提问即冻结」。因此通知验收不是锦上添花，而是宽限期能否成立的前置条件；同时页面必须显示倒计时，让用户知道还剩多少秒可抢答。

**原则**：通知不是事实来源；**待决策区的 open/grace 列表与徽标才是**。任何「只靠弹窗」的方案都会在权限/静音/最小化场景下静默失败。

---

### 3.5 答案可修改：权威来源、是否重跑、历史、与评论/知识页的关系

#### 方案 A：覆盖式（`issue.answer_text` 直接 UPDATE）
- 优点：简单。
- 代价：无历史、并发下后写覆盖先写、无法审计「谁在什么时候改了答案」；一旦 agent 已按旧答案动工，无法判断它读到的是哪一版。
- 结论：不推荐。

#### 方案 B（推荐）：追加式 revision（append-only）
- `issue_decision_answer` 每次回答/修订插入一行，`revision` 自增；`issue_decision.current_answer_id` 指向最新一行，旧行保留并标记 `superseded_by`。
- **权威来源**：`current_answer_id` 指向的那一行 = 唯一有效答案；历史修订只用于展示与审计。
- **改答案是否重跑**：不自动重跑。首次回答分两种情形：**宽限内回答**（卡从未释放、仍被提问者占用）→ 直接放行，agent 继续执行，不产生「重新 claim」；**锁后回答**→ 解锁卡（回待规划，需重新 claim）。修订只更新答案并**追加一条结构化系统评论**：
  - 若此时无人占用 → `answer_stale=false`，下次 claim 会看到最新答案；
  - 若此时已被 agent 占用/已开始执行 → `answer_stale=true`，卡面显示「答案在你开工后被修订」，并在评论里 @ 当前占用者（沿用现有评论唤醒机制，不新增强制中断）。
- **并发**：修订必须带 `expected_revision`（CAS），旧 revision → 409 `DECISION_REVISION_CONFLICT`；与首次回答的 `state IN ('grace','open')` 条件更新互斥，先到者赢。
- **历史展示**：详情面板展示「第 1 版 / 第 2 版」时间线，含 `answered_by`、来源（web / cli）、选项与自由文本。
- **与卡评论的关系**：决策是结构化数据，评论是叙事。回答/修订**都要**写一条系统评论（含 decision id、revision、选项摘要），保证 `kb show` 与卡评论流能自解释；但**评论不是权威**，以决策行回读为准。
- **与知识页的关系**：不自动生成知识页。若决策结论可复用，由人在收尾时 `kb knowledge create/revise`；决策详情可提供一键「沉淀为知识页」的复制文案（把 question/options/answer 转成 markdown），但不自动写，避免把看板数据污染成知识库。
- 代价：多一张表和一次 CAS；列表需要 join 最新答案；修订展示要处理空选项/自由文本。

#### 权责
- **谁能改**：人类用户（Web/CLI，`answered_by=user`）可无限修订；提问 agent **不能**回答或修订自己的问题（防止自问自答）；其他 agent 只能读、评论。
- **提问 agent 能做什么**：仅在 open 期间 `withdraw`（撤回），撤回时写理由并解锁；已 answered 后只能等用户修订或重新提问（新决策）。

---

### 3.6 多 agent 并发

| 竞态 | 处理 |
| --- | --- |
| A 正在执行并准备提问，B 抢先 claim | `claim` 与 `ask` 都是单事务 + 条件 UPDATE。B 先 claim → A 的 `ask` 因 `claimed_by != A` 失败（409）；A 先 `ask` → 卡进入 grace、仍归 A 占用，B 的 `claim` 被占用挡住（409 `ISSUE_CLAIMED`）；60s 后转 open 并释放占用，B 再 claim 才被 `NOT EXISTS` 挡（409 `DECISION_LOCKED`）。 |
| 两个 agent 同时提问同一卡 | 提问要求当前占用者，而占用是排他的 → 结构上只可能一个。即使异常路径绕过，`UNIQUE(issue_id) WHERE state IN ('grace','open')` 兜底，第二个 409。 |
| 两个客户端同时点「回答」 | 回答是 `UPDATE ... WHERE state IN ('grace','open')` + `changes==1`；第二个 409 `DECISION_ALREADY_ANSWERED`；与 60s 到期竞态由事务时间戳判定。 |
| 回答与撤回同时 | 同一条件更新，先到者赢；另一个 409。 |
| 两个修订同时提交 | `expected_revision` CAS，旧版 409。 |
| 租约清扫 / 批量退回 / 启动恢复 与 提问并发 | 全部是 IMMEDIATE 事务，串行化。清扫跳过 grace 卡、只清过期占用；批量退回不选 grace 卡；提问要求持有占用且 fence 匹配。 |
| 回答与 60 秒到期并发 | 同一事务内以 `grace_until` 与事务时间判定：`now < grace_until` 且决策仍 `grace` → 回答成功并直接放行；`now >= grace_until` → 先落锁再判回答，回答只能走「锁后解锁」路径。两者用条件 UPDATE，先到者赢，不出现「又放行又锁」。 |
| ask 阻塞期间租约过期 | 宽限期内 agent 仍在占用，但租约可能先到期。处理：`sweepExpiredLeases` **跳过有 grace 决策的卡**；CLI 每次 2 秒轮询顺带刷新心跳/租约。这样 60 秒内不会被第三方领走；60s 后正常落锁。 |
| 服务重启时正处于宽限期 | 启动恢复：`grace_until > now` 的决策继续计时（ticker 重建），卡保持占用；`grace_until <= now` 的直接执行 `grace→open`（释放占用 + 落锁 + 停止信号），避免重启留下「永远宽限」的卡。 |
| 删卡与回答并发 | 删卡级联删决策；回答事务先读决策状态再更新，删卡后回答 404。 |
| 提问后旧 agent 继续动代码（宽限内） | 宽限内占用仍归提问者，旧 agent 的 `done/fail` 仍可用（它会继续执行）；**锁后才释放占用**，此后旧 agent 的 `done/fail/heartbeat` 因 `claimed_by=null` / fence 不匹配而 409。 |

**权限规则汇总**：提问 = 唯一当前占用者 + fence；回答/修订 = 人类；撤回 = 人类或提问者本人；读取 = 本工作区所有人。

---

### 3.7 可发现性：待决策区放哪、未读数怎么算

#### 方案 A（推荐）：侧栏第六入口「待决策」+ 独立视图
- `navStore.NavView` 增加 `'decisions'`，`ENTRIES` 增加一项（图标 + 文案），位于「任务看板 / 任务树 / 知识库 / 日志 / 聊天」之后或「任务看板」之后（建议紧随看板，与任务同域）。
- **徽标** = 当前工作区 `state IN ('grace','open')` 的决策数；>0 显示红点数字，0 时不显示数字（入口仍可见、置灰），避免「入口凭空消失」导致找不到。
- 视图内容：按「宽限中（带倒计时）/ 未回答 / 已超时 / 最近已回答」四段分组；每条显示卡标题（可跳详情）、问题摘要、选项数、等待时长、提问者。宽限中的条目必须有秒级倒计时与「立即回答」主按钮。
- 优点：与现有单一导航权威一致（`navStore` 是唯一 view 状态）；徽标和聊天未读同级，符合用户「右下角弹窗 + 一个区域」的心智；深链（通知点击）直接 `setView('decisions')` + 选中 decision。
- 代价：侧栏从 5 项变 6 项，窄屏 176px 宽度需确认文案不折行（「待决策」两字足够）；需要新增 query 与 WS 失效逻辑。

#### 方案 B：看板「待规划」列内置顶分组
- 优点：零导航改动，卡本来就回待规划，天然同列。
- 代价：与普通待规划卡混在一起，锁卡容易被当成普通卡；「移出待决策区」需要额外分组折叠；侧栏无徽标 → 不看板就发现不了。**不推荐作为主入口**，可作为看板内的次级提示（卡片锁标识）。

#### 方案 C：右上角铃铛 + 抽屉
- 优点：不占侧栏。
- 代价：项目刚完成「顶栏移除、侧栏为唯一导航」的重构（`App.tsx:70` 注释），再引入顶栏入口会逆着既定 IA；且与账号/设置抽屉互斥关系需要新规则。**不推荐**。

#### 未读口径（必须与聊天未读分开）
- **徽标数** = grace + open 决策数（不是「未点击」）。理由：待决策的语义是「未回答」，不是「未查看」；用 seen 状态会让徽标在点开后消失，但卡仍然锁着，误导用户。宽限中的条目也应计数（它正在倒计时）。
- 附加红点：`created_at` 在 24 小时内且 grace/open → 红点（强调新问题）；锁后超过 72 小时 → 黄/红「超时」标签。
- `answered` 的决策在「最近已回答（24h）」区保留一小时或一天，让用户看到「它移出去了」，之后只留历史查询。
- 数据接口：`GET /api/decisions?workspace_id=&state=grace|open&limit=`；徽标可复用同一 query 的 `count`（或轻量 `GET .../decisions/count`），WS `decision.*` 事件触发 invalidate。

---

## 4. 数据模型草案（与现有 `issue` 表对齐）

### 4.1 新表

```sql
-- 决策主表：一条问题 = 一行；state='open' 即「该卡被锁」
CREATE TABLE IF NOT EXISTS issue_decision (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  context_md TEXT NOT NULL DEFAULT '',        -- 为什么卡住、已尝试什么
  trigger TEXT NOT NULL DEFAULT 'blocked',    -- blocked / scope_change / irreversible / missing_input
  state TEXT NOT NULL DEFAULT 'grace',        -- grace / open / answered / withdrawn
  created_by TEXT NOT NULL,                   -- agent id（必须是当时的 claimed_by）
  created_session_id TEXT,
  created_turn_id TEXT,
  created_fence INTEGER,                      -- 提问时的 claim_fence（审计用）
  grace_seconds INTEGER NOT NULL DEFAULT 60,  -- 本次宽限时长（工作区默认 60，可单次覆盖）
  grace_until INTEGER NOT NULL,               -- 宽限截止时刻；到期由 ticker/惰性判定落锁
  locked_at INTEGER,                          -- 实际落锁时间（提醒起点）
  stop_requested_at INTEGER,                  -- 协作式停止信号写入时间
  stop_ack_at INTEGER,                        -- agent 确认收到停止（可选，仅观测）
  checkpoint_json TEXT,                       -- 提问前断点（stash SHA / 文件清单 / next_step / 后台进程）
  current_answer_id TEXT,                     -- 最新有效答案（NULL=未回答）
  answer_revision INTEGER NOT NULL DEFAULT 0, -- 与 answer 行一一对应
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  withdrawn_at INTEGER,
  withdrawn_by TEXT,
  withdrawn_reason TEXT,
  expires_at INTEGER,                         -- 可空；NULL=锁后永久等待
  on_expire TEXT NOT NULL DEFAULT 'stay_locked', -- stay_locked / unlock_default（仅显式选择才允许）
  stale_level INTEGER NOT NULL DEFAULT 0,     -- 0/1/2 = 4h/24h/72h 提醒档位（去重用）
  last_notified_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_decision_option (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES issue_decision(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,                 -- 1..N，展示顺序
  label TEXT NOT NULL,                  -- 选项短标题（必填）
  consequence TEXT NOT NULL,            -- 选它会发生什么（必填）
  is_default INTEGER NOT NULL DEFAULT 0 -- 「搁置/超时」时按它继续；最多 1 个
);

CREATE TABLE IF NOT EXISTS issue_decision_answer (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES issue_decision(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  option_id TEXT REFERENCES issue_decision_option(id) ON DELETE SET NULL,
  answer_text TEXT,                     -- 自由补充；option_id 为空则必须有文本
  answered_by TEXT NOT NULL,            -- 'user'（当前仅人类可答）
  source TEXT NOT NULL,                 -- web / cli
  created_at INTEGER NOT NULL
);
```

### 4.2 索引与约束

```sql
-- 一卡最多一条「grace 或 open」决策：宽限期与锁共用同一个唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_active
  ON issue_decision(issue_id) WHERE state IN ('grace', 'open');
CREATE INDEX IF NOT EXISTS ix_decision_ws_state
  ON issue_decision(workspace_id, state, created_at);
CREATE INDEX IF NOT EXISTS ix_decision_issue
  ON issue_decision(issue_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_option_ord
  ON issue_decision_option(decision_id, ord);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_answer_rev
  ON issue_decision_answer(decision_id, revision);
```

### 4.3 状态机

```
        kb ask（事务：建决策 grace，卡保持「进行中」+ 仍占用）
   [无决策] ─────────────────────────────────────────────► grace (grace_until = now+60s)
                                                               │
            ┌──────────── 60s 内 answer（立即放行）─────────────┤
            ▼                                                  │ 60s 到期（ticker/惰性判定）
        answered（卡仍进行中、仍占用，agent 继续）                ▼
            │                                              open（锁）
            │ 修订（人类，CAS revision）                     │
            ▼                                              ├─ answer（人类）→ answered（解锁，需重新 claim）
        answered(rev+1)                                    ├─ withdraw（人类/提问者，reason）→ withdrawn（解锁）
                                                           └─ 不自动作答、不自动解锁
```

- **进入 grace 的前置**：卡被提问者占用（`claimed_by=agent`、fence 匹配、`status='进行中'`）；同卡无 grace/open 决策；选项 ≥2 且 consequence 非空；checkpoint 已落库（建议强制，可配置）。
- **grace 期间**：卡 status=进行中、占用不释放、`claim_fence` 不 bump；服务端只记录 `grace_until` 与 `checkpoint_json`；任何状态流转仍受「占用中禁止改状态」保护；租约清扫与批量退回必须跳过 grace 卡（否则 60 秒内会被第三方领走）。
- **grace→answered（宽限内回答）**：决策转 answered；**卡不动**（仍进行中、仍占用），agent 直接继续；不写 stop 信号；不产生 trim/requeue。
- **grace→open（60s 到期）**：单事务内完成——决策转 open、写 `locked_at`/`stop_requested_at`、bump `claim_fence`、卡 status=待规划、清空 `claimed_by/claimed_at/claim_lease_until/last_heartbeat_at/session_id/last_seen_comment_id`、写系统评论、广播 WS。bump fence 用于让旧 agent 的后续收尾一律 409，避免「已被停任务却还能 done」。
- **open→answered（锁后回答）**：决策转 answered；卡保持待规划、解锁；agent 需重新 `claim` 才继续（可能换人）。
- **withdrawn**：分两种——**grace 内撤回**：取消宽限，卡保持「进行中」且占用不释放，CLI 返回 `WITHDRAWN`，agent 按默认选项继续（用户主动取消提问，不是拒绝执行）；**open 后撤回**：解锁，卡回待规划，保留理由与撤回人，并打 `decision_parked` 标记防止 dispatch 立刻领走。
- **删除卡**：级联删除全部决策与答案；删除确认需提示。
- **不允许**：answered → open（重新提问 = 新建一条决策）；grace/open → 自动 answered（无超时自动作答）；grace 期间被第三方 claim（占用未释放，结构上不可能）。

### 4.4 `Issue` 投影新增字段（`packages/shared`，只读派生，不落 `issue` 表）

```ts
interface Issue {
  // ...现有字段
  /** 是否存在 open 决策（锁；查询期由 EXISTS 派生；grace 不算） */
  decision_locked?: boolean;
  /** 当前 open/grace 决策 id（无则 null） */
  open_decision_id?: string | null;
  /** 宽限期截止毫秒时间戳（仅 grace 期间有值，用于倒计时） */
  decision_grace_until?: number | null;
  /** 最久未回答的 open 决策已等待秒数（无则 null） */
  decision_waiting_seconds?: number | null;
}
```

- 全部声明为可选（与现有 `due_date?`/`blocked_by_count?` 的兼容口径一致），旧消费者零改动。
- 列表查询用相关子查询派生（与 `blockedByAggregateJoin` 同风格），避免 N+1。

### 4.5 迁移与注册顺序

- 新增 `apps/server/src/db/migrations/pendingDecision.ts`，**纯追加表 + 索引**，不重建 `issue`，因此**不受** `migrateIssueStatusModel` 重建顺序影响；在 `initSchema` 末尾（`migrateClaimLease` 之后）注册即可。
- 若采纳可选优化「`issue.open_decision_id` 指针列」，该列必须在 `migrateIssueStatusModel` 之后加（否则被重建带走）；推荐先不做，避免双源。

---

## 5. CLI 与技能接口草案（与现有 `kb` 风格一致）

### 5.1 命令组

| 命令 | 参数 | 作用 | 退出码 |
| --- | --- | --- | --- |
| `kb ask <issue-uuid>` | `--question <text>`（必填）<br>`--option '<label>|<consequence>'`（重复 ≥2）<br>`--default <ord>`（可选，默认 1）<br>`--context <md>` / `--context-stdin`<br>`--trigger blocked\|scope_change\|irreversible\|missing_input`<br>`--grace <s>`（默认取工作区 60，0–600）<br>`--wait <s>`（默认 = grace；0 等同 `--no-wait`）<br>`--no-wait`（异步 pending）<br>`--checkpoint-file <path>` / `--checkpoint-stdin`<br>`--on-expire stay_locked\|unlock_default`<br>`--session <id>` `--turn <id>`（仅记录） | 提问：建 `grace` 决策；**卡保持进行中、占用不释放**；同步等待最多 `--wait` 秒。宽限内答→打印答案并退出（放行）；超时→服务端落锁 + 停任务，打印 `LOCKED decision=<id>` | 0 已回答或已锁（两者都用结构化字段区分，非错误）<br>2 非占用者 / 已有 grace/open / 限流 / 状态非进行中<br>3 选项不足、重复 label、consequence 为空、非法枚举<br>1 任务不存在 / 服务错误 |
| `kb decisions` | `--workspace <id\|名>`（缺省按 cwd）<br>`--state grace\|open\|answered\|withdrawn`（缺省 open）<br>`--issue <uuid>`<br>`--stale`（只看超时）<br>`--limit <n>`<br>`--json` | 列待决策（`grace` 用于展示 60 秒倒计时） | 0 / 1 |
| `kb decision <decision-id>` | 决策 id（支持 ≥8 位前缀，**仅本命令组**）<br>`--json` | 详情：问题、选项、答案、修订历史、等待时长 | 0 / 1 / 2（前缀歧义） |
| `kb answer <decision-id>` | `--option <ord\|option-id\|label>` 或 `--text <自由文本>`（二选一/可并用）<br>`--actor user`（默认 user）<br>`--source cli`<br>`--mark`（可选：同时把卡评论游标推进） | 首次回答：`grace` 内→立即放行（卡不动）；`open` 后→解锁（卡回待规划）+ 写答案 + 系统评论 | 0 成功<br>2 已回答 / 已撤回 / CAS 冲突<br>3 选项不存在 / 既无选项又无文本<br>1 决策不存在 |
| `kb answer <decision-id> --revise` | 追加 `--expected-revision <n>` | 修订答案（追加 revision） | 0 / 2（版本冲突）/ 3 |
| `kb decision withdraw <decision-id>` | `--reason <text>`（必填）<br>`--actor user\|agent` | 撤回问题并解锁（grace 期间撤回则取消宽限、卡保持占用） | 0 / 2（非 grace/open / 非提问者）/ 3 |
| `kb stop-check <issue-uuid>` | `--json` | 供 agent 在步骤间/写文件前检查 `stop_requested`；`--json` 返回 `{stop_requested, decision_id, reason}` | 0（无论是否需停止）/ 1（任务不存在） |

**与现有命令的兼容改动**
- `kb show <issue>` 输出追加 `决策: <id>（grace，剩余 42s）` / `（open，已等待 3h）` 或 `决策: 无`；`--json` 增加 `decision` 字段（含 `state`、`grace_until`、`checkpoint_json` 摘要）。
- `kb list-tasks` 表格在「占用者」列后加锁标记 `🔒`（文本用 `[待决策]`，避免终端字体问题）；`--json` 带 `decision_locked`。
- `kb claim` 遇到 `DECISION_LOCKED` 时，stderr 必须给出**决策 id + 卡标题 + 可执行下一步**（`kb decision <id>`），不得沿用「已被占用」文案。
- `kb done/fail` 对锁卡：卡已无占用，本来就会报「未被占用」；文案可细化为「该卡存在未回答决策，请先回答或撤回」。

### 5.2 服务端端点草案

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/issues/:id/ask` | body：`{agent_id, fence?, question, context_md?, trigger, options:[{label,consequence,is_default?}], grace_seconds?, wait_seconds?, no_wait?, checkpoint?, expires_at?, on_expire?, session_id?, turn_id?}`；事务建 `grace` 决策（卡不变、占用不释放）；`wait_seconds>0` 时服务端最多挂起该请求到宽限结束或回答（也可由 CLI 轮询，实现取其一并保持一致）；返回 `{status:'answered'|'locked', decision}` |
| GET | `/api/decisions` | `workspace_id / state（含 grace）/ issue_id / stale / limit`；返回 decision 摘要 + 卡标题 |
| GET | `/api/decisions/:id` | 全量：选项、答案、revision 历史、剩余宽限秒数、checkpoint 摘要 |
| POST | `/api/decisions/:id/answer` | `{option_id?, option_ord?, answer_text?, answered_by:'user', source, expected_revision?}`；`state='grace'` → 立即放行（卡不动）；`state='open'` → 解锁（卡回待规划）；修订要求 `state='answered'` + CAS |
| POST | `/api/decisions/:id/withdraw` | `{actor, reason}`；提问者或 user；grace 撤回=取消宽限（卡保持占用），open 撤回=解锁 |
| GET | `/api/issues/:id/stop` | `{stop_requested, decision_id, reason}`；供 CLI 与心跳读取 |
| POST | `/api/issues/:id/stop-ack` | 可选：agent 确认收到停止（写 `stop_ack_at`，仅观测，不影响锁） |
| GET | `/api/workspaces/:workspaceId/decisions/count` | 徽标数（grace + open + stale 分组） |
| WS | `decision.grace_started / decision.answered / decision.expired / decision.revised / decision.withdrawn / issue.stop_requested / issue.changed` | 前端倒计时、通知与失效；`issue.changed` 继续用于卡面锁标识 |

> `routes.ts` 是热点文件（多张卡共用）。实现卡必须串行，或把决策路由拆到独立 `decisionRoutes.ts` 只在 `routes.ts` 加一行 `router.use(...)`，把冲突面压到最小。

### 5.3 `skills/ask-user/SKILL.md` 草案

```markdown
# ask-user

## 何时用（必须同时满足）
1. 已 `kb claim` 一张卡，且状态是「进行中」；
2. 已经尝试过读代码/文档/知识页，仍缺一个**只有用户能拍板**的事实或取舍；
3. 该问题的答案会改变接下来写什么代码（不是审美、不是「要不要继续」）；
4. 能给至少 2 个具体选项，每个选项有一句「选了会怎样」。

## 何时禁用
- 用户正在对话里，能用一句话回你 → 直接在聊天回答，不得进待决策区；
- 能靠读仓库/知识页得出答案；
- 想用提问逃避执行、验收或失败回报；
- 同一张卡已有 grace/open 决策（先等这 60 秒，不要重复问）。

## 流程
1. **先写断点**（stash create SHA、git status/diff 摘要、未完成步骤、next_step、后台进程 PID），存进 `--checkpoint-file` 或随 `--checkpoint-stdin`；
2. `kb ask <卡> --question ... --option 'A|后果A' --option 'B|后果B' --trigger ... --checkpoint-file ...`（默认最多阻塞等待 60 秒）；
3. 若返回 `answered`：**立即继续**，不释放占用、不重新 claim，按答案接着做；
4. 若返回 `LOCKED`：**立即停止**——不再改文件、不再提交、不 `kb done`；写一条卡评论说明停在断点 `next_step`，然后结束本轮；
5. 之后用户回答（可能 3 小时后）：重新 `kb claim` → `kb decision <id>` 读答案/修订 → `git status` 复核 → 从 checkpoint 的 `next_step` 续跑；
6. 若答案在你开工后被修订，卡面会标 `answer_stale`，重新读最新 revision。
7. 异步模式（`--no-wait`）下：拿到 `decision_id` 后写评论、停手，在每步之间用 `kb stop-check <卡>` 检查是否需停止；不得盲目继续跑完整任务。

## 禁止
- 一次提多个问题；无选项的问题；自问自答；替用户选答案；
- 提问后继续提交代码；
- 把「长任务」当免罪符：短任务里真正卡住也可以问，长任务里不需要问就不许问。
```

**打包影响**：`AGENTS.md` 的「对外打包约束」固定携带 5 个技能；新增 `ask-user` 必须同步 `scripts/package-portable.mjs` 与 `app/rules-manifest.json` 的清单（属于实现卡，不在本次设计范围）。

---

## 6. 风险清单（v2 重点 4 项，前 3 项最高）

### R1 锁死与连锁阻塞（最高风险，v2 概率上调）
- 触发：60 秒内没人抢答（开会/离开/通知没到）→ 每次长任务都被冻结一次；决策再无人回答 + 依赖链/父子结构把卡放在关键路径上。
- 最坏后果：一条依赖链全部停摆，父卡永远无法 `close`，`swing-dev` 每班都跳过、看起来「没有可做任务」；用户以为系统坏了。由于 60 秒很短，**同样的永久锁问题会比 v1 更频繁地发生**。
- 缓解：宽限倒计时 + 秒级通知（§3.2.5）、锁后 4h/24h/72h 分级提醒、待决策区置顶超时分组、`kb decisions --stale`、撤回/搁置入口、`decision_parked` 防自动派工、卡面与父卡错误文案显式点名「因未回答决策阻塞」。
- 残余：只要用户始终不回答，锁就不会解开（除非显式撤回/搁置）——这是产品选择，必须在 UI 与技能文案里写明，不能靠自动解锁掩盖。

### R2 ask-user 被滥用（把「不确定」外包给用户）
- 触发：技能约束被忽略；agent 在正常对话中频繁提问；每张卡都问三四条。
- 最坏后果：决策区被低价值问题淹没，用户开始无视所有通知 → R1 的概率与损失同时放大；正常聊天被打断，体验倒退。
- 缓解：一卡一条 grace/open、同 agent 并发/频率上限、`trigger` 枚举与审计统计、技能「禁用清单」、可关闭开关。
- 残余：结构校验能拦「没有选项/重复提问」，拦不住「这条问题本不该问」。

### R3 通知静默失败（v2 从「不便」升级为「功能失效」）
- 触发：浏览器权限被拒、页面关闭、系统专注助手拦截、桌面壳未授予通知权限、窗口最小化后定时器节流。
- 最坏后果：宽限 60 秒内用户根本收不到提醒 → **每次提问都必然超时**；用户事后只看到「任务被冻结」，误判为「agent 卡死」。通知失败不再只是体验问题，而是直接决定 60 秒机制是否成立。
- 缓解：把通知定位为宽限期前置能力（§3.2.5 的 ≤2s 验收标准）；徽标 + 顶部汇总条 + 应用内常驻 toast 三件套；宽限倒计时在所有可见面同步；回答前 toast 不自动消失；下次打开必现未回答列表。
- 残余：纯 Web + 页面长期关闭时，系统层面没有任何可靠推送能力（没有 Service Worker/推送服务），只能等下次打开；这类场景 60 秒设计注定失败，需要用户改用桌面壳或缩短不在场时的工作。

### R4 协作式停止失效（v2 新增）
- 触发：agent 收到 `LOCKED` 后仍继续跑（忽略返回值）、或用异步模式后没有检查 `stop_requested`；CLI 进程被杀/超时预算不足，停止信号没送达。
- 最坏后果：卡已回待规划并上锁，但 agent 仍在改文件，产生「锁卡还在被写」的脏工作树；下一次 claim 的 agent 看到无法解释的改动；若 agent 尝试 `done` 会 409，但本地改动无法自动回滚。
- 缓解：同步 `kb ask` 的返回值即停止指令（最短路径）；`--no-wait` 强制在技能里要求步骤间 `kb stop-check`；锁时 bump fence，使旧 agent 的一切看板收尾 409；断点约定让续跑者先 `git status` 审阅。
- 残余：无法强制 kill 正在执行的工具；文件层只能协作式停止，必须如实写进技能与 UI。

### 次级风险（列出但不展开）
- 双源漂移（若加 `open_decision_id` 指针列，漏改即漂移）→ 推荐行即锁，不加权威列。
- `routes.ts` 热点冲突 → 决策路由独立文件，`routes.ts` 只加一行挂载。
- 旧库迁移顺序（新表纯追加，风险低；若加 issue 列须排在重建迁移之后）。
- 候选：决策数据含用户输入，可能包含敏感信息；需与评论同级的脱敏要求，不进日志明文。

---

## 7. 拆卡建议（只建议，不建卡）

### 7.1 建议的卡序与边界

| 卡 | 标题（建议） | 目标文件集（预估） | 依赖 | 验收要点 |
| --- | --- | --- | --- | --- |
| DEC-1 | 决策数据模型与生命周期 | `apps/server/src/db/migrations/pendingDecision.ts`、`schema.ts`、`db/repos/decision.ts`、`services/decision.ts`、`test/decision.test.ts` | 无（本设计卡） | 建表/索引幂等；`grace/open` 唯一约束；状态机（grace→answered 放行 / grace→open 落锁 / open→answered 解锁 / withdraw；修订 CAS）；checkpoint 存取；删卡级联；旧库迁移 |
| DEC-2 | 锁与流程门禁接线 | `services/claim.ts`、`services/taskHierarchy.ts`、`services/releaseRunning.ts`、`db/repos/issue.ts`、`packages/shared/src/types.ts`（仅本卡 hunk） | DEC-1 | 锁卡 claim 409 `DECISION_LOCKED`（仅 open）；`grace→open` 时释放占用 + bump fence + 卡回待规划；批量退回/租约清扫/启动恢复不得清 grace/open；issue 投影 `decision_locked/open_decision_id/decision_grace_until`；回归 claim/lease/release 用例 |
| DEC-3 | 决策 REST 与 WS 事件 | `apps/server/src/api/decisionRoutes.ts`（新）、`routes.ts`（仅挂载 1–3 行）、`api/schemas.ts` | DEC-1、DEC-2 | ask（grace + wait/nowait）、answer（grace 放行 / open 解锁）、revise、withdraw、stop/stop-ack、count；单事务；错误码；WS 事件；幂等接口口径 |
| DEC-4 | CLI 决策命令组 | `packages/cli/src/commands/decision.ts`（新）、`index.ts`、`show.ts`、`listTasks.ts`、`test/decision.test.ts` | DEC-3 | `kb ask`（默认 60s 同步等待/2s 轮询、`--no-wait`）、`kb decisions/decision/answer/withdraw/stop-check`；退出码 0/1/2/3；`--json`；claim 遇锁文案；`show` 决策块与倒计时 |
| DEC-5 | ask-user 技能与打包清单 | `skills/ask-user/SKILL.md`、`AGENTS.md`、`scripts/package-portable.mjs`、`app/rules-manifest.json` 生成逻辑 | DEC-4（行为可验） | 技能文案含「禁用清单/checkpoint/60s 流程/LOCKED 停止/续跑」；打包后 `check-rules.cmd` 自检含 ask-user；不携带全局规则 |
| DEC-6 | 待决策视图与卡面锁标识 | `apps/web/src/state/navStore.ts`、`components/shell/SideBar.tsx`、`components/decisions/**`（新）、`App.tsx`、`Board.tsx`/`IssueCard.tsx`、`DetailPanel.tsx`、对应测试 | DEC-3 | 第六入口 + 徽标 = grace+open 数；三段分组（宽限中/未回答/超时/最近已回答）；卡面 `[待决策]`/倒计时标识；详情回答/修订历史/checkpoint 摘要；窄屏可用；测试 |
| DEC-7 | 通知两档与降级 | `desktop/src-tauri/Cargo.toml`、`capabilities/*.json`、`apps/web/src/components/decisions/notify.ts`、`apps/web/**` toast/汇总条 | DEC-6 | 有壳走 Tauri 通知；无壳走 Web Notification；**同机权限允许时 ≤2s 到达**；拒绝/静音降级到徽标+toast；点击深链到决策；不引入服务端推送 |
| DEC-8 | 提醒档位与超时升级 | `services/decisionReminder.ts`、启动接线、`decisionRoutes.ts` 的 stale 查询、测试 | DEC-2、DEC-6 | 从 `locked_at` 起算 4h/24h/72h 幂等去重；不自动解锁；`--stale` 列表；统计端点 |
| DEC-9 | 宽限计时器与停止信号通道 | `services/decisionGrace.ts`（新）、启动接线、心跳响应、`services/sessionManager.ts`（仅 stop 读取）、测试 | DEC-2、DEC-3 | `grace→open` ticker 幂等（含服务重启补算）；写 `stop_requested_at` + bump fence + WS；心跳/`stop-check` 可读；不得误伤 `grace` 决策 |

### 7.2 执行顺序与并行约束

```
DEC-1 → DEC-2 → DEC-3 → DEC-4 → DEC-5
DEC-2, DEC-3 → DEC-9（宽限计时与停止信号）
DEC-3 → DEC-6 → DEC-7（通知，须满足 60s 验收）
DEC-2, DEC-6 → DEC-8（提醒与 stale 展示）
```

- **必须串行**：DEC-1 → DEC-2 → DEC-3（三张卡都动服务端契约，且 DEC-2 改 `claim.ts` 热点）。
- **DEC-9（60s 计时与停止信号）** 依赖 DEC-2 的「锁时释放 + bump fence」口径，可与 DEC-3 并行；但必须等 DEC-3 的 WS 事件名定稿，避免两卡各写一套事件。
- **DEC-4 / DEC-6** 在 DEC-3 完成后可并行（不同包），但 DEC-4 与 DEC-6 都会读 `Issue` 投影，需在 DEC-2 定稿字段名后冻结。
- **DEC-6 与其它前端卡** 可能撞 `navStore.ts`、`SideBar.tsx`、`DetailPanel.tsx`、`Board.tsx`（项目里这些是高频文件）；派工前必须 `git status` + `kb show` 核对占用，有在飞卡就排队或建 blocks 边。
- **DEC-7** 动 `desktop/**`，与前端卡不同包，但要等 DEC-6 的事件源与深链接口定型；60 秒验收必须在此卡完成（否则宽限期不可用）。
- **DEC-8** 只读决策表，可与 DEC-6 并行，但「超时分组」UI 归 DEC-6。
- 每张卡独立验收、独立提交；提交信息带卡号；`--scope` 精确到本卡文件集。

### 7.3 不建议的做法
- 不建议把「决策表 + 锁门禁 + CLI + Web 视图 + 通知」塞进一张卡：跨 3 个包、≥8 个可独立验收步骤，按项目拆卡判据必须拆。
- 不建议先做 UI（DEC-6）再补门禁：会出现「界面能提问、但锁不住卡」的假可用状态，误导验收。
- 不建议复用 `awaiting_input` 的 15 分钟/2 小时超时；也不建议用自定义状态表达锁。

---

## 8. 结论摘要（给验收人 30 秒版）

1. **可实现**，但必须新增一张决策表并把它作为「锁」的唯一真相；不加新状态、不用布尔锁字段当权威。
2. **时序采用 v2 语义**：提问 → `grace` 60 秒（卡不锁、占用不释放、agent 同步等待）→ 期内回答立即放行（不重领卡）→ 超时则 `grace→open`，卡回待规划 + 释放占用 + bump fence + 停止信号。
3. **7 条意图中 #2 有硬限制**（模型判断无法机器验证），只能靠技能硬规则 + CLI 结构校验 + 频率限制 + 审计；其余可实现，#5 需改 claim/状态门禁，#3/#7 有明确降级。
4. **推荐承载方式 A**：CLI 同步等待 60 秒、2 秒短轮询，超时返回值即停止指令；`--no-wait` 作为异步降级，必须先写断点。
5. **推荐锁方案**：`issue_decision` 的 open 行即锁（`grace`/`open` 部分唯一索引 + `claim` 的 `NOT EXISTS`）；回答/撤回即解锁；批量退回、租约清扫、启动恢复都不得解锁。
6. **不复用会话级 15 分钟/2 小时超时**：锁后默认永久等待，配 4h/24h/72h 分级提醒（从 `locked_at` 起算）与人工撤回/搁置，绝不自动作答或自动解锁。
7. **60 秒只覆盖「人在机器旁 + 通知秒到」**：通知必须 ≤2s 且为宽限期前置条件；纯浏览器关页必然超时，这是物理限制。
8. **弹窗两档**：Tauri 壳走 `tauri-plugin-notification`；纯浏览器走 Web Notification（localhost 可用但需授权）→ 两者都必须以「徽标 + 汇总条 + 常驻 toast」为可靠通道。
9. **最可能翻车**：锁死连锁阻塞（60s 使概率上调）、ask-user 被滥用、通知静默失败、协作式停止失效。
10. **建议 9 张实现卡**（DEC-1…DEC-9），先模型/门禁/宽限计时，再接口/CLI/技能/Web，最后通知与提醒；`routes.ts`、`navStore.ts`、`SideBar.tsx`、`DetailPanel.tsx` 为串行热点。

---

## 9. 未验证项与需要人工裁决的点

- 桌面壳通知的实际权限表现（Windows 专注助手、打包后的通知身份）未在真机验证；设计只给出能力路径。
- 浏览器 Web Notification 在 8787 的具体权限弹窗时机与系统静音表现未实测（需要真实点击）。
- 「长任务」阈值（多少步/多久算长）没有客观口径，需产品裁决；本文只建议记录 `created_turn_id` 而不做硬判定。
- **60 秒是否为最终默认值**未定：本文按用户原话设 60，并建议做成工作区可调（默认 60、0–600）。若实测「每次长任务都被冻结」成本过高，需要产品重新裁决默认值，而不是实现层偷偷延长。
- **agent 工具调用的超时预算**未知：同步等待 60s 要求 harness 单次工具超时 ≥60s；若某些客户端硬编码 30s，必须改用 `--no-wait` 或缩短 `--wait`，需在 DEC-4 实测后确认。
- **ticker 精度与重启补算**未实跑：`grace→open` 依赖服务端定时扫描，需验证「服务重启跨宽限」「高并发 100 条 grace」下的延迟与幂等。
- 决策内容是否允许包含附件/截图（当前草案纯文本 + markdown），未定；如需附件，要复用现有 attachment 通道，成本另计。
- 是否允许 agent 之间互相回答（草案：不允许，回答仅人类），需产品确认。
