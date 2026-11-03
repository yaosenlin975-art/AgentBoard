# AgentBoard HTTP API 参考

本文件是 REST + WebSocket 接口的完整参考，以 `apps/server/src/api/routes.ts`（及其中挂载的 `knowledgeRoutes.ts`、`accountRoutes.ts`）当前实现为准；表内 `routes.ts:n` / `knowledgeRoutes.ts:n` 为行号锚点。设计概要见 `Docs/设计文档.md` §6.1。

## 1. 服务与配置

- 启动命令、后台常驻：见 `README.md`「启动」节。
- 监听地址：仅 `127.0.0.1:<port>`（`index.ts:122`），REST 前缀 `/api`，WebSocket 路径 `/ws`。
- 默认：端口 8787，并发上限 3，图片配额 1 GiB、暂存 TTL 24h、清理周期 1h，DB `%APPDATA%\AgentBoard\agentboard.db`（`config.ts`）。
- 端口误判：DSH 桌面端插件经 DSH web server 暴露独立数据源，对其请求返回 401 时见 `README.md`「与 DSH 任务看板插件的边界」。
- 配置文件 `%APPDATA%\AgentBoard\config.json`（非 Windows 回退 `~/.config/AgentBoard/`），字段 `port` / `dbPath` / `maxConcurrentTurns` / `attachmentQuotaBytes` / `attachmentStagedTtlMs` / `attachmentCleanupIntervalMs`；首次启动写回默认值，文件损坏按默认处理且不覆盖原文件（`config.ts`）。
- 环境变量 `AGENTBOARD_PORT`（正整数）、`AGENTBOARD_DB`（非空路径）：仅启动期覆盖，不写回 config.json；`GET /api/settings` 不回显 env 覆盖值（`config.ts:88-95, 98-105`）。
- `PATCH /api/settings` 写回 config.json：`maxConcurrentTurns` 与附件设置即时生效，`port` / `dbPath` 重启生效（`routes.ts`）。

## 2. 通用约定

> CLI-UX（2026-11-03）：`400 VALIDATION_ERROR` 的 message 已中文化并附可用值（如 `priority: 取值必须是：低 / 中 / 高`）；`kb done` 支持 `--notes-stdin`，`kb list-tasks --full` 只对 `--json` 生效，`kb changelog` 时间按本地时区展示。


- 请求/响应均为 JSON；时间戳为 Unix 毫秒整数。错误信封统一为 `{ "error": { "code", "message", "details"? } }`（`routes.ts:508`）。
- 状态码：`ValidationError`→400（code `VALIDATION_ERROR`）、`NotFoundError`→404（`NOT_FOUND`）、`ConflictError`→409（`CONFLICT`）、未处理→500（`INTERNAL`）（`errors.ts:14-30`）。端点专属 code 见各行：`TASK_NOT_FOUND` 404、`TASK_REVISION_CONFLICT` 409、`NOT_TASK_OWNER` 409、`COMMENT_NOT_FOUND` 404、`PICK_FOLDER_BUSY` 409、`PICK_FOLDER_FAILED` 500、`IDEMPOTENCY_KEY_REUSED` 409、`OPERATION_UNKNOWN` 409、`KNOWLEDGE_*` 404/409。
- `/api` 未匹配路由 → 404 `NOT_FOUND`（`routes.ts:522`）；请求体非法 JSON → 400 `INVALID_JSON`（`routes.ts:513`）。
- 分页：query `limit`（1..100，缺省 50）、`offset`（≥0，缺省 0）；带任一参数即启用分页，否则返回全量数组。分页响应 `PageResult<T> = { items: T[], next_offset: number|null }`（`pagination.ts:7`）。
- 正文窗口：query/body `*_offset_chars`（≥0，默认 0）、`*_max_chars`（1..40000，默认 12000），按 Unicode 字符截取；响应附 `*_truncated` 与 `next_*_offset_chars`（`pagination.ts:9`）。
- `workspace_id` 守卫（`routes.ts:189-198`）：`/api/issues/:id` 及其全部子路由，query 或 body 带 `workspace_id` 时校验任务归属，不匹配 → 404 `TASK_NOT_FOUND`；query 与 body 同时给出且不一致 → 400；省略时不做归属校验。`workspace_id` 在 query 与 body 均可提供（取值等价）。
- Idempotency-Key（`idempotency.ts:15-39`）：请求头 `Idempotency-Key`（须为 UUID）+ actor（`body.actor ?? body.agent_id ?? 'user'`，非空且 ≤100 字符）。适用于表中标注"幂等"的端点：POST /api/issues、PATCH /api/issues/:id、claim/release/done/fail、POST comments、knowledge POST/PUT/actions。非 UUID key → 400；同 key 复用于不同 payload（body+query）/actor/方法/路径 → 409 `IDEMPOTENCY_KEY_REUSED`；评论唤醒效果待定期间重放 → 409 `OPERATION_UNKNOWN`（`details.result` 为已落库响应）；记录保留 24h。重放返回首次结果，不重复广播 WS。幂等的 release/done/fail 必须提供 `workspace_id`（`routes.ts:384`）。
- 版本协商：所有 `/api` 响应带 `x-agentboard-version: <version>` 头（含 404/错误响应，`index.ts:101-104`），值取 `apps/server/package.json`（`version.ts`）。CLI 每次请求读该头与自身版本比对：major 不同、双方 0.x 且 minor 不同、头缺失或不可解析 → stderr 警告一次（仅警告不阻断，patch 差异不警告；`packages/cli/src/api.ts`）。

### 响应对象字段（`packages/shared/src/types.ts`）

| 对象 | 字段 |
| --- | --- |
| Workspace | `id, name, path, created_at` |
| Issue | `id, workspace_id, title, description, priority, labels: string[], status, sort_order: int, claimed_by: string\|null, claimed_at: number\|null, session_id: string\|null, comment_count: int, blocked_by_count: int, blocked_by_open_count: int, resolved: boolean, created_at, updated_at`；`comment_count` 查询时由 issue_comment 计数，`blocked_by_count`/`blocked_by_open_count` 由 issue_dependency 单次预聚合、`resolved` 由 `isBlockerResolved` 推出（无前置时 0/0/true），三者都不是落库列（`issue.ts:29-40`、`dependency.ts:86-105`） |
| IssueComment | `id, issue_id, author, content, ts, attachments?: AttachmentMetadata[]`；author 取值 `'user' \| 'agent:<id>' \| 'system'` |
| AttachmentMetadata | `id, file_name, mime_type: 'image/png'\|'image/jpeg'\|'image/webp', size_bytes, url`；不包含服务器存储路径 |
| Session | `id, workspace_id, issue_id: string\|null, cli, model: string\|null, status, adapter_session_id: string\|null, created_at`；运行时合并字段 `queued_count?: int`（内存队列中待合并消息数）、`waiting_slot?: boolean`（当前轮在等全局并发槽位）——不入库，仅 GET /api/sessions 与 GET /api/sessions/:id 返回时由 sessionManager 内存态合并（`routes.ts:418-435`）；WS `session.changed` 不携带 |
| Message | `id, session_id, role: 'user'\|'assistant'\|'event'\|'error', content, ts` |
| CliInfo | `id, displayName, installed: boolean, version: string\|null, supportsModelSelection: boolean` |
| ModelInfo | `id, source: 'probed'\|'static'\|'manual'` |
| TaskKnowledge | `enabled: boolean, query: string, warning?: 'KNOWLEDGE_UNAVAILABLE', items: Array<{ id, scope, workspace_id, revision, title, sources, evidence, snippet }>`（`taskKnowledge.ts:5`） |

