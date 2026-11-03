# 任务依赖关系（issue dependency）设计

状态：待用户批准（2026-11-03）
范围：`apps/server` + `packages/cli` + `apps/mcp` + `apps/web` + 四份技能文档

## 1. 意图与为什么

看板现在只能表达「层级」（父卡/子卡），表达不了「先后」。团队实际为多 agent 并行，依赖目前只写在卡片描述里当纯文本 issue id：

- `writing-plans` 明写「express dependencies in descriptions or comments as plain issue IDs; do not invent dependency fields」。
- `executing-plans` 第 38 行「Follow dependencies recorded as issue IDs」（`C:\Users\31633\.agents\skills\executing-plans\SKILL.md`）。
- `kb` CLI 没有任何依赖子命令。

后果：依赖不可校验、不可防环、不可门禁。agent 会抢做前置未完成的卡，human 只能事后在评论里纠正。

## 2. 目标 / 非目标 / 反目标

目标
- 任务之间可维护「阻塞」有向边，字段级别同工作区、无自环、无环。
- `claim` 在依赖未解除时服务端硬拒绝（409），错误信息列出阻塞项。
- 依赖可通过 REST / CLI / MCP / UI 四条通道读写。
- 四份技能文档的依赖口径从「纯文本」切到「结构化边」。

非目标
- 不做看板内依赖连线图（收益低，成本高）。
- 不做自动排期/甘特/关键路径。
- 不做跨工作区依赖。
- 不复用 `parent_issue_id` 表达顺序。

反目标（即使技术上跑通也算失败）
- 让父子层级与依赖语义在同一字段上打架。
- 依赖边能成环，或 claim 能被措辞绕过（「顺手」「只跑一下」）。
- 引入需要人工审批的阻塞式交互（服务端无 UI 审批通道）。
- 让既有 ~100 张待验收卡把整条流水线锁死。

## 3. 约束

- SQLite + 既有幂等迁移风格（`CREATE TABLE/INDEX IF NOT EXISTS`、`ALTER TABLE ADD COLUMN` 幂等）。
- 迁移必须可平移到存量库（生产库在 `%APPDATA%\AgentBoard\agentboard.db`）。
- 工作区边界规则：所有读写落在当前工作区（`apps/server` 层强制，非仅 UI）。
- 不得破坏既有契约：`issue` 表列与 `parent_issue_id` 触发器不动。
- `kb done` 的 GIT-ON-DONE 提交范围另有缺陷卡（`006537f4`），本设计不依赖它修好。

## 4. 方案与选择

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 独立边表 + claim 硬门禁** | 新表 `issue_dependency`，同工作区/防环触发器，claim 校验，四通道读写 | **采纳** |
| B. 复用 `parent_issue_id` | 用父子层级表达先后 | 否决：与「父卡=汇总、子卡全 done 父卡才 done」冲突，语义打架 |
| C. 只解析描述里的 plain id | 不动库，前端解析渲染 | 否决：无原子校验、无防环、无法门禁，仍是自觉 |

用户已选 A。

## 5. 已定决策

| # | 决策 | 取值 | 依据 |
|---|---|---|---|
| D1 | 落地方案 | A 独立边表 + claim 硬门禁 | 用户 2026-11-03 选定 |
| D2 | 依赖解除判定 | blocker 状态 ∈ {`待验收`, `已关闭`} = 解除 | 用户选定；避免 `done` 后卡在人工验收堵死流水线 |
| D3 | 门禁强度 | `claim` 硬拒绝（409） | 用户选定 |
| D4 | 跨工作区依赖 | 禁止（触发器 + 服务层双重拒绝） | 与既有工作区边界规则一致，lead 判定 |
| D5 | 边的方向 | `blocked_issue_id` ← `blocker_issue_id`（blocker 完成后 blocked 才可开工） | 实现者的语义约定 |
| D6 | UI 范围 | 卡片角标「等 N 项」+ 详情面板依赖编辑器 + 树视图锁标 | lead 判定（不做看板连线图） |

## 6. 数据模型

```sql
CREATE TABLE IF NOT EXISTS issue_dependency (
  blocked_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  blocker_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocked_issue_id, blocker_issue_id),
  CHECK (blocked_issue_id <> blocker_issue_id)
);
CREATE INDEX IF NOT EXISTS idx_issue_dep_blocked ON issue_dependency(blocked_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_dep_blocker ON issue_dependency(blocker_issue_id);
```

触发器（与 `taskHierarchy.ts` 同风格）：
1. `BEFORE INSERT`：两端 issue 必须同 `workspace_id`，否则 `RAISE(ABORT)`。
2. `BEFORE INSERT`：若从 blocker 沿边可达 blocked（即插入后成环），`RAISE(ABORT)`。
3. 迁移文件：`apps/server/src/db/migrations/issueDependency.ts`，在 `initSchema` 注册，幂等。

不成环判定用递归 CTE：
```sql
WITH RECURSIVE descendants(id) AS (
  SELECT blocker_issue_id FROM issue_dependency WHERE blocked_issue_id = NEW.blocker_issue_id
  UNION SELECT d.blocker_issue_id FROM issue_dependency d JOIN descendants x ON d.blocked_issue_id = x.id
)
SELECT 1 FROM descendants WHERE id = NEW.blocked_issue_id;
```
命中即 ABORT。

