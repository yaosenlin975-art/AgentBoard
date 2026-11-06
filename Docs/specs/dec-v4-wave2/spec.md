# DEC-V4 波 2 规格：延长宽限（EXT）+ 处置队列（P2）

- 卡：`61310826-eba9-4797-8abb-9981e841be66`（EXT）、`b1fd617d-3eb9-438f-b2e5-ecaf9dd01cc7`（P2）
- 依据：`Docs/prototypes/decisions-redesign-2026-11-06/DESIGN-NOTES.md` §3.5 / §4 / §6；两张卡面验收
- 结论先行：EXT 不需要改 `apps/server/src/api/routes.ts`（决策路由已在 `routes.ts:594` 挂载，新端点加在 `decisionRoutes.ts`），因此不触碰工作树里 PERF-1 未提交的 66+/13- 改动。

## 一、EXT：延长宽限

### 1. HTTP 契约

`POST /api/decisions/:id/extend`，body `{ seconds, by?, fence?, workspace_id? }`。

| 情况 | HTTP / code |
| --- | --- |
| 成功 | 200，返回体见下 |
| `seconds` 非整数 / <1 / >300 | 400 `INVALID_SECONDS` |
| id 不存在 | 404 `DECISION_NOT_FOUND` |
| `state != grace` | 409 `DECISION_NOT_GRACE` |
| `extended_seconds + seconds > max_extend_seconds` | 409 `EXTEND_LIMIT_EXCEEDED`（details: `extended_seconds` / `max_extend_seconds`） |
| 传了 `fence` 且 ≠ 当前 issue.claim_fence | 409 `STALE_FENCE`（复用 `assertFenceCurrent`） |
| 传了 `workspace_id` 且 ≠ 决策所属工作区 | 403 `FORBIDDEN`（跨区写） |

> 403 口径说明：本仓库没有服务端用户/权限模型（`kb answer` 同样不做权限校验）。按设计 §3.5「跨区延长需要目标工作区写权限，CLI 直接 403」，用**显式 `workspace_id` 与决策工作区不一致**作为唯一可落地的「无写权限」判定；不新造权限系统。

成功返回体：

```json
{
  "decision_id": "...",
  "state": "grace",
  "grace_until": 1793931234000,
  "remaining_grace_seconds": 227,
  "extended_seconds": 120,
  "extension_count": 2,
  "max_extend_seconds": 300
}
```

### 2. 落库与事件

- 迁移 `apps/server/src/db/migrations/pendingDecision.ts`：
  - 新库 DDL 增 `extended_seconds INTEGER NOT NULL DEFAULT 0`、`extension_count INTEGER NOT NULL DEFAULT 0`、`extended_by TEXT`、`extended_at INTEGER`；
  - 存量库用 `ensureColumn` 逐列幂等补齐（可重复执行）。
- 更新（`db/repos/decision.ts` 新函数，CAS `WHERE id=? AND state='grace'`）：
  - `grace_until = max(now, grace_until) + seconds * 1000`
  - `extended_seconds += seconds`、`extension_count += 1`、`extended_by = by ?? 'user'`、`extended_at = now`
  - **不动** `grace_seconds`、`created_fence`、issue 的 `claim_fence` / 占用 / 状态。
- `max_extend_seconds = min(300, max(0, 600 - grace_seconds))`；`grace_seconds` 已是 600 → 0，任何延长都 409。
- WS：`DecisionEvent` 增 `type: 'decision.extended'`（`packages/shared/src/types.ts`），payload 带 `grace_until`，另加可选 `extended_seconds` / `extension_count`；随后按既有口径广播 `issue.changed`。

### 3. 服务与路由

- 新服务函数放 `apps/server/src/services/decisionGrace.ts`：`extendDecisionGrace(db, input)`（校验顺序：参数 → 决策存在 → state → fence → 上限 → CAS 更新）。
- 路由加在 `apps/server/src/api/decisionRoutes.ts`，`askExtendSchema` 就地声明（该文件注释已说明 schema 暂不迁 `schemas.ts`）。
- 路由内 `emit(decision.extended)` + `emitIssueChanged`。

### 4. CLI `kb ask-extend`

`packages/cli/src/commands/decision.ts`：

```
kb ask-extend <decision-id> --seconds 60 [--by <actor>] [--fence <n>] [--json]
```

