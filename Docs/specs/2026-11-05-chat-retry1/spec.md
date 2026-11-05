# 【CHAT-RETRY1】单步重试服务端规格

卡号：`984853e7-1cdf-4bc3-b260-dcdd7e2b8b06`（工作区 `e41eb0fb-c367-43cf-a99d-6dc5239a5694`）

## 1. 目标与边界

在既有轮次观测（`session_turn.plan_json`）之上增加 **step ledger**、**稳定幂等键** 与
`POST /api/sessions/:id/turns/:turnId/steps/:stepId/retry`，做到：

- 只有 `failed` 且 **显式 retryable** 的步骤可重试；其余一律 409 + 机器可判文案。
- 重试不新建 `session_turn` 行，不重发整轮，不重复写已完成步骤的消息 / diff 卡。
- 同一重试请求重复提交只执行一次。

不在本卡范围：整轮重试既有能力保持原样；`apps/web/**`、`settings/**`、`services/accounts/**` 禁改；
`awaiting_input` / `awaiting_approval` 状态下不得触发重试。

## 2. 数据结构

### 2.1 新表 `session_step_ledger`

迁移文件 `apps/server/src/db/migrations/sessionStepLedger.ts`，在 `schema.ts` 的
`migrateSessionTurn(db)` 之后注册（依赖 `session_turn` 已存在）。

```
id TEXT PRIMARY KEY,
session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
turn_id TEXT NOT NULL REFERENCES session_turn(id) ON DELETE CASCADE,
step_id TEXT NOT NULL,
tool_name TEXT NOT NULL,
tool_call_id TEXT,
idempotency_key TEXT NOT NULL,
status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
retryable INTEGER NOT NULL DEFAULT 0,
writes_json TEXT NOT NULL DEFAULT '[]',
attempt INTEGER NOT NULL DEFAULT 1,
created_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL
CREATE UNIQUE INDEX idx_session_step_ledger_key ON session_step_ledger(idempotency_key)
```

- 迁移只用 `CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行，无回填。
- 幂等键生成（单一函数 `buildStepIdempotencyKey(turnId, stepId, toolCallId)`）：
  `${turn_id}:${step_id}:${tool_call_id ?? 'no-tool-call'}`。当前适配器事件不带 `tool_call_id`，
  因此键退化为轮次内稳定的 `turn:step:no-tool-call`；键不随重试次数变化，重复提交天然撞同一行。
- `writes_json` 记录该步已成功写入的目标（当前执行器未产出 diff，默认空数组；
  未来由工具观测侧填真值）。`attempt` 记录执行次数（首次 1，每次合法重试 +1）。

### 2.2 读取模型（`packages/shared/src/types.ts`）

新增（纯加法，不动既有字段）：

```
StepLedgerStatus = 'running' | 'done' | 'failed'
SessionStepLedgerEntry { id, session_id, turn_id, step_id, tool_name, tool_call_id, idempotency_key,
                         status, retryable, writes, attempt, created_at, updated_at }
