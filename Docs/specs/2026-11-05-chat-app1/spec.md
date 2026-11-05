# Spec：CHAT-APP1 三档确认服务端（卡 97342849）

## 目标
落地 `approval_rule` 表、审批决策端点、规则查询/软撤销端点、`session.approval_request` 推送与 scope 解析；
复用 CHAT-AWAIT1 的 `session_turn` 暂停通道（心跳/超时兜底天然复用），不为 `984853e7` 预留代码。

## 决策（不可再改）
| 项 | 结论 |
|---|---|
| 三档语义 | `once` 不写规则；`task` 写 `issue_id`；`workspace` 写 `workspace_id` |
| 拒绝终态 | `deny` → `session_turn.state='stopped'`，`awaiting_json.reason='approval_denied'`，`ended_at` 落值 |
| 允许终态 | `allow` → `running`，`awaiting_json=null`、`awaiting_heartbeat_at=null`、`ended_at=null`；当前 awaiting 步骤回 `running` |
| 唯一约束 | 部分唯一索引：`(scope, workspace_id, COALESCE(issue_id,''), tool_name, match_key) WHERE revoked_at IS NULL`；重复插入 → 409 |
| 撤销 | 软撤销写 `revoked_at`，不物理删；重复撤销 → 404 |
| scope 解析 | 先 `task`（issue 存在且状态非关闭类）再 `workspace`；未命中 → 进入 `awaiting_approval` 并推 `session.approval_request` |
| 工作区档工具限制 | 仅 `Read/Grep/List`（大小写不敏感）；写类工具 → 403 `FORBIDDEN`，文案含「需先提供撤销入口」 |
| `task` 档无 issue | 400 `VALIDATION_ERROR` |
| 请求关联 | 决策按 `turn.awaiting_json.approval.request_id` 校验；不匹配 → 404 |
| WS 事件归属 | `SessionApprovalRequestEvent` 并入 `TurnObservationEvent`（**不**并入前端 `WsEvent`，避免 `apps/web` 穷尽 switch 编译失败） |
| 超时 | 不新增定时器：`sweepAwaitingTurns` 已覆盖 `awaiting_approval`，超时 → `failed(awaiting_timeout)` |

## 文件与改动

