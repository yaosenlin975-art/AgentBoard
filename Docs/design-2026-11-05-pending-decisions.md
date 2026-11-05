# 待决策区 + ask-user 技能 + CLI 接口：可行性设计

- 状态：设计提案（未实现、未拆实现卡）
- 日期：2026-11-05
- 设计卡：`77fcf859-5303-40e4-8c47-6593b54cc465`
- 边界：本文只落 `Docs/**`。未改动 `apps/**`、`packages/**`、`scripts/**`、`desktop/**`，也未在看板建任何实现卡。

---

## 0. 术语先对齐（名称混用是本需求最大的歧义源）

| 术语 | 本文定义 | 不是什么 |
| --- | --- | --- |
| **决策（decision）** | 一条绑定到任务卡的、带候选答案的结构化问题，可长期挂在看板上等人回答。 | 不是聊天里的 `awaiting_input`，也不是审批 `awaiting_approval`。 |
| **待决策（pending decision）** | `state='open'` 的决策行。 | 不是任务状态名，也不是「待规划」的同义词。 |
| **锁（decision lock）** | 「该卡存在 open 决策」这一事实带来的不可领取约束。 | 不是 `claimed_by`（那是执行占用），也不是租约 `claim_lease_until`。 |
| **回答（answer）** | 首次给出答案，使决策从 open 变 answered，并解除锁。 | 不等于「修订」。 |
| **修订（revise）** | 已回答后改答案，追加一条新 revision。 | 不会重新加锁，也不会自动重跑任务。 |
| **占用（claim）** | 智能体领取任务执行，受 fence / 租约约束。 | 与决策锁互斥：锁着的卡不可 claim。 |

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
| 3 | 待决策区展示 + 右下角弹窗 | **可实现（分两档）** | 有 Tauri 壳可走系统通知；纯浏览器只能 Web Notification + 应用内提示，且可能被系统静音。见 §3.4。 |
| 4 | 问题与任务卡绑定 | **可实现** | 决策表以 `issue_id` 外键 + 同工作区约束；天然支持一卡多条历史决策。 |
| 5 | 提问后卡回「待规划」并上锁，回答才解锁 | **需改数据模型 + 改 claim/状态门禁** | 这是全案核心：现有 `claimIssue` 会让任何「待规划」卡被领走，`swing-dev`/dispatch 都会踩中。必须加独立锁源。见 §3.1。 |
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
- 做法：新增 `issue_decision` 表；`state='open'` 的行存在即锁。用**部分唯一索引** `UNIQUE(issue_id) WHERE state='open'` 保证一卡最多一条 open 决策。
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
| `sweepExpiredLeases` | 只清占用字段 | 不动锁；若未来出现「锁卡仍有占用」（异常态），清扫只清占用、保留锁 |
| `recoverOnBoot` | 把会话绑定卡置回待规划并清占用 | 不碰决策行；锁保持 |
| `close` / `reopen` | 锁卡是「待规划」，close 本来就 409 | 无需改；文档写明「父卡收口前必须先回答或撤回子卡决策」 |
| 依赖判定 | 锁卡 status=待规划（kind=open），对下游仍是未解除 | 语义不变；**不把锁当成新的 blocker kind**，避免依赖口径分叉 |
| 删除任务卡 | 决策行随 `ON DELETE CASCADE` 消失 | UI 删除确认里提示「该卡有 1 条未回答决策，将一并删除」 |
| 父卡关闭 | 锁着的子卡停在待规划，未关闭 | 自然 409「存在未关闭后代」；错误文案可补「（含 N 条未回答决策）」 |

---

### 3.2 卡级决策 vs 会话级阻塞（超时与提醒）

**现状**：`awaiting_input` 属于 `session_turn`，窗口 = 心跳延长 15 分钟、绝对上限 2 小时（`turnAwawiting.ts:21-28`），超时直接把轮次判 `failed(awaiting_timeout)`。

