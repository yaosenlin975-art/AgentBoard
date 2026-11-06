# 聊天界面改造设计说明（2026-11-05）

- 可点击原型：[index.html](index.html)（双击即可打开，无构建依赖）
- 一屏信息架构：[ia.html](ia.html)
- 边界：本轮**只出原型与设计**，未修改 `apps/**` 任何源码；账号管理 `settings/**` 不在范围内。
- 方向已拍板：①计划条=B、②工具结果=B、③危险操作=A（三档）、④长任务=B（阻塞态）、⑤侧栏=B+C（分叉）。
- 视觉沿用 `apps/web/src/index.css` 的 `--ab-*` 令牌（暖石墨 + 琥珀），仅新增 diff 的增/删语义色。

---

## 0. 结论与推荐落地顺序

| 顺序 | 先做什么 | 为什么先做 |
|---|---|---|
| 1 | 侧栏：`title` / 归档 / 搜索 / 分叉（含契约底座字段） | 与工具执行链路完全解耦，失败面最小；现有待规划卡 `35a0d755` 可直接并入，避免两套改名实现 |
| 2 | 计划条 + 工具结果卡（diff 卡） | 只读观测层：新增 `session_turn` 与 `message.meta_json`，不改执行器；先把"看得见"做扎实 |
| 3 | 暂停—回答通道 + `awaiting_input` | 阻塞态与危险审批共用同一套"turn 暂停 + 恢复"底座，先做问答最省 |
| 4 | 三档确认 + `approval_rule` + 撤销入口 | 复用第 3 步的暂停通道，增量是规则表与授权 UI |
| 5 | 单步重试 | 唯一需要改执行器语义（step ledger + 幂等），风险最高，放最后 |

> 计划条与 diff 卡不要等执行器改造：先把状态与观测落到 `session_turn` / `message.meta_json`，后续阻塞、审批、重试都在这套状态上叠加。

---

## 1. 视觉与密度契约

- 令牌：`--ab-page / card / raised / hairline / ink / ink-2 / ink-3 / accent / accent-soft`，暗色同源；新增 `--ab-add`、`--ab-del` 两对语义色，仍落在暖色系内。
- 字号：标题 13px、正文 12px、元信息 10px、代码 10px；不做大字号仪表盘。
- 圆角 7–10px；1px 细线分隔；不用彩色大底色块（除危险区块用 `--ab-del-soft`）。
- 动效：160ms `cubic-bezier(0.2,0,0,1)`；`prefers-reduced-motion: reduce` 下全部关闭（原型 CSS 已实现）。
- 三处落点，不新增页面：**侧栏**（ChatSessionList）、**轮次**（MessageList 内）、**输入区**（Composer）。

---

## 2. 五块能力逐条

### ① 计划条（用户已定 B）