### 1. 新增 `apps/server/src/db/migrations/approvalRule.ts`
`migrateApprovalRule(db)`：
- `CREATE TABLE IF NOT EXISTS approval_rule(...)`（字段按卡面 #9；`workspace_id`/`issue_id`/`session_id`/`turn_id` 外键，`scope CHECK IN ('task','workspace')`）。
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_rule_active ON approval_rule(scope, workspace_id, COALESCE(issue_id,''), tool_name, match_key) WHERE revoked_at IS NULL`。

### 2. `apps/server/src/db/schema.ts`
import 并在 `migrateSessionAwaiting` 之后调用 `migrateApprovalRule(db)`（依赖 `session_turn` 已建）。

### 3. 新增 `apps/server/src/db/repos/approvalRule.ts`
导出：
- `createApprovalRule(db, input): ApprovalRule` —— UNIQUE 约束异常转 `ConflictError('同键的审批规则已存在')`。
- `getApprovalRule(db, id): ApprovalRule | null`
- `listActiveApprovalRules(db, workspaceId): ApprovalRule[]`（`revoked_at IS NULL`，`created_at, id` 升序）
- `revokeApprovalRule(db, workspaceId, ruleId, now?): ApprovalRule` —— 不存在/跨工作区/已撤销 → 404
- `findActiveTaskRule(db, {workspace_id, issue_id, tool_name, match_key})`
- `findActiveWorkspaceRule(db, {workspace_id, tool_name, match_key})`

### 4. `packages/shared/src/types.ts`
- `TurnApprovalInfo { request_id, tool, target, risk, match_key }`
- `TurnAwaitingInfo` 增可选 `approval?: TurnApprovalInfo | null`
- `ApprovalScope = 'once'|'task'|'workspace'`；`ApprovalRuleScope = 'task'|'workspace'`；`ApprovalRule` 行类型
- `SessionApprovalRequestEvent { type:'session.approval_request'; session_id; turn_id; request_id; tool; target; risk }`
- `TurnObservationEvent` 并入该事件

### 5. `apps/server/src/services/turnAwaiting.ts`
`MarkAwaitingInput` 增可选 `approval?: TurnApprovalInfo`，`markTurnAwaiting` 写入 `awaiting_json.approval`；其余逻辑不变。

### 6. 新增 `apps/server/src/services/turnApproval.ts`
- 常量/工具：`APPROVAL_READ_ONLY_TOOLS = ['Read','Grep','List']`、`isReadOnlyApprovalTool(tool)`、`approvalMatchKey(tool, target)`。
- `resolveApprovalRule(db, input)`：task 精确匹配（issue 存在且 `!isClosedStatusName(...)`）优先，其次 workspace（且工具为只读）。
- `requestTurnApproval(db, { broadcast }, sessionId, turnId, input)`：轮次必须存在且属于会话（否则 404）、当前 `running`（否则 409）；命中规则 → `{auto_allowed:true}` 不改状态；未命中 → `markTurnAwaiting(..., approval)` + 广播 `session.approval_request`，返回 `request_id`。
- `decideTurnApproval(db, sessionId, turnId, requestId, input)`：
  1. 会话/轮次不存在 → 404；轮次非 `awaiting_approval` → 409；
  2. `awaiting_json.approval` 缺失或 `request_id` 不匹配 → 404；
  3. `allow + workspace` 且工具非只读 → 403；
  4. `allow + task` 且会话无 `issue_id` → 400；
  5. 事务内：按档写规则（`once` 不写；`task`/`workspace` 调 repo），更新 turn；规则重复 409 时整体回滚。

### 7. `apps/server/src/errors.ts`
新增 `ForbiddenError extends ApiError`（403，code `FORBIDDEN`）。

### 8. `apps/server/src/api/schemas.ts`
`approvalDecisionSchema = z.object({ decision: z.enum(['allow','deny']), scope: z.enum(['once','task','workspace']) })`。

### 9. `apps/server/src/api/routes.ts`
- `POST /sessions/:id/turns/:turnId/approvals/:requestId`：校验会话 → `decideTurnApproval` → 广播 `session.turn` → 返回 `{ turn, rule }`；第二次调用天然 409。
- `GET /workspaces/:workspaceId/approval-rules`：`requireExistingWorkspace` → 返回未撤销规则数组。
- `DELETE /workspaces/:workspaceId/approval-rules/:ruleId`：`requireExistingWorkspace` → 软撤销 → 返回含 `revoked_at` 的规则。

### 10. 新增 `apps/server/test/turnApproval.test.ts`
覆盖：
1. 迁移幂等 + 部分唯一索引（同键重复 409、撤销后同键可再建）。
2. `once` 不落规则 / `task` 的 `issue_id` 非空 / `workspace` 的 `issue_id` 为 NULL。
3. 非 `awaiting_approval` → 409；`deny` → `stopped`。
4. 写类工具 + `workspace` → 403（明确 code/文案）；只读工具 + `workspace` → 200。
5. GET 不含已撤销；DELETE 后行仍在且 `revoked_at` 非空；撤销后再次请求重新进入审批。
6. `session.approval_request` 四字段齐全；`allow` 后 `running`。
7. 任务关闭后 task 规则不命中。
8. 边界：body 非法 400、未知 turn/request/rule 404。
9. `awaiting_approval` 超时 → `failed(awaiting_timeout)`（复用 sweeper）。

## 提交口径
- 只暂存本卡 9 个改动文件 + 新增测试；`types.ts` 用 `git show HEAD:` 的 blob 仅应用本卡 hunk，经 `git hash-object -w` + `git update-index --cacheinfo` 入索引，**绝不整文件提交** CHAT-VIS1 改动。
- 严禁 `git add -A`；提交信息带 `[97342849]`；`git show --stat` 核对。
- 不派子代理。

## 验证
- `pnpm --filter @agentboard/shared build`、`pnpm --filter @agentboard/server build`、`pnpm --filter @agentboard/web build`。
- `pnpm --filter @agentboard/server exec vitest run test/turnApproval.test.ts`。
- 全量 `pnpm --filter @agentboard/server test`；红项逐条标基线/瞬时（已知基线：api / gitOnDone / gitBaselinePreexisting）。

## 收尾
置「待验收」、释放占用、写知识页 + 变更日志。
