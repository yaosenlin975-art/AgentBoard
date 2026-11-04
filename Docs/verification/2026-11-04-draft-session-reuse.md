# 智能创建草稿会话按工作区与执行方式复用（0fce2f7b）

日期：2026-11-04 · 卡：`0fce2f7b-7177-4631-8de9-dbb3400651dc` · 父卡 `935fc96a`

## 1. 会话口径

**key = `workspace_id + adapter`**（与卡面一致）：同一 key 连续生成复用同一草稿会话；换工作区或换执行方式 → 新会话；失败不写会话上下文。

## 2. 实现点（只动智能创建自己的文件 + 前端）

| 位置 | 改动 |
|---|---|
| `apps/server/src/services/smartCreateDraft.ts:31-61` | `DraftResult` 增加 `session_id` / `session_turn` / `session_reused`；新增 `draftSessionKey()`、`MAX_DRAFT_SESSIONS=32`、`MAX_CONTEXT_TURNS=5` |
| 同文件 `:150-227` | 进程内会话注册表：`acquireDraftSession()`（取或建、按 `lastUsedAt` 淘汰，防泄漏）、`recordDraftTurn()`（**只在成功时** +1 轮并记录需求）、`sessionContextBlock()`（把此前需求拼成只读上下文）、`draftSessionSnapshot()`/`resetDraftSessions()`（测试用） |
| 同文件 `generate()` | 取会话 → 若已有历史则把上下文块前置进 prompt → 成功后 `recordDraftTurn()` 并回填三个字段；**失败路径（502/422/504/503）不调用 recordDraftTurn** |
| `apps/web/src/lib/smartDraft.ts` | `IssueDraft` 增加 `sessionId/sessionTurn/sessionReused` 并从响应 `session_id/session_turn/session_reused` 解析 |
| `apps/web/src/components/topbar/NewIssueDialog.tsx` | 复用时提示：「草稿已生成（同一草稿会话 · 第 N 轮；换工作区或执行方式会开新会话），可编辑后创建任务」 |

**为什么不是「复用 agent 常驻会话」**：这条路径的 `run` 是一次性 `runTurn`（不建 session 行、不占 claim 槽位），适配器侧没有可 resume 的句柄；因此「会话」实现在草稿层——同一 key 复用同一会话 id，并把该会话此前**成功**的需求作为只读上下文拼进 prompt，实现多轮追加需求。这是与「服务端复用真会话」的口径差异，如实记录。

## 3. 服务端测试（`apps/server/test/smartCreateDraft.test.ts`，新增 3 例，共 15 passed）

1. 同工作区同 adapter 连点两次 → `session_id` 相同、`session_turn` 1→2、`session_reused` false→true，且第二轮 prompt 含第一轮需求；
2. 换 adapter（codex→opencode）→ 新 `session_id`；换工作区 → 又一个新 `session_id`，两者 `session_reused=false`；
3. 失败不吃脏上下文：先 422（模型输出非 JSON），再成功后 `session_turn=1`，且 prompt **不含**失败那条需求。

## 4. 真机取证：**被两个环境事实阻塞**

- **8787 跑的是本次改动之前的构建**：`POST /api/issues/draft` 的真实响应没有 `session_id/session_turn/session_reused`（全为 null）→ 无法在该实例上取证。需要重启 8787（共享实例，交 lead 决定时机）。
- **codex 草稿调用当前 502**：`适配器 codex 调用失败：适配器退出码 1：Reading additional input from stdin... | ERROR codex_models_manager::manager: failed to refresh available models: request timed out` —— 是 codex CLI 刷新模型列表超时（网络/环境问题），与本改动无关；codebuddy 侧返回 422（模型输出非 JSON）。

因此真机「同 adapter 两次 → 同一 session_id / 换 adapter → 新 session_id / 失败不污染」三项，目前只有**服务端集成测试**覆盖（用真实 HTTP 路由 + 注入 runner，等价于 UI 点击时的同一条链路）。

## 5. 门禁

- `pnpm -r build` → **exit 0**（6 包 Done）。注：`apps/web/src/App.tsx` 当前有他人未提交改动（`DrawerPanel` 未定义），`npx tsc --noEmit`（含测试的默认 project）会红，但 **build 用的 project 不含它**，故 build 绿。
- `apps/server/test/smartCreateDraft.test.ts` → **15 passed**；`apps/web/src/test/smartCreate.test.tsx` → **8 passed**。
- **变异 RED**：把 `acquireDraftSession` 里的 `sessions.get(key)` 改成恒 `undefined`（永不复用）→ 用例 1 红（`expected 'draft-session-…-2' to be 'draft-session-…-1'`）；还原后 15/15。

## 6. 未验证

- 真机（5174 UI）两次生成的同/异会话 id：被「8787 旧构建 + codex 502」双重阻塞，需重启服务 + codex 可用后复测；
- 会话淘汰上限（32）与 5 轮上下文截断只有代码路径，未做压力验证；
- 多客户端并发同一 key 时是否应串行（当前无锁，两个并发请求可能各建一个会话）。
