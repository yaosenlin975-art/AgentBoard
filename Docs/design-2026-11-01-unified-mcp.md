# AgentBoard 任务板与共享知识 MCP 设计

- 日期：2026-11-01
- 状态：MCP-04 任务工具和 MCP-05 知识工具已实现；MCP SDK stdio 流测试通过。真实子进程 smoke 与客户端兼容验收仍待执行。
- 范围：Codex、DSH、WorkBuddy 等本机 LLM 工具通过 MCP 读取任务与知识，并按授权契约更新任务、知识条目。
- 验收依据：固定工具 schema、API 契约、隔离用例、并发/CAS 用例和各 MCP 客户端实际握手；本地工具测试/构建已通过，真实子进程和客户端握手未通过验收。

## 1. 需求与边界

### 已确认

- 一个统一 AgentBoard MCP，功能只包括任务板与共享知识库。
- 知识范围为当前 Workspace 项目知识及跨 Workspace 公共经验；查询任务相关知识时合并当前 Workspace 与公共范围。
- Codex、DSH、WorkBuddy 等工具公用知识；agent 通常写入，用户查看；agent 在编写项目代码时检索复用。
- AgentBoard 内建知识库路线已实现；MCP 知识工具通过同一 loopback REST API 调用知识服务。

### 设计提案