## 3. workspaces

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/workspaces` | query：`limit? offset?` | `Workspace[]`（created_at,id 升序）；带分页参数时 `PageResult<Workspace>`（id 升序） | 400 分页参数非法 | routes.ts:201 |
| `POST /api/workspaces` | body：`name: string`（键必填，可空串）、`path: string`（非空，须为已存在目录） | `Workspace`；name 空串时取 path 去尾部 `/` `\` 后的最后一段 | 400 path 为空 / 路径不存在或不是目录；path 重复（`workspace.path` UNIQUE，`schema.ts:9`）未映射为业务错误 → 500 `INTERNAL`（以实现为准） | routes.ts:206 |
| `DELETE /api/workspaces/:id` | — | 204；级联删除该空间 issue/comment/session/message/附件元数据，提交后回收附件文件 | 404 工作空间不存在；409 `CONFLICT`（body `{error:{code,message}}`，message 为可读原因：`该空间仍有 <n> 个知识页及 <m> 条历史 revision，请先删除或迁移知识页后再移除` / `该空间有 <n> 个运行中会话，请先结束会话后再移除` / `该空间有 <n> 个子任务仍挂在父任务下，请先解除关联后再移除`）；CLI 用 `kb delete-space <id\|名> --yes`（缺 `--yes` 只回显，退出码 1；被阻塞退出码 2） | routes.ts:415 |

### 评论图片附件

单图上限 10 MiB，单评论最多 5 张；允许纯图片评论。仅支持 PNG/JPEG/WebP，服务端核对 MIME 与文件签名。暂存默认 24 小时，私有存储配额默认 1 GiB。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/workspaces/:workspaceId/attachments` | raw bytes；`Content-Type: image/png\|image/jpeg\|image/webp`；可选 `X-File-Name`（仅保存清理后的文件名） | 201 `{ id, workspace_id, file_name, mime_type, size_bytes, status: 'staged', expires_at, download_url }`；响应不含存储键或路径 | 404 工作空间不存在；400 `ATTACHMENT_INVALID_IMAGE`；413 `ATTACHMENT_TOO_LARGE` / `ATTACHMENT_QUOTA_EXCEEDED` | routes.ts |
| `GET /api/workspaces/:workspaceId/attachments/:attachmentId` | — | staged 图片原始字节；仅同 Workspace 且暂存未过期时可读取 | 404 图片/工作空间不存在；410 `ATTACHMENT_EXPIRED` | routes.ts |
| `GET /api/issues/:id/attachments/:attachmentId` | — | attached 图片原始字节；附件必须关联此 Issue 的评论 | 404 任务或图片不存在 | routes.ts |

## 4. system

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/version` | — | `{ name: 'agentboard-server', version: string, pid: number }`；version 取 `apps/server/package.json`（`version.ts`）；`pid` 供重启后区分「新进程已接管」与「已回退旧进程」；web 顶栏与设置弹窗经 `apps/web/src/api/version.ts` 展示 | — | routes.ts:239 |
| `POST /api/system/pick-folder` | — | `{ path: string\|null }`；null=用户取消；Windows 原生 FolderBrowserDialog（powershell.exe），同一时刻仅允许一个窗口 | 409 `PICK_FOLDER_BUSY` 已有选择窗口打开；500 `PICK_FOLDER_FAILED` 打开窗口失败 | routes.ts:228 |

## 5. settings

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/settings` | — | `{ port, dbPath, maxConcurrentTurns, attachmentQuotaBytes, attachmentStagedTtlMs, attachmentCleanupIntervalMs }`（仅 config.json 持久化值） | — | routes.ts |
| `PATCH /api/settings` | body：`port?: int 1-65535`、`dbPath?: string 非空`、`maxConcurrentTurns?: int ≥1`、附件数值设置均为安全正整数（至少一个；未知键忽略） | 新的持久化 settings；并发和附件设置即时生效 | 400 未提供字段 / 取值非法 | routes.ts |

## 6. issues

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues` | query：`workspace`（必填）、`status?`（**该工作区已定义的任意状态名**：内置五状态 + 自定义；分页与非分页都生效）、`limit? offset?` | `Issue[]`（sort_order,created_at,id 升序）；分页模式 `PageResult<TaskPreview>`（id 升序；description 截取默认 12000 字符并附 `description_truncated` `next_description_offset_chars`） | 400 缺 workspace / 分页非法 / `status` 不属于该工作区（文案列出可用状态）；404 工作空间不存在 | routes.ts |
| `POST /api/issues`（幂等） | body：`workspace_id: string`、`title: string 非空`、`description?: string`、`priority?: '低'\|'中'\|'高'`（缺省 中）、`labels?: string[]`（缺省 []） | `Issue`（status=待规划、sort_order=0）；WS issue.changed | 400 校验失败；404 工作空间不存在 | routes.ts:268 |
| `POST /api/issues/draft` | body：`workspace_id`、`requirement: string 1-4000`、`adapter: 'dsh'\|'codex'\|'opencode'`、`priority?: '低'\|'中'\|'高'` | **不落库**：`{ title, description, labels, warnings: string[] }`。`description` 固定三段（`## 背景` / `## 要求` / `## 验收`），模型没给的段落写「未提供」，**不补需求、不编验收条件**；`labels` 只保留工作区已有标签，自造的丢弃并进 `warnings`；一次性适配器调用（不建会话/不占 claim），超时 120s；审计写 `issue_draft_audit`（只记 adapter/耗时/成败/warning 数，不记需求原文） | 400 参数非法（adapter 不在三家内、requirement 空/超长）；404 工作空间不存在；422 `DRAFT_INVALID_OUTPUT`（JSON 不合法，已重试 1 次）；502 `DRAFT_ADAPTER_FAILED`；504 `DRAFT_TIMEOUT` | routes.ts（`services/smartCreateDraft.ts`） |
| `GET /api/issues/:id` | query：`description_offset_chars?` `description_max_chars?` | `Issue`；带窗口参数时 description 为窗口内容并附 `description_truncated` `next_description_offset_chars` | 404 任务不存在（归属不匹配同为 404） | routes.ts:276 |
| `PATCH /api/issues/:id`（幂等） | body：`title? description? priority? labels? status? sort_order?: int`（至少一个）；`workspace_id?`；`expected_updated_at?: int ≥0`（CAS，须同时提供 workspace_id） | `Issue`（`updated_at` 单调递增：`MAX(now, 旧值+1)`，`issue.ts:145` + `schema.ts:42` 触发器，CAS 调用方依赖）；WS issue.changed | 400 未提供更新字段 / CAS 缺 workspace_id / 参数非法；404 任务不存在；409 `CONFLICT` 占用中禁改 status；409 `TASK_REVISION_CONFLICT` CAS 过期（details `current_updated_at`） | routes.ts:284 |
| `DELETE /api/issues/:id` | — | 204；先停各绑定会话在途轮次，再同事务级联删除消息+会话+任务；同事务内对每个被本卡阻塞的卡追加 system 评论「前置 X(short id) 已删除，依赖自动解除」；WS issue.deleted + 每会话 session.deleted + 每条解锁评论 comment.added | 404 任务不存在；409 `CONFLICT` 占用中禁止删除；含子任务时 409 `CONFLICT`（子任务先处理） | routes.ts:447；CLI `kb delete-issue <id> --yes`（缺 `--yes` 只打印标题/状态、非 0 退出、不发请求）；MCP `agentboard_delete_task` |

### 依赖（DEP-1，`services/dependency.ts`）