#### 方案 A：直接复用 15 分钟 / 2 小时
- 优点：一套心跳、一套扫尾代码，最少新增。
- 代价：**语义错位**。会话级阻塞是「这一轮执行停在这里」，2 小时后超时收口是合理的；卡级决策是「这张卡等人拍板」，用户可能隔夜甚至隔周回答。2 小时自动收口会：解锁或丢弃决策、让卡突然变得可领、把「没人回答」误判成「执行失败」。
- 结论：不推荐复用超时数值；心跳/扫尾的**写法**可以借鉴，语义不能照搬。

#### 方案 B：永久锁死，直到有人回答
- 优点：最符合用户直觉（「只有回答了才解锁」），无「问着问着锁自己开了」的怪事。
- 代价：没有兜底。一张被遗忘的卡会永久不可领，拖住依赖链与父卡关闭；巡检只能看见它、不能推进；时间越久越没人记得。
- 结论：作为**默认**是对的，但必须配「可见性升级 + 人工撤出入口」，不能只有永久锁。

#### 方案 C（推荐）：默认永久锁 + 分层提醒 + 人工撤出入口，绝不自动解锁
- **默认**：`expires_at = NULL`，锁不因时间自动解除。
- **分层提醒（只提醒，不改状态）**：
  | 时长（自 `created_at`） | 动作 |
  | --- | --- |
  | 4 小时 | 侧栏徽标转红点；桌面/浏览器通知补推一次（去重键 = decision id + 档位） |
  | 24 小时 | 卡打 `decision_stale` 标记；卡片与详情展示「已等待 1 天」；当日汇总里列首位 |
  | 72 小时 | 进入「待决策 · 超时」分组；提醒改为每天一次；不再逐条弹窗 |
- **人工撤出入口（唯一合法解锁方式，均需理由）**：
  1. 提问的 agent 自己 `kb decision withdraw`（仅在 open 且仍是该卡最近提问者）；
  2. 用户在待决策区点「撤回问题」；
  3. 用户对决策显式回答「搁置，按默认方案继续」——这要求提问时**强制**给一个可执行的默认选项（建议固定为第 1 项，确认框里明示）。
- **可选的前瞻开关（默认关闭）**：提问时可传 `--expires 72h --on-expire stay_locked|unlock_default`。默认 `stay_locked`；只有用户显式选了 `unlock_default` 才允许到期解锁，并在决策详情永久标注「到期自动按默认项解锁」。
- 优点：语义与「只有回答了才解锁」一致；遗忘风险靠可见性而非自动开锁解决；锁的来源始终可追溯。
- 代价：需要新增「提醒档位」字段/去重逻辑与一个低频扫描任务；如果用户长期不看，卡确实会一直停着（这是设计选择，不是 bug，需在 UI 明写）。

#### 与会话级的关系
- 两者**并存、不互相替代**：聊天执行器卡住用 `awaiting_input`（15 分钟/2 小时，超时收口轮次）；看板决策用 `decision`（长期、无硬超时）。
- 一次 `kb ask` **不**要写 `awaiting_json`，也不要把轮次改成 `awaiting_input`；否则会出现「同一问题两套状态、两套超时」。
- 若提问发生在某个绑定会话的长任务里，可在 `issue_decision` 上冗余记录 `created_session_id / created_turn_id`，仅用于审计和「回答后是否唤醒该会话」的**可选**策略，不参与超时判定。

---

### 3.3 「只在长任务后调用、沟通中不调用」如何落地

**本质**：这是**判断力问题**，不是接口问题。任何服务端策略只能约束「结构合法」，不能证明「时机正确」。下面四层是能做的全部，末尾如实写残留风险。

#### 手段 1：技能文案硬规则（`skills/ask-user/SKILL.md`）
必须写死「问什么 / 不问什么」：
- **必须问**：不可逆操作（删数据、改对外契约）、范围变更（跨工作区/跨模块）、需要产品取舍且两种实现都合理、缺少凭据/设备/账号这类 agent 无法自行获取的前提。
- **禁止问**：能靠读代码/文档/知识页回答的；用户正在对话中可直接用一句话回的（**直接在聊天里回复，不进决策区**）；纯偏好/审美；一张卡能拆成多个小问题的（禁止打包多问，一次一条决策）；用提问代替执行或逃避验收。
- **硬前置**：必须先 `kb claim` 成功、且当前卡已工作到「无法继续」；提问后**不得**继续改代码或 `kb done`。
- **一次一条**：同一张卡同时最多 1 条 open 决策。

