# Tasks：CHAT-APP1（97342849）

- [ ] T1 新增 `approvalRule` 迁移并在 `initSchema` 中接线（幂等 + 部分唯一索引）
- [ ] T2 新增 `db/repos/approvalRule.ts`（创建/查询/软撤销/按档查询；UNIQUE → 409）
- [ ] T3 shared 类型：`TurnApprovalInfo`、`ApprovalRule`、`SessionApprovalRequestEvent` 并入 `TurnObservationEvent`
- [ ] T4 `turnAwaiting.MarkAwaitingInput` 支持 `approval` 并落库
- [ ] T5 新增 `services/turnApproval.ts`（规则解析、request、decide；403/400/404/409 边界）
- [ ] T6 `errors.ts` 增 `ForbiddenError`；`schemas.ts` 增 `approvalDecisionSchema`
- [ ] T7 `routes.ts` 增审批决策 / 规则列表 / 软撤销三个端点
- [ ] T8 新增 `test/turnApproval.test.ts` 覆盖验收 1–7 + 边界 + 审批超时
- [ ] T9 三处 build + 定向测试 + 全量测试（红项标基线/瞬时）
- [ ] T10 精确暂存提交 `[97342849]` + `git show --stat` 核对
- [ ] T11 置「待验收」、释放占用、知识页 + 变更日志

## 验收映射
| 卡面验收 | 覆盖任务 |
|---|---|
| 1 迁移幂等/唯一索引/撤销后可再建 | T1/T2/T8 |
| 2 三档落库差异 | T5/T8 |
| 3 非 awaiting_approval 409；deny=stopped | T5/T7/T8 |
| 4 写类 + workspace 403；只读通过 | T5/T7/T8 |
| 5 GET 过滤/DELETE 软撤销/撤销后重弹 | T2/T7/T8 |
| 6 WS 四字段 + allow 回 running | T3/T5/T8 |
| 7 任务结束后 task 规则不命中 | T5/T8 |
| 硬风险：审批超时兜底 | T5（复用 sweeper）/T8 |