- id 支持完整 UUID 或 ≥8 位前缀；<8 位 → 退出码 3。
- `--seconds` 默认 60，必须 1–300 整数，否则本地拒绝退出码 3（`INVALID_SECONDS`）。
- `--by` 缺省 `ctx.agentId`；`--fence` 可选。
- 自动附带当前工作区 id 作为跨区守卫（`matchCurrentWorkspace` 失败则不带，不阻断）。
- 退出码：0 成功；2 状态/权限/上限（409/403 走全局映射）；3 参数非法；1 其它。

### 5. 文档与技能

- `Docs/api.md` 新增「待决策（DEC）」小节：端点、错误码、CLI 命令与退出码。
- `skills/ask-user/SKILL.md`：新增「延长宽限」流程（何时延/何时不延、命令、连点与 300/600 上限、LOCKED 不延、跨区 403），命令速查表补一行。

### 6. 验收（可观测）

- `apps/server/test/decisionApi.test.ts` 新增用例：200 字段齐全、`grace_until = max(now, 原值)+seconds`、extended 计数/人/原 `grace_seconds` 不变、fence 不变、`decision.extended` 事件、409/400/404/403 全码、连点到上限。
- 真实 `createApp`：`POST /api/decisions/:id/extend` 非 404（RULE-3）。
- CLI 真跑一次：对真实服务建 grace 决策 → `kb ask-extend --json` → `GET /api/decisions/:id` 读回 `grace_until` 增大（RULE-3）。

## 二、P2：处置队列

文件：`apps/web/src/components/decisions/DecisionsView.tsx`、`apps/web/src/components/decisions/countdown.ts`、`apps/web/src/test/decisionsView.test.tsx`。

### 1. 纯函数（countdown.ts）

- 新增 `DecisionSort = 'urgency' | 'waiting' | 'priority'`；`groupDecisions(active, answered, now, sort = 'urgency')`。
- 紧急度（默认）：grace `grace_until` 升序；open `blocked_downstream_count` 降序 → `locked_at` 升序；stale `locked_at` 升序；answered `answered_at` 降序。
- 等待最久：grace/open `created_at` 升序，同键回落紧急度；stale/answered 保持紧急度。
- 任务优先级：grace/open/stale `issue_priority` 高>中>低，同键回落紧急度；answered 保持紧急度。
- 兜底：`issue_priority` 缺失按「中」（rank=2）；`blocked_downstream_count` 非数字按 0。

### 2. 视图（DecisionsView.tsx）

- 页头：仅 `<h1>待决策</h1>` + 一个总数徽标（`data-testid="decisions-total"`，值 = grace+open+stale，原型 `list.length` 口径）；删除 `decisions-summary` 整句。
- 筛选 tab（`role=tablist`，`data-testid="decisions-tab-<key>"`，计数 `decisions-tab-count-<key>`）：全部 / 宽限中 / 待回答 / 已超时 / 已回答；计数来自完整分组，不受当前 tab 影响。
- 排序下拉（`data-testid="decisions-sort"`）：紧急度 / 等待最久 / 任务优先级。
- 分层固定 grace → open → stale → answered；rank 只在 grace/open/stale 连续编号（`data-testid="decision-rank-<id>"`），切 tab 后按当前可见序列重新从 #1 连续；answered 无 rank。
- 保留既有 `decisions-group-*` / `decision-item-*` testid，避免破坏既有用例。

### 3. 验收（可观测）

- 无 `decisions-summary`；总数徽标 = 在途条数；tab 计数正确。
- 3 grace + 2 open + 1 stale：前三项全为 grace 且倒计时升序，第 4 项起为 open。
- 切「已超时」只剩 stale；切回「全部」rank 从 #1 连续；answered 无 rank。
- 三种排序切换后 DOM 顺序符合定义。
- 删除某 open 项 `blocked_downstream_count`：仍渲染、排在 open 层末尾、全文无 `NaN`。

## 三、提交与隔离

- EXT 不碰 `routes.ts` / `resolver.ts`；P2 只碰 web decisions。
- 收尾按 `kb done --scope` 精确列出本卡文件；提交信息带卡号。
- 工作树中 PERF-1 的未提交改动（`routes.ts` 66+/13-、`resolver.ts` 104+/2-）保持原样、不入提交。