#### 手段 2：CLI 前置检查（可执行、可报错）
`kb ask` 在本地与服务端都校验：
1. 卡必须是**本 agent 当前占用**（`agent_id == claimed_by` 且 fence 匹配），否则 409 `NOT_TASK_OWNER`；
2. 卡状态必须是「进行中」，否则 409 `ISSUE_STATUS_NOT_RUNNING`；
3. 至少 2 个选项，且每个选项必须有 `label` 与非空 `consequence`；重复 label 直接拒；
4. 该卡不得已有 open 决策（部分唯一索引兜底，服务端 409 `DECISION_ALREADY_OPEN`）；
5. 频率限制：同一 agent 同工作区同时最多 3 条 open 决策；每小时最多 6 条新决策（超过 429/409，文案给冷却时间）；
6. 可选 `--session <id> --turn <id>`：服务端校验会话属于本卡/本工作区，并记录 `created_turn_id`。**只记录，不据此判定「够不够长」**。

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

**原则**：通知不是事实来源；**待决策区的 open 列表与徽标才是**。任何「只靠弹窗」的方案都会在权限/静音/最小化场景下静默失败。

---

### 3.5 答案可修改：权威来源、是否重跑、历史、与评论/知识页的关系

#### 方案 A：覆盖式（`issue.answer_text` 直接 UPDATE）
- 优点：简单。
- 代价：无历史、并发下后写覆盖先写、无法审计「谁在什么时候改了答案」；一旦 agent 已按旧答案动工，无法判断它读到的是哪一版。
- 结论：不推荐。

#### 方案 B（推荐）：追加式 revision（append-only）
- `issue_decision_answer` 每次回答/修订插入一行，`revision` 自增；`issue_decision.current_answer_id` 指向最新一行，旧行保留并标记 `superseded_by`。
- **权威来源**：`current_answer_id` 指向的那一行 = 唯一有效答案；历史修订只用于展示与审计。
- **改答案是否重跑**：不自动重跑。首次回答只解锁卡（卡回到「待规划」，可被再次 claim）；修订只更新答案并**追加一条结构化系统评论**：
  - 若此时无人占用 → `answer_stale=false`，下次 claim 会看到最新答案；
  - 若此时已被 agent 占用/已开始执行 → `answer_stale=true`，卡面显示「答案在你开工后被修订」，并在评论里 @ 当前占用者（沿用现有评论唤醒机制，不新增强制中断）。
- **并发**：修订必须带 `expected_revision`（CAS），旧 revision → 409 `DECISION_REVISION_CONFLICT`；与首次回答的 `state='open'` 条件更新互斥，先到者赢。
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
| A 正在执行并准备提问，B 抢先 claim | `claim` 与 `ask` 都是单事务 + 条件 UPDATE。B 先 claim → A 的 `ask` 因 `claimed_by != A` 失败（409）；A 先 `ask` → 卡回待规划且带 open 决策，B 的 `claim` 被 `NOT EXISTS` 挡（409 `DECISION_LOCKED`）。 |
| 两个 agent 同时提问同一卡 | 提问要求当前占用者，而占用是排他的 → 结构上只可能一个。即使异常路径绕过，`UNIQUE(issue_id) WHERE state='open'` 兜底，第二个 409。 |
| 两个客户端同时点「回答」 | 回答是 `UPDATE ... WHERE state='open'` + `changes==1`；第二个 409 `DECISION_ALREADY_ANSWERED`。 |
| 回答与撤回同时 | 同一条件更新，先到者赢；另一个 409。 |
| 两个修订同时提交 | `expected_revision` CAS，旧版 409。 |
| 租约清扫 / 批量退回 / 启动恢复 与 提问并发 | 全部是 IMMEDIATE 事务，串行化。清扫只清占用、不碰决策；提问要求持有占用且 fence 匹配，若租约刚好过期，提问失败，agent 需重新 claim。 |
| 删卡与回答并发 | 删卡级联删决策；回答事务先读决策状态再更新，删卡后回答 404。 |
| 提问后旧 agent 继续动代码 | `ask` 已释放占用，旧 agent 的 `done/fail/heartbeat` 会因 `claimed_by=null` / fence 不匹配而 409；这是期望行为。 |