边方向：`blocked_issue_id` ← `blocker_issue_id`（blocker 完成后 blocked 才可开工）。解除判定唯一口径：blocker 状态 ∈ {`待验收`, `已关闭`}；`resolved` 由服务端算好，消费端不再判断。写通道强制 `workspace_id`（POST 走 body、DELETE 走 query，缺省 400），用 `requireIssueInWorkspace` 校验，不按 issue 自身工作区放行。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues/:id/dependencies` | query：`workspace_id`（必填） | `{ blockers: DependencyRef[], blocked: DependencyRef[] }`，`DependencyRef = { issue_id, title, status, resolved }` | 400 缺 `workspace_id`；404 `TASK_NOT_FOUND` | routes.ts |
| `POST /api/issues/:id/dependencies`（幂等） | body：`workspace_id: string`、`blocker_issue_id: string` | 201 `{ blockers, blocked }`；WS issue.changed（被阻塞卡与前置卡各一条） | 400 缺 `workspace_id` / `DEPENDENCY_SELF` 自环 / `CROSS_WORKSPACE_DEPENDENCY` 跨区；404 `TASK_NOT_FOUND` / `NOT_FOUND`（blocker 不存在）；409 `DEPENDENCY_EXISTS` 重复 / `DEPENDENCY_CYCLE` 成环 / `ISSUE_CLAIMED` 被阻塞卡已占用须先 release | routes.ts |
| `DELETE /api/issues/:id/dependencies/:blockerId` | query：`workspace_id`（必填） | 204；WS issue.changed | 400 缺 `workspace_id`；404 `TASK_NOT_FOUND` / `NOT_FOUND`（边不存在） | routes.ts |

约束：同工作区与防环由服务层先判错误码，表上另有 `BEFORE INSERT` 触发器兜底（直接写库绕不过）；自环由 `CHECK` + 服务层 400 负责；单卡前置上限 50（`MAX_DEPENDENCY_EDGES`）。`claimed_by IS NOT NULL` 的卡不得新增前置（409 `ISSUE_CLAIMED`，含"进行中但已释放"除外）。`done`/`fail`/`release` 不受依赖影响。

**CLI（DEP-2，`packages/cli/src/commands/dep.ts`）**

```
kb dep ls <issue-id>                 # 前置与被阻塞者（状态 + 解除标记），--json 出原始响应
kb dep add <issue-id> <blocker-id>   # 建边；blocker 解除后本卡才可 claim
kb dep rm <issue-id> <blocker-id>    # 删边；缺边 404
```

workspace 解析：先 `GET /api/issues/:id` 取 `workspace_id` 再上送（同 `kb claim` 手法），写通道因此恒带 `workspace_id`。`--json` 输出原始响应。退出码**由本子命令自带映射，不改全局 `toExit`**：0 成功；2 `DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED`；3 `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR`；4 `NOT_FOUND` / `TASK_NOT_FOUND`；未映射的码交回全局 `toExit`（409 → 2、其余 → 1，用服务端原文）。每个已映射码一句中文文案，不会被包装成「已被占用（…）」：

| 错误码 | 退出码 | 文案 |
| --- | --- | --- |
| `DEPENDENCY_CYCLE` | 2 | 该依赖会让任务成环，已拒绝 |
| `DEPENDENCY_EXISTS` | 2 | 该依赖已存在 |
| `ISSUE_CLAIMED` | 2 | 任务已被占用，请先释放占用（release）再新增前置 |
| `CROSS_WORKSPACE_DEPENDENCY` | 3 | 不支持跨工作区依赖 |
| `DEPENDENCY_SELF` | 3 | 不能依赖自身：被阻塞卡与前置卡是同一张 |
| `VALIDATION_ERROR` | 3 | 参数不合法（缺少 workspace_id 或前置 id 为空） |
| `NOT_FOUND` | 4 | 任务或依赖不存在 |
| `TASK_NOT_FOUND` | 4 | 任务不存在或不属于该工作区 |

**MCP（DEP-2，`apps/mcp/src/tools/dependencies.ts`）**

| 工具 | 入参 | 语义 |
| --- | --- | --- |
| `list_dependencies` | `task_id`、`workspace_id?`（绑定工作区优先，越界 `WORKSPACE_BOUND`） | 返回 `{ blockers, blocked, workspace_id }`，`resolved` 由服务端给 |
| `add_dependency` | `task_id`、`blocker_task_id`、`request_id`（UUID，作 `Idempotency-Key`）、`workspace_id?` | 建边，返回同 `list` 的视图 |
| `remove_dependency` | `task_id`、`blocker_task_id`、`workspace_id?` | 删边，返回 `{ removed: true, task_id, blocker_task_id, workspace_id }` |

错误走 `structuredContent.error.code`：依赖码原样透传（`DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED` / `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF`），404 `NOT_FOUND` 按 `apiClient` 既有约定落成 `TASK_NOT_FOUND`；`message` 用本地安全文案，不回传服务端原文。

> **命名与兼容（MCP-NAMING）**：MCP server 名已是 `agentboard`，工具名不再带 `agentboard_` 前缀（客户端显示为 `mcp__agentboard__list_tasks` 这类形式）。旧名 `agentboard_<name>` 作为 alias 同时注册、指向同一 handler，**下个大版本移除**；已有客户端配置与 prompt 无需立即改。

### 状态字典（STATUS-1/2，`workspace_status` + `services/workspaceStatus.ts`）

`issue.status` 落库是名字字符串，合法值 = 该卡所属工作区的 `workspace_status.name`；写入不在字典里的值 → 400 `VALIDATION_ERROR` 且文案列出可用状态（DDL 已无 CHECK 枚举，STATUS-1 迁移把校验挪到服务层）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/workspaces/:workspaceId/statuses` | — | `WorkspaceStatus[]`（`{ id, workspace_id, name, kind, sort_order, is_builtin }`，`sort_order`,`name`,`id` 升序）；5 条内置恒在（`is_builtin=1`，`kind` = open/started/review/done/deprecated，sort_order 0/10/20/30/40） | 404 工作空间不存在；400 body/query 的 `workspace_id` 与路径不一致 | workspaceStatusRoutes.ts |
| `POST /api/workspaces/:workspaceId/statuses` | body：`name: string 1-50`、`kind: 'open'\|'started'\|'review'\|'done'\|'deprecated'`、`sort_order?: int`（缺省 = 当前最大值 +10）、`workspace_id?`（一致性校验） | 201 `WorkspaceStatus`（`is_builtin=0`） | 400 名空 / kind 非法 / workspace_id 与路径不一致；409 `WORKSPACE_STATUS_EXISTS` 同区重名（含内置名）；404 工作空间不存在 | workspaceStatusRoutes.ts |
| `DELETE /api/workspaces/:workspaceId/statuses/:statusId` | query：`migrate_to`（**必填**，目标状态名）、`workspace_id?` | 200 `{ removed, migrate_to, migrated_issue_count }`；同事务把该状态下的卡全部改成 `migrate_to` 再删行 | 400 `MIGRATION_TARGET_REQUIRED` 缺 migrate_to / `MIGRATION_TARGET_INVALID` 目标不存在或等于自身 / `workspace_id` 不一致；409 `WORKSPACE_STATUS_BUILTIN` 内置不可删；404 `NOT_FOUND` 状态或工作空间不存在 | workspaceStatusRoutes.ts |

**CLI**：`kb status ls <workspace>`、`kb status add <workspace> <name> [--kind …] [--sort-order N]`、`kb status rm <workspace> <name|id> --migrate-to <name>`。workspace 支持 id 或名称；409 的状态字典错误（`WORKSPACE_STATUS_*`）由子命令原样打印文案并退出 **2**（不被全局包装成「已被占用（…）」），其余失败退出 1。