## 7. 解除判定（唯一口径，四处复用）

```
isBlockerResolved(status) = status IN ('待验收', '已关闭')
```
实现为 `apps/server/src/services/dependency.ts` 的单一导出函数，`claim` 守卫、REST 列表投影、CLI 输出、MCP 输出、UI 角标全部调用它，禁止各处复制判断。

## 8. REST API

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/issues/:id/dependencies` | 返回 `{ blockers: [{issue_id,title,status,resolved}], blocked: [...] }` |
| POST | `/api/issues/:id/dependencies` | body `{ workspace_id, blocker_issue_id }`；成功 201；成环 409 `DEPENDENCY_CYCLE`；跨工作区 400 `CROSS_WORKSPACE_DEPENDENCY`；重复 409 `DEPENDENCY_EXISTS`；自环 400 `DEPENDENCY_SELF`；缺 `workspace_id` 400 `VALIDATION_ERROR` |
| DELETE | `/api/issues/:id/dependencies/:blockerId` | 204；不存在 404 |

- 所有写操作走既有幂等中间件（`Issue-Key` 同款），并广播 `issue.changed`（卡片角标需要实时更新）。
- 列表投影在 `GET /api/issues` 与树/分页接口里追加 `blocked_by_count`、`blocked_by_open_count`、`resolved`，供卡片角标使用，不改变既有字段。

## 9. CLI

```
kb dep ls <issue-id>                       # 列出 blockers 与被阻塞者，含状态与解除标记
kb dep add <issue-id> <blocker-id>         # 建边；跨区/自环/成环/重复按 §8 错误码退出（2/3/4）
kb dep rm <issue-id> <blocker-id>          # 删边；缺边退出 404
```
退出码沿用既有约定：0 成功，2 冲突/占用，3 参数错误，4 跨工作区或成环；stdout 输出人类可读表，`--json` 输出原始响应。

## 10. MCP

新增三个工具，参数与 REST 同构：`agentboard_list_dependencies` / `agentboard_add_dependency` / `agentboard_remove_dependency`。错误码透传，不吞错。

## 11. UI

- 看板卡片：右上有依赖角标 `等 2 项`（未解除数 > 0 时显示）；全部解除时显示淡色 `依赖已清`。
- 任务详情面板：新增「依赖」区，列出 blockers（标题 + 状态 + 解除标记）与被阻塞者；提供「添加前置」选择器（当前工作区内搜索）与「移除」。
- 任务树视图：被阻塞的卡标题前加锁标；父卡汇总显示子树未解除依赖总数。
- 试图 claim 被阻塞卡时：前端先拦并展示 blocker 清单；服务端 409 兜底（前端拦截不是唯一防线）。

## 12. 守卫行为（claim）

`claimIssue(db, issueId, actor)` 增加前置检查：
1. 查 `blockers where status NOT IN ('待验收','已关闭')`。
2. 非空 → `ConflictError`，文案：`存在未完成的前置任务：<title>(<short id>) ×N；完成后可领取`。
3. 事务内复查一次（防 TOCTOU），与既有 claim 原子性一致。
4. `done`/`fail`/`release` **不**受依赖影响（不得因为依赖未解除而卡住收尾）。

## 13. 迁移与回滚

- 迁移幂等，可重复执行；不改既有列。
- 回滚：`DROP TABLE issue_dependency`（数据丢弃）；服务端代码回滚不依赖表结构，旧代码忽略新表。
- 存量库演练：复制 `agentboard.db` 到临时目录 → 起服务 → 确认表与触发器存在、既有 issue 可读写、`kb claim` 行为不变（无依赖时）。

## 14. 验收标准

1. `CREATE` 边后 `kb dep ls` 双向可见；删除后消失。
2. 跨工作区建边 → 400 `CROSS_WORKSPACE_DEPENDENCY`；自环 → 400；成环（A→B→C→A）→ 409 `DEPENDENCY_CYCLE`；重复 → 409。
3. blocker 未解除时 `kb claim` → 409 且文案含 blocker 标题；blocker `done`（→待验收）后同命令成功。
4. `done` / `fail` / `release` 在依赖未解除时仍可执行。
5. 卡片角标数字与 `kb dep ls` 一致；详情面板可增删依赖；树视图锁标随 blocker 状态实时消失。
6. server 与 web 测试全绿（允许既有基线失败 `knowledge.test.tsx:66`）、`pnpm -r build` exit 0；新用例能证明去掉修复会失败（至少：claim 守卫、成环触发器、跨区触发器各 1 条变异 RED）。
7. 存量库副本演练通过（§13）。

## 15. 留给实现者的决定

- 度数上限（建议 ≤ 50，防界面爆炸）——实现者定并写进卡。
- 前端角标配色与文案细节。
- 依赖编辑器的搜索交互（复用既有 card picker 与否）。
- CLI 输出表格列宽与截断规则。

## 16. 需要用户确认的点（builder-check 后收敛）

- 拆卡边界：本设计跨 server / cli+mcp / web / 四份技能，按 `writing-plans` 的拆卡判据应拆成 4 张子卡 + 1 张父卡；是否同意这个粒度。
- 是否要「依赖模板」（新建卡时按父卡预设依赖）：默认不做。

## 17. Builder-check 决议（2026-11-03，作者答复）

阻断级缺口全部收敛，实现者按此执行，不再回头问。

**B1 工作区参数**：写通道强制带 `workspace_id`（POST 放 body，DELETE 放 query），缺省 400 `VALIDATION_ERROR`；服务端用既有 `requireIssueInWorkspace` 校验，不按 issue 自身工作区放行。CLI 三命令按既有 `commands/claim.ts:17-21` 的方式先取 issue 的 `workspace_id` 再上送；MCP 三工具按 `tools/tasks.ts` 既有模式强制 `resolveWorkspaceId`。GET 走 query `workspace_id`。

**B2 退出码**：不改全局 `toExit`（`packages/cli/src/index.ts:26-44`）。`dep` 子命令自带映射：成功 0；`DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` → 2；`CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR` → 3；`NOT_FOUND` → 4。映射写在 `commands/dep.ts` 内，并对三个 code 给出自己的中文文案，避免被全局包装成「已被占用」。

**B3 计数字段**：跟随既有先例，把 `blocked_by_count`、`blocked_by_open_count`、`resolved` 加到 `packages/shared/src/types.ts` 的 `Issue`（与 `comment_count` 同款查询期字段，`repos/issue.ts:84-89` 已有先例）。语义：无 blocker 时 `blocked_by_count=0`、`blocked_by_open_count=0`、`resolved=true`（UI 据此区分「等 N 项」与「依赖已清」）。子查询一律用 `LEFT JOIN ... GROUP BY` 单次聚合，禁止 N+1。

**B4 占用态增删**：给**已占用**（`claimed_by IS NOT NULL`）的卡新增 blocker → 409 `ISSUE_CLAIMED`，文案要求先 release；未占用的卡（含进行中但已释放）允许加。删除 blocker 卡导致的 CASCADE 静默解锁**不是本意**：删除时服务端对每个被阻塞卡追加系统评论「前置 X 已删除，依赖自动解除」，保证可追溯；该评论与删除同事务。

**B5 存量文本依赖**：不做一次性 backfill。约 100 张待验收卡不动；agent 在 `claim` 或读卡时遇到描述里的 plain issue id，用 `kb dep add` 补录，并把「补录」写进技能文档的一句话（见 §18）。理由：批量解析纯文本无稳定语法，误录成本高于收益。

**B6 技能文件路径与验收**：四个绝对路径 ——
`D:\WorkSpaces\任务看板\skills\agentboard\SKILL.md`（仓库内，进 git）
`C:\Users\31633\.agents\skills\writing-plans\SKILL.md`（仓库外）
`C:\Users\31633\.agents\skills\executing-plans\SKILL.md`（仓库外）
`C:\Users\31633\.agents\skills\handoff\SKILL.md`（仓库外）
仓库外三份无副本、不进 `pnpm build`/测试：验收方式 = `grep` 断言（各命令名与新口径字符串命中）+ 全文回读；变更日志只写本仓库工作区日志（`kb changelog create --workspace 任务看板`），因为改的是本项目的协作口径。仓库内那份照常进 git。

**次要项（采纳 builder 自决）**：幂等头 `Idempotency-Key` 白名单增 `POST /dependencies`；触发器只兜底、服务层先判错误码；blocker 不存在取 404；自环不留触发器（`CHECK` + 服务层 400），只建 blocker 侧索引；不额外做「事务内复查」（guard 放进 `claimIssue` 既有 `db.transaction().immediate()`，并覆盖 `services/dispatch.ts:247` 派发路径与失败回滚 :248-252 的测试）；short id 取 uuid 前 8 位。

**已成立、无需新增机制**：树视图 `queryKey ['issues', ws, 'tree', …]`（`IssueTreeView.tsx:199`）在 `ws.ts:12-18` 的 `['issues', ws]` 失效前缀下，blocker 状态变化即可刷新锁标，不新增 WS 事件类型。

## 18. 技能口径改动明细（供拆卡引用）

- `agentboard`：命令速查加 `kb dep ls|add|rm`；「领任务」流程加一步「先 `kb dep ls`，有未解除 blocker 时服务端会 409，不得绕过」；占用规则加「已占用的卡不得新增 blocker（409）」。
- `writing-plans`：把「dependencies as plain issue IDs; do not invent dependency fields」改为「用 `kb dep add <子卡> <前置卡>` 建结构化边；描述里可写 plain id 供人阅读，但权威来源是边表」；拆子卡步骤加一句「前置关系建边后 `kb dep ls` 复核」。
- `executing-plans`：claim 段落加「先 `kb dep ls`；被阻塞时报告父代理，不得 release 他人占用或自行补边解锁」；遇到描述里的 plain id 时按 §17-B5 补录。
- `handoff`：「Prepare and save context」加一项「记录未解除的 blocker 与被阻塞者，便于接手者判断能否开工」。