**权限规则汇总**：提问 = 唯一当前占用者 + fence；回答/修订 = 人类；撤回 = 人类或提问者本人；读取 = 本工作区所有人。

---

### 3.7 可发现性：待决策区放哪、未读数怎么算

#### 方案 A（推荐）：侧栏第六入口「待决策」+ 独立视图
- `navStore.NavView` 增加 `'decisions'`，`ENTRIES` 增加一项（图标 + 文案），位于「任务看板 / 任务树 / 知识库 / 日志 / 聊天」之后或「任务看板」之后（建议紧随看板，与任务同域）。
- **徽标** = 当前工作区 `state='open'` 的决策数；>0 显示红点数字，0 时不显示数字（入口仍可见、置灰），避免「入口凭空消失」导致找不到。
- 视图内容：按「未回答 / 已超时 / 最近已回答」三段分组；每条显示卡标题（可跳详情）、问题摘要、选项数、等待时长、提问者。
- 优点：与现有单一导航权威一致（`navStore` 是唯一 view 状态）；徽标和聊天未读同级，符合用户「右下角弹窗 + 一个区域」的心智；深链（通知点击）直接 `setView('decisions')` + 选中 decision。
- 代价：侧栏从 5 项变 6 项，窄屏 176px 宽度需确认文案不折行（「待决策」两字足够）；需要新增 query 与 WS 失效逻辑。

#### 方案 B：看板「待规划」列内置顶分组
- 优点：零导航改动，卡本来就回待规划，天然同列。
- 代价：与普通待规划卡混在一起，锁卡容易被当成普通卡；「移出待决策区」需要额外分组折叠；侧栏无徽标 → 不看板就发现不了。**不推荐作为主入口**，可作为看板内的次级提示（卡片锁标识）。

#### 方案 C：右上角铃铛 + 抽屉
- 优点：不占侧栏。
- 代价：项目刚完成「顶栏移除、侧栏为唯一导航」的重构（`App.tsx:70` 注释），再引入顶栏入口会逆着既定 IA；且与账号/设置抽屉互斥关系需要新规则。**不推荐**。

#### 未读口径（必须与聊天未读分开）
- **徽标数** = open 决策数（不是「未点击」）。理由：待决策的语义是「未回答」，不是「未查看」；用 seen 状态会让徽标在点开后消失，但卡仍然锁着，误导用户。
- 附加红点：`created_at` 在 24 小时内且 open → 红点（强调新问题）；超过 72 小时 → 黄/红「超时」标签。
- `answered` 的决策在「最近已回答（24h）」区保留一小时或一天，让用户看到「它移出去了」，之后只留历史查询。
- 数据接口：`GET /api/decisions?workspace_id=&state=open&limit=`；徽标可复用同一 query 的 `count`（或轻量 `GET .../decisions/count`），WS `decision.*` 事件触发 invalidate。

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
  state TEXT NOT NULL DEFAULT 'open',         -- open / answered / withdrawn
  created_by TEXT NOT NULL,                   -- agent id（必须是当时的 claimed_by）
  created_session_id TEXT,
  created_turn_id TEXT,
  created_fence INTEGER,                      -- 提问时的 claim_fence（审计用）
  current_answer_id TEXT,                     -- 最新有效答案（NULL=未回答）
  answer_revision INTEGER NOT NULL DEFAULT 0, -- 与 answer 行一一对应
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  withdrawn_at INTEGER,
  withdrawn_by TEXT,
  withdrawn_reason TEXT,
  expires_at INTEGER,                         -- 可空；NULL=永久等待
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
-- 一卡最多一条 open 决策：锁的唯一数据库级保证
CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_open
  ON issue_decision(issue_id) WHERE state = 'open';
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
                 kb ask（事务：建决策 + 卡回待规划 + 释放占用）
   [无决策] ─────────────────────────────────────────────► open
                                                            │
              answer（人类，首答，CAS state='open'）          │ withdraw（人类或提问者，reason 必填）
                                                            ▼            ▼
                                                        answered      withdrawn
                                                            │
                        revise（人类，expected_revision CAS） │
                                                            ▼
                                                        answered(rev+1)