**CLI 列表口径（CLI-LIST-GUARD）**：`kb list-tasks --status <状态>` 先按该工作区（未指定 workspace 时按「任一工作区」）的状态字典校验，非法值 → 非 0 退出并列出可用状态（不再静默返回「（无任务）」）；`--json` **默认裁掉 `description` 正文**并标记 `description_omitted: true`，需要正文时显式 `--json --full`；表格模式本来就不输出正文。

**MCP**：`list_statuses` / `add_status`（`request_id` 作幂等键） / `remove_status`（`migrate_to` 走 query，无幂等键，与 REST 一致）；强制 `resolveWorkspaceId`，错误码透传（`WORKSPACE_STATUS_BUILTIN` / `WORKSPACE_STATUS_EXISTS` / `MIGRATION_TARGET_REQUIRED` / `MIGRATION_TARGET_INVALID`）。

## 7. comments

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues/:id/comments` | query：`limit? offset?` | `IssueComment[]`（ts,id 升序）；分页模式 `PageResult<{ id, author, ts, snippet(≤500 字符), has_more, attachments? }>`；图片元数据带 `delivery_state?: pending\|sending\|unknown\|delivered` | 404 任务不存在；400 分页参数非法 | routes.ts |
| `GET /api/issues/:id/pending-attachments` | query：`limit? offset?`（默认 50、最大 100） | `PageResult<DispatchAttachmentCandidate>`：仅返回该 Issue 的 pending/unknown 图片元数据，按评论时间、评论 ID、附件位置升序；每项含作者、500 code point 评论片段，不含路径 | 404 任务不存在；400 分页参数非法 | routes.ts |
| `GET /api/issues/:id/comments/:commentId` | query：`content_offset_chars?` `content_max_chars?` | 单条评论窗口及 `truncated`、续读 offset；含 `attachments?` | 404 任务不存在；404 `COMMENT_NOT_FOUND` 评论不存在 | routes.ts |
| `POST /api/issues/:id/comments` | body：`content: string`（可空，仅当有图片）、`workspace_id?`、`attachment_ids?: UUID[]`（唯一，最多 5；有图时 workspace_id 必填）、`agent_id?: string`。幂等 | `{ comment: IssueComment, woke: boolean, warning?: 'WAKE_FAILED'\|'IMAGE_DELIVERY_UNVERIFIED' }`。纯文字沿用用户评论唤醒；含图片时仅在当前 CLI/model 已验证时唤醒。附件元数据带 `delivery_state`：pending、sending、unknown、delivered。未知/失败时评论保持待读。WS comment.added + issue.changed；投递状态经 comment.delivery.changed 刷新 | 400 内容与图片同时空 / 字段非法；404 图片或任务不在指定空间；409 `ATTACHMENT_ALREADY_BOUND`；410 `ATTACHMENT_EXPIRED` | routes.ts |
| `POST /api/issues/:id/comments/consume` | — | `{ comments: IssueComment[], new_comment_ids: string[] }`。含附件的首条待读评论在 `delivered_at` 为空时阻止游标前进；`new_comment_ids` 不含该图片评论及其后的评论。无图片阻塞时沿用原有恰好一次游标语义 | 404 任务不存在 | routes.ts |

## 8. 占用事务（claim / release / done / fail）

响应均为平铺：`{ ...issue, comment: IssueComment \| null }`（claim 为 `{ ...issue, knowledge: TaskKnowledge }`）。四个端点均幂等；comment 非空时 WS 先 comment.added 后 issue.changed。

release / done / fail 按是否携带 `workspace_id`（query 或 body）走两条实现路径，错误语义不同（`routes.ts:381-397`）：

| 路径 | 实现 | 任务缺失 | 未占用 | 占用者≠agent_id | agent_id='user' |
| --- | --- | --- | --- | --- | --- |
| 不带 workspace_id | `releaseIssue` / `doneIssue` / `failIssue`（`claim.ts:71-149`） | 404 `NOT_FOUND` | done/fail → 409 `CONFLICT`；release 任何状态可释放 | 409 `NOT_TASK_OWNER` | done/fail 豁免所有者校验 |
| 带 workspace_id | `scopedFinish`（`claim.ts:22-35`） | 404 `TASK_NOT_FOUND` | 409 `NOT_TASK_OWNER` | 409 `NOT_TASK_OWNER` | 不豁免（须与 claimed_by 完全相等） |

带 `Idempotency-Key` 时必须携带 `workspace_id`（`routes.ts:384`），即只走第二条路径。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/issues/:id/claim` | body：`agent_id: string 非空`、`knowledge_enabled?: boolean`（默认 true）、`knowledge_query?: string 1-500` | `{ ...issue, knowledge }`。原子占用（status→进行中、session_id=null 纯登记不建会话；仅未占用且 status∈{待规划,进行中} 可领取），并发领取仅一个成功；留言游标置为领取前最新评论；存在未验证图片时停在首条图片评论之前。**依赖门禁（DEP-1）**：前置未解除时 409，文案 `存在未完成的前置任务：<title>(<short id>)…；完成后可领取`，守卫与占用更新在同一 IMMEDIATE 事务内；`services/dispatch.ts` 派发路径同样被拦 | 400 agent_id 为空；**409 `ISSUE_CLAIMED`** 已被占（文案 `已被 <agent> 占用；先 release 或换卡，勿重复 claim`）/ **409 `ISSUE_STATUS_NOT_CLAIMABLE`** 无人占用但 status∉{待规划,进行中}（文案 `状态不可领取（当前=<status>，需=待规划 或 进行中）；无人占用，待验收卡由 owner 验收或由父代理退回待规划`）/ 409 前置未解除（DEP-1）；404 `TASK_NOT_FOUND`（带 workspace_id 且任务缺失/不归属） | routes.ts、`claim.ts:83-91`（CLAIM-MSG） |
| `POST /api/issues/:id/release` | 不带 workspace_id：无需 body（用户强制释放）；带 workspace_id：body `agent_id: string 非空` | `{ ...issue, comment }`。状态→待规划、清空占用。不带 workspace_id：comment author=`system` 内容「用户强制释放」、任何状态可释放；带 workspace_id：comment author=`agent:<agent_id>` 内容「占用者释放任务」 | 不带 workspace_id：404 任务不存在。带 workspace_id：404 `TASK_NOT_FOUND`；409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id | routes.ts:398 |
| `POST /api/issues/:id/done` | body：`agent_id: string 非空`、`notes?: string`（空串等价不写评论）、`scope_paths?: string[]`（最多 200 项，提交范围声明：文件路径或目录前缀） | `{ ...issue, comment }`。状态→待验收、清空占用；notes 非空时落评论（author=`agent:<agent_id>`），否则 comment=null。GIT-ON-DONE 提交范围：同 workspace 有其它「进行中且被占用」任务时，只提交 `scope_paths` 命中的路径，其余路径不提交并以 system 评论列出清单；未声明则整批不提交（同样列清单）；无并行占用时按 claim 基线 diff 提交。**claim 前就已未提交的文件**（指纹与基线相同、不在变化集）：落在 `scope_paths` 内的会被强制提交，评论标注「claim 前就已修改、按声明范围强制提交」；不在范围内或未声明时一律不提交，改为评论列出清单 + 可直接执行的 `git add -- … && git commit -m … -- …` 补救命令（不静默跳过）。详见 `gitBaseline.ts` 头注释。**SCOPE-GUARD**：声明了 `scope_paths` 却零命中时，系统评论以「⚠ 声明范围零命中，本次未自动提交」开头，列出声明范围与未提交文件，并给出可直接执行的两条命令（`git add -- …; git commit -m … -- …`）；done 本身仍然成功（不阻塞已完成的卡）。CLI 侧 `--scope` 建议每个路径一个，不要写逗号串（PowerShell 会拆/并参数；含空格的值会给 stderr 警告）。**不能自动提交的三档原因**（`detectGitRepo`，`gitBaseline.ts`；done 本身仍成功，只落一条 system 评论并回显声明范围）：① `GIT_NOT_INSTALLED` — `git --version` 失败（如容器镜像未装 git）：`跳过自动提交：环境未安装 git（GIT_NOT_INSTALLED，<path>）；声明范围：…`；② `NOT_A_GIT_REPO` — git 有但目录不是仓库或目录不存在：`跳过自动提交：工作区不是 git 仓库（NOT_A_GIT_REPO，<path>），如需自动提交请在该目录 git init；声明范围：…`；③ `GIT_REPO_UNHEALTHY` — 是仓库但 `git status` 失败（index/HEAD 损坏、权限）：`跳过自动提交：git 仓库状态异常（GIT_REPO_UNHEALTHY，<path>）：<具体错误>；声明范围：…`。 | 400 agent_id 为空；400 `scope_paths` 超限或空串。不带 workspace_id：404 任务不存在、409 `CONFLICT` 未被占用、409 `NOT_TASK_OWNER` 仅当 agent_id≠'user' 且≠占用者。带 workspace_id：404 `TASK_NOT_FOUND`、409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id（'user' 不豁免） | routes.ts:399 |
| `POST /api/issues/:id/close`（幂等） | body：`agent_id`（可选）、`workspace_id?` | `Issue`（status→`已关闭`）。只允许「待验收」→「已关闭」；已关闭再调幂等返回；占用中拒绝 | 409 `ISSUE_CLAIMED`（先 release）/ `INVALID_TRANSITION`（当前不是待验收）；404 `NOT_FOUND` | routes.ts（`services/issueTransitions.ts`） |
| `POST /api/issues/:id/reopen`（幂等） | body：`status?`（默认 `待规划`）、`agent_id`（可选）、`workspace_id?` | `Issue`（status→目标）。只允许关闭类（kind `done`/`deprecated`）→ 目标状态；目标必须命中本工作区状态字典（含自定义状态） | 400 目标状态非法（文案列出可用状态）；409 `ISSUE_CLAIMED` / `INVALID_TRANSITION`（当前不是关闭态）；404 `NOT_FOUND` | routes.ts |
| `POST /api/issues/:id/fail` | body：`agent_id: string 非空`、`reason: string 非空` | `{ ...issue, comment }`。状态→待规划、清空占用；reason 落评论（author=`agent:<agent_id>`） | 400 agent_id / reason 为空；其余按两条路径同 done | routes.ts:400 |