**改哪里**：新增 `apps/web/src/components/chat/PlanBar.tsx`；挂在 `MessageList` 的"一轮"容器顶部（现有事件聚合块之前，[MessageList.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/chat/MessageList.tsx#L270-L303)）；状态来源由 `ChatPanel` 透传（现有 `running` 推导在 [ChatPanel.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/chat/ChatPanel.tsx#L311-L311)）。

**形态**：一轮一条，sticky 贴消息区顶部；一行显示 `计划 3/5 · 正在执行：… · 状态 chip · ▾`；点开是紧凑步骤清单（第 n 步 + 完成/执行中/失败/等待回答），**不铺时间线**。思考与工具明细继续走现有 `EventGroup` 折叠（[MessageList.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/chat/MessageList.tsx#L117-L131)）。

**新字段**：`session_turn.current_index`、`session_turn.state`、`session_turn.plan_json`（`[{step_id,title,state}]`，state ∈ pending/running/done/failed/awaiting）。

**状态**：`running / awaiting_input / awaiting_approval / failed / done / stopped`。计划条只读，不提供改计划（避免与执行器抢状态）。

**可访问性**：计划条是 `button` + `aria-expanded`；步骤变化写入隐藏 `aria-live=polite` 区域（"计划第 3 步，共 5 步，执行中"）。

**验收口径**：一轮内只有一个计划条；切到别的会话不显示该条；完成/失败/等待回答三种 chip 与颜色可辨；reduced-motion 下不闪。

### ② 工具结果卡（用户已定 B）

**改哪里**：`MessageList` 内新增 `ToolResultCard` + 文件级 `DiffBlock`；事件流里"带产物"的 tool 事件提升为可见卡，纯思考/无产物的工具仍留在 `EventGroup` 折叠里（不推翻现有聚合）。

**形态（必须三件套）**：头部 `✓/✕ + 工具名 + 耗时 + 输出摘要（单行截断）`；主体按**文件**折叠：路径 + `+N −M` + 展开后 unified diff（行级增删底色）；footer `在 git 里看 ↗`（有完整 diff/补丁时给出出口）。

**新字段**：`message.turn_id`、`message.step_id`、`message.meta_json`：
```json
{ "status": "ok|failed", "duration_ms": 2400, "output_summary": "更新 3 处…",
  "diff": { "files": [{ "path": "...", "add": 18, "del": 4, "patch": "@@ …" }] },
  "tool_call_id": "call_…" }
```
> `patch` 服务端截断（如 400 行/文件），完整内容走 git 出口；老消息 `meta_json` 为 NULL 时按现有 EventGroup 渲染，不回填。

**「在 git 里看」**：优先打开现有文件查看器的 diff 视图；没有该视图时退化为"复制 `git diff -- <path>` + 提示"。不做新页面。

**验收口径**：任一工具结果都能看到成功/失败、耗时、输出摘要；diff 默认折叠到文件级；单文件可展开/收起；失败卡有"重试此步"而不是整轮重试。

### ③ 危险操作三档确认（用户已定 A）

**改哪里**：新增 `ApprovalDialog.tsx`（`role=dialog aria-modal`），由 `ChatPanel` 在 `awaiting_approval` 时挂载；会话头 `⋯` 增加"审批规则"入口（工作表，不是新页面）。

**形态**：列出工具名、目标路径/命令、不可撤销说明；三张单选卡画全：
- **仅本次**：只批这次调用，不写规则；
- **本任务**：规则绑定 `issue_id`，任务结束失效；
- **本工作区**：规则绑定 `workspace_id`，跨会话生效，需要撤销入口与审计。

键盘：方向键切换档位、Esc=拒绝、弹窗内 Tab 循环、打开时焦点落在当前档位；默认选"仅本次"。

**新字段/新表**：`approval_rule(id, workspace_id, issue_id?, session_id?, turn_id?, tool_name, match_key, scope, created_at, created_by, revoked_at?)`；未撤销规则的唯一索引按"scope+归属+tool+match_key"。

**成本与裁剪**（不默认砍掉）：见第 8 节。

**验收口径**：三档全部可见可选；选择后写入 `approval_rule`（仅本次不写）；撤销后下次重新询问；拒绝后本轮转入 `stopped` 而不是静默失败。

### ④ 长任务阻塞态（用户已定 B）

**改哪里**：`MessageList` 内新增 `AwaitingInputCard`；`ChatPanel` 的 `running` 判定扩展为"session.status=运行中 **或** turn 未结束"（否则阻塞态下停止按钮消失）；`Composer` 增加阻塞提示条。

**形态**：轮次内提问卡（Agent 在等你回答 + 问题 + 选项按钮 + "回答后继续同一轮"说明）。回答后**同一轮**继续：计划当前步完成、下一步转 running，已完成步骤不重放。

**契约**：`POST /api/sessions/:id/turns/:turnId/answer { option_id?, text? }`；`session_turn.state` 写入 `awaiting_input`；WS 推 `session.turn`。

**停止**：阻塞态仍显示"停止"（用户已定：除了停止，还要能阻塞等人回答）；停止后已完成步骤保留。

**验收口径**：阻塞态计划 chip 显示"等待回答"，输入区出现提示；点选项或直接输入都能恢复同一轮；刷新后状态从服务端恢复（不依赖前端内存）。

### ⑤ 会话侧栏（B+C）

**改哪里**：`ChatSessionList.tsx` 增补，**保留 AUDIT-3 的两行条目、分组头、运行/失败点、未读、行内删除确认**（现有结构在 [ChatSessionList.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/chat/ChatSessionList.tsx#L125-L133) 与 L243-L249）。

**新增**：
- 搜索框：客户端过滤标题 / 任务号 / 模型 / 分叉来源；标题字段落库后无需再为预览做额外查询（避免 N+1）。
- 重命名：行内编辑，Enter 提交 / Esc 取消，空标题拒绝。
- 归档：行操作与会话头 `⋯` 均可；`已归档 N ▸` 折叠组可恢复；运行中的会话拒绝归档（409，与删除同口径）。
- 分叉：行操作/会话头 `⋯`；从当前轮（或指定消息）复制消息到新会话，新会话带 `⎇ 分叉自 …` 标记并自动选中。**不复制** plan、审批、adapter_session_id；`issue_id/cli/model` 继承。
- 删除入口与确认保留（不因新增菜单而移除）。

**新字段**：`session.title`（含"首条用户消息懒生成"的可选策略）、`session.archived_at`、`session.forked_from_session_id`、`session.fork_message_id`。

**验收口径**：搜索无匹配有空态；重命名即时生效且列表/头部同步；归档后默认列表不可见、可恢复；分叉后源会话不变、新会话有来源标记；AUDIT-3 的未读/运行点/删除确认一个不少。

---

## 3. 补齐项

### 3.1 单步重试
- 失败步骤卡提供"重试此步"；**只重跑该步**，不整轮重发。现有错误卡的"整轮重试"保留为兜底，但默认引导到单步。
- 需要 `message.step_id` 与 step ledger（每步工具调用记录 + 幂等键）；仅 `failed` 步骤允许重试。
- 验收：重试后已完成步骤不重复执行、diff 卡不重复生成（原型用 `executed` 计数验证）。

### 3.2 草稿持久化
- 现在 `chatDraft` 是单值且未进 `persist.partialize`（[panelStore.ts](file:///D:/WorkSpaces/任务看板/apps/web/src/state/panelStore.ts#L55-L55) / L139-L147）。
- 改为 `chatDrafts: Record<sessionId, string>`，进 `partialize` 的 localStorage；切换会话/刷新后恢复；不落服务端。
- 验收：刷新后草稿仍在且光标可继续输入；不同会话草稿互不覆盖。

### 3.3 成本/上下文脚注
- 输入区底部一行：`本轮 12.4k tokens · 估算 ¥0.02 · 上下文 34%`，右对齐，10px，不使用仪表盘。
- 数据：`session_turn.usage_json { input_tokens, output_tokens, cost_usd, context_used_tokens, context_limit_tokens }`；汇率由服务端配置提供，UI 标注"估算"。
- 验收：未开始轮次显示 0；流式过程中随 `session.usage` 更新；不占消息区高度。

---

## 4. 状态机

### 4.1 轮次（`session_turn.state`）

```
idle ──发送──> running
running ──Agent 提问──> awaiting_input ──回答────> running   （同一 turn，不新建）
running ──危险工具──> awaiting_approval ──允许──> running
                                      └──拒绝──> stopped
running ──全部步骤完成──> done
running ──某步失败──────> failed(step) ──重试此步──> running(step) ──> done
running ──用户停止──────> stopped（已完成步骤保留）
```

- 状态唯一写入方：服务端 `sessionManager`；前端只渲染 + 发起动作（answer / approve / retry / stop）。
- `session.status` 保持现有四态（运行中/已结束/失败/…），**不新增会话状态**；`awaiting_*` 属于 turn 维度，避免"运行中"语义被拆散。
- 超时兜底：`awaiting_*` 超过 N 分钟转 `failed(awaiting_timeout)`，UI 给"重新开始此步"，防止永久卡死。

### 4.2 步骤（`plan_json[].state`）

```
pending → running → done
                 └→ failed → (retry) → running → done
                 └→ awaiting（Agent 提问时暂停该步）
```

### 4.3 三档确认的作用域解析顺序

```
本次请求 scope=once        → 直接执行，不写规则
scope=task                 → 写 approval_rule(issue_id, tool, match_key)，任务结束/取消时失效
scope=workspace            → 写 approval_rule(workspace_id, tool, match_key)，需要撤销入口
后续请求：精确匹配(workspace/issue) > 规则过期/撤销 → 重新弹窗
```

---

## 5. 服务端契约变更表（共 22 条）

### 5.1 数据库（9）

| # | 变更 | 形态 | 迁移影响 |
|---|---|---|---|
| 1 | `session.title` | `TEXT NULL` | 纯加列；NULL 时沿用现有"任务标题 / cli·model / 首条消息"回退，行为不变 |
| 2 | `session.archived_at` | `INTEGER NULL` | 纯加列；NULL=未归档；默认查询排除 |
| 3 | `session.forked_from_session_id` | `TEXT NULL` | 纯加列，无回填 |
| 4 | `session.fork_message_id` | `TEXT NULL` | 分叉起点消息 id，仅用于来源说明 |
| 5 | 新表 `session_turn` | `id, session_id, seq, state, current_index, plan_json, awaiting_json, usage_json, started_at, ended_at` | 新表；历史轮次不补，旧会话无计划条 |
| 6 | `message.turn_id` | `TEXT NULL` | 纯加列；旧消息 NULL，按旧逻辑聚合 |
| 7 | `message.step_id` | `TEXT NULL` | 单步重试与步骤定位；旧消息 NULL |
| 8 | `message.meta_json` | `TEXT NULL` | 工具状态/耗时/摘要/diff/tool_call_id；NULL 时旧渲染 |
| 9 | 新表 `approval_rule` | `id, workspace_id, issue_id?, session_id?, turn_id?, tool_name, match_key, scope, created_at, created_by, revoked_at?` | 新表；未撤销规则建唯一索引 |

### 5.2 端点（8）

| # | 端点 | 说明 |
|---|---|---|
| 10 | `PATCH /api/sessions/:id` | 扩展现有（当前只收 `model`，[routes.ts](file:///D:/WorkSpaces/任务看板/apps/server/src/api/routes.ts#L1194-L1198)）：新增 `title?`、`archived?`；运行中归档→409 |
| 11 | `GET /api/sessions?workspace_id=&include_archived=1` | 默认排除归档；列表直接带 `title/archived_at/forked_from_session_id` |
| 12 | `POST /api/sessions/:id/fork` | `{ from_message_id?, title? }`；复制截止消息；清空运行时状态 |
| 13 | `POST /api/sessions/:id/turns/:turnId/answer` | `{ option_id?, text? }`；turn 非 `awaiting_input` → 409 |
| 14 | `POST /api/sessions/:id/turns/:turnId/approvals/:requestId` | `{ decision:'allow'|'deny', scope:'once'|'task'|'workspace' }` |
| 15 | `POST /api/sessions/:id/turns/:turnId/steps/:stepId/retry` | 仅 `failed` 步骤；需 step ledger/幂等键 |
| 16 | `GET /api/workspaces/:id/approval-rules` | 当前生效规则列表（撤销入口数据源） |
| 17 | `DELETE /api/workspaces/:id/approval-rules/:ruleId` | 软撤销（写 `revoked_at`），不物理删 |

### 5.3 WS 事件（5）

| # | 事件 | 载荷 |
|---|---|---|
| 18 | `session.plan` | `{ turn_id, plan, current_index }` 快照，变更即推 |
| 19 | `session.turn` | `{ turn_id, state, awaiting? }`（含 answer 恢复后） |
| 20 | `session.approval_request` | `{ turn_id, request_id, tool, target, risk }`，触发三档弹窗 |
| 21 | `session.usage` | `{ turn_id, usage }`，合并节流推送 |
| 22 | `session.changed` | `{ session_id, title?, archived_at?, forked_from_session_id? }`，侧栏增量更新 |

### 5.4 兼容与回滚
- 全部为**加列/加表**，SQLite `ALTER TABLE ADD COLUMN` 无重写；老库可直接起。
- 老消息 `meta_json=NULL`、老会话 `title=NULL` 时渲染与今天一致，不需要数据回填。
- 回滚只需停用新 UI；新列/新表留着不影响旧路径。**不做**任何破坏性迁移。

---

## 6. 组件与状态落点（实现对照）

| 能力 | 组件/文件 | 新增内容 |
|---|---|---|
| ① 计划条 | 新 `PlanBar.tsx`；`MessageList.tsx` 挂载 | 步骤渲染、状态 chip、aria 播报 |
| ② 工具结果 | `MessageList.tsx` 新 `ToolResultCard`/`DiffBlock` | 摘要行、文件折叠、diff、git 出口 |
| ③ 三档确认 | 新 `ApprovalDialog.tsx`；`ChatPanel.tsx` 挂载；头 `⋯` | 单选组、风险说明、撤销入口 |
| ④ 阻塞态 | `MessageList.tsx` 新 `AwaitingInputCard`；`ChatPanel.tsx` running 推导；`Composer.tsx` 提示条 | 提问卡、恢复通道 |
| ⑤ 侧栏 | `ChatSessionList.tsx` | 搜索、行内改名、归档组、分叉、来源标记 |
| 草稿 | `panelStore.ts` | `chatDrafts: Record<sessionId,string>` 进 `partialize` |
| 轮次状态 | `appStore.ts` | `turns: Record<turnId, TurnState>`、`plan`、`usage`、`awaiting` |
| 类型 | `packages/shared/src/types.ts` | `Session` 加 4 字段（现 L180-L182）；`Message` 加 turn/step/meta（现 L189）；新增 `SessionTurn`/`ApprovalRule`/`ToolMeta` |

> 说明：`session.status` 不动；`running` 判定从"只看 session.status"扩展为"session.status 或存在未结束 turn"（[ChatPanel.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/chat/ChatPanel.tsx#L311-L311) 的 L351/L455 两处使用点一并核对）。

---

## 7. 明确砍掉的信息与理由

| 砍掉 | 理由 |
|---|---|
| 工具时间线/甘特 | 与"明细折叠"方向冲突；消息区被工具流水淹没 |
| 全局计划面板 | 跨会话污染，分叉会话会共享错误计划；每轮一条已够 |
| token/费用仪表盘 | 噪音大、决策价值低；一行脚注即可 |
| 分叉树可视化 | 需要树查询与布局；平铺 + `⎇ 来源` 已能辨认 |
| 审批中心独立页 | 仅为低频撤销建页成本过高；`⋯` 内工作表足够 |
| 列表摘要/最后消息预览 | 会引入额外 JOIN 或 N+1；AUDIT-3 刚收口，不破坏结构 |
| 工具明细默认展开 | 已定 B；保持默认折叠 |
| 计划可编辑 | 执行器是唯一状态源，前端改计划会双写 |
| 替换现有错误卡/整轮重试 | 不推翻现有能力；单步重试是新增首选入口 |
| 删除入口与行内确认 | AUDIT-3 既有结构，保留 |

---

## 8. 「本工作区」档的成本与裁剪建议

**全量实现的成本**
1. `approval_rule` 表 + 撤销列表/撤销端点 + 审计记录（谁在何时把规则放大到全区）。
2. 规则失效策略：会话归档/删除、工作区删除、任务结束时规则去留；分叉会话是否继承规则必须写死。
3. 影响面放大：一条规则可让全区同类写操作免确认，误用代价最高；需要"最近使用/影响会话数"提示。
4. UI：撤销入口、规则列表、过期时间；否则规则只增不减。

**裁剪建议（推荐 v1，不砍 UI）**
- 三档**全部画出**、全部可选；但 `workspace` 档首版只对**只读工具**（Read/Grep/List）放开，写类工具禁用并提示"需先提供撤销入口"。
- 代价：写类高频操作仍需重复确认（用户疲劳）；收益：零撤销面板成本，且不会把危险写操作放大到全区。
- 备选：`workspace` 档 UI 置灰 + tooltip，等撤销入口落地再开放；代价是设计稿承诺的三档可用性延后。
- 不建议的做法：直接砍掉第三档（用户已明确要求三档都画出来）。

---

## 9. 最可能翻车的两处

1. **`awaiting_input` 与 adapter 生命周期绑定**：turn 的"暂停"依赖执行进程/会话还活着。进程重启、租约丢失、页面刷新后，turn 可能永久停在 `awaiting_input`（停止按钮在、但没人能回答）。必须有服务端心跳 + 超时转 `failed(awaiting_timeout)` + "重新开始此步"出口，并验证刷新后的恢复路径。
2. **单步重试的副作用幂等**：工具"部分成功但报失败"（如写了 2 个文件、第 3 个失败）时重试会重复写；没有 step ledger + 幂等键时，单步重试比整轮重试更危险。必须只允许 `failed` 且标记为可重试的步骤，并记录每步已产生的写入。

---

## 10. 验证记录

- 方式：jsdom 载入 `index.html` + 内联 `app.js`，模拟真实点击/输入/键盘事件；临时脚本 `verify.cjs` 跑完已删除。
- 结果：**51 / 51 断言通过**（9 组）：
  - A 计划条：初始 5/5、折叠/展开、步骤计数、button + aria-expanded、明细折叠
  - B diff 卡：工具卡展开、文件级折叠、diff 增删行、git 出口、整体收起
  - C 长任务：步骤推进、3/5 失败态、失败卡与重试入口、执行记录
  - D 单步重试：只追加第 4 步、步骤 1–3 保留、diff 卡不重复、继续至完成
  - E 阻塞态：等待回答、输入提示、选项回答、同一轮继续、不重放
  - F 三档确认：三档齐全、单选切换、本工作区可选、确认写入本任务、回到运行中
  - G 侧栏：搜索过滤/清空、行内重命名、归档与归档组、分叉与来源标记
  - H 草稿：localStorage 写入、模拟刷新恢复、成本脚注
  - I 无障碍：aria-live、radiogroup、Esc 关闭、无重复 id、`--ab-*` 令牌、reduced-motion

复跑命令（临时脚本已清理，如需复跑按此重建即可）：`NODE_PATH=apps/web/node_modules node verify.cjs`。

---

## 11. 与现有卡片的协调

- 改名：现有待规划卡 `35a0d755` 与本设计共用 `session.title` 契约；实现时只保留一条改名路径，避免两套 PATCH 体。
- 会话列表：AUDIT-3 刚重构，新增能力只做**增量**（搜索框在头部、行操作菜单、归档组），不改两行条目与删除确认结构。
- 与存储线无关：本轮契约只涉及 session/message/turn/approval，不碰工作区数据下沉与知识库链路。