```

- **进入 open 的前置**：卡被提问者占用（`claimed_by=agent`、fence 匹配、`status='进行中'`）；同卡无 open 决策；选项 ≥2 且 consequence 非空。
- **open 期间**：卡 status=待规划；`claimed_by/claimed_at/claim_lease_until/last_heartbeat_at/session_id/last_seen_comment_id` 全部清空（与 `releaseRunning` 同语义）；`claim_fence` **不 bump**（提问不是抢占，bump 会让提问者自己的 fence 失效；这里与批量退回有意不同）。
  - 若实现选择 bump fence，则 `ask` 必须返回新 fence 供调用方丢弃；**推荐不 bump**，因为 `ask` 后该 agent 不应再持有占用，后续收尾一律重新 claim。
- **answered**：卡保持待规划、可被重新 claim；**不再有锁**。
- **withdrawn**：同 answered（解锁），但保留理由与撤回人；卡评论区有系统评论。
- **删除卡**：级联删除全部决策与答案；删除确认需提示。
- **不允许**：answered → open（重新提问 = 新建一条决策）；open → 自动 answered（无超时自动作答）。

### 4.4 `Issue` 投影新增字段（`packages/shared`，只读派生，不落 `issue` 表）

```ts
interface Issue {
  // ...现有字段
  /** 是否存在 open 决策（查询期由 EXISTS 派生） */
  decision_locked?: boolean;
  /** 当前 open 决策 id（无则 null） */
  open_decision_id?: string | null;
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
| `kb ask <issue-uuid>` | `--question <text>`（必填）<br>`--option '<label>|<consequence>'`（重复 ≥2）<br>`--default <ord>`（可选，默认 1）<br>`--context <md>` / `--context-stdin`<br>`--trigger blocked\|scope_change\|irreversible\|missing_input`<br>`--expires <24h/72h/7d>`<br>`--on-expire stay_locked\|unlock_default`<br>`--session <id>` `--turn <id>`（仅记录） | 提问：建决策 + 卡回待规划 + 释放占用 + 系统评论 | 0 成功<br>2 非占用者 / 已有 open / 限流 / 状态非进行中<br>3 选项不足、重复 label、consequence 为空、非法枚举<br>1 任务不存在 / 服务错误 |
| `kb decisions` | `--workspace <id\|名>`（缺省按 cwd）<br>`--state open\|answered\|withdrawn`（缺省 open）<br>`--issue <uuid>`<br>`--stale`（只看超时）<br>`--limit <n>`<br>`--json` | 列待决策 | 0 / 1 |
| `kb decision <decision-id>` | 决策 id（支持 ≥8 位前缀，**仅本命令组**）<br>`--json` | 详情：问题、选项、答案、修订历史、等待时长 | 0 / 1 / 2（前缀歧义） |
| `kb answer <decision-id>` | `--option <ord\|option-id\|label>` 或 `--text <自由文本>`（二选一/可并用）<br>`--actor user`（默认 user）<br>`--source cli`<br>`--mark`（可选：同时把卡评论游标推进） | 首次回答：解锁 + 写答案 + 系统评论 | 0 成功<br>2 已回答 / 已撤回 / CAS 冲突<br>3 选项不存在 / 既无选项又无文本<br>1 决策不存在 |
| `kb answer <decision-id> --revise` | 追加 `--expected-revision <n>` | 修订答案（追加 revision） | 0 / 2（版本冲突）/ 3 |
| `kb decision withdraw <decision-id>` | `--reason <text>`（必填）<br>`--actor user\|agent` | 撤回问题并解锁 | 0 / 2（非 open / 非提问者）/ 3 |

**与现有命令的兼容改动**
- `kb show <issue>` 输出追加 `决策: <id>（open，等待 3h）` 或 `决策: 无`；`--json` 增加 `decision` 字段。
- `kb list-tasks` 表格在「占用者」列后加锁标记 `🔒`（文本用 `[待决策]`，避免终端字体问题）；`--json` 带 `decision_locked`。
- `kb claim` 遇到 `DECISION_LOCKED` 时，stderr 必须给出**决策 id + 卡标题 + 可执行下一步**（`kb decision <id>`），不得沿用「已被占用」文案。
- `kb done/fail` 对锁卡：卡已无占用，本来就会报「未被占用」；文案可细化为「该卡存在未回答决策，请先回答或撤回」。

### 5.2 服务端端点草案

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/issues/:id/ask` | body：`{agent_id, fence?, question, context_md?, trigger, options:[{label,consequence,is_default?}], expires_at?, on_expire?, session_id?, turn_id?}`；单事务建决策 + 回待规划 + 清占用 + 系统评论 |
| GET | `/api/decisions` | `workspace_id / state / issue_id / stale / limit`；返回 decision 摘要 + 卡标题 |
| GET | `/api/decisions/:id` | 全量：选项、答案、revision 历史、等待时长 |
| POST | `/api/decisions/:id/answer` | `{option_id?, option_ord?, answer_text?, answered_by:'user', source, expected_revision?}`；首答要求 `state='open'`，修订要求 `state='answered'` + CAS |
| POST | `/api/decisions/:id/withdraw` | `{actor, reason}`；提问者或 user |
| GET | `/api/workspaces/:workspaceId/decisions/count` | 徽标数（open + stale 分组） |
| WS | `decision.created / decision.answered / decision.revised / decision.withdrawn / issue.changed` | 前端失效与通知触发；`issue.changed` 继续用于卡面锁标识 |

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
- 同一张卡已有 open 决策（先等回答，不要重复问）。

## 流程
1. `kb ask <卡> --question ... --option 'A|后果A' --option 'B|后果B' --trigger ...`
2. `kb comment <卡> "已提交待决策 <decision-id>，等待回答后继续"`；
3. **停止改动**：不要 `kb done`，不要继续跑实现；占用已由 `ask` 释放；
4. 回答后（`kb decisions` 看到 answered）：`kb claim` 重新领卡 → `kb decision <id>` 读答案与修订历史 → 继续工作；
5. 若答案在你开工后被修订，卡面会标 `answer_stale`，重新读最新 revision。

## 禁止
- 一次提多个问题；无选项的问题；自问自答；替用户选答案；
- 提问后继续提交代码；
- 把「长任务」当免罪符：短任务里真正卡住也可以问，长任务里不需要问就不许问。
```

**打包影响**：`AGENTS.md` 的「对外打包约束」固定携带 5 个技能；新增 `ask-user` 必须同步 `scripts/package-portable.mjs` 与 `app/rules-manifest.json` 的清单（属于实现卡，不在本次设计范围）。

---

## 6. 风险清单（最可能翻车的 3 个点）

### R1 永久锁死与连锁阻塞（最高风险）
- 触发：决策没人回答 + 用户长期不看徽标 + 依赖链/父子结构把这张卡放在关键路径上。
- 最坏后果：一条依赖链全部停摆，父卡永远无法 `close`，`swing-dev` 每班都跳过、看起来「没有可做任务」；用户以为系统坏了。
- 缓解：§3.2 的分层提醒（4h/24h/72h）、待决策区置顶超时分组、`kb decisions --stale`、撤回/搁置入口、卡面与父卡错误文案显式点名「因未回答决策阻塞」。
- 残余：只要用户始终不回答，锁就不会解开——这是产品选择，必须在 UI 与技能文案里写明，不能靠自动解锁掩盖。

### R2 ask-user 被滥用（把「不确定」外包给用户）
- 触发：技能约束被忽略；agent 在正常对话中频繁提问；每张卡都问三四条。
- 最坏后果：决策区被低价值问题淹没，用户开始无视所有通知 → R1 的概率与损失同时放大；正常聊天被打断，体验倒退。
- 缓解：一卡一条 open、同 agent 并发/频率上限、`trigger` 枚举与审计统计、技能「禁用清单」、可关闭开关。
- 残余：结构校验能拦「没有选项/重复提问」，拦不住「这条问题本不该问」。

### R3 通知静默失败（用户以为没有待决策）
- 触发：浏览器权限被拒、页面关闭、系统专注助手拦截、桌面壳未授予通知权限、窗口最小化后定时器节流。
- 最坏后果：问题已提出但用户完全不知道，卡一直锁着；错过窗口期后误判为「agent 卡死」。
- 缓解：把通知定位为增强通道；徽标 + 顶部汇总条 + 应用内 toast 三件套常驻；回答前 toast 不自动消失；下次打开必现未回答列表。
- 残余：纯 Web + 页面长期关闭时，系统层面没有任何可靠推送能力（没有 Service Worker/推送服务），只能等下次打开。

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
| DEC-1 | 决策数据模型与生命周期 | `apps/server/src/db/migrations/pendingDecision.ts`、`schema.ts`、`db/repos/decision.ts`、`services/decision.ts`、`test/decision.test.ts` | 无（本设计卡） | 建表/索引幂等；open 唯一约束；状态机（open→answered/withdrawn，修订 CAS）；删卡级联；旧库迁移 |
| DEC-2 | 锁与流程门禁接线 | `services/claim.ts`、`services/taskHierarchy.ts`、`services/releaseRunning.ts`、`db/repos/issue.ts`、`packages/shared/src/types.ts`（仅本卡 hunk） | DEC-1 | 锁卡 claim 409 `DECISION_LOCKED`；锁卡禁改状态；批量退回/启动恢复不清锁；issue 投影 `decision_locked/open_decision_id`；回归 claim/lease/release 用例 |
| DEC-3 | 决策 REST 与 WS 事件 | `apps/server/src/api/decisionRoutes.ts`（新）、`routes.ts`（仅挂载 1–3 行）、`api/schemas.ts` | DEC-1、DEC-2 | ask/answer/revise/withdraw/count 五端点；单事务；错误码；WS 事件；幂等接口口径 |
| DEC-4 | CLI 决策命令组 | `packages/cli/src/commands/decision.ts`（新）、`index.ts`、`show.ts`、`listTasks.ts`、`test/decision.test.ts` | DEC-3 | `kb ask/decisions/decision/answer/withdraw`；退出码 0/1/2/3；`--json`；claim 遇锁文案；`show` 决策块 |
| DEC-5 | ask-user 技能与打包清单 | `skills/ask-user/SKILL.md`、`AGENTS.md`、`scripts/package-portable.mjs`、`app/rules-manifest.json` 生成逻辑 | DEC-4（行为可验） | 技能文案含「禁用清单/流程/禁止」；打包后 `check-rules.cmd` 自检含 ask-user；不携带全局规则 |
| DEC-6 | 待决策视图与卡面锁标识 | `apps/web/src/state/navStore.ts`、`components/shell/SideBar.tsx`、`components/decisions/**`（新）、`App.tsx`、`Board.tsx`/`IssueCard.tsx`、`DetailPanel.tsx`、对应测试 | DEC-3 | 第六入口 + 徽标 = open 数；三段分组（未回答/超时/最近已回答）；卡面 `[待决策]` 标识；详情回答/修订历史；窄屏可用；测试 |
| DEC-7 | 通知两档与降级 | `desktop/src-tauri/Cargo.toml`、`capabilities/*.json`、`apps/web/src/components/decisions/notify.ts`、`apps/web/**` toast/汇总条 | DEC-6 | 有壳走 Tauri 通知；无壳走 Web Notification；拒绝/静音降级到徽标+toast；点击深链到决策；不引入服务端推送 |
| DEC-8 | 提醒档位与超时升级 | `services/decisionReminder.ts`、启动接线、`decisionRoutes.ts` 的 stale 查询、测试 | DEC-2、DEC-6 | 4h/24h/72h 幂等去重；不自动解锁；`--stale` 列表；统计端点 |

### 7.2 执行顺序与并行约束

```
DEC-1 ──► DEC-2 ──► DEC-3 ──► DEC-4 ──► DEC-5
                        │
                        ├──────► DEC-6 ──► DEC-7
                        └──────► DEC-8（与 DEC-6 可并行，但 stale 展示部分需等 DEC-6）
```

- **必须串行**：DEC-1 → DEC-2 → DEC-3（三张卡都动服务端契约，且 DEC-2 改 `claim.ts` 热点）。
- **DEC-4 / DEC-6** 在 DEC-3 完成后可并行（不同包），但 DEC-4 与 DEC-6 都会读 `Issue` 投影，需在 DEC-2 定稿字段名后冻结。
- **DEC-6 与其它前端卡** 可能撞 `navStore.ts`、`SideBar.tsx`、`DetailPanel.tsx`、`Board.tsx`（项目里这些是高频文件）；派工前必须 `git status` + `kb show` 核对占用，有在飞卡就排队或建 blocks 边。
- **DEC-7** 动 `desktop/**`，与前端卡不同包，但要等 DEC-6 的事件源与深链接口定型。
- **DEC-8** 只读决策表，可与 DEC-6 并行，但「超时分组」UI 归 DEC-6。
- 每张卡独立验收、独立提交；提交信息带卡号；`--scope` 精确到本卡文件集。

### 7.3 不建议的做法
- 不建议把「决策表 + 锁门禁 + CLI + Web 视图 + 通知」塞进一张卡：跨 3 个包、≥8 个可独立验收步骤，按项目拆卡判据必须拆。
- 不建议先做 UI（DEC-6）再补门禁：会出现「界面能提问、但锁不住卡」的假可用状态，误导验收。
- 不建议复用 `awaiting_input` 的 15 分钟/2 小时超时；也不建议用自定义状态表达锁。

---

## 8. 结论摘要（给验收人 30 秒版）

1. **可实现**，但必须新增一张决策表并把它作为「锁」的唯一真相；不加新状态、不用布尔锁字段当权威。
2. **7 条意图中 #2 有硬限制**（模型判断无法机器验证），只能靠技能硬规则 + CLI 结构校验 + 频率限制 + 审计；其余可实现，#5 必须改 claim/状态门禁，#3/#7 有明确降级。
3. **推荐锁方案**：`issue_decision` 的 open 行即锁（部分唯一索引）+ `claim` 的 `NOT EXISTS` 门禁；回答/撤回即解锁；批量退回、租约清扫、启动恢复都不得解锁。
4. **不复用会话级 15 分钟/2 小时超时**：卡级决策默认永久锁，配 4h/24h/72h 分级提醒与人工撤回，绝不自动作答或自动解锁。
5. **弹窗两档**：Tauri 壳走 `tauri-plugin-notification`；纯浏览器走 Web Notification（localhost 可用但需授权）→ 两者都必须以「徽标 + 汇总条 + 常驻 toast」为可靠通道。
6. **最可能翻车**：永久锁死连锁阻塞、ask-user 被滥用、通知静默失败。
7. **建议 8 张实现卡**（DEC-1…DEC-8），先模型/门禁/接口，再 CLI/技能/Web，最后通知与提醒；`routes.ts`、`navStore.ts`、`SideBar.tsx`、`DetailPanel.tsx` 为串行热点。

---

## 9. 未验证项与需要人工裁决的点

- 桌面壳通知的实际权限表现（Windows 专注助手、打包后的通知身份）未在真机验证；设计只给出能力路径。
- 浏览器 Web Notification 在 8787 的具体权限弹窗时机与系统静音表现未实测（需要真实点击）。
- 「长任务」阈值（多少步/多久算长）没有客观口径，需产品裁决；本文只建议记录 `created_turn_id` 而不做硬判定。
- 决策内容是否允许包含附件/截图（当前草案纯文本 + markdown），未定；如需附件，要复用现有 attachment 通道，成本另计。
- 是否允许 agent 之间互相回答（草案：不允许，回答仅人类），需产品确认。