## 9. clis

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/clis` | — | `CliInfo[]`；启动时并行探测的内存缓存 | — | routes.ts:403 |
| `GET /api/clis/:id/models` | — | `ModelInfo[]`；CLI 未安装返回 `[]` | 404 id 不在四家适配器内 | routes.ts:407 |

## 10. sessions

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/sessions` | query：`workspace`（必填） | `Session[]`（created_at,id 升序），合并运行时字段 `queued_count` `waiting_slot`（来源：sessionManager 内存态，不入库） | 400 缺 workspace；404 工作空间不存在 | routes.ts:419 |
| `GET /api/sessions/:id` | — | `Session` + `queued_count` `waiting_slot` | 404 会话不存在 | routes.ts:431 |
| `GET /api/sessions/:id/queue` | — | `{ texts: string[] }`：当前内存排队文本副本（只读，无编辑接口） | 404 会话不存在 | routes.ts:439 |
| `GET /api/sessions/:id/messages` | query：`after?: 非负整数毫秒时间戳`（默认 0） | `Message[]`（ts 升序，ts>after） | 400 after 非法；404 会话不存在 | routes.ts:444 |
| `POST /api/sessions` | body：`cli: string 非空`、`model?: string\|null`、`issue_id?: string`、`workspace_id?: string`（**issue_id 为空时必填**）、`prompt?: string`、`reuse_session?: 'last'\|'new'`（'last' 复用该任务已绑定会话的 adapter_session_id）、`knowledge_enabled?: boolean`、`knowledge_query?: string 1-500`、`selected_attachment_ids?: UUID[]`（仅 issue-bound session 可用，最多 100 个）、`retry_unknown_images?: boolean`（实际投递前缀含 unknown 时必须为 true） | 绑 issue：派发（自动 claim + 起首轮）；按评论顺序把所选图片截断为最多 5 张、总计 ≤20 MiB 的前缀；其余图片保持待读并追加 `另有 N 张未附`，返回 `{ ...session, knowledge, remaining_attachment_count }`。图片输入能力未验证时不派发所选图片。自由会话返回 `Session`，不含剩余图片计数。WS：绑 issue 先 issue.changed，再 session.changed | 400 issue_id 为空未给 workspace_id 或图片ID未绑定 issue；400 未知 CLI、选择 ID 超过 100、`IMAGE_DELIVERY_IN_PROGRESS`、`IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED` 或 `IMAGE_DELIVERY_UNVERIFIED`；404 任务 / 工作空间 / 图片不存在；409 `ISSUE_CLAIMED` 已被占用（CLAIM-MSG，文案含占用者） | routes.ts:456 |
| `POST /api/sessions/:id/messages` | body：`text: string 非空` | `{ queued: boolean }`；false=空闲立即起轮（状态回运行中），true=入队待合并（运行时变化经 WS session.runtime）。两种情况均先落 user 消息（WS message.added） | 400 text 为空；404 会话不存在 | routes.ts:485 |
| `POST /api/sessions/:id/stop` | — | `Session`（status=已结束）；kill 当前轮，队列保留 | 404 会话不存在 | routes.ts:491 |
| `PATCH /api/sessions/:id` | body：`model: 非空 string\|null`（键必填；null 清空） | `Session`；仅改 model，下一轮起轮生效；WS session.changed | 400 缺 model 键或为空串；404 会话不存在 | routes.ts:496 |

### 知识页图片（KB-IMG-1，`services/knowledgeImages.ts`）

