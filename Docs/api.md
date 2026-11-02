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
| Issue | `id, workspace_id, title, description, priority, labels: string[], status, sort_order: int, claimed_by: string\|null, claimed_at: number\|null, session_id: string\|null, comment_count: int, created_at, updated_at`；`comment_count` 查询时由 issue_comment 计数，非落库列 |
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
| `DELETE /api/workspaces/:id` | — | 204；级联删除该空间 issue/comment/session/message/附件元数据，提交后回收附件文件 | 404 工作空间不存在；409 `CONFLICT` 仍存在知识页（禁删） | routes.ts |

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
| `GET /api/version` | — | `{ name: 'agentboard-server', version: string }`；version 取 `apps/server/package.json`（`version.ts`）；web 顶栏与设置弹窗经 `apps/web/src/api/version.ts` 展示 | — | routes.ts:239 |
| `POST /api/system/pick-folder` | — | `{ path: string\|null }`；null=用户取消；Windows 原生 FolderBrowserDialog（powershell.exe），同一时刻仅允许一个窗口 | 409 `PICK_FOLDER_BUSY` 已有选择窗口打开；500 `PICK_FOLDER_FAILED` 打开窗口失败 | routes.ts:228 |

## 5. settings

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/settings` | — | `{ port, dbPath, maxConcurrentTurns, attachmentQuotaBytes, attachmentStagedTtlMs, attachmentCleanupIntervalMs }`（仅 config.json 持久化值） | — | routes.ts |
| `PATCH /api/settings` | body：`port?: int 1-65535`、`dbPath?: string 非空`、`maxConcurrentTurns?: int ≥1`、附件数值设置均为安全正整数（至少一个；未知键忽略） | 新的持久化 settings；并发和附件设置即时生效 | 400 未提供字段 / 取值非法 | routes.ts |

## 6. issues

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues` | query：`workspace`（必填）、`status?`（枚举，仅分页模式生效）、`limit? offset?` | `Issue[]`（sort_order,created_at,id 升序）；分页模式 `PageResult<TaskPreview>`（id 升序；description 截取默认 12000 字符并附 `description_truncated` `next_description_offset_chars`） | 400 缺 workspace / 分页或 status 非法；404 工作空间不存在 | routes.ts:258 |
| `POST /api/issues`（幂等） | body：`workspace_id: string`、`title: string 非空`、`description?: string`、`priority?: '低'\|'中'\|'高'`（缺省 中）、`labels?: string[]`（缺省 []） | `Issue`（status=待规划、sort_order=0）；WS issue.changed | 400 校验失败；404 工作空间不存在 | routes.ts:268 |
| `GET /api/issues/:id` | query：`description_offset_chars?` `description_max_chars?` | `Issue`；带窗口参数时 description 为窗口内容并附 `description_truncated` `next_description_offset_chars` | 404 任务不存在（归属不匹配同为 404） | routes.ts:276 |
| `PATCH /api/issues/:id`（幂等） | body：`title? description? priority? labels? status? sort_order?: int`（至少一个）；`workspace_id?`；`expected_updated_at?: int ≥0`（CAS，须同时提供 workspace_id） | `Issue`（`updated_at` 单调递增：`MAX(now, 旧值+1)`，`issue.ts:145` + `schema.ts:42` 触发器，CAS 调用方依赖）；WS issue.changed | 400 未提供更新字段 / CAS 缺 workspace_id / 参数非法；404 任务不存在；409 `CONFLICT` 占用中禁改 status；409 `TASK_REVISION_CONFLICT` CAS 过期（details `current_updated_at`） | routes.ts:284 |
| `DELETE /api/issues/:id` | — | 204；先停各绑定会话在途轮次，再同事务级联删除消息+会话+任务；WS issue.deleted + 每会话 session.deleted | 404 任务不存在；409 `CONFLICT` 占用中禁止删除；含子任务时 409 `CONFLICT`（子任务先处理） | routes.ts:447；CLI `kb delete-issue <id> --yes`（缺 `--yes` 只打印标题/状态、非 0 退出、不发请求）；MCP `agentboard_delete_task` |

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
| `POST /api/issues/:id/claim` | body：`agent_id: string 非空`、`knowledge_enabled?: boolean`（默认 true）、`knowledge_query?: string 1-500` | `{ ...issue, knowledge }`。原子占用（status→进行中、session_id=null 纯登记不建会话；仅未占用且 status∈{待规划,进行中} 可领取），并发领取仅一个成功；留言游标置为领取前最新评论；存在未验证图片时停在首条图片评论之前 | 400 agent_id 为空；409 `CONFLICT` 已被占用或 status∉{待规划,进行中}；404 `TASK_NOT_FOUND`（带 workspace_id 且任务缺失/不归属） | routes.ts |
| `POST /api/issues/:id/release` | 不带 workspace_id：无需 body（用户强制释放）；带 workspace_id：body `agent_id: string 非空` | `{ ...issue, comment }`。状态→待规划、清空占用。不带 workspace_id：comment author=`system` 内容「用户强制释放」、任何状态可释放；带 workspace_id：comment author=`agent:<agent_id>` 内容「占用者释放任务」 | 不带 workspace_id：404 任务不存在。带 workspace_id：404 `TASK_NOT_FOUND`；409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id | routes.ts:398 |
| `POST /api/issues/:id/done` | body：`agent_id: string 非空`、`notes?: string`（空串等价不写评论） | `{ ...issue, comment }`。状态→待验收、清空占用；notes 非空时落评论（author=`agent:<agent_id>`），否则 comment=null | 400 agent_id 为空。不带 workspace_id：404 任务不存在、409 `CONFLICT` 未被占用、409 `NOT_TASK_OWNER` 仅当 agent_id≠'user' 且≠占用者。带 workspace_id：404 `TASK_NOT_FOUND`、409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id（'user' 不豁免） | routes.ts:399 |
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
| `POST /api/sessions` | body：`cli: string 非空`、`model?: string\|null`、`issue_id?: string`、`workspace_id?: string`（**issue_id 为空时必填**）、`prompt?: string`、`reuse_session?: 'last'\|'new'`（'last' 复用该任务已绑定会话的 adapter_session_id）、`knowledge_enabled?: boolean`、`knowledge_query?: string 1-500`、`selected_attachment_ids?: UUID[]`（仅 issue-bound session 可用，最多 100 个）、`retry_unknown_images?: boolean`（实际投递前缀含 unknown 时必须为 true） | 绑 issue：派发（自动 claim + 起首轮）；按评论顺序把所选图片截断为最多 5 张、总计 ≤20 MiB 的前缀；其余图片保持待读并追加 `另有 N 张未附`，返回 `{ ...session, knowledge, remaining_attachment_count }`。图片输入能力未验证时不派发所选图片。自由会话返回 `Session`，不含剩余图片计数。WS：绑 issue 先 issue.changed，再 session.changed | 400 issue_id 为空未给 workspace_id 或图片ID未绑定 issue；400 未知 CLI、选择 ID 超过 100、`IMAGE_DELIVERY_IN_PROGRESS`、`IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED` 或 `IMAGE_DELIVERY_UNVERIFIED`；404 任务 / 工作空间 / 图片不存在；409 `CONFLICT` 已被占用 | routes.ts:456 |
| `POST /api/sessions/:id/messages` | body：`text: string 非空` | `{ queued: boolean }`；false=空闲立即起轮（状态回运行中），true=入队待合并（运行时变化经 WS session.runtime）。两种情况均先落 user 消息（WS message.added） | 400 text 为空；404 会话不存在 | routes.ts:485 |
| `POST /api/sessions/:id/stop` | — | `Session`（status=已结束）；kill 当前轮，队列保留 | 404 会话不存在 | routes.ts:491 |
| `PATCH /api/sessions/:id` | body：`model: 非空 string\|null`（键必填；null 清空） | `Session`；仅改 model，下一轮起轮生效；WS session.changed | 400 缺 model 键或为空串；404 会话不存在 | routes.ts:496 |

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


## 15. system（`/api/system`，systemRoutes.ts，SYSTEM-RESTART）

服务自重启，供设置页「重启服务器」按钮调用。**无鉴权**，因此只允许本机回环地址触发（`req.ip` ∈ `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，本项目无反向代理，不读 `X-Forwarded-For`）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/system/restart` | 无 body | `202 { restarting: true, pid, started_at }`；**先回 202**，再延迟约 200ms 关闭监听并退出旧进程 | 403 `RESTART_FORBIDDEN`（非回环）；500 `RESTART_ENTRY_MISSING`（入口脚本不存在）/ `RESTART_SPAWN_FAILED`（新进程 spawn 失败——旧进程继续服务，监听未动）；503 `RESTART_UNAVAILABLE`（当前装配未启用重启，仅测试/非生产） | systemRoutes.ts |

顺序：回环校验 → 入口存在性 → `spawn`（`detached` / `stdio: ignore` / `unref`）并等 `'spawn'` 事件 → 回 202 → 200ms 后 `server.close()` 停监听 → `process.exit(0)`。新进程启动时对 `EADDRINUSE` 以 250ms 间隔重试最多 20 次（等旧进程让出端口）。
