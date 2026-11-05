# CHAT-RETRY1 任务清单

卡号：`984853e7-1cdf-4bc3-b260-dcdd7e2b8b06`

- [ ] T1 迁移：`db/migrations/sessionStepLedger.ts` 建 `session_step_ledger` + 唯一索引；`db/schema.ts` 在 `migrateSessionTurn` 后注册。
- [ ] T2 仓库：`db/repos/stepLedger.ts`（建键 / 开始 / 结束 / 登记写入 / 读取），`retryable` 规则集中在此。
- [ ] T3 观测接线：`services/turnObservation.ts` 的 `beginStep` / `closeStep` 同步写 ledger；不改变计划事件语义。
- [ ] T4 共享类型：`packages/shared/src/types.ts` 增加 `StepLedgerStatus` / `SessionStepLedgerEntry` / `SessionStepRetryResult`（纯加法）。
- [ ] T5 执行器：`services/sessionManager.ts` 增加 `runRetriedStep`（不建轮次、不落消息、定向提示）。
- [ ] T6 服务：`services/turnStepRetry.ts` 校验链 + 条件 UPDATE 幂等 + 终态推进 + 单次广播。
- [ ] T7 路由：`api/routes.ts` 增加 `POST /sessions/:id/turns/:turnId/steps/:stepId/retry`。
- [ ] T8 测试：`apps/server/test/turnStepRetry.test.ts` 覆盖迁移幂等、happy path、重复提交、409 边界、404、部分成功、只推一次事件、整轮能力保留。
- [ ] T9 验证：shared/server/web 三处 build；定向测试全过；全量测试失败逐条标注基线/瞬时。
- [ ] T10 提交：精确暂存（禁止 `git add -A`），提交信息带 `[984853e7]`，`git show --stat` 核对。
- [ ] T11 收尾：`kb done` 置待验收、释放占用、知识页 + 变更日志。

## 验证命令

```
pnpm --filter @agentboard/shared build
pnpm --filter @agentboard/server build
pnpm --filter @agentboard/web build
pnpm --filter @agentboard/server exec vitest run test/turnStepRetry.test.ts
pnpm --filter @agentboard/server test
```