存储：`<db 目录>/attachments/knowledge/<pageId>/<attachmentId>.<ext>`（`storage_key` 只由服务端生成，不接受客户端文件名 → 防路径穿越）；表 `knowledge_attachment`。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/knowledge/pages/:id/images` | `multipart/form-data`：任意文件字段（须带 filename）+ 可选文本字段 `scope` / `workspace_id` / `original_bytes` | 201 `{ id, url, bytes, width, height, mime }`；`url` = `/api/knowledge/images/<id>` | 400 body 非 multipart / 缺 boundary / 无文件；**413 `IMAGE_TOO_LARGE`** 单张 >5 MiB；**415 `IMAGE_TYPE_UNSUPPORTED`** 非 png/jpeg/webp/gif（按文件签名判定）；**409 `IMAGE_LIMIT_EXCEEDED`** 每页 >20 张或合计 >50 MiB；404 `PAGE_NOT_FOUND`；403 `KNOWLEDGE_SCOPE_FORBIDDEN` | knowledgeRoutes.ts |
| `GET /api/knowledge/images/:attachmentId` | query：`scope`、`workspace_id`（workspace 页必填） | 图片原始字节，`Cache-Control: private, max-age=31536000, immutable` | 404 `IMAGE_NOT_FOUND`；403 跨工作区 | knowledgeRoutes.ts |
| `DELETE /api/knowledge/images/:attachmentId` | query 同上 | 204；**不改写 `body_md`**（正文引用留给作者处理） | 404 `IMAGE_NOT_FOUND`；403 跨工作区 | knowledgeRoutes.ts |

可见性：`scope=common` 的知识页图片对**任意**工作区可读；`scope=workspace` 的图片只对同工作区可读，跨区 → 403。
回收：知识页执行 `action=delete`（软删）时同事务删掉该页 `knowledge_attachment` 行并移除图片目录；工作区级硬删由 FK `ON DELETE CASCADE` 兜底；服务启动后还会做一次孤儿文件扫描（无行引用的文件被删除）。

## 11. knowledge（`/api/knowledge`，routes.ts:188 挂载）

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/knowledge/search` | query：`scope: common\|workspace\|both`、`q: string`（trim 后非空、≤500 字符）、`workspace_id?`（scope=common 时禁止提供，其余必填）、`limit? 1-20`（默认 5）；strict（未知 query 键 400） | `KnowledgeSearchResult[]`（page_id/scope/workspace_id/revision/title/snippet(≤1200 字符)/sources/evidence/score）；仅 status=active 且未过期页；≥3 字符走 FTS bm25，1-2 字符走 LIKE 子串 | 400 校验失败（q 为空/超长、scope 与 workspace_id 不一致，`knowledgeSearch.ts:16-19`） | knowledgeRoutes.ts:25 |
| `GET /api/knowledge/pages` | query：`scope`、`workspace_id?`、`status? active\|archived\|deleted\|all`（默认 active）、`include_expired? true\|false`（默认 false）、`offset?`、`limit? 1-100`（默认 20）；strict（未知 query 键 400） | `PageResult<摘要行>`（updated_at DESC,id；摘要行不含正文） | 400 scope=both 缺 workspace_id 等 | knowledgeRoutes.ts:29 |
| `GET /api/knowledge/pages/:id/revisions` | query：`scope`（workspace\|common）、`workspace_id?`、`limit? 1-50`（默认 20）、`offset?` | `{ items: KnowledgeRevision[], next_offset }`（revision 降序；next_offset 在本页满 limit 时为 offset+limit，不预读下一页——以实现为准 `knowledgeRoutes.ts:45`） | 404 `KNOWLEDGE_NOT_FOUND`；400 分页参数 | knowledgeRoutes.ts:41 |
| `GET /api/knowledge/pages/:id` | query：`scope`、`workspace_id?` | `KnowledgePage` 全量 | 404 `KNOWLEDGE_NOT_FOUND` | knowledgeRoutes.ts:47 |
| `POST /api/knowledge/pages`（幂等） | body：`scope`、`workspace_id?`、`slug: string`（1-200，`/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/`，禁 `..`）、`title`（1-300）、`body_md`（1-100000）、`sources: 1-100`、`evidence: 1-100`、`actor`（1-100）、`change_note?`（≤2000）、`expires_at?: number\|null` | `KnowledgePage`（status=active、revision=1）。sources/evidence 规则：来源 id 唯一、证据须引用本版本来源、非 file 来源必须带 snapshot 摘录（≤2 KiB）、file 来源只存路径与 sha256 | 400 校验 / slug 非法 / 工作空间不存在；409 `KNOWLEDGE_EXISTS` 范围内 slug 重复 | knowledgeRoutes.ts:52 |
| `PUT /api/knowledge/pages/:id`（幂等） | body：`scope`、`workspace_id?`、`expected_revision: int ≥1`、`title? body_md? sources? evidence? expires_at?`（至少一个）、`actor`、`change_note?` | `KnowledgePage`（revision+1） | 400 校验（含合并后内容规则复验）；404 `KNOWLEDGE_NOT_FOUND`；409 `KNOWLEDGE_REVISION_CONFLICT`（details `current_revision`）；409 `KNOWLEDGE_STATE_CONFLICT` 页已 deleted（archived 页可修订，`knowledge.ts:56`） | knowledgeRoutes.ts:58 |
| `POST /api/knowledge/pages/:id/actions`（幂等） | body：`scope`、`workspace_id?`、`action: archive\|restore\|delete`、`expected_revision: int ≥1`、`actor` | `KnowledgePage` | 400 未知操作；404 `KNOWLEDGE_NOT_FOUND`；409 `KNOWLEDGE_REVISION_CONFLICT` / `KNOWLEDGE_STATE_CONFLICT`（前置：archive←active、restore←archived、delete←active\|archived；deleted 页拒绝一切操作，`knowledge.ts:56`） | knowledgeRoutes.ts:62 |

### 11.1 CLI 对应命令（`kb knowledge *`，`packages/cli/src/commands/knowledge.ts`）

| 端点 | CLI | 必填 | 备注 |
| --- | --- | --- | --- |
| `GET /api/knowledge/search` | `kb knowledge search <query>` | `<query>` | `--scope both` 默认；`--limit` 1-20 |
| `GET /api/knowledge/pages` | `kb knowledge list` | `--scope` | 非 `--json` 每页一行，有下一页时打印 `下一页：--offset <n>` |
| `GET /api/knowledge/pages/:id` | `kb knowledge show <page-id>` | `--scope` | `--history` 追加版本历史 |
| `POST /api/knowledge/pages` | `kb knowledge create` | `--scope`、`--title`、`--slug`、`--stdin`、`--sources`/`--sources-file`、`--evidence`/`--evidence-file` | 缺项一次列全；字段级中文报错 |
| `PUT /api/knowledge/pages/:id` | `kb knowledge revise <page-id>` | `--scope`、`--expected-revision`、至少一个改动字段 | revision 冲突退出码 2 |
| `POST /api/knowledge/pages/:id/actions` | `kb knowledge action <page-id> <action>` | `--scope`、`--expected-revision` | `action` ∈ `archive\|restore\|delete` |

create 最小用法（PowerShell 复制可用；`sources.json`/`evidence.json` 见 `kb knowledge create --help`）：

```powershell
Get-Content body.md -Raw | kb knowledge create --scope common --title '缓存策略' --slug cache-policy --stdin --sources-file sources.json --evidence-file evidence.json
kb knowledge show <page-id> --scope common
Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 1 --stdin --title '缓存策略 v2'
kb knowledge action <page-id> archive --scope common --expected-revision 2
```

`--sources[].content_hash` 取文件 sha256：`(Get-FileHash README.md -Algorithm SHA256).Hash.ToLower()`；`captured_at` 取 `[DateTimeOffset]::Now.ToUnixTimeMilliseconds()`。

### 11.2 CLI 退出码表（`kb --help` 末尾同源，`index.ts` `EXIT_CODE_HELP`）

| 码 | 含义 | 典型命令与实测 |
| --- | --- | --- |
| 0 | 成功（`--help` / `--version` 同样 0） | `kb --version` / `kb done …` |
| 1 | 参数或用法错误、服务端非冲突错误（400/404/500）、服务看板不可达；命令未改动数据 | `kb done <不存在 id>` → `任务不存在`；`kb delete-issue <id>` 缺 `--yes` → 只回显标题/状态、不发 DELETE；`kb delete-space <空间>` 缺 `--yes` → 只回显名称/路径；`kb nope` → `unknown command` |
| 2 | 冲突，命令未改动数据：占用（`已被 <agent> 占用`）/ `未被占用` / 非当前占用者 / 状态不可领取 / 知识页 revision 冲突 / 幂等键复用 / 删除被阻塞（占用中、含子任务、仍有知识页或运行中会话） | `kb claim <已被占>`、`kb claim <待验收>`、`kb done <未占用>`、`kb delete-space <有知识页> --yes` |
| 3 | `kb dep` 专用：依赖参数错误（自环 / 跨工作区 / `VALIDATION_ERROR`） | `kb dep add <id> <同一 id>` → `不能依赖自身…` |
| 4 | `kb dep` 专用：任务或依赖不存在 | `kb dep add <id> <不存在 id>` → `任务或依赖不存在` |