SessionStepRetryResult { turn: SessionTurn, step_id: string, ledger: SessionStepLedgerEntry, executed: boolean }
```

## 3. 代码落点

| 文件 | 变更 |
| --- | --- |
| `db/migrations/sessionStepLedger.ts`（新） | 建表 + 唯一索引 |
| `db/schema.ts` | 注册迁移（`migrateSessionTurn` 之后） |
| `db/repos/stepLedger.ts`（新） | `buildStepIdempotencyKey`、`recordStepStart`、`recordStepFinish`、`recordStepWrites`、`getStepLedger`、`listStepLedgerByTurn` |
| `services/turnObservation.ts` | `beginStep` 写 ledger(running)；`closeStep` 写 ledger(done/failed) 并按写入记录计算 `retryable` |
| `services/turnStepRetry.ts`（新） | 校验 + 幂等 + 状态推进 + 调执行器 |
| `services/sessionManager.ts` | 新增 `runRetriedStep`：解析 adapter/workspace，以定向提示执行该步，不建轮次行、不观测事件 |
| `api/routes.ts` | 新增 `POST /sessions/:id/turns/:turnId/steps/:stepId/retry` |

### 3.1 失败步的 retryable 判定（二选一并写入注释）

采用 **「有写入记录即判不可重试」**：`recordStepFinish` 时 `failed && writes.length === 0` →
`retryable = 1`，否则 `0`。代码注释明确写：部分成功（写 2 个文件、第 3 个失败）的步骤不允许单步重试，
避免重复写已成功文件。`recordStepWrites` 供执行器/测试登记写入。

### 3.2 重试状态机（`retryFailedStep`）

1. 轮次存在且属于该会话，否则 404（`轮次不存在`）。
2. 步骤在该轮 `plan_json` 中，否则 404（`步骤不存在`）。
3. 轮次 `awaiting_input` / `awaiting_approval` / `running` → 409（`当前轮次不可重试`）。
4. 步骤 `state` 不是 `failed` → 409（`仅失败步骤可重试`）。
5. ledger 行不存在 → 409 `STEP_NOT_RETRYABLE`（`该步骤缺少执行台账，不允许单步重试`）。
6. ledger `retryable = 0` → 409 `STEP_NOT_RETRYABLE`（`该步骤不可重试：重试可能重复已成功的写入`）。
7. 以条件 UPDATE 把步骤置 `running`、轮次置 `running`、`ended_at/awaiting_json/awaiting_heartbeat_at` 清空；
   `changes === 0` → 409（并发重复请求）。
8. 调 `sessionManager.runRetriedStep`（同步执行器；`turnActive` 为真 → 409）。
9. 成功：步骤 `done`、ledger `done/attempt+1`；若计划中所有步骤均为 `done` → 轮次 `done`，
   否则轮次回 `failed(reason=step_retry_incomplete)`（其余步骤未执行，不能谎报 done）。
   失败：步骤 `failed`、ledger `failed/attempt+1`、轮次 `failed(reason=step_retry_failed)`。
10. 只在终态广播 **一次** `session.turn`；重复请求（步骤已 done/running）走 409，不广播。

### 3.3 执行器（`runRetriedStep`）

- 位置：`services/sessionManager.ts`，由路由作为 `execute` 回调注入 `turnStepRetry`。
- 行为：解析 adapter → 取 workspace → `adapter.runTurn({ cwd, model, prompt, adapterSessionId })`，
  prompt 为定向文案（`【单步重试】步骤 sN（工具 X）失败，请只重试该步骤；已完成步骤不要重复执行。`）。
- 不创建 `session_turn`、不落 message、不推 `session.event`：避免 diff 卡与消息重复（卡面验收 4）。
- 结果回写 `session.adapter_session_id`（继续同一适配器会话）。
- 失败/抛错由服务层统一收口为 `failed(step_retry_failed)`，HTTP 仍返回 200 的终态（执行失败不等于请求非法）；
  若参数/状态非法才 4xx。

### 3.4 路由

`POST /api/sessions/:id/turns/:turnId/steps/:stepId/retry`，无请求体；成功 200 返回
`SessionStepRetryResult`。错误码：
- 400：无（本卡不收 body）
- 403：无
- 404：会话 / 轮次 / 步骤不存在
- 409：`STEP_NOT_FAILED`、`STEP_NOT_RETRYABLE`、`TURN_NOT_RETRYABLE`、`STEP_RETRY_IN_FLIGHT`

## 4. 验收对照

| 卡面验收 | 实现/测试 |
| --- | --- |
| 1 running/done → 409；failed 但 retryable=false → 409 且说明原因 | `turnStepRetry.test.ts` 边界用例 |
| 2 合法重试 200；`session_turn` 行数不变 | 断言 `COUNT(session_turn)` 前后均为 1 |
| 3 重复提交只执行一次 | FakeAdapter `calls.length === 1`；ledger `attempt === 2`（首跑 1 + 一次重试） |
| 4 已完成步骤 message 条数/step_id 集合不变 | 重试前后对比 message 行 |
| 5 部分成功但报失败 | `recordStepWrites` 后 retryable=0 → 409（选择「直接判不可重试」） |
| 6 整轮重试能力未移除 | 重试后仍可 `POST /sessions/:id/messages` 起新轮次 |

## 5. 验证

```
pnpm --filter @agentboard/shared build
pnpm --filter @agentboard/server build
pnpm --filter @agentboard/web build
pnpm --filter @agentboard/server exec vitest run test/turnStepRetry.test.ts
pnpm --filter @agentboard/server test   # 失败项逐条标注基线/瞬时
```

提交：精确 `git add`（禁止 `git add -A`），提交信息带 `[984853e7]`，`git show --stat` 核对。
收尾：`kb done` 置待验收、释放占用、写知识页 + 变更日志。

## 6. 风险与取舍

- CLI 的工具执行在适配器进程内，服务端无法直接调用单个工具；本卡用「同会话定向提示」作为单步执行通道，
  并在代码注释记录该限制（观测层不重放事件，因此不会重复落消息/diff）。
- 部分成功场景选择「不可重试」而非「跳过已写文件」，因为当前 ledger 没有可靠的写入集合来源；
  等执行器产出 diff 后再考虑放开。
