# Tasks：第二轮审查优化（2026-11-10）

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）D:\WorkSpaces\任务看板

上游：`Docs/spec-2026-11-10-code-review-round2.md`。每项一卡，父卡只承载汇总。

| 顺序 | 卡 | 标题 | 文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| [x] 1 | CR3-01 | Web 请求超时真正中断底层连接（realm-safe） | `apps/web/src/api/client.ts` | 无 | web 620 测试全绿；假服务 15s 后客户端 TIMEOUT 且连接在 16s 内关闭 |
| [x] 2 | CR3-02 | 语音就绪判定去全量 sha256 | `services/voiceModels.ts`（+ `api/voiceRoutes.ts` 如需要） | 无 | voice 用例全绿；200MB 假文件下 `GET /api/voice/models` < 50ms；SSE tick 的 `readFileSync` 计数 0 |
| [x] 3 | CR3-03 | 派工模板修正（反引号 + 知识页口径） | `services/dispatchTemplate.ts` | 无 | 渲染文本不含 `handoff-`；反引号成对；模板单测通过 |
| [x] 4 | CR3-04 | SQLite TRIGGER 错误按消息分流 | `api/routes.ts` | 无 | 三条单测：workspace mismatch→400、cycle→409、immutable→500 |
| [x] 5 | CR3-05 | 快照清单路径包含校验 | `services/accounts/traeSnapshot.ts` | 无 | `../../x` 清单抛错；合法清单行为不变 |
| [x] 6 | CR3-06 | check-bom 跳过 `.qa-temp` | `scripts/check-bom.mjs` | 无 | `node scripts/check-bom.mjs` exit 0 |

## 完成记录（2026-11-10）

- 6 张卡全部 `kb done` → 待验收，提交：`c66b69f`(CR3-01) `d8a18f5`(CR3-02) `92c70f0`(CR3-03) `0b8fceb`(CR3-04) `3651f8b`(CR3-05) `eb9f21b`(CR3-06)。
- 知识页：`knowledge:b6806ab6-7611-4b28-a2f1-09010bc2f0f5`；变更日志：`7c1ea69a-1f36-4737-a185-c9e9d50b6fef`。
- 未验证项：CR3-01 浏览器侧真中断未做自动化验证（jsdom 无法复现跨 realm 挂死），由构建期常量 `import.meta.env.MODE !== 'test'` 控制；web dist 未重建（改动为数据层与模板文案）。

## 执行顺序与汇报

1. 先做 1–3（影响面最大）：完成后报一次（含验证输出）。
2. 再做 4–6：完成后报一次并收尾（知识页 + 变更日志 + 父卡 done）。

## 不做

- `routes.ts` 再拆分（CR-10 已收口）
- `synchronous` 改值（CR-12 定案不改，知识页 `knowledge:56983afc`）
- MCP `next_tasks` N+1（并入 PERF-4）
- `sha256_verified` 改名（契约变更，随下个语音需求）