约定：原因一律单行写 stderr；`--json` 只改 stdout 结构，不改退出码。`done` 的「占用 2」与「参数 2」都以 2 上报，区别在文案（`未被占用：如需推进请先 kb claim…` vs 参数错误列表），脚本只按 2 判「当前不可完成」即可。

## 12. WebSocket 事件（`/ws`，`packages/shared/src/types.ts:73-82`）

单行 JSON 广播给全部 OPEN 客户端；连接时不推快照，初始态经 REST 拉取（`hub.ts:20`）。

| type | 载荷 | 触发时机 |
| --- | --- | --- |
| `issue.changed` | `{ issue: Issue }` | 任务创建、PATCH、claim、done/fail/release、派发占用后 |
| `issue.deleted` | `{ issue_id, workspace_id }` | DELETE /api/issues/:id |
| `comment.added` | `{ comment: IssueComment }` | 任意新评论落库（手动评论、done notes、fail reason、release 评论、重启恢复 system 评论）；同一事务内先于 issue.changed |
| `session.changed` | `{ session: Session }`（不含 queued_count/waiting_slot） | 会话创建、状态/adapter_session_id/model 变更、停止、重启恢复置 失败（`sessionManager.ts:294`） |
| `session.deleted` | `{ session_id }` | 任务删除级联清理会话 |
| `session.event` | `{ session_id, event: { type: 'text'\|'thinking'\|'tool'\|'error'\|'end', ... } }` | 轮次执行事件实时流（text/thinking 为 delta） |
| `session.runtime` | `{ session_id, queued_count, waiting_slot }` | 排队消息数或等槽位标志变化时 |
| `message.added` | `{ message: Message }` | 每条消息落库（user/assistant/event/error） |
| `clis.changed` | `{ clis: CliInfo[] }` | 服务启动探测完成后一次（`index.ts:67`）；运行期无刷新端点 |
| `account.notice` | `{ app_id, client_instance_id, message }` | 账号切换 safe-exit 降级：UIA 托盘退出失败后提示用户手动退出 WorkBuddy（ACC-05，`accountRoutes.ts` → provider broadcast）；前端仅提示不失效查询 |

## 13. 枚举汇总

| 枚举 | 取值 |
| --- | --- |
| IssueStatus | `待规划 \| 进行中 \| 待验收 \| 已关闭`（types.ts:1） |
| Priority | `低 \| 中 \| 高`（types.ts:2） |
| SessionStatus | `运行中 \| 已结束 \| 失败`（types.ts:3） |
| ModelInfo.source | `probed \| static \| manual`（types.ts:72） |
| Message.role | `user \| assistant \| event \| error`（types.ts:66） |
| CLI id（CliInfo.id / sessions.cli） | `codebuddy \| codex \| opencode \| dsh`（adapters/src/index.ts:14） |

状态流转：issue 由 claim（→进行中）/done（→待验收）/fail、release（→待规划）驱动；PATCH 可直接改 status，但占用中禁改。session 由轮次生命周期驱动：运行中 →（正常/停止）已结束、（异常退出/起轮失败）失败。

## 14. accounts（`/api/managed-accounts`、`/api/account-operations`，accountRoutes.ts，ACC-05）

WorkBuddy Desktop 账号捕获/切换。设计见 `Docs/design-2026-11-01-workbuddy-accounts.md` §6/§8 与 `Docs/DESIGNS.md`「账号 provider：WorkBuddy Desktop」。响应只含脱敏元数据（无 identity_hash、快照引用、信封或凭据字节）；同一 client_instance_id 的操作经 operationRunner 串行并独占锁；实例存在 recovery_required 操作时写类请求一律 409 `RECOVERY_REQUIRED`（先走 restore 解冻）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/managed-accounts` | query：`app?`（workbuddy_desktop / codebuddy_desktop） | `Array<PublicManagedAccount & { is_current: boolean\|null }>`（created_at,id 升序；is_current 按 provider 只读身份比对，provider 未装配时 null） | 400 app 非法 | accountRoutes.ts |
| `POST /api/managed-accounts/:app/capture-current` | body：`display_name?`（1-100） | `{ account: PublicManagedAccount }`；同步执行（preflight→快照 DPAPI 加密→复读身份） | 409 `PROVIDER_UNVERIFIED`（codebuddy_desktop，details.reason_code=TARGET_KIND_UNCONFIRMED） / 409 `CLIENT_INSTANCE_NOT_FOUND` `CLIENT_VERSION_UNSUPPORTED`（非 5.9.3.x）`CLIENT_SCHEMA_UNSUPPORTED`（v1 明文）`CLIENT_NOT_RUNNING` `IDENTITY_UNAVAILABLE`（缺 uid）`IDENTITY_CHANGED` `ACCOUNT_EXISTS`；409 `RECOVERY_REQUIRED` 实例冻结；503 `PROVIDER_UNAVAILABLE` / `VAULT_*` | accountRoutes.ts |
| `POST /api/managed-accounts/:id/switch` | — | 202 `{ operation_id, operation: AccountOperation }`；执行异步，阶段 preflight→stop→snapshot→validate_target→write→start→verify→(rollback)，结果轮询下一行 | 404 `NOT_FOUND` 账号不存在；409 `PROVIDER_UNVERIFIED` / `RECOVERY_REQUIRED`；切换失败码见下 | accountRoutes.ts |
| `GET /api/account-operations/:id` | — | `AccountOperation`（state/stage/safe_error_code，无敏感字段） | 404 `OPERATION_NOT_FOUND` | accountRoutes.ts |

切换终态：`succeeded`；`failed`+`safe_error_code`=`EXIT_NOT_CONFIRMED`（未确认完全退出，未写任何数据）/ `TARGET_INSTANCE_MISMATCH` `TARGET_IDENTITY_MISMATCH` `SNAPSHOT_VERSION_MISMATCH` `TARGET_SNAPSHOT_INVALID` `SNAPSHOT_MISSING`（validate 拒绝，未写）/ `SWITCH_ROLLED_BACK`（写后失败已回滚并核验原账号）/ `VAULT_READ_FAILED`；`recovery_required`（写后失败且回滚未能核验恢复——实例冻结，同实例后续 capture/switch 409）。safe-exit 降级：UIA 托盘退出失败时广播 WS `account.notice` 请求用户手动退出并轮询退出签名（进程清零 + window-state mtime ≥ auth 写盘）；绝不强杀进程。


## 14b. 额度与余额（`GET /api/managed-account-quotas`，accountRoutes.ts，ACC-QUOTA-01）

账号页三来源额度/余额聚合：**逐来源独立结果**（单来源失败不影响其它来源），服务端 60s 缓存 + 失败指数退避（60s 起，上限 10min），同来源并发只打一次第三方。取证结论（2026-11-03）：DeepSeek 走官方余额端点；OpenCode Go 走**本地 opencode 服务**的 usage 路由（ACC-QUOTA-02）；Codex 无公开窗口端点，固定 `unsupported`（不编造数据）。响应不含 token / identity_hash / 本机路径。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/managed-account-quotas` | query：`workspace_id?`（uuid；额度不按工作区切分，仅回显） | `{ items: QuotaResult[], fetched_at: number, workspace_id: string\|null }` | 400 `VALIDATION_ERROR`（workspace_id 非 uuid） | `services/quotas/quotaService.ts` |