- 一个本机 `stdio` MCP server 作为薄适配器，通过现有 `http://127.0.0.1:<port>/api` 调 AgentBoard API；任务、知识业务逻辑和 SQLite 只保留一份。
- MCP 工具只处理任务板和知识条目。不开远程 MCP transport，不增加第三方 MCP 框架或新鉴权系统；不暴露账号签到、账号切换、凭据、进程、终端或任意文件操作。
- 进程可绑定一个 `workspace_id`，工具省略 `workspace_id` 时使用绑定值。未绑定进程时，所有项目任务操作和项目知识查询/写入都必须提供 `workspace_id`。绑定进程收到不同 `workspace_id` 返回 `WORKSPACE_BOUND`；改用另一 Workspace 时为该工作空间单独配置 MCP 进程。
- 通用知识搜索可显式用 `scope='common'`；`scope='both'` 必须有一个明确当前 Workspace。公共知识写入必须显式传 `scope='common'`，默认不得从项目知识自动提升。
- MCP 工具输出是 MCP client 提供给当前 agent 的数据。它不创建 AgentBoard chat session，也不暗中改写任务 prompt。任务派发 prompt 的可选知识注入沿用[共享知识库设计](./design-2026-11-01-shared-knowledge.md#dispatch-注入提案)，与 agent 主动调用 MCP 搜索是两条调用路径；实际统一数据由知识 API/service 提供。
- 不提供工作空间创建/删除、任务删除、知识物理删除、会话创建/停止、CLI 执行、任意路径读写。用户可继续在 AgentBoard UI 管理 Workspace 和浏览知识。

## 2. 当前实现与缺口

AgentBoard 当前是 Node.js ≥20、TypeScript、Express API、SQLite；API 挂载在 `/api`，服务仅监听 `127.0.0.1`。[项目技术栈与权限基线](./design-2026-11-01-shared-knowledge.md#2-当前系统与术语) · [API 装配](../apps/server/src/index.ts#L62-L70) · [loopback bind](../apps/server/src/index.ts#L108-L119)

当前 API 已提供：`GET /workspaces`；任务 `GET/POST /issues`、`GET/PATCH/DELETE /issues/:id`；评论 list/add/consume；claim/release/done/fail。[routes.ts workspace](../apps/server/src/api/routes.ts#L173-L195) · [task](../apps/server/src/api/routes.ts#L228-L253) · [delete](../apps/server/src/api/routes.ts#L255-L277) · [comments](../apps/server/src/api/routes.ts#L279-L298) · [claim actions](../apps/server/src/api/routes.ts#L300-L330)

`GET /issues`、工作空间列表与评论列表支持 `limit` / `offset` 分页；任务详情、评论、claim、release、done、fail 都在服务端验证有效 Workspace。创建任务默认 description 为空、priority 为“中”、labels 为空数组、status 为“待规划”。任务更新使用 `expected_updated_at` CAS，评论/会话等任务修改递增 `updated_at`。[issue schemas](../apps/server/src/api/schemas.ts) · [issue repository](../apps/server/src/db/repos/issue.ts)

任务领取以单条条件更新实现原子互斥；REST claim 只登记 `agent_id`、不创建 session。MCP owner 操作在服务端以同一事务的条件更新验证 `claimed_by`；人类 UI 强制操作保留独立 REST 契约，不由 MCP 暴露。[claim service](../apps/server/src/services/claim.ts) · [claim schema](../apps/server/src/api/schemas.ts)

评论 GET 是只读。`POST /comments/consume` 按 issue 共享的 `last_seen_comment_id` 计算新评论并推进游标，同一事务重复调用只返回空的新评论 ID；多个客户端共用该游标。首版 MCP 仅提供不消费游标的评论读取，不暴露 consume 工具，避免一个工具替其他客户端标记已读。[comment routes](../apps/server/src/api/routes.ts#L279-L298) · [consume semantics](../apps/server/src/services/comments.ts#L65-L90)

Agent identity 由请求 `agent_id` 自报；当前服务没有登录或角色授权。该字段只用于 claim owner 值和评论审计标签，不能作为安全鉴权。loopback + 本机 MCP stdio 是单机单用户假设，不构成抵御同机其他进程的安全边界。[CLI agent id](../packages/cli/src/index.ts#L34-L41) · [server bind](../apps/server/src/index.ts#L108-L119)

共享知识库由 `knowledge_page` / `knowledge_revision`、FTS5 trigram、本地 REST、CLI 与 Web 共用 repository 实现。MCP knowledge 工具只调用现有 `/api/knowledge/*` 契约；服务不提供对应路由时返回 `KNOWLEDGE_UNAVAILABLE`，不直连数据库、不实现第二份搜索/版本逻辑。实际客户端握手仍待验收。[共享知识库设计](./design-2026-11-01-shared-knowledge.md)

## 3. 方案比较与选型

| 候选 | 版本 / 许可证 / 兼容性 | 匹配与成本 | 结论 / 验证 |
|---|---|---|---|
| 官方 MCP TypeScript SDK | `@modelcontextprotocol/server` **2.4.0**, Apache-2.0, Node `>=20`；固定 release tag `v2.4.0`，commit `951fe56`。[release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) · [tag package metadata](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/server/package.json) · [官方 v2 稳定线说明](https://github.com/modelcontextprotocol/typescript-sdk#readme) | 原生 stdio server、MCP tools 和 Zod schema 支持；项目 Node/TypeScript 兼容。薄 MCP package 调用现有 REST；不移植 domain code。 | **已采用。** 固定 2.4.0；package LICENSE 保留，无 NOTICE 文件；SDK stdio 流测试、MCP 20/20、typecheck/build 已通过。真实子进程和客户端兼容待验收。 |
| 官方 MCP servers reference | repo `main`；根 package metadata `0.6.2`，LICENSE 正处 MIT→Apache-2.0 过渡，部分贡献仍保留 MIT。README 说明是教育/参考实现，不是生产就绪服务器。[README](https://github.com/modelcontextprotocol/servers#readme) · [package metadata](https://github.com/modelcontextprotocol/servers/blob/main/package.json) · [LICENSE](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE) | 用于观察官方 server/tool 示例；没有 AgentBoard 任务、Workspace 或共享知识 domain。复制/依赖该 repo 增加的代码范围高于直接使用 SDK。 | 只作协议参考，不作为运行依赖或代码来源；本轮未构建示例。 |
| `nashsu/llm_wiki` | v0.6.13，commit `e08cfce65aad8b76b13546a081c1a8d4422b70c3`；root GPL-3.0，MCP package metadata MIT。[release](https://github.com/nashsu/llm_wiki/releases/tag/v0.6.13) · [固定 commit MCP package](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/mcp-server/package.json) | 有本地 Wiki 搜索/读写 MCP，可参考知识工具边界；其 Tauri/Rust + React、文件型 Wiki/API 与 AgentBoard Express/SQLite、Workspace/issue 模型不同。集成需新增项目与公共 scope、CAS、任务检索和 UI/CLI 共用 API。 | 作为机制参考，不移植代码、不加入依赖；源码已静态调研，未安装或运行。[既有调研报告](../research/llmwiki/REPORT.md#r2-解剖) |

实施前如要复制或移植任何 GitHub 项目代码或资源，另行确认是否保留 LICENSE、NOTICE 等文件。本设计仅选择官方 SDK 依赖；不复制示例源码。

## 4. 结构与服务边界

```text
Codex / DSH / WorkBuddy MCP client
          │ stdio (one local child process per client configuration)
          ▼
apps/mcp (MCP schema + bounded tool adapter + HTTP client)
          │ HTTP http://127.0.0.1:<port>/api
          ▼
apps/server routes → shared domain services → existing SQLite
                     ├─ task / comments / claim services
                     └─ knowledge service / FTS5 (per shared KB design)
          ▲
          └─ existing kb CLI uses the same API/domain contracts
```

- MCP server is a separate stdio child process; it does not own the DB connection, start/stop the AgentBoard server, create sessions, or add a second store.
- Task and knowledge scope checks, owner matching, CAS, validation, idempotency, and pagination live in API/domain service contracts. The adapter validates MCP input, sends one bounded HTTP request, maps the response, and truncates output for context limits.
- CLI keeps existing commands and calls the same API. Shared business behavior must not be implemented once in MCP and again in CLI.
- Knowledge tools share the KB design's `workspace` + `common` filter, FTS ranking, page/revision storage, source evidence and lifecycle state. MCP is another client surface, not another index.
- MCP v1 publishes tools only. No resources/prompts solely to fill MCP capability categories; no notifications/subscriptions in first version.

## 5. Workspace and identity rules

| Setting / input | Proposal |
|---|---|
| `AGENTBOARD_BASE_URL` | Optional; default `http://127.0.0.1:8787`. Reject any non-loopback host in v1. Never start the app automatically. |
| `AGENTBOARD_WORKSPACE_ID` | Optional process binding. If configured, omitted tool `workspace_id` resolves to it; a different explicit ID returns `WORKSPACE_BOUND`. If absent, project-scoped tools require an explicit `workspace_id`. |
| `AGENTBOARD_AGENT_ID` | Required for write/claim tools; a display/audit label forwarded to API. It is self-declared and grants no permission. Missing ID returns `AGENT_ID_REQUIRED`. |
| `request_id` | Required on mutations. UUID supplied by MCP client per logical operation and reused unchanged after timeout. API idempotency behavior is described in §8. |

`agentboard_list_workspaces` returns only `{id,name}`; it does not return local paths and does not change the process binding. Project tool calls cannot silently search or mutate other workspaces. An unbound process may act on another workspace only by sending its explicit `workspace_id` on that call. A bound process requires a separately configured MCP instance for a different Workspace.

## 6. Tool contracts

All schemas are strict objects; unknown fields fail validation. Defaults and limits below are proposals. Success returns a short human-readable `content` summary and typed `structuredContent` with `ok:true`; large bodies are included in structured data only up to the documented output cap. Business failures return `isError:true`, a short `content` message, and `structuredContent:{ok:false,error:{code,message,retryable,operation_state}}`. JSON-RPC/protocol errors (unknown tool, malformed protocol envelope) stay protocol errors and are not disguised as business failures.

| Tool | Required inputs | Optional/default inputs | Success data |
|---|---|---|---|
| `agentboard_list_workspaces` | none | `limit=50` (1–100), `offset=0` | `items:[{id,name}]`, `next_offset|null`; no paths |
| `agentboard_list_tasks` | effective `workspace_id` | `status`, `limit=50` (1–100), `offset=0` | `items:Issue[]`, `next_offset|null`, resolved `workspace_id` |
| `agentboard_get_task` | `task_id` | effective `workspace_id`, `description_offset_chars=0`, `description_max_chars=12000` (1–40000) | one task; description includes `truncated` and `next_description_offset_chars` when clipped; server verifies Workspace in the same read path |
| `agentboard_get_task_comments` | `task_id` | effective `workspace_id`, `limit=50` (1–100), `offset=0` | comment page with `{id,author,ts,snippet,has_more}` and `next_offset|null`; **read-only, does not advance unread cursor** |
| `agentboard_get_task_comment` | `task_id`, `comment_id` | effective `workspace_id`, `content_offset_chars=0`, `content_max_chars=12000` (1–40000) | one comment body; returns `truncated` and `next_content_offset_chars` when clipped |
| `agentboard_create_task` | effective `workspace_id`, `title`, `request_id` | `description=''`, `priority='中'`, `labels=[]` | created Issue |
| `agentboard_update_task` | effective `workspace_id`, `task_id`, `expected_updated_at`, `request_id`, at least one patch field | `title`, `description`, `priority`, `labels`, `sort_order` | updated Issue; no status/owner/session fields in patch |
| `agentboard_claim_task` | effective `workspace_id`, `task_id`, `request_id` | none; actor from process `AGENTBOARD_AGENT_ID` | claimed Issue; atomic conflict if already claimed or status ineligible |
| `agentboard_release_task` | effective `workspace_id`, `task_id`, `request_id` | none | released Issue; API atomically requires `claimed_by=actor`, resets to “待规划”, adds system comment |
| `agentboard_add_task_comment` | effective `workspace_id`, `task_id`, `content`, `request_id` | none | `{comment,woke}`; server applies existing add-comment behavior; author uses self-declared actor label |
| `agentboard_complete_task` | effective `workspace_id`, `task_id`, `request_id` | `notes=''` | Issue in “待验收”; API atomically requires current owner=actor, clears claim, writes nonempty notes as agent comment |
| `agentboard_fail_task` | effective `workspace_id`, `task_id`, nonempty `reason`, `request_id` | none | Issue in “待规划”; API atomically requires current owner=actor, clears claim, adds agent comment |
| `agentboard_search_knowledge` | `query`, `scope` | effective `workspace_id` for `workspace`/`both`, `limit=5` (1–20) | ranked items `{id,scope,workspace_id,revision,title,snippet,sources,evidence}`; `both` means only current Workspace + common; returns at most one source/evidence locator per result with totals |
| `agentboard_read_knowledge` | `page_id`, `scope` | `workspace_id` for `workspace` (bound value auto-fills); `include_history=false`, `history_offset=0`, `history_limit=20` (1–50); `offset_chars=0`, `max_chars=12000` (1–40000); `sources_offset=0`, `sources_limit=10` (1–100); `evidence_offset=0`, `evidence_limit=10` (1–100); optional `history_body_offset_chars` (Unicode code points; requires history enabled and `history_limit=1`) | page/history body windows, source/evidence totals and continuation offsets; `history_next_offset` advances by returned revisions when output budget clips history; `common` requires omitted `workspace_id` |
| `agentboard_create_knowledge` | explicit `scope`, `title`, `slug`, `body_md`, `sources`, `evidence`, `request_id` | effective `workspace_id` required for `workspace` (bound value auto-fills); optional `expires_at` | created page/revision summary with bounded body and source/evidence counts. Use `agentboard_read_knowledge` for full paged content. `scope='common'` must be explicit and `workspace_id` omitted |
| `agentboard_revise_knowledge` | `page_id`, `scope`, `expected_revision`, `request_id` | effective `workspace_id` for `workspace` (bound value auto-fills); changed fields `title`, `body_md`, `sources`, `evidence`, `expires_at`; at least one content/lifecycle field | new revision; stale revision returns conflict with current revision metadata; `common` requires omitted `workspace_id` |
| `agentboard_archive_knowledge` | `page_id`, `scope`, `expected_revision`, `request_id` | effective `workspace_id` for `workspace` (bound value auto-fills) | archived page with incremented revision; excluded from default search; `common` requires omitted `workspace_id` |
| `agentboard_restore_knowledge` | `page_id`, `scope`, `expected_revision`, `request_id` | effective `workspace_id` for `workspace` (bound value auto-fills) | active page with incremented revision; `common` requires omitted `workspace_id` |

`agentboard_list_workspaces`, `agentboard_list_tasks`, and `agentboard_get_task_comments` use `offset` / `next_offset`; default `limit=50`, maximum 100. Paged endpoints use deterministic `id ASC` ordering. Inserts/deletes or scope changes during a multi-call traversal may still cause repeated or skipped items; v1 does not promise a snapshot. Task descriptions and single-comment content use their corresponding `*_offset_chars` and `*_max_chars` inputs to continue a clipped body. Comment-list results contain bounded snippets (maximum 500 characters each), comment IDs, and `has_more`; `agentboard_get_task_comment` retrieves the body in bounded character windows. Every clipped body returns an offset consumable by that same tool. `agentboard_read_knowledge` caps the serialized tool result (`content` plus `structuredContent`) at 40,000 characters, including page metadata, sources, evidence and history. Body offsets count Unicode code points; source/evidence offsets count array items and apply to page and returned revisions. If history is reduced to fit the cap, `history_next_offset` advances by the number of revisions actually returned. A single row that cannot fit returns `KNOWLEDGE_RESULT_TOO_LARGE`; no revision is silently skipped.

Every knowledge page-ID operation (`read`, `revise`, `archive`, `restore`) requires explicit `scope='workspace'|'common'`. For `workspace`, use the bound `workspace_id` or require the caller to supply it when unbound; for `common`, omit `workspace_id`. The API must validate `page_id`, scope and effective Workspace together in the same operation and reject Workspace A access to a Workspace B page. It must reject `scope='common'` with a Workspace ID and reject `scope='workspace'` without an effective Workspace. A process binding cannot be overridden by a tool argument.

MCP v1 does not expose issue delete, workspace delete, knowledge delete/physical purge, or `POST /comments/consume`. The shared comment consume cursor is issue-wide and can be changed by another client; keeping it out of MCP avoids hidden cross-client state changes. The existing CLI semantics remain unchanged.

## 7. HTTP/domain contracts used by MCP

The server API/domain services own these contracts; CLI and MCP reuse them:

1. **Workspace scope:** task detail/comment/action endpoints take effective `workspace_id` and validate it with the task in the same server handler/service operation. Return `404 TASK_NOT_FOUND` for missing or out-of-scope IDs to avoid leaking another Workspace.
2. **Atomic owner checks:** release/done/fail services accept actor and perform `WHERE workspace_id=? AND id=? AND claimed_by=?` conditional update plus resulting state/comment in one transaction. Return `409 NOT_TASK_OWNER` on mismatch; do not adapt the current force-release route for MCP.
3. **Task edit CAS:** add `expected_updated_at` check in the same update statement/transaction; mismatch returns `409 TASK_REVISION_CONFLICT` and current `updated_at`. Every task-changing path—edit, claim, release, complete, fail, and comments that update the issue—must set `updated_at=max(now,old+1)` in the same transaction as its conditional update. Status transitions remain claim/release/complete/fail tools, not arbitrary PATCH fields.
4. **Knowledge endpoints:** implement `/api/knowledge/*` using the shared knowledge service and repository from the KB design; FTS scope, source/evidence, revisions, archive and CAS stay there.
5. **Idempotency:** every mutating endpoint accepts the MCP `request_id` as the HTTP `Idempotency-Key` header and stores `(key, actor_id, action, resource, payload_hash, response)` transactionally with the domain mutation. Repeating the same key+payload returns the original response; same key with different actor/action/payload returns `409 IDEMPOTENCY_KEY_REUSED`. Retain successful operation results for at least 24 hours. CLI and MCP use this same API behavior. Knowledge CAS remains named `expected_revision`, matching the shared knowledge design; task edit CAS is `expected_updated_at`.
6. **Pagination and bounds:** add bounded `limit` / `offset` inputs and `next_offset` results to task/workspace/comment list contracts; Knowledge search/pages use KB design limits. Page results use deterministic `id ASC`; concurrent inserts/deletes may repeat or skip rows between requests. Domain responses specify truncation explicitly rather than dropping content silently.

`request_id` makes a retried request safe only if it is identical. MCP does not automatically retry mutations. If a client loses the response, it receives no conclusive tool result; it must repeat the identical call with the same `request_id` or inspect the target state. A different payload with that key is rejected. A failed server connection before sending is `SERVER_UNREACHABLE`; a timeout after sending is `OPERATION_UNKNOWN` with retryable=true and operation_state=`unknown`.

## 8. Errors, output limits, startup

| Code | Meaning / caller action |
|---|---|
| `INVALID_ARGUMENT` | MCP input validation failed; correct the named field. |
| `WORKSPACE_REQUIRED` / `WORKSPACE_BOUND` | Supply workspace ID or use the configured workspace process. |
| `TASK_NOT_FOUND` / `KNOWLEDGE_NOT_FOUND` | Resource absent or outside scope. |
| `TASK_CLAIMED` / `NOT_TASK_OWNER` | Re-read task; only current claimed owner can perform owner actions. |
| `TASK_REVISION_CONFLICT` / `KNOWLEDGE_REVISION_CONFLICT` | Read current record and decide whether to reapply. Structured error returns only numeric `current_updated_at` or `current_revision`; no auto-merge. |
| `IDEMPOTENCY_KEY_REUSED` | Reuse same request ID only for the original exact operation. |
| `KNOWLEDGE_UNAVAILABLE` | Knowledge route is missing; do not substitute an independent search path. |
| `KNOWLEDGE_RESULT_TOO_LARGE` | Reduce text/history/source/evidence limits and continue from offsets. A single oversized row is returned as a bounded error. |
| `SERVER_UNREACHABLE` / `OPERATION_UNKNOWN` | Restore local service or resolve mutation with the identical request ID. |
| `UPSTREAM_ERROR` | Sanitized API error; no stack trace, path, or raw server body in MCP output. |

Start command for a local install:

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["<AgentBoard install>/apps/mcp/dist/index.js"],
      "env": {
        "AGENTBOARD_BASE_URL": "http://127.0.0.1:8787",
        "AGENTBOARD_WORKSPACE_ID": "<workspace-id>",
        "AGENTBOARD_AGENT_ID": "<codex|dsh|workbuddy>"
      }
    }
  }
}
```

No secret/token is required in this single-user loopback proposal. MCP startup must not start the API server. If API health/readiness is missing, startup completes with the tool server available; calls return `SERVER_UNREACHABLE` until AgentBoard is running. Writes must not be queued offline.

## 9. Security and untrusted data

- Server remains loopback-only; the MCP transport is local stdio. Reject non-loopback base URLs in first release.
- Agent ID is a self-declared audit label, not proof of client identity, user identity, or role. Owner match prevents accidental completion by a different label but is not security authentication.
- Tool scope validation is enforced in server API/domain service. Do not rely on tool descriptions or an MCP client to enforce Workspace isolation.
- Task comments and knowledge source text are untrusted reference data. Return as quoted content/data; do not promote embedded instructions to system or developer instructions.
- No task/workspace delete, session operation, shell/file path, desktop account, or credential tool is registered.
- API errors exposed through `structuredContent` contain stable codes and bounded messages. Never return stack traces, local DB paths or environment values.

## 10. Acceptance

1. **Handshake:** Codex CLI, Codex Desktop, DSH and WorkBuddy each discover the same named tools over stdio on supported current client versions; CLI/Desktop forms require separate validation. MCP server stdout contains protocol only; diagnostics go to stderr.
2. **Workspace binding:** bound process omitting workspace ID reads/writes only its Workspace; mismatched ID fails. Unbound process without ID fails. Explicit common search works without a Workspace ID; `both` and workspace writes require a current ID.
3. **Task lifecycle:** create → get → claim → comment → complete reaches “待验收”; fail returns to “待规划”; non-owner release/complete/fail conflicts; simultaneous claims yield one success; fields and statuses match the API contract.
4. **Task timestamps and comment reads:** all mutating task/comment paths advance `updated_at` to `max(now,old+1)` in the same transaction; two mutations within one millisecond still produce distinct timestamps and only the caller with the current expected value updates. `get_task_comments` does not change `last_seen_comment_id`; repeated reads return the same comments. Truncated descriptions/comments continue using their returned character offset and the same read tool. No MCP tool consumes the shared cursor.
5. **Knowledge scopes:** `both` for Workspace A yields only A+common, never Workspace B; `common` write requires explicit scope; workspace item cannot be read from a different Workspace.
6. **Knowledge revision:** create/revise/archive/restore preserve snapshots and evidence; stale expected revision returns conflict; competing updates from same revision accept one only.
7. **Retry safety:** retry identical mutation with same `request_id` returns the original result and does not duplicate task/comment/revision; same key with altered payload fails; timeout after send is reported unknown and not auto-retried.
8. **Pagination and limits:** limits enforce defaults/maxima; `offset`/`next_offset` use stable id ordering; concurrent list mutations may repeat or skip rows and are documented. Truncated descriptions/comments/knowledge bodies include an offset that the corresponding read tool accepts; knowledge history is capped and paginated, not unbounded.
9. **Failure behavior:** stopped AgentBoard returns `SERVER_UNREACHABLE`; missing KB API returns `KNOWLEDGE_UNAVAILABLE`; SDK schema errors follow the SDK `tools/call` input-validation response (`isError:true`, text content, no `structuredContent`); domain errors use `isError:true` structured business errors.
10. **Boundary:** tool listing contains only task-board and shared-knowledge tools; no session execution, arbitrary terminal, account credentials, desktop switching, or destructive delete.

本地 MCP 20/20、server knowledge API 3/3、MCP typecheck/build 已通过；SDK stdio 流测试覆盖 initialize 与 18 个工具列表。该流测试没有启动 MCP 子进程。真实 `dist/index.js` stdin/stdout/EOF smoke、真实任务或知识写入和 MCP 客户端实际接入仍待验收。

## 11. 剩余验收

1. 使用临时 CLI 参数执行只读模型握手，不改持久 MCP 配置；Codex Desktop、DSH 与 WorkBuddy GUI 分开验证。
2. 用 child_process 启动 `apps/mcp/dist/index.js`，验证 initialize/list/call、stdout 纯 JSON-RPC 与 stdin EOF 退出。
3. MCP 子进程和 WorkBuddy GUI 使用隔离合成 API fixture，不连正式任务/知识数据。
4. 单机进程边界不是可信身份认证。若以后需要多用户/agent ACL、远程 MCP 或网络暴露，另立授权与安全设计。
