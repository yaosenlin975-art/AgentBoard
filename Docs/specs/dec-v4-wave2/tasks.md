# DEC-V4 波 2 任务清单

## EXT（`61310826`）

1. **E1 迁移**：`apps/server/src/db/migrations/pendingDecision.ts` 增 4 列（新库 DDL + `ensureColumn` 存量补列）。
2. **E2 事件类型**：`packages/shared/src/types.ts` 的 `DecisionEvent.type` 增 `decision.extended`（payload 带 `grace_until`、`extended_seconds`、`extension_count`）。
3. **E3 仓储**：`apps/server/src/db/repos/decision.ts` 增 `extendDecisionGrace`（CAS `state='grace'`，返回更新后行）。
4. **E4 服务**：`apps/server/src/services/decisionGrace.ts` 增 `extendDecisionGrace`（参数/存在/state/fence/上限校验，`max_extend_seconds = min(300, max(0, 600-grace_seconds))`）。
5. **E5 路由**：`apps/server/src/api/decisionRoutes.ts` 增 `POST /api/decisions/:id/extend` + `askExtendSchema` + 事件广播（不碰 `routes.ts`）。
6. **E6 服务端测试**：`apps/server/test/decisionApi.test.ts` 补 200/400/403/404/409/上限/fence/事件/真实 `createApp` 用例。
7. **E7 CLI**：`packages/cli/src/commands/decision.ts` 增 `ask-extend`（参数校验、前缀解析、当前工作区守卫、文本/`--json` 输出、退出码）。
8. **E8 CLI 测试**：定位现有 CLI 决策命令测试文件并补用例（参数 3、403/409 → 2、成功输出/回读）。
9. **E9 文档**：`Docs/api.md` 增「待决策（DEC）」小节（端点/错误码/CLI/退出码）。
10. **E10 技能**：`skills/ask-user/SKILL.md` 增「延长宽限」流程与命令表。
11. **E11 验证**：server vitest + server/CLI `tsc` 0 错；真实服务 + `kb ask-extend` 跑通并读回 `grace_until`。
12. **E12 收尾**：知识页 + 变更日志 + `kb done --scope` 提交（带卡号）+ 卡面证据。

## P2（`b1fd617d`）

13. **P1 纯函数**：`apps/web/src/components/decisions/countdown.ts` 增 `DecisionSort` 与三排序、缺失字段兜底。
14. **P2 视图**：`DecisionsView.tsx` 页头去重（标题 + 总数徽标）、筛选 tab（含计数）、排序下拉、分层、连续 rank。
15. **P3 测试**：`apps/web/src/test/decisionsView.test.tsx` 补页头/tab/分层/排序/rank/兜底用例。
16. **P4 验证**：`pnpm --filter @agentboard/web exec vitest run src/test/decisionsView.test.tsx` + web `tsc` 0 错。
17. **P5 收尾**：知识页 + 变更日志 + `kb done --scope` 提交（带卡号）+ 卡面证据。

## 全局约束

- 不碰 `routes.ts` / `resolver.ts`（PERF-1 未提交改动留在工作树）。
- 不做卡面范围外的重构；提交前 `git status` 复核只含本卡文件。