`QuotaResult = { source: 'deepseek'\|'opencode_go'\|'codex', status: 'ok'\|'unsupported'\|'error', balance: number\|null, unit: 'CNY'\|'USD'\|null, windows: Array<{ name: string, remaining: number, reset_at: number\|null }>, fetched_at: number, reason_code: string\|null, detail: string\|null }`

- **deepseek**：`GET https://api.deepseek.com/user/balance`（Bearer）。key 走**多候选 + 逐个试**（ACC-QUOTA-03），按优先级：①`DEEPSEEK_API_KEY`（env）②`~/.deepseek/config.toml` 的 `api_key` ③`~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（**最低优先级的兼容来源**，DSH 私有格式、非官方约定，解析失败静默跳过）；依次打端点用第一个 200 的，命中来源在缓存生命周期内优先复用。`ok` 时给 `balance`/`unit`（优先 CNY）；无任何候选 → `unsupported` `CREDENTIAL_MISSING`；有候选但全部 401/403 → `error` `CREDENTIAL_INVALID`（`detail` 含「尝试过 N 个凭据来源」）；429 → `RATE_LIMITED`；5xx → `UPSTREAM_ERROR`；网络/超时 → `NETWORK_ERROR`；结构不符 → `UPSTREAM_SHAPE_UNEXPECTED`。
- **opencode_go**：走本地 opencode 服务 `GET {url}/api/experimental/usage/limits`（Basic `opencode:<~/.config/opencode/service.json password>`）。响应 `data.go.{rolling,weekly,monthly}={percent,limited,resetsAt}` → 三窗口（`5h`/`weekly`/`monthly`），`remaining = 100 - percent`、`used_percent = percent`、`reset_at = resetsAt`，`unit = '%'`、`detail` 给工作区名或限额提示。服务发现：`OPENCODE_SERVER_URL` 优先，否则 `netstat -ano` LISTENING 端口 ∩ `tasklist` 中名字含 `opencode` 的 PID（Windows）。不可用码：`OPENCODE_NOT_LOGGED_IN`（无 auth.json）/ `OPENCODE_AUTH_UNAVAILABLE`（无 service.json 口令）/ `OPENCODE_SERVER_NOT_RUNNING`（未发现本地服务）/ `OPENCODE_AUTH_FAILED`（401/403）/ `OPENCODE_ROUTE_UNSUPPORTED`（404）。
- **codex**（ACC-CODEX-QUOTA-IMPL）：只读**本机 rollout 快照**（零网络、零凭据）——扫描 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` 取 mtime 最新一份，读 `event_msg → payload.rate_limits`：`primary{used_percent, window_minutes:300, resets_at}` → `5h`、`secondary{window_minutes:10080}` → `weekly`（**只映射这两种窗口，Monthly 不展示**）；`resets_at` 为秒级 epoch（×1000 转毫秒）；`credits.balance` → `balance`/`unit=USD`，余额为 0 时 `detail="额度内"`（避免误读成欠费）。不可用码：`NO_CODEX_SESSIONS`（无 `~/.codex/sessions` 或无 rollout 文件）/ `NO_CODEX_RATE_LIMITS`（最新会话里没有 `rate_limits` 或窗口不可用）。不读 token 原文、不写 `.codex`、不请求 ChatGPT 后端（`/backend-api/codex/usage` 需浏览器 UA 才 200，本卡不启用，见 `Docs/research-2026-11-03-codex-quota.md`）。
- `windows[].reset_at` 为该窗口重置时刻（epoch ms），前端展示为本地 `HH:mm` + 剩余时长；无窗口概念时 `windows = []`。
## 15. system（`/api/system`，systemRoutes.ts，SYSTEM-RESTART）

服务自重启，供设置页「重启服务器」按钮调用。**无鉴权**，因此只允许本机回环地址触发（`req.ip` ∈ `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，本项目无反向代理，不读 `X-Forwarded-For`）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/system/restart` | 无 body | `202 { restarting: true, old_pid, new_pid, log_path, started_at }`；新进程 stdout/stderr 重定向到 `log_path`；**先回 202**，再延迟约 200ms 关闭监听，轮询 `/api/version`（≤15s，须由 `new_pid` 应答）确认接管后才退出旧进程；不健康则重新监听并继续服务（前端据 `pid !== new_pid` 显示「已回退」） | 403 `RESTART_FORBIDDEN`（非回环）；409 `RESTART_PORT_CONFLICT`（目标端口被其它进程/另一个看板实例占用——未重启，旧进程继续服务，日志留「重启已拒绝」一行）；500 `RESTART_ENTRY_MISSING`（入口脚本不存在）/ `RESTART_SPAWN_FAILED`（新进程 spawn 失败——旧进程继续服务，监听未动）；503 `RESTART_UNAVAILABLE`（当前装配未启用重启，仅测试/非生产） | systemRoutes.ts |

顺序：回环校验 → 入口存在性 → `spawn`（`detached` / `stdio: ignore` / `unref`）并等 `'spawn'` 事件 → 回 202 → 200ms 后 `server.close()` 停监听 → `process.exit(0)`。新进程启动时对 `EADDRINUSE` 以 250ms 间隔重试最多 20 次（等旧进程让出端口）。

## CLI 标签规范（TAG-HYGIENE）

`kb create-issue -l` 的标签分隔规则：

- **逗号与空白都是分隔符**：`-l "调研 跨平台 文档"` 会拆成 `调研` / `跨平台` / `文档` 三个标签；`-l "web,server"` 与 `-l "web server"` 等价。
- **全角逗号 `，` 视同半角**；连续分隔符与首尾空白会被丢掉（`-l "  测试 ,,  测试  ,文档  "` → `测试` / `文档`）。
- **重复标签自动去重**（保留首次出现顺序）。
- **标签本身不含空格**：这是硬约定。历史上把多个词塞进一个 label（如 `调研 跨平台 文档`）会被当作带空格的单个标签，是标签体系脏掉的主因；现在一律拆分。若要表达短语概念，请用有检索价值的领域词（`跨平台`、`文档`），不要拼多词短语。
- 标签规范（写入侧）：**≤4 个**、用领域词（`web` / `server` / `cli` / `知识库` / `账号管理` / `依赖` / `技能` / `测试` / `文档` / `调研` / `跨平台`）、**不写日期**（时间信息用 `due_date`/`created_at`）、**不写「父卡」**（层级用 `parent_issue_id`）、**不加空格**。

### 服务端 labels 规范化（TAG-CLEANUP-EXEC）

`POST /api/issues` 与 `PATCH /api/issues/:id` 的 `labels` 在**请求边界**统一走 `apps/server/src/services/labelNormalize.ts`：

- 与 CLI `parseLabels`（`packages/cli/src/commands/createIssue.ts`）同一套规则：按 `[,，\s]+` 拆分、trim、丢空、去重（保留首次出现顺序）。
- 直接 `PATCH {"labels":["功能  web，UI"]}` 会落库为 `["功能","web","UI"]`；`{"labels":[]}` 清空标签。
- 规则单一来源：服务端实现文件顶注释指向 CLI 实现，改动需两处同步（本卡已收口「非 CLI 写入路径能落进带空格标签」的缺口）。
