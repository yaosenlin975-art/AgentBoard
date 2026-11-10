# AgentBoard HTTP API 参考

本文件是 REST + WebSocket 接口的完整参考，以 `apps/server/src/api/routes.ts`（及其中挂载的 `knowledgeRoutes.ts`、`accountRoutes.ts`）当前实现为准；表内 `routes.ts:n` / `knowledgeRoutes.ts:n` 为行号锚点。设计概要见 `Docs/设计文档.md` §6.1。

## 0b. 静态资源缓存口径（CHUNK-CACHE）

- `/assets/<带 hash 的构建产物>`：`Cache-Control: public, max-age=31536000, immutable`（内容寻址，重建后文件名变）；保留 `ETag`。
- `/assets/*` 未命中：**真 404 + `Content-Type: text/plain`**，响应体 `Asset not found`，**不会被 SPA fallback 兜成 index.html**（否则浏览器把 HTML 当 JS 解析，报错形态误导）。
- `/`、`/index.html` 及其它非 hash 静态资源与 SPA 路由：`Cache-Control: no-cache`（允许 304），避免旧页面长期引用已被重建替换的旧 chunk。
## 1. 服务与配置

- 启动命令、后台常驻：见 `README.md`「启动」节。
- 监听地址：仅 `127.0.0.1:<port>`（`index.ts:122`），REST 前缀 `/api`，WebSocket 路径 `/ws`。
- 默认：端口 8787，并发上限 3，图片配额 1 GiB、暂存 TTL 24h、清理周期 1h，DB `%APPDATA%\AgentBoard\agentboard.db`（`config.ts`）。
- 端口误判：DSH 桌面端插件经 DSH web server 暴露独立数据源，对其请求返回 401 时见 `README.md`「与 DSH 任务看板插件的边界」。
- 配置文件 `%APPDATA%\AgentBoard\config.json`（非 Windows 回退 `~/.config/AgentBoard/`），字段 `port` / `dbPath` / `maxConcurrentTurns` / `attachmentQuotaBytes` / `attachmentStagedTtlMs` / `attachmentCleanupIntervalMs`；首次启动写回默认值，文件损坏按默认处理且不覆盖原文件（`config.ts`）。
- 环境变量 `AGENTBOARD_PORT`（正整数）、`AGENTBOARD_DB`（非空路径）：仅启动期覆盖，不写回 config.json；`GET /api/settings` 不回显 env 覆盖值（`config.ts:88-95, 98-105`）。
- 环境变量 `AGENTBOARD_WORKBUDDY_REGION`（`cn` / `global`，缺省 `cn`；非法值启动即报错）：决定 WorkBuddy 签到与额度请求的计费域，同样仅启动期生效、不写回 config.json、`/api/settings` 不回显（`config.ts`、`services/accounts/platformHosts.ts`）。CN = `https://www.codebuddy.cn`（有业务成功证据），Global = `https://www.workbuddy.cn`（区域备用线路）；`unknown` 区域在装配期直接抛 `CHECKIN_REGION_UNSUPPORTED`，不回落默认域。
- `PATCH /api/settings` 写回 config.json：`maxConcurrentTurns` 与附件设置即时生效，`port` / `dbPath` 重启生效（`routes.ts`）。

### 派发 prompt 模板（ARCH-05，`services/dispatchTemplate.ts`）

- 模板文件：数据目录（`configDir()`；Windows 默认 `%APPDATA%\AgentBoard`，非 Windows `~/.config/AgentBoard`）下的 `dispatch-prompt.md`，UTF-8 无 BOM（带 BOM 读取时剥掉）。
- env 覆盖：`AGENTBOARD_DISPATCH_PROMPT=<路径>`，优先于数据目录默认文件；仅启动期生效，不写回 config.json。
- 生效规则：**文件不存在 → 内置默认模板**（逐字等于 `DISPATCH_PROMPT_TEMPLATE`，派发行为与改造前一致）；**文件存在但缺任一必需占位符或不可读 → 拒绝启动**（启动日志/stderr 点名缺失占位符与文件路径，退出码 1），不静默回退默认值。env 指向的文件不存在时回落内置默认，并在启动日志记录 warning。
- 运行期：启动时解析并校验一次并缓存，派发请求不重新读盘；改模板需重启服务。
- 合法占位符（渲染见 `services/dispatch.ts` 的 `renderPrompt`）：`{{issue_id}}`、`{{title}}`、`{{description}}`（空描述渲染为 `(空)`）、`{{workspace_path}}`、`{{workspace_id}}`。必需集合 = 以上全部（`REQUIRED_PLACEHOLDERS`）；新增变量须同步 `renderPrompt` 与本清单。
- 知识块：仍按 OPT-14 口径作为 prompt 的精确后缀追加（只列 `id` + `knowledge:<id>` + 标题 + `scope · revision`，不内联正文；模板已含 `## 知识参考` 时不重复追加）。
- `POST /api/sessions` 的 `body.prompt` 仍可整段替换本次派发的模板（占位符照常渲染）。
- 不做工作区级模板覆盖。

## 2. 通用约定

> CLI-UX（2026-11-03）：`400 VALIDATION_ERROR` 的 message 已中文化并附可用值（如 `priority: 取值必须是：低 / 中 / 高`）；`kb done` 支持 `--notes-stdin`，`kb list-tasks --full` 只对 `--json` 生效，`kb changelog` 时间按本地时区展示。
>
> ARCH-04：`kb done` 前置检查本卡（含父链）在 `issue:<uuid>` 来源/证据里关联的 `category=design` 知识页；若仍有 `landed=proposed`（非 pending/archived），报错退出 1 并列出页 id 与两个选项：`kb knowledge revise <页 id> --landed landed|partial`，或 `kb done ... --design-not-advanced`（声明写入 notes，跳过门禁）。


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
| Session | `id, workspace_id, issue_id: string\|null, cli, model: string\|null, status, adapter_session_id: string\|null, created_at`；列表派生字段 `preview: string`（首条 user 消息压缩空白后截断 ≤80 字，markdown 图片折叠为 `[图片]`，无消息为空串）、`source: 'dispatch'\|'chat'`（`issue_id` 非空为 dispatch，否则 chat）——仅 GET /api/sessions 返回（`messageSignals.ts`）；运行时合并字段 `queued_count?: int`（内存队列中待合并消息数）、`waiting_slot?: boolean`（当前轮在等全局并发槽位）——不入库，仅 GET /api/sessions 与 GET /api/sessions/:id 返回时由 sessionManager 内存态合并（`routes.ts:418-435`）；WS `session.changed` 不携带 |
| Message | `id, session_id, role: 'user'\|'assistant'\|'event'\|'error', content, ts`；AUDIT-SRV 追加字段：`error_code?: 'QUOTA_EXCEEDED'\|'RATE_LIMITED'\|'AUTH_FAILED'\|'CONTEXT_OVERFLOW'\|'UNKNOWN_ERROR'\|null`（error 消息的错误归类，非 error 为 null）、`retryable?: boolean`（该错误是否值得重试：额度/鉴权/上下文超限为 false，限流与未知为 true）、`encoding_lost?: boolean`（正文含 U+FFFD 或连续 `?...` → 「原始编码不可用」，读取时派生、不落库） |
| CliInfo | `id, displayName, installed: boolean, version: string\|null, supportsModelSelection: boolean` |
| ModelInfo | `id, source: 'probed'\|'static'\|'manual'` |
| TaskKnowledge | `enabled: boolean, query: string, warning?: 'KNOWLEDGE_UNAVAILABLE', items: Array<{ id, scope, workspace_id, revision, title, sources, evidence, snippet }>`（`taskKnowledge.ts:5`） |

## 3. workspaces

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/workspaces` | query：`limit? offset?` | `Workspace[]`（created_at,id 升序）；带分页参数时 `PageResult<Workspace>`（id 升序）。每项额外带**只读** `db_mode`（center/localizing/localized/failed）、`db_path`（实际生效库）、`snapshot_lag`（整数，快照落后条数；`null` = 未导出过快照或不可读），客户端不得据此改写走库决策 | 400 分页参数非法 | routes.ts |
| `POST /api/workspaces` | body：`name: string`（键必填，可空串）、`path: string`（非空，须为已存在目录） | `Workspace`；name 空串时取 path 去尾部 `/` `\` 后的最后一段 | 400 path 为空 / 路径不存在或不是目录；path 重复（`workspace.path` UNIQUE，`schema.ts:9`）未映射为业务错误 → 500 `INTERNAL`（以实现为准） | routes.ts:206 |
| `DELETE /api/workspaces/:id` | — | 204；级联删除该空间 issue/comment/session/message/附件元数据，提交后回收附件文件。**STORE-7**：已下沉（`db_mode=localized`）时不删库文件——`<ws>/.agentboard/agentboard.db`（含 -wal/-shm）与 `attachments/` 移入 `<中心库目录>/archive/<id>/`，中心库落 `workspace_archive` 记录（归档列表可见），归档目录经响应头 `X-Workspace-Archived`（URI 编码）回显 | 404 工作空间不存在；409 `CONFLICT`（body `{error:{code,message}}`，message 为可读原因：`该空间仍有 <n> 个知识页及 <m> 条历史 revision，请先删除或迁移知识页后再移除` / `该空间有 <n> 个运行中会话，请先结束会话后再移除` / `该空间有 <n> 个子任务仍挂在父任务下，请先解除关联后再移除`）；CLI 用 `kb delete-space <id\|名> --yes`（缺 `--yes` 只回显，退出码 1；被阻塞退出码 2） | routes.ts:415 |

### 评论图片附件

单图上限 10 MiB，单评论最多 5 张；允许纯图片评论。仅支持 PNG/JPEG/WebP，服务端核对 MIME 与文件签名。暂存默认 24 小时，私有存储配额默认 1 GiB。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/workspaces/:workspaceId/attachments` | raw bytes；`Content-Type: image/png\|image/jpeg\|image/webp`；可选 `X-File-Name`（仅保存清理后的文件名） | 201 `{ id, workspace_id, file_name, mime_type, size_bytes, status: 'staged', expires_at, download_url }`；响应不含存储键或路径 | 404 工作空间不存在；400 `ATTACHMENT_INVALID_IMAGE`；413 `ATTACHMENT_TOO_LARGE` / `ATTACHMENT_QUOTA_EXCEEDED` | routes.ts |
| `GET /api/workspaces/:workspaceId/attachments/:attachmentId` | — | staged 图片原始字节；仅同 Workspace 且暂存未过期时可读取 | 404 图片/工作空间不存在；410 `ATTACHMENT_EXPIRED` | routes.ts |
| `GET /api/issues/:id/attachments/:attachmentId` | — | attached 图片原始字节；附件必须关联此 Issue 的评论 | 404 任务或图片不存在 | routes.ts |

### 工作区库下沉（STORE-2a/3a，`/api/workspaces/:id/db*`，类型 `packages/shared/src/workspaceLocalize.ts`）

- jobId 模型：POST 立即 **202** 回任务创建时快照，`GET /api/workspaces/:id/db/localize/:jobId` 轮询到终态（快照 `status` 已非 `running` 时无需轮询）；localize / cleanup / revert 共用一张进程内存任务表（进程重启即失，旧 jobId → 404），每工作区同一时间只允许一个 running 任务（不分 kind）。
- 跨进程事实源：`<ws>/.agentboard/localize.json`（中间态，resume 落点）与工作区库 `<ws>/.agentboard/agentboard.db` 的 meta。
- POST 同步只返回 404（工作空间不存在）、400（body 非法，strict）、409 `MIGRATION_BUSY`（任务互斥）；预检拒绝与执行失败一律落在 job 终态 `status:'failed'` + `lastError`（标准文案，不带 code）。
- 紧急开关 `AGENTBOARD_WORKSPACE_DB=disabled`：已下沉工作区的请求回中心库（不打开工作区库、不自动搬回）；`GET .../db` 以 `disabled` + `needsRevert` + `reason` 暴露，需 revert 收口。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/workspaces/:id/db/localize` | body：`dryRun?: boolean`、`overwrite?: boolean`、`resume?: boolean`（strict）；`dryRun=true` 时忽略 `resume`，`resume=true` 时忽略 `overwrite` | 202 `WorkspaceLocalizeJobView`（`kind:'localize'`、`status:'running'`、`stage:'preflight'`；resume 的续跑落点以 `GET .../db` 的 `localizeState.stage` 为准）；真实迁移开跑即置中心 `db_mode=localizing`，该区写请求 409 `WORKSPACE_DB_MIGRATING` | 404；400；409 `MIGRATION_BUSY`；job failed 见下方错误码表 | routes.ts:648 |
| `GET /api/workspaces/:id/db/localize/:jobId` | — | 三类任务共用：`WorkspaceLocalizeJobView`（`kind` 缺省 = localize）或 `WorkspaceDbOpJobView`（`kind:'cleanup'\|'revert'`） | 404 `NOT_FOUND`（`迁移任务不存在`：jobId 不存在 / 不属于该区 / 进程已重启） | routes.ts:663 |
| `POST /api/workspaces/:id/db/localize/cleanup` | body 严格 `{}` | 202 `WorkspaceDbOpJobView`（`kind:'cleanup'`，同步执行，快照通常已是终态）；成功 `result:'cleaned'`、`stage:null`、`counts:{ center_rows_before, removed }`；只删工作区侧半成品（目标库及 `-wal`/`-shm`、附件目录、残留 `*.center-backup-*` 快照、localize.json），中心库数据不动；db_mode failed / localizing → center（写闸门释放） | 404；400；409 `MIGRATION_BUSY`；job failed：`WORKSPACE_DB_NOTHING_TO_CLEAN` / `WORKSPACE_DB_CLEANUP_NOT_ALLOWED` / `WORKSPACE_DB_CLEANUP_UNSAFE` | routes.ts:675 |
| `POST /api/workspaces/:id/db/localize/revert` | body 严格 `{}` | 202 `WorkspaceDbOpJobView`（`kind:'revert'`，`stage` 为当前阶段）；成功 `result:'reverted'`、`stage:'finalize'`、`counts` = 回迁到中心库的逐表行数（无 `rows_total`）、`backupPath` = `<ws>/.agentboard/backup/agentboard.db-reverted-<ts>`（工作区库移入处）；db_mode → center | 404；400；409 `MIGRATION_BUSY`；job failed（`stage` 置 null，中心库数据不变）：`WORKSPACE_DB_REVERT_NOT_LOCALIZED` / `WORKSPACE_DB_REVERT_CENTER_ROWS` / `WORKSPACE_DB_ID_MISMATCH` / `WORKSPACE_DB_UNREADABLE` / `CENTER_DB_UNHEALTHY` / `REVERT_ATTACHMENT_MISMATCH` / `REVERT_VERIFY_FAILED` | routes.ts:693 |
| `GET /api/workspaces/:id/db` | — | `WorkspaceDbStatusView`（只读汇总） | 404 工作空间不存在 | routes.ts:709 |

| 对象 | 字段 |
| --- | --- |
| WorkspaceLocalizeJobView | `jobId`（`loc-<8 位>`）、`workspaceId`、`kind?: 'localize'`、`dryRun`、`status: 'running'\|'done'\|'failed'\|'already_localized'`、`stage`（running = 当前阶段；done = `finalize`；failed = 失败所在阶段；already_localized / dry-run 完成 = null）、`counts: Record<string, number>`（dry-run 含 `rows_total` / `attachment_files` / `attachment_bytes` / `estimated_bytes`；真实迁移只有逐表键，copy 起逐步填充）、`lastError`、`result: 'localized'\|'already_localized'\|'dry_run'\|null`、`targetDbPath`、`backupPath`（中心库 VACUUM INTO 快照；dry-run / already_localized = null）、`startedAt`、`finishedAt` |
| WorkspaceDbOpJobView | `jobId`（`cleanup-<8 位>` / `revert-<8 位>`）、`workspaceId`、`kind: 'cleanup'\|'revert'`、`status: 'running'\|'done'\|'failed'`、`stage: string\|null`、`counts`、`lastError`、`result: 'cleaned'\|'reverted'\|null`、`backupPath`（cleanup = null）、`startedAt`、`finishedAt` |
| WorkspaceDbStatusView | `workspaceId`、`dbMode: 'center'\|'localizing'\|'localized'\|'failed'`、`writeGate: 'open'\|'frozen'`（frozen = 该区写请求 409 `WORKSPACE_DB_MIGRATING`）、`disabled`（紧急开关生效）、`needsRevert`（disabled 且 db_mode=localized）、`centerDbPath`、`workspaceDbPath: string\|null`（工作区 path 缺失 = null）、`workspaceDbExists`、`effectiveDbPath`（解析层判定后实际落库路径，含 disabled 语义）、`counts`（数据所在库逐表行数 + `rows_total`）、`attachments: { rows, files, bytes, dir }`、`snapshotLagRows: number\|null`（localized = 中心库该区残留行数，>0 时 revert 拒绝；localizing / failed = Σ max(0, 中心 − 工作区库)；工作区库不存在或打不开 = null）、`localizeState: { migrationId, stage, lastError, backupPath, startedAt }\|null`（localize.json）、`activeJob: { jobId, kind, status, stage }\|null`（本进程该区 running 任务）、`error: string\|null`（解析层错误码）、`reason`（解析层判定依据） |

| 任务 | 阶段顺序 | 续跑 / 失败语义 |
| --- | --- | --- |
| localize | `preflight → backup → create → copy → copy_attachments → verify → switch → finalize` | `resume` 落点 = localize.json 的 `stage`：preflight / backup 整段重跑；create ~ copy_attachments 删半成品后从 create 重建；verify 重跑校验 → switch → finalize；switch 幂等重跑；已提交（db_mode=localized）→ `already_localized` |
| revert | `preflight → copy_attachments_back → copy_back → finalize` | 预检通过后置 localizing 冻结该区写；copy_back 单事务（删中心残留 + 反向插行 + 逐表守恒 + db_mode=center）；之后的失败回滚并还原 localized |
| cleanup | 无（`stage` 恒 null） | — |

错误码（`状态` 为服务端 ApiError 口径；除 POST 同步的 `MIGRATION_BUSY` 外，客户端见到的是 job failed + `lastError` 标准文案）：

| code | 状态 | 场景 |
| --- | --- | --- |
| `MIGRATION_BUSY` | 409 | POST 同步：该区已有任务在跑（`本进程已有任务 <jobId>（<kind>）在跑`）；job 内：非 resume 且已有 localize.json 中间态（上次迁移未收尾，需 `overwrite=true` 或 `resume=true`） |
| `TARGET_DB_EXISTS` | 409 | 预检：目标库已存在（需 `overwrite=true`） |
| `ALREADY_LOCALIZED` | 409 | 预检：db_mode 已是 localized（工作区库完好时真实迁移先幂等返回 `already_localized`，不到此码） |
| `WORKSPACE_PATH_NOT_LOCAL` / `INSUFFICIENT_SPACE` / `WORKSPACE_BUSY` | 409 | 预检：工作区目录不在本机磁盘 / 剩余空间 < (数据 + 附件) × 1.2 或目标目录不可写 / 有运行中会话 |
| `CENTER_DB_UNHEALTHY` | 500 | 中心库 integrity_check 未通过（localize / revert 预检） |
| `NO_LOCALIZE_STATE` / `LOCALIZE_STATE_INVALID` | 409 | resume：localize.json 不存在 / 与工作区或中心库不一致、阶段非法（先 cleanup） |
| `WORKSPACE_DB_NOTHING_TO_CLEAN` | 409 | cleanup：db_mode=center 且无半成品 |
| `WORKSPACE_DB_CLEANUP_NOT_ALLOWED` / `WORKSPACE_DB_CLEANUP_UNSAFE` | 409 | cleanup：db_mode=localized（活库）/ 中心库无该区行且工作区库是唯一数据副本（先 revert） |
| `WORKSPACE_DB_REVERT_NOT_LOCALIZED` / `WORKSPACE_DB_REVERT_CENTER_ROWS` | 409 | revert：db_mode 不在 localized / failed、工作区库缺失或未完成迁移 / 中心库已有该区数据（分叉，核对 `snapshotLagRows`） |
| `WORKSPACE_DB_ID_MISMATCH` | 409 | 工作区库 meta 的 workspace_id 与目录绑定不一致（revert 拒绝；解析层拒绝打开） |
| `WORKSPACE_DB_UNREADABLE` | 500 | 工作区库存在但打不开（revert 拒绝；解析层不回退中心库，文案附迁移前中心库快照路径） |
| `REVERT_ATTACHMENT_MISMATCH` / `REVERT_VERIFY_FAILED` | 500 | revert：附件 sha256 不一致 / 逐表行数不守恒（事务回滚） |
| `WORKSPACE_DB_MIGRATING` | 409 | 本族之外的写请求：db_mode=localizing / failed（或工作区库 meta.localized=0）期间该区写被闸门拒绝，读走中心库 |
| `WORKSPACE_DB_MISSING` | 500 | 解析层：中心 db_mode=localized 但工作区库文件缺失（不回退中心库） |

### 工作区库下沉 CLI（`kb workspace-db *`，`packages/cli/src/commands/workspaceDb.ts`）

| 端点 | CLI | 必填 | 备注 |
| --- | --- | --- | --- |
| `POST .../db/localize` + 轮询 | `kb workspace-db enable [workspace]` | `[workspace]`（id 或名称；缺省按 cwd 解析，「当前目录不在任何工作区且全库只有一个工作区」时回退到它并在 stderr 提示；也可用 `--workspace`） | `--dry-run` 只统计；`--overwrite` 清理后重来；`--resume` 透传 `resume:true`，先读 `GET .../db` 的 `localizeState.stage` 打印 `从<阶段>阶段继续`（同给 `--dry-run` 时不读不打印） |
| `GET .../db` | `kb workspace-db status` | — | `--workspace <id\|名>`（缺省按 cwd 解析）；中文渲染模式（中心库 / 迁移中 / 已下沉 / 失败）、写闸门、生效库、行数合计与附件、快照落后、中间态、活动任务、解析依据；`disabled && needsRevert` 首行 `【警告】紧急开关已启用：该工作区数据在工作区库中，需 revert 才能回中心库`（`--json` 时该提示写 stderr）；failed 态末行提示 `enable --resume` / `cleanup` |
| `POST .../db/localize/cleanup` + 轮询 | `kb workspace-db cleanup` | `--workspace <id\|名>` | 终态打印删除项数与中心库该区行数；`WORKSPACE_DB_NOTHING_TO_CLEAN`（job failed 或 POST 409）→ stderr `无可清理的半成品：<服务端文案>` |
| `POST .../db/localize/revert` + 轮询 | `kb workspace-db revert` | `--workspace <id\|名>` | 进度按四阶段中文渲染（预检 / 回拷附件 / 回拷数据 / 收尾）；终态打印反向拷贝行数合计与 `工作区库已移入 .agentboard/backup/：<path>` |

- 轮询：间隔 2s、总超时 10 分钟；超时退出码 1，stderr 给 jobId 与 GET 重查路径；网络抖动连续 15 次内重试，服务端明确应答（如 404）直接失败。
- `--json`：stdout 只输出终态 JobView / StatusView 原文，进度行写 stderr；POST 409 走全局错误体，退出码不变。

| 码 | 含义 |
| --- | --- |
| 0 | enable 完成 / dry-run / `already_localized` 幂等回显；status 查询成功（不论模式）；cleanup / revert 完成 |
| 1 | job failed（`lastError` 原文透出，含预检拒绝：目标库已存在、上次迁移未收尾、无中间态可恢复、清理被拒、回迁被拒）；工作区不存在；400；轮询超时；cleanup / revert 缺 `--workspace` |
| 2 | POST 409（该区已有任务在跑，服务端文案原样透出）；cleanup 无可清理的半成品 |

### 工作区文本快照（STORE-5/6，`/api/workspaces/:id/db/snapshot*`，`apps/server/src/services/workspaceSnapshot.ts`）

- `export` 对两种形态都可用：已 localized 读工作区库；未 enable 时从**中心库按 `workspace_id` 过滤**导出同一行集（STORE-6，行集与迁移/status 共用 `workspaceScopedQueries.ts`），因此「没 enable 也能把看板提交进 git」。迁移进行中（`db_mode=localizing`）回答 409 `SNAPSHOT_MIGRATING`。
- `import` 仍只对 **localized** 工作区库生效；中心库模式回答 409 `SNAPSHOT_NOT_LOCALIZED`。`validate` 只读快照文件、不碰库。
- 格式：目录下 `manifest.json` + 每表一个 `<文件复数名>.jsonl`（`issues` / `issue_comments` / `issue_dependencies` / `issue_git_baseline` / `issue_draft_audit` / `workspace_status` / `workspace_change_log` / `knowledge_pages` / `knowledge_revisions` / `knowledge_links` / `sessions`，可选 `attachments` / `comment_attachments` / `knowledge_attachments`（`--include-attachments`）与 `messages`（`--include-messages`））。
- manifest：`format:'agentboard.workspace-snapshot/1'`、`workspace_id`、`schema_version:1`、`exported_at`（ISO）、`generator_version`、`source_db`、`included_tables`（库内单数表名）、`files:[{ file, table, rows, sha256 }]`、可选 `attachments:[{ storage_key, file, bytes, sha256 }]`；JSONL 每行一个对象，列序固定、按主键升序，保证同样数据两次导出除 `exported_at` 外逐字节一致。
- 时间列（`ts` 与 `*_at`）导出为 ISO 字符串，导入时还原为 epoch ms；列已存在则忽略导出侧多出的列，缺列 / 字段不一致 / 哈希或行数不符一律 422。
- 附件（STORE-6）：`--include-attachments` 把 `attachment` / `knowledge_attachment` 行引用的本体复制到 `snapshot/attachments/<storage_key>` 并记 sha256；导入前逐个校验，缺文件 → 422 `SNAPSHOT_ATTACHMENT_MISSING` 并列出 storage_key；通过后落到 `<ws>/.agentboard/attachments/`，图片路由即可 200。
- 目录边界：缺省 `<ws>/.agentboard/snapshot`；`dir` 允许相对工作区根或绝对路径，但必须落在工作区内，否则 400 `SNAPSHOT_PATH_OUTSIDE_WORKSPACE`。
- git 接线（STORE-6）：导出（含 enable 后自动导出）会同时写 `<ws>/.agentboard/.gitignore`（`*.db`、`*.db-wal`、`*.db-shm`、`localize.json`、`attachments/`）与 `<ws>/.agentboard/README.md`（事实源、恢复命令、附件开关说明）；内容不变不重写。根 `.gitignore` 不改（已有 `*.db`）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/workspaces/:id/db/snapshot/export` | body 严格 `{ includeMessages?: boolean, includeAttachments?: boolean }` | `{ dir, manifest: SnapshotManifest }`；单写事务读行 → 临时目录 → rename 覆盖，导出后回读自校验 | 404；400；409 `SNAPSHOT_MIGRATING`；500 `SNAPSHOT_SCHEMA_MISSING` / `SNAPSHOT_SELF_CHECK_FAILED` / `SNAPSHOT_ATTACHMENT_SOURCE_MISSING` | routes.ts:886 |
| `GET /api/workspaces/:id/db/snapshot/validate?dir=` | query `dir?`（缺省 `.agentboard/snapshot`） | `{ ok: true, dir, manifest, tables: [{ table, rows }] }`；只读 | 404；400 `SNAPSHOT_PATH_OUTSIDE_WORKSPACE`；422 `SNAPSHOT_INVALID` / `SNAPSHOT_ATTACHMENT_MISSING` | routes.ts:928 |
| `POST /api/workspaces/:id/db/snapshot/import` | body 严格 `{ dir?: string, replace?: boolean }` | `ImportSnapshotResult`：`{ dir, tables: [{ table, rows }], rows, backupPath }`；`replace=true` 先 `VACUUM INTO <ws>/.agentboard/backup/snapshot-import-<ts>.db` 再覆盖；单事务插入、逐表行数守恒，失败整体 ROLLBACK | 404；400；409 `SNAPSHOT_NOT_LOCALIZED` / `SNAPSHOT_TARGET_NOT_EMPTY`；422 `SNAPSHOT_INVALID` / `SNAPSHOT_WORKSPACE_MISMATCH` / `SNAPSHOT_ATTACHMENT_MISSING` | routes.ts:944 |

`SNAPSHOT_TARGET_NOT_EMPTY` 判定只看 `workspace_status` 之外的业务表（内置状态字典非空不算）；`SNAPSHOT_WORKSPACE_MISMATCH` 是快照 `workspace_id` 与目标工作区不一致（不做跨库重映射）。导入使用 `PRAGMA foreign_key_check` 兜底，库内断链可导出但不可导入。

| 端点 | CLI | 备注 |
| --- | --- | --- |
| `POST .../db/snapshot/export` | `kb workspace-db snapshot export [workspace]` | `[workspace]` 缺省按 cwd 解析（同 enable 的单工作区回退），也可用 `--workspace`；`--include-messages`、`--include-attachments`；文本输出「快照已导出 / 行数合计 / 附件 / 未包含」 |
| `GET .../db/snapshot/validate` | `kb workspace-db snapshot validate <workspace>` | `--file <dir>`；输出「快照校验通过 / 文件 N 个 / 行数合计」 |
| `POST .../db/snapshot/import` | `kb workspace-db snapshot import <workspace>` | `--file <dir>`、`--replace`；输出「快照已导入 / 导入行数 / 覆盖前备份」 |

退出码沿用本族口径：0 成功；1 校验不通过（`SNAPSHOT_INVALID` / 附件缺失）、工作区不存在、400；2 409（迁移中 / 未下沉导入 / 目标库非空）。

#### 中心库全局快照（STORE-6，`/api/system/center-snapshot/*`，`apps/server/src/services/centerSnapshot.ts`）

- 内容：`workspaces`（注册表）、`workspace_members`、`managed_accounts`（账号元数据）、`account_operations`（签到/切换等操作元数据）、`common_knowledge_pages`、`common_knowledge_revisions`（`scope='common'`）。
- 位置：**中心库同级的 `center-snapshot/`**（不跟随单个工作区仓库）；格式 `agentboard.center-snapshot/1`，manifest 多一个 `scope:'center'`、无 `workspace_id`。
- 脱敏：`managed_account.client_snapshot_ref` / `checkin_credential_ref` 与 `account_operation.recovery_ref` 一律写 `***`；导出后自检，发现非空未脱敏值直接 500 `CENTER_SNAPSHOT_SECRET_LEAK`（防未来改列名后静默泄露）。
- 只导出 + 校验，不提供导入（中心库重建走库备份）。

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `POST /api/system/center-snapshot/export` | — | `{ dir, manifest: CenterSnapshotManifest }` | 500 `SNAPSHOT_SCHEMA_MISSING` / `CENTER_SNAPSHOT_SECRET_LEAK` |
| `GET /api/system/center-snapshot/validate` | — | `{ ok: true, dir, manifest, tables: [{ table, rows }] }`（含脱敏自检） | 422 `SNAPSHOT_INVALID` |

CLI：`kb workspace-db snapshot center-export` / `center-validate`（不带 `<workspace>`，退出码 0 成功、1 校验/脱敏失败）。

## 4. system

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/version` | — | `{ name: 'agentboard-server', version: string, pid: number }`；version 取 `apps/server/package.json`（`version.ts`）；`pid` 供重启后区分「新进程已接管」与「已回退旧进程」；web 顶栏与设置弹窗经 `apps/web/src/api/version.ts` 展示 | — | routes.ts:239 |
| `POST /api/system/pick-folder` | — | `{ path: string\|null }`；null=用户取消；Windows 原生 FolderBrowserDialog（powershell.exe），同一时刻仅允许一个窗口 | 409 `PICK_FOLDER_BUSY` 已有选择窗口打开；500 `PICK_FOLDER_FAILED` 打开窗口失败 | routes.ts:228 |

## 5. settings

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/settings` | — | `{ port, dbPath, db_path, maxConcurrentTurns, attachmentQuotaBytes, attachmentStagedTtlMs, attachmentCleanupIntervalMs }`（仅 config.json 持久化值；`db_path` 是对外规范名、`dbPath` 是持久化键，两者同值同出；`db_path` 语义为**中心库路径**，不代表工作区库） | — | routes.ts |
| `PATCH /api/settings` | body：`port?: int 1-65535`、`db_path?: string 非空`（对外名，`dbPath` 为兼容别名；两者同时出现且不一致 → 400）、`maxConcurrentTurns?: int ≥1`、附件数值设置均为安全正整数（至少一个；未知键忽略） | 与 `GET /api/settings` **同形**的新配置（含 `db_path`）；并发和附件设置即时生效；迁移进行中改 db 路径 → 409 `DB_MIGRATION_BUSY` | 400 未提供字段 / 取值非法 | routes.ts |

### SKILLS-SYNC 配套技能复制到本机 agent 目录

把仓库 `skills/` 下 8 份配套技能（`using-agentboard` / `writing-task` / `executing-task` / `handoff` / `swing-dev` / `ask-user` / `brainstorming` / `kb-curator`）复制到本机常见 agent skills 目录。**目标目录只由服务端固定枚举，接口只收 `target_id`，不接受任意路径**；写入/删除范围仅限 `<目标>/<8 个技能名>`。

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/settings/skills-sync/targets` | query：`workspace_id?`（传入时才枚举 `<工作区>/.agentboard/skills`） | `{ source: { root, skill_count, file_count, skills:[{name,files}], hash }, targets:[{ id, label, path, resolved_path, exists, creatable, shared_with:[id], is_source, status, skills_present, synced_at }] }`；`status`：`synced`（8 技能内容与源逐文件一致）｜`stale`（有同名技能但内容不同/不全）｜`never`（不存在或没有同名技能）｜`unavailable`（不存在且祖先生效目录不可用）；`resolved_path` 按 junction/软链接实体路径解析，多个目标同物理目录时互相列进 `shared_with`；`is_source=true` 表示该目标就是技能来源（禁止复制/移除）；`synced_at` 来自 `<configDir>/skills-sync.json`，无记录为 `null` | 404 工作区不存在 |
| `POST /api/settings/skills-sync` | body（strict）：`target_ids: string[]`（1–16，必须是枚举 id）、`conflict?: 'overwrite'\|'skip'\|'backup'`、`workspace_id?: string` | `{ results:[{ target_id, path, resolved_path, action: 'copied'\|'skipped'\|'nothing', backup_dir, skills:[{name,files,bytes,status: copied\|overwritten\|backup_overwritten\|unchanged\|skipped}], errors:[{skill,file,message}] }], summary:{ targets, copied, skipped, errors, total_files } }`；`backup` 把冲突技能先备份到 `<目标>/.agentboard-backup-<yyyyMMdd-HHmmss>/` 再覆盖；复制后逐文件校验数量/大小/sha256，错误精确到技能与文件；只有整目标无错误才写同步时间 | 400 `VALIDATION_ERROR`（未知 id / 空数组 / 路径穿越式 id）；409 `SKILLS_SYNC_CONFLICT`（目标已有同名技能且未传 `conflict`，details.conflicts 列 `{target_id,skill,reason}`）；409 `SKILLS_SYNC_SOURCE_INCOMPLETE`（源缺任一 `SKILL.md`） |
| `DELETE /api/settings/skills-sync/:targetId` | query：`workspace_id?` | `{ target_id, path, removed:[技能名], errors:[{skill,file,message}], also_cleared:[同物理目录的其它目标 id], state_cleared }`；只删除本工具真实写入过的技能（记录在 `<configDir>/skills-sync.json` 的 `written` 里），目标里用户原有的 junction / 手工安装不动 | 400 未知目标；409 `SKILLS_SYNC_SOURCE_TARGET` 目标是技能来源目录（拒绝删除） |

口径：

- 目标清单（实测本机）：`~/.agents/skills`、`~/.claude/skills`、`~/.cursor/skills-cursor`（本机 Cursor 实际目录，实测为 junction → `~/.agents/skills`；不是网传的 `~/.cursor/skills`）、`~/.trae-cn/skills`、`~/.trae/skills`、`~/.codex/skills`、`~/.qoder/skills`、`~/.codeium/windsurf/skills`，以及传 `workspace_id` 时的 `<工作区>/.agentboard/skills`。
- 技能来源解析顺序：`AGENTBOARD_SKILLS_SRC` → 仓库 `skills/` → 便携包 `rules/skills` → `~/.agents/skills`。
- 安全：不写工作区外未声明位置（只写枚举目标）；源/目标同一实体路径时**直接拒绝**，绝不先删后拷；复制前校验源 8 技能齐全。
- junction/软链接：本机 `~/.agents/skills` 里 7 个技能本身就是指向仓库 `skills/` 的 junction。目标技能目录是链接时，覆盖/备份只删链接本身（不跟进去删真实目录），随后落真实复制；移除只删本工具写入过的条目。

### 后端改动上线口径（源码新 ≠ 运行新）

后端改动必须 **重建 dist + 重启服务**，否则端口上跑的仍是旧代码（RESTART-PROXY 的起因就是 8787 上跑旧 dist，`/api/version` 连 `instance_id` / `proxy_env` 都没有）。

| 步骤 | 命令 |
| --- | --- |
| 构建 | `pnpm --filter @agentboard/server build`（或 `pnpm -r build`） |
| 自检 | `pnpm check:stale`：5 条 `--help` 冒烟（含 `knowledge`）+ 各包 `dist` 与 `src` 的 mtime 比对；陈旧或冒烟失败 → exit 1 并给出重建命令 |
| 重启 | `pnpm server:ensure`（未监听会拉起；已监听但 dist 早于 src、或运行进程早于 dist／未上报 `started_at` → 打印「需重启（dist 陈旧）」并 exit 4；其余情况复用，**不会**自动换代码）→ 需要换代时用 `POST /api/system/restart` |

可复核判据（三项都变才算真的换上新代码）：`GET /api/version` 的 `instance_id` 变化、`started_at` 变化、`pid` 变化；字段本身的出现/取值（如 `proxy_env.enabled`）用来确认这版行为已生效。
## 5aa. 后台服务单例（SERVER-SINGLETON）

`pnpm server:ensure` 原来是「probe → spawn」，没有锁：两个 ensure 同时跑会都 spawn，其中一个子进程 `EADDRINUSE` 崩掉，脚本只看到健康超时。

| 项 | 口径 |
| --- | --- |
| 锁文件 | `<configDir>/server.lock`，内容 `{ pid, port, dbPath, startedAt, instanceId }`；**由服务进程持有**（生命周期 = 服务生命周期），不是启动器 |
| 获取 | `open(lock, 'wx')` 原子创建；已有活持有者 → 拒绝启动并打印持有者（`pid / 端口 / 库 / 起始时间 / 实例`），**不静默双开**；持有者 pid 已死或文件损坏 → 接管并写一行日志 |
| 释放 | `process.on('exit')` 里删锁，且只有 `pid + instanceId` 都对上才删（不误删接管者的锁） |
| 启动器行为 | 端口健康 → 复用 exit 0；锁被活实例持有且端口不同 → **拒绝** exit 2；自家子进程因锁退出（code 4）→ 继续等已有实例健康，健康则 exit 0（并发 ensure 不再误报失败） |
| `GET /api/version` | 增 `instance_id` / `db_path` / `started_at`（未注入时 null） |
| 重启交棒 | `POST /api/system/restart` 的接班进程带 `AGENTBOARD_RESTART_FROM=<旧 pid>`，其 `acquireServerLock({ takeoverFrom })` 允许受让「前任还活着但正在退出」的锁；普通 `server:ensure` 不带该变量，仍拒绝双开 |
| 终止与释放 | `process.on('exit')` + `SIGINT`/`SIGTERM` 里释放（`pid + instanceId` 都对上才删）。Windows 的 `Stop-Process -Force` 走 TerminateProcess，JS 捕获不到 → 锁残留，由**下一次启动的陈旧锁接管**兜底（残留不会导致起不来） |
| 多开 | 同 DB / 同 configDir 只能一个实例；需要多开请换 `APPDATA`（configDir）**和** `AGENTBOARD_DB`，并监听不同端口 |

## 5a. 出站代理（PROXY-ENV）

Node 24 的内置 `fetch` **默认不读** `HTTPS_PROXY`：必须 `NODE_USE_ENV_PROXY=1` 才会按环境代理出站。缺这个变量时访问 HuggingFace 等外网会 10000ms 连接超时，对外只看到裸 `fetch failed`。

| 项 | 口径 |
| --- | --- |
| 谁注入 | `scripts/server-detached.mjs`（`pnpm server:ensure`）拉起子进程前：宿主有 `HTTPS_PROXY`/`HTTP_PROXY`（含小写）且 `NODE_USE_ENV_PROXY` 未显式设为 `0` → 注入 `NODE_USE_ENV_PROXY=1` |
| 关闭 | 宿主设 `NODE_USE_ENV_PROXY=0` → **不覆盖**（尊重显式关闭） |
| 日志 | `[server] proxy_env=on host=127.0.0.1:7897（源 HTTPS_PROXY，已注入 NODE_USE_ENV_PROXY=1）`；只打 host:port，**丢 userinfo、不打印凭据** |
| `GET /api/version` | 新增只读 `proxy_env: { enabled, proxy_var, proxy_host, node_env_proxy }`；`proxy_host` 已脱敏 |
| 两条拉起路径 | `pnpm server:ensure`（启动器）与 `POST /api/system/restart`（服务内 `performRestart` → `spawnDetached` → `restartChildEnv`）**共用 `@agentboard/shared` 的 `ensureProxyEnv`**：宿主有代理变量且未显式设 `NODE_USE_ENV_PROXY=0` → 子进程 env 注入 `=1`。RESTART-PROXY（`8d0bb480`）之前只有启动器注入，任何一次 restart 都会丢代理 |
| `enabled` 语义 | `proxy_env.enabled` 只有 `NODE_USE_ENV_PROXY=1` 且存在代理变量时才为 true（Node 缺省/为 0 都直连，实测三态）；每次请求实时解析，**不是启动快照** |
| 手工启动 | 直接 `node apps/server/dist/index.js` 起的实例**不会**带该变量（启动器才注入；此时 `/api/version.proxy_env.enabled=false`）；该实例**经 `POST /api/system/restart` 换代后**，新进程会被注入 `=1`（RESTART-PROXY）。其它出站请求（额度等）同样受益于这次注入 |
| 唯一实现 | `packages/shared/src/proxyEnv.ts`（`resolveProxyEnv` / `ensureProxyEnv` / `maskProxyHost`）：启动器与服务端共用，不各写一份 |

## 5b. 数据库位置（DB-1，`config.ts` + `GET/PATCH /api/settings`）

生效顺序：**`AGENTBOARD_DB`（env）→ `config.json` 的 `dbPath`（设置项）→ 默认 `%APPDATA%\AgentBoard\agentboard.db`**。env 存在时设置项被忽略（但仍留在 config.json，env 去掉后自动回到设置值）。

| 端点 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/settings` | — | 配置快照；除既有字段外新增 `db_path`（对外规范名，与 `dbPath` 同值，保留 `dbPath` 兼容既有前端） |
| `PATCH /api/settings` | `{ db_path?: string, ... }`（`db_path` 与 `dbPath` 二选一；同时出现且不一致 → 400） | 写回 config.json 后的完整配置；**只改配置，不搬数据**（搬迁属 DB-2）；DB 路径变更需重启生效 |

启动首行日志会打印实际生效的库路径与来源：`listening http://… db=<path> db_source=<env|settings|default> attachments=<dir>`；附件目录恒为 `dirname(db)/attachments`，DB 路径一变自动跟随。

存储引擎口径（CR-12，2026-11-08 定案）：WAL + `synchronous=FULL`（SQLite 默认，不显式降级）。掉电语义：每个事务提交都 FlushFileBuffers，**掉电/断电不丢任何已提交事务、库不损坏**；实测本机 NVMe 下 FULL 的逐提交 fsync 开销约 20µs/事务（吞吐 ~14k tx/s，better-sqlite3 同步 API），`synchronous=NORMAL` 两轮 5 次采样中位无可测收益（0.96x/0.98x，噪声内），不改默认——评估数据与采样方法见知识页 `kb-synchronous-full-vs-normal`。

### DB-2 迁移引擎（`services/dbMigration.ts`，服务层；无新增端点）

把「当前库 + 附件目录」整体搬到新位置：**前置检查 → 一致性快照 → 附件逐文件校验 → 写设置 → 重启 → 自检**。

| 阶段 | 行为 | 失败码 |
| --- | --- | --- |
| 前置检查 | 目标目录可写（写探针）、剩余空间 ≥ (db + `-wal` + `-shm` + attachments) × **1.2**、目标已有同名库必须显式 `overwrite=true` | `DB_MIGRATION_TARGET_UNWRITABLE` / `DB_MIGRATION_NO_SPACE` / `DB_MIGRATION_TARGET_EXISTS` |
| 一致性快照 | SQLite 用 **`VACUUM INTO`**（带 WAL 未 checkpoint 内容，不改源库）；无句柄时退化为 copy + `-wal`/`-shm` **成对复制**（绝不只拷主文件） | `DB_MIGRATION_COPY_FAILED` |
| 附件 | 整目录复制 + **逐文件 sha256**，文件数与总字节都要对上 | `DB_MIGRATION_VERIFY_FAILED` |
| 切换 | 写设置（持久化键 `dbPath`，对外 `db_path`）→ `POST /api/system/restart` → 启动后自检（表数/卡数/附件数） | 自检不过 → 回滚到旧路径 |
| 失败 | **旧路径不变**：目标侧半成品（库 + sidecar + 目标附件目录）被清掉，`.bak-<ts>.json` 不生成；全部失败态 `retryable: true` | 上述固定码 |
| 成功 | 生成 `<newDbPath>.bak-<ts>.json` 标记；旧文件由 `cleanupOldDbFiles` 移入 `<bak>.old/`（保留供回滚），**自检通过后才清理** | — |

命名边界：`.bak-<ts>` / 本文件的迁移快照属**数据库迁移域**；`security/<uuid>`（B6）属设备身份域；`ClientSnapshotManifest`（B4S-2）属客户端账号域，三者不复用类型。

### DB-2B 迁移编排端点（`POST/GET /api/settings/db-path/migrate`，`services/dbMigration.ts` 编排段）

自检必须跑在**新进程**里（旧进程没有新库的句柄），所以编排拆成两段：旧进程跑到 `restart` 为止，`selfcheck → cleanup | rolled_back` 由新进程启动钩子完成。

| 阶段 | 谁执行 | 行为 | 失败处理 |
| --- | --- | --- | --- |
| `preflight` | 旧进程 | 采集期望值（表数/卡数/附件数/附件字节/附件抽样 sha256）+ 引擎前置检查 | 直接失败，不动源数据 |
| `snapshot` | 旧进程 | `VACUUM INTO` 一致性快照 + 附件整目录复制 | 目标侧半成品清掉 |
| `verify` | 旧进程 | 附件逐文件 sha256、文件数、总字节 | `DB_MIGRATION_VERIFY_FAILED` |
| `switch` | 旧进程 | 写意图文件（`<configDir>/db-migration-pending.json`）+ 写设置 `dbPath` | — |
| `restart` | 旧进程 | 内部调用 `performRestart`（与 `POST /api/system/restart` 同一实现） | 重启失败 → 设置回滚旧路径 + `DB_MIGRATION_ROLLED_BACK` |
| `selfcheck` | **新进程** | 读意图 → 比对表数/卡数/附件数/字节/抽样 sha256 | 不过 → 设置回滚旧库 + 清意图 + 本进程退出（旧进程健康判定失败后重新监听旧库）→ `DB_MIGRATION_ROLLED_BACK` |
| `cleanup` | 新进程 | 自检通过才把旧库 + sidecar 移入 `<bak>.old/`（旧进程可能仍占用，失败延迟 3s 重试一次） | 清理失败只影响归档，迁移仍算成功 |
| `done` | 新进程 | 终态 | — |

| 端点 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `POST /api/settings/db-path/migrate` | `{ target_db_path: string 非空, overwrite?: boolean }`（严格模式，未知键 400） | **202** `{ migration_id, backup_dir, stages, stage, message }`（此时只到 `restart`，自检结果用 GET 查） | 400 参数非法；409 `DB_MIGRATION_BUSY`（已有迁移或待自检意图）/ `DB_MIGRATION_ENV_OVERRIDDEN`（`AGENTBOARD_DB` 生效时改设置无效）/ `DB_MIGRATION_NO_SPACE` / `DB_MIGRATION_TARGET_EXISTS` / `DB_MIGRATION_ROLLED_BACK`；500 `DB_MIGRATION_VERIFY_FAILED` / `DB_MIGRATION_COPY_FAILED`；503 `DB_MIGRATION_RESTART_UNAVAILABLE` |
| `GET /api/settings/db-path/migrate/:migrationId` | — | `{ migration_id, stage, stages: [{stage, at, detail?}], ok: boolean\|null, code, message, retryable, backup_dir, from_db_path, to_db_path }`；`ok=null` 表示已切换、等新进程自检；**状态落盘**（`<configDir>/db-migration-status-<id>.json`），重启后仍可查 | 404 迁移记录不存在 |

- 错误码文案与 `retryable` 由 `DB_MIGRATION_ERROR_TEXT` 统一给出，引擎细节以「标准文案：细节」拼接，前端不拼文案。
- 单并发：进程内有活跃迁移或状态目录存在待自检意图 → 后续迁移与 `PATCH /api/settings` 改 db 路径都 409。

### KB-PAGE-3 `domain`（域词表）与回填状态

| 项 | 口径 |
| --- | --- |
| 列 | `knowledge_page.domain TEXT`（**幂等 ADD COLUMN**，NULL = 未归类；不加 CHECK，词表校验在服务层，便于扩展） |
| 词表 | `accounts / knowledge / board / chat / ui / infra`（`db/migrations/knowledge.ts` 的 `KNOWLEDGE_DOMAINS`，单一来源） |
| 写入 | `POST /pages`（create）与 `PUT /pages/:id`（revise）都接受 `domain`；非法值 → **400** `domain 只能是：accounts / knowledge / board / chat / ui / infra（当前：xxx）`；revise 未传则保持原值 |
| 读取 | 页面响应与列表/搜索**新增** `domain` 字段（加法，既有字段语义不变） |
| CLI | `kb knowledge create|revise --domain <域>`；`list` 输出含 domain |

### KB-PAGE-2 统一 resolve 与 link

| 端点 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/knowledge/resolve` | `ref`（**完整 id / ≥8 位 id 前缀 / slug**）、`scope?`=`workspace\|common\|both`（**缺省 both**，需 `workspace_id`） | 200 `{ state:'resolved', id, title, scope, workspace_id, status, revision, link, redirect_to:null }` | 404 `KNOWLEDGE_NOT_FOUND` / 403 `KNOWLEDGE_SCOPE_FORBIDDEN`（跨范围/跨工作区，**不回显标题**）/ 409 `KNOWLEDGE_REF_AMBIGUOUS`（附 `details.candidates`，**不猜第一条**）/ 410 `KNOWLEDGE_DELETED` |

- **权威标识是 page.id**；slug 与前缀只是输入别名，agent 输出一律用 `link.ref = knowledge:<uuid>`。
- `link` 形状（show / search / resolve 三处同源产出，前端与 CLI 不再拼串）：
  ```json
  { "id": "<uuid>", "scope": "common|workspace", "workspace_id": null, "slug": "cache-policy",
    "ref": "knowledge:<uuid>", "markdown": "[标题](knowledge:<uuid>)" }
  ```
- CLI：`kb knowledge resolve <ref>`（默认 both）/ `kb knowledge link <id|slug> --format token|markdown|plain`；退出码沿用既有约定 **404→1、409/403→2**（实现走 `CommanderError`，与 `kb dep` 同一套）。

### KB-PAGE-2b link 全覆盖 / find-source / show 省略 --scope

| 端点 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| `GET /api/knowledge/pages` | 同列表 | 每个列表项**新增** `link`（形状同上） | 列表文本与 `--json` 都能直接拿到引用串 |
| `POST /api/knowledge/pages`、`PUT /api/knowledge/pages/:id` | 同创建/修订 | 响应新增 `link` | CLI 文本输出在标题后补一行 `link: knowledge:<uuid>` |
| `GET /api/knowledge/find-source` | `path`（必填，精确匹配 `sources[].locator` / `content_hash` / `source_id`）、`scope?`=`workspace\|common\|both`（默认 both，需 `workspace_id`） | 200 `{ path, items: [{ id, slug, title, scope, workspace_id, revision, status, link }] }` | **只读**：只扫页面**当前 revision** 的 `sources_json`（历史版本不参与），软删页排除；不建表、不做全表反序列化 |

- CLI：`kb knowledge find-source <path>`（默认 both）；`kb knowledge show <page-id>` 的 `--scope` **可省略**——省略时先调 `resolve`（both + 当前工作区）再按解析结果取页，显式给出 `--scope` 时行为与旧版逐字一致。
- `show` 省略 scope 的退出码沿用 resolve 约定：404→1、409 歧义/403 跨范围→2。

### KB-PAGE-1 知识页读语义与 slug 解析（缺陷修复）

| 项 | 变化 |
| --- | --- |
| `GET /api/knowledge/pages/:id` | 软删页（`status='deleted'`）→ **410 `KNOWLEDGE_DELETED`**（附 `details.revision`，提示可看历史）；不存在 → 仍 404 `KNOWLEDGE_NOT_FOUND`；归档页 → 200 且响应带 `status='archived'` |
| `GET /api/knowledge/search` | 每条结果**新增** `slug` 与 `status`（只加字段，既有 `page_id/scope/revision/title/snippet/sources/evidence/score` 不变）；当前 SQL 仍只返回 `active` 页 |
| 仓储 `getKnowledgePage` | 默认**不再返回软删页**（`options.includeDeleted: true` 才返回）；`GET /pages/:id` 用它区分 404 与 410 |
| 前端 `knowledge:<slug>` 解析 | 不再用 `?? rows[0]` 兜底：只接受 **slug 完全相等且唯一**的搜索结果；无命中/歧义一律降级为灰文本（`data-link-state="denied"`），不再静默打开错页 |

### IMPORT-LIMIT-S 导入上限（单文件 10MB / 单页正文 200 万字符）

| 项 | 口径 |
| --- | --- |
| 请求体上限（导入路径） | `12 MiB`（`apps/server/src/index.ts` 的路径级 parser + `knowledgeRoutes.ts` 路由级 parser 同一值）；10MB 文件经 JSON 转义膨胀 1.1–1.4 倍留余量。其余端点仍 100kb |
| 单文件上限 | `10MB`（`services/knowledgeImport.ts` 的 `IMPORT_MAX_BYTES`）→ 超限 `413 IMPORT_TOO_LARGE`，文案写明「10MB」 |
| 单页正文上限 | `2,000,000` 字符（唯一来源 `services/knowledge.ts` 的 `KNOWLEDGE_BODY_MAX_CHARS`；`IMPORT_MAX_BODY_CHARS` 引用它，create/revise 的 zod 上限也引用它）→ 超限 `413 IMPORT_BODY_TOO_LONG`，文案给「当前 N 字符 / 上限 2,000,000 字符」 |
| 超限语义 | parser 层（请求体超 12MiB）→ `413 IMPORT_TOO_LARGE`（不落到 `ATTACHMENT_TOO_LARGE`）；业务层（文件 >10MB / 单页 >200 万字符）→ 各自的 413 |
| 大正文读回 | `GET /api/knowledge/pages/:id` 整篇返回；实测 2,000,000 字符页响应 2,000,661 字节、`body_md.length` 一致（不截断）。超大页建议前端分窗渲染 |

### KBIMP-1B2 json 数组逐条 `category` / `landed`

`format: 'json'` 的数组逐条取值，**逐条字段优先于请求顶层**：

| 情形 | 结果 |
| --- | --- |
| 本条有 `category` / `landed` | 用本条的值 |
| 本条 `category: null` / `''` | 本条未指定（不继承顶层）→ 归一为 `legacy` |
| 本条 `landed: null` / `''` | 本条「未落地」（不继承顶层）→ `design` 归一为 `proposed`，其它分类 `null` |
| 本条没有这两个键 | 继承请求顶层的 `category` / `landed` |
| 本条值非法 | **400** `VALIDATION_ERROR`，message 指明第几条与可选值（例：`第 2 条 landed 非法：done（可选 landed / partial / proposed；null 表示未落地）`） |

缺省归一规则：缺失/未知 `category` → `legacy`；`design` 缺 `landed` → `proposed`；非 `design` 类未显式传 `landed` 时为 `null`。

> KB-LANDED（卡 `e0f324d0`）：`category` 与 `landed` 相互独立、可任意组合。显式传入合法 `landed`（`landed`/`partial`/`proposed`）时，**任何分类都原样落库**（`open` / `solved` / `pinned` / `legacy` 也可以带落地进度）；不再把非 `design` 的 `landed` 强制置 `null`。上文的缺省规则只在未传 `landed` 时生效。

### DB-3B-S 存储位置汇总（`GET /api/settings/storage`，只读）

只读端点：不改配置、不触发迁移。所有数字由服务端算，前端只格式化（不许前后端各算一套）。

| 字段 | 含义 |
| --- | --- |
| `db_path` | 本进程实际打开的库（= 启动日志 `db=`） |
| `db_path_source` | `env`（`AGENTBOARD_DB`）｜`settings`（config.json 的 `dbPath`）｜`default`；**取启动期解析值**（= 启动日志 `db_source=`）。请求期再 `loadConfig` 会把 `default` 误判成 `settings`：首次启动会把默认值（含 `dbPath`）写回 config.json |
| `attachments_dir` | 附件目录（与 `AttachmentStore.storageDir` 同值） |
| `usage` | `{ db_bytes, wal_bytes, shm_bytes, attachments_bytes, attachments_files, total_bytes }`；附件目录不存在按 0；`total_bytes = db + -wal + -shm + 附件` |
| `migration_estimate` | `{ issue_count, attachment_count, estimated_bytes, required_bytes }`；`estimated_bytes` 与 `preflightMigration` 的 `plan.totalBytes` **同源同值**（db + sidecar + 附件字节），`required_bytes = ceil(estimated_bytes × 1.2)`（与前置检查同一个 `DB_MIGRATION_SPACE_MARGIN`） |
| `truncated` | 附件遍历达到 `STORAGE_SCAN_MAX_FILES`（50000）即停；此时 `attachments_files`/`attachments_bytes`/`total_bytes`/`attachment_count`/`estimated_bytes`/`required_bytes` 全为 `null`，`truncated: true`（宁可报未知，也不长时间占着请求） |

错误：503 `DB_STORAGE_UNAVAILABLE`（最小装配拿不到库路径）。

### VOICE-DL-FAIL 语音模型下载：代理 / 可读错误 / 断点续传

| 项 | 口径 |
| --- | --- |
| 代理 | Node 24 只在 `NODE_USE_ENV_PROXY=1` 时让内置 `fetch` 走 `HTTPS_PROXY`/`HTTP_PROXY`；直连 HuggingFace 多数网络会在 10000ms 连接超时（对外只看到裸 `fetch failed`）。服务端在**首次下载请求前**开启该支持（已显式设 `NODE_USE_ENV_PROXY=0` 时尊重用户，不改） |
| `GET /api/voice/models` / `/models/:id` | 新增只读 `download_env: { proxy_detected, proxy_var, proxy_host, node_env_proxy, no_proxy }`；`proxy_host` **只留 host:port，丢弃 userinfo**（不打印凭据） |
| 错误文案 | `cause.code` 映射成中文（`ECONNRESET`→连接被重置、`ENOTFOUND`→域名解析失败、`UND_ERR_CONNECT_TIMEOUT`→连接超时（多为没走代理）等），并附「已下载 X/Y」与代理提示；不再是裸 `fetch failed` |
| 断点续传 | 失败**保留** `.part`；下次带 `Range: bytes=<size>-`，响应 206 追加写、200 表示服务端不支持则从头写；完成后再验 sha256（校验的是整份文件） |
| 空闲超时 / 重试 | 单文件 `VOICE_DOWNLOAD_IDLE_MS = 60000` 内无数据即中断（`VOICE_DOWNLOAD_IDLE_TIMEOUT`）；单文件最多 `VOICE_DOWNLOAD_RETRIES = 2` 次退避重试，每次从 `.part` 续传；sha256 不符与主动中断不重试 |
| 失败态 | 只重下未就绪的文件（`fileReady` 过滤），重试即「只补失败文件」 |

## 6. issues

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues` | query：`workspace`（必填）、`status?`（**该工作区已定义的任意状态名**：内置五状态 + 自定义；分页与非分页都生效）、`kinds?`（OPT-01：逗号分隔的 kind 白名单 `open/started/review/done/deprecated/blocked`，比对状态字典的 `kind`，自定义状态同样生效；`blocked` 自 ARCH-02 起可用）、`unclaimed?`（OPT-01：`1`/`true` 只返回 `claimed_by IS NULL` 的无主卡，`0`/`false` 显式关闭）、`limit? offset?`、`fields?`（PERF-4a：逗号分隔字段白名单，字段名与 `Issue` 同名；未传时非分页=完整字段兼容旧契约，分页=精简列表字段（不含 description，PERF-4 起）） | `Issue[]`（sort_order,created_at,id 升序）；分页模式 `PageResult<TaskPreview>`（id 升序；缺省不含 description；显式 `fields=description` 时截取默认 12000 字符并附 `description_truncated` `next_description_offset_chars`）；带 `fields` 时只返回所列字段，未请求 `description` 则响应不含正文与截断标记；完整字段模式含 `claim_lease_until`（占用到期 epoch ms，null=无租约语义）与 `last_heartbeat_at`（最近心跳续租时刻，null=未心跳）——BORROW-0.2 租约投影（034427fa），`GET /api/issues/:id` 同带；租约剩余由调用方 `claim_lease_until - now` 求差，服务端不下发倒计时 | 400 缺 workspace / 分页非法 / `fields` 含未知字段（列出可用值）/ `status` 不属于该工作区（文案列出可用状态）/ `kinds` 为空或含未知 kind（列出可用 kind）/ `unclaimed` 非 `1|0`；404 工作空间不存在 | routes.ts（`api/routes/issueRoutes.ts`） |
| `GET /api/issues/counts`（PERF-4a） | query：`workspace_ids`（必填，逗号分隔或重复参数；去重后 ≤50，重复项 400） | `{ items: [{ workspace_id, total, counts: Record<状态名, 数量> }] }`，顺序与入参一致；按目标库分组 `GROUP BY workspace_id, status` 聚合，无卡工作区返回 `total=0` | 400 缺参 / 超 50 / 重复项；404 工作空间不存在；开关 `AGENTBOARD_ISSUES_V2=off\|0` 时 404 | routes.ts（`api/issuePayloadRoutes.ts`） |
| `POST /api/issues`（幂等） | body：`workspace_id: string`、`title: string 非空`、`description: string`（CARD-FACE：去标题/模板段名/空白后为空 → 400，错误文案含「验收标准」与最小模板）、`allow_empty?: boolean`（批量建卡 / 纯父卡跳过空面校验）、`status?: '待规划'\|'待验收'`（CREATE-STATUS：缺省 待规划；待验收必须同时填验收标准，其它值 400 并点名允许值）、`priority?: '低'\|'中'\|'高'`（缺省 中）、`labels?: string[]`（缺省 []） | `Issue`（缺省 status=待规划、sort_order=0；status=待验收时无占用、无 done 评论、无 baseline）；WS issue.changed | 400 校验失败（空描述 / 待验收缺验收标准 / status 非允许值）；404 工作空间不存在 | routes.ts:268 |
| `POST /api/issues/draft` | body：`workspace_id`、`requirement: string 1-4000`、`adapter: 'dsh'\|'codex'\|'opencode'`、`priority?: '低'\|'中'\|'高'` | **不落库**：`{ cards: [{ local_id, title, description, labels, warnings }], title, description, labels, warnings }`（MULTI-DRAFT：多条需求按原话分条，1 条 1 张卡，最多 10 张；顶层字段镜像 `cards[0]` 以兼容旧单读法；`splitRequirementItems` 只切分不推断，模型条数不符时按原文逐条兜底）。`description` 固定三段（`## 背景` / `## 要求` / `## 验收`），模型没给的段落写「未提供」，**不补需求、不编验收条件**；`labels` 只保留工作区已有标签，自造的丢弃并进 `warnings`；一次性适配器调用（不建会话/不占 claim），超时 120s；审计写 `issue_draft_audit`（只记 adapter/耗时/成败/warning 数，不记需求原文） | 400 参数非法（adapter 不在三家内、requirement 空/超长）；404 工作空间不存在；422 `DRAFT_INVALID_OUTPUT`（JSON 不合法，已重试 1 次）；502 `DRAFT_ADAPTER_FAILED`；504 `DRAFT_TIMEOUT` | routes.ts（`services/smartCreateDraft.ts`） |
| `GET /api/issues/:id` | query：`description_offset_chars?` `description_max_chars?` | `Issue`；带窗口参数时 description 为窗口内容并附 `description_truncated` `next_description_offset_chars` | 404 任务不存在（归属不匹配同为 404） | routes.ts:276 |
| `PATCH /api/issues/:id`（幂等） | body：`title? description? priority? labels? status? sort_order?: int`（至少一个）；`workspace_id?`；`expected_updated_at?: int ≥0`（CAS，须同时提供 workspace_id） | `Issue`（`updated_at` 单调递增：`MAX(now, 旧值+1)`，`issue.ts:145` + `schema.ts:42` 触发器，CAS 调用方依赖）；WS issue.changed | 400 未提供更新字段 / CAS 缺 workspace_id / 参数非法；404 任务不存在；409 `CONFLICT` 占用中禁改 status；409 `TASK_REVISION_CONFLICT` CAS 过期（details `current_updated_at`） | routes.ts:284 |
| `DELETE /api/issues/:id` | — | 204；先停各绑定会话在途轮次，再同事务级联删除消息+会话+任务；同事务内对每个被本卡阻塞的卡追加 system 评论「前置 X(short id) 已删除，依赖自动解除」；WS issue.deleted + 每会话 session.deleted + 每条解锁评论 comment.added | 404 任务不存在；409 `CONFLICT` 占用中禁止删除；含子任务时 409 `CONFLICT`（子任务先处理） | routes.ts:447；CLI `kb delete-issue <id> --yes`（缺 `--yes` 只打印标题/状态、非 0 退出、不发请求）；MCP `agentboard_delete_task` |

**CLI 状态入口（CLI-STATUS-SET）**：`kb update <issue-id> --status <状态>` 直接走本端点的 `status` 字段，可把卡置入本工作区任意已定义状态（含 `kb status add` 的自定义状态与内置「已废弃」）；非法状态仍由服务端 400 并列出可用状态（exit 1），占用中的卡仍 409 `占用中禁止修改状态`（exit 2，先 done/fail/release）。内置流转仍优先用 `kb claim` / `done` / `close` / `reopen` / `fail`；幂等沿用 `--request-id`。

### 依赖（DEP-1，`services/dependency.ts`）

| `POST /api/issues/:id/dependencies` | — | — | 400 `DEPENDENCY_SELF`（依赖自身）/ `CROSS_WORKSPACE_DEPENDENCY`（跨工作区）；409 `DEPENDENCY_EXISTS`（重复）/ `ISSUE_CLAIMED`（被阻塞卡占用中）/ **`DEPENDENCY_PARENT_CYCLE`**（被阻塞卡是前置卡的**子孙**：父卡要等子卡全完才 done，再让子卡依赖父卡会双向互等 → 流程死锁）/ `DEPENDENCY_CYCLE`（依赖环，含多跳与长链） |

- **允许方向**：**父卡依赖子卡**（`blocked` 是 `blocker` 的祖先）语义合理，放行；只有「子卡依赖父/祖先卡」被拒（`DEPENDENCY_PARENT_CYCLE`）。
- 祖先判定与父子改挂共用同一实现：`services/taskHierarchy.ts` 的 `isIssueDescendant`（递归 CTE），不在依赖模块里另写一份。
- 多跳/长链成环：`wouldCreateCycle` 从 blocker 沿「前置的前置」上溯，A→B→C→A 与 5 跳以上同样拒绝（`DEPENDENCY_CYCLE`），DB 触发器兜底直接写库。


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

workspace 解析：先 `GET /api/issues/:id` 取 `workspace_id` 再上送（同 `kb claim` 手法），写通道因此恒带 `workspace_id`。`--json` 输出原始响应。退出码**由本子命令自带映射，不改全局 `toExit`**：0 成功；2 `DEPENDENCY_CYCLE` / `DEPENDENCY_PARENT_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED`；3 `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR`；**4 只用于 `dep rm` 的「依赖边不存在」**（任务不存在 `NOT_FOUND` / `TASK_NOT_FOUND` 交回全局口径落 **1**，与 `show` / `claim` 一致）；未映射的码交回全局 `toExit`（409 → 2、其余 → 1，用服务端原文）。每个已映射码一句中文文案，不会被包装成「已被占用（…）」：

| 错误码 | 退出码 | 文案 |
| --- | --- | --- |
| `DEPENDENCY_CYCLE` | 2 | 该依赖会让任务成环，已拒绝 |
| `DEPENDENCY_PARENT_CYCLE` | 2 | 子卡不能依赖其父/祖先卡：父卡要等子卡全完才 done，会形成流程死锁 |
| `DEPENDENCY_EXISTS` | 2 | 该依赖已存在 |
| `ISSUE_CLAIMED` | 2 | 任务已被占用：请先 kb release <issue-id> 再新增前置 |
| `CROSS_WORKSPACE_DEPENDENCY` | 3 | 不支持跨工作区依赖（依赖边两端必须属于同一工作区） |
| `DEPENDENCY_SELF` | 3 | 不能依赖自身：被阻塞卡与前置卡是同一张 |
| `VALIDATION_ERROR` | 3 | 参数不合法（缺少 workspace_id 或前置 id 为空） |
| `NOT_FOUND` / `TASK_NOT_FOUND` | 1 | 任务不存在或不属于该工作区（附 id 与查 id 提示） |
| `NOT_FOUND`（仅 `dep rm` 的边缺失） | 4 | 依赖边不存在：<issue-id> ← <blocker-id> |

**MCP（DEP-2，`apps/mcp/src/tools/dependencies.ts`）**

| 工具 | 入参 | 语义 |
| --- | --- | --- |
| `list_dependencies` | `task_id`、`workspace_id?`（绑定工作区优先，越界 `WORKSPACE_BOUND`） | 返回 `{ blockers, blocked, workspace_id }`，`resolved` 由服务端给 |
| `add_dependency` | `task_id`、`blocker_task_id`、`request_id`（UUID，作 `Idempotency-Key`）、`workspace_id?` | 建边，返回同 `list` 的视图 |
| `remove_dependency` | `task_id`、`blocker_task_id`、`workspace_id?` | 删边，返回 `{ removed: true, task_id, blocker_task_id, workspace_id }` |

错误走 `structuredContent.error.code`：依赖码原样透传（`DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED` / `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF`），404 `NOT_FOUND` 按 `apiClient` 既有约定落成 `TASK_NOT_FOUND`；`message` 用本地安全文案，不回传服务端原文。

> **命名与兼容（MCP-NAMING）**：MCP server 名已是 `agentboard`，工具名不再带 `agentboard_` 前缀（客户端显示为 `mcp__agentboard__list_tasks` 这类形式）。旧名 `agentboard_<name>` 作为 alias 同时注册、指向同一 handler，**下个大版本移除**；已有客户端配置与 prompt 无需立即改。

**MCP（MCP-C2，`apps/mcp/src/tools/changelog.ts`）**：`list_changelog`（`workspace_id?`、`limit` 1–100、`offset`、`change_type?`、`q?`；正文只回 300 字摘要）、`get_changelog`（`changelog_id`、`body_offset`、`body_max_chars` 默认 12000，截断回 `next_offset_chars`）、`create_changelog`（`title`、`body_md`、`change_type` 新增/修复/调整、`occurred_at?`、`issue_id?`（归属任务 UUID，done 门禁据此识别本卡日志）、`request_id` 作 `Idempotency-Key`，`actor` 取 `AGENTBOARD_AGENT_ID`）。三者复用 `GET/POST /api/workspaces/:workspaceId/changelog`（POST 另接受可选 `issue_id`，写入 `workspace_change_log.issue_id`；服务端校验它必须是本工作区的真实任务，不存在或跨区返回 400 `VALIDATION_ERROR`，不落库；列表/详情响应均回显 `issue_id`，无归属为 `null`），404 落 `CHANGELOG_NOT_FOUND` / `WORKSPACE_NOT_FOUND`，不新增路由。CLI `kb changelog list/show` 文本模式以 `归属:<id|->` 展示该字段。

**MCP（MCP-K1，`apps/mcp/src/tools/knowledge.ts`）**：`list_knowledge`（`scope` workspace/common/both、`workspace_id?`、`status` active/archived/deleted/all、`include_expired`、`offset`、`limit` 1–100 默认 20）→ `GET /api/knowledge/pages`，只回元数据摘要（无正文、无 `link_info`）；`find_knowledge_sources`（`path`、`scope` 默认 both）→ `GET /api/knowledge/find-source`，结果最多回 100 条并带 `total` / `truncated`。两工具只读，scope 越界沿用 `INVALID_ARGUMENT`（common 带 workspace_id）/ `WORKSPACE_REQUIRED`（workspace 缺绑定）。

### 状态字典（STATUS-1/2，`workspace_status` + `services/workspaceStatus.ts`）

`issue.status` 落库是名字字符串，合法值 = 该卡所属工作区的 `workspace_status.name`；写入不在字典里的值 → 400 `VALIDATION_ERROR` 且文案列出可用状态（DDL 已无 CHECK 枚举，STATUS-1 迁移把校验挪到服务层）。

**kind 语义（ARCH-02）**：`kind` 可取 `open/started/review/done/deprecated/blocked`，行为只看 kind、不看名字。关闭类仍是 `done` 与 `deprecated`（`kb close` 的「所有后代已关闭」判定不变）；新增的 `blocked` 表示「阻塞待解除」，只允许自定义状态使用，**不新增第六个内置状态**，内置五状态与列集合不变。存量库的 `workspace_status` 还是五 kind 的旧 CHECK（SQLite 不能改 CHECK），服务启动时由 `migrateWorkspaceStatusKinds` 重建表并把旧行（id/name/kind/sort_order/is_builtin/created_at）原样搬入新表；重建幂等，已是新 CHECK 时不做任何事。前端 `statusAccent` 把 `blocked` 归入石墨档（不占用强调色），状态设置里的「行为类别」可选「阻塞」。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/workspaces/:workspaceId/statuses` | — | `WorkspaceStatus[]`（`{ id, workspace_id, name, kind, sort_order, is_builtin }`，`sort_order`,`name`,`id` 升序）；5 条内置恒在（`is_builtin=1`，`kind` = open/started/review/done/deprecated，sort_order 0/10/20/30/40）；`kind` 的完整取值另含 `blocked`（仅自定义状态使用，不新增内置状态） | 404 工作空间不存在；400 body/query 的 `workspace_id` 与路径不一致 | workspaceStatusRoutes.ts |
| `POST /api/workspaces/:workspaceId/statuses` | body：`name: string 1-50`、`kind: 'open'\|'started'\|'review'\|'done'\|'deprecated'\|'blocked'`、`sort_order?: int`（缺省 = 当前最大值 +10）、`workspace_id?`（一致性校验） | 201 `WorkspaceStatus`（`is_builtin=0`） | 400 名空 / kind 非法（文案列出可用 kind，含 `blocked`） / workspace_id 与路径不一致；409 `WORKSPACE_STATUS_EXISTS` 同区重名（含内置名）；404 工作空间不存在 | workspaceStatusRoutes.ts |
| `DELETE /api/workspaces/:workspaceId/statuses/:statusId` | query：`migrate_to`（**必填**，目标状态名）、`workspace_id?` | 200 `{ removed, migrate_to, migrated_issue_count }`；同事务把该状态下的卡全部改成 `migrate_to` 再删行。`migrated_issue_count` = **实际迁移卡数**：先 `SELECT COUNT(*)` 该状态卡数再 UPDATE，两者不等则 500 `MIGRATION_COUNT_MISMATCH` 回滚（宁可报错也不谎报 0）；该状态本来没卡时为真实的 `0` | 400 `MIGRATION_TARGET_REQUIRED` 缺 migrate_to / `MIGRATION_TARGET_INVALID` 目标不存在或等于自身 / `workspace_id` 不一致；409 `WORKSPACE_STATUS_BUILTIN` 内置不可删；500 `MIGRATION_COUNT_MISMATCH` 计数不一致（已回滚）；404 `NOT_FOUND` 状态或工作空间不存在 | workspaceStatusRoutes.ts |

**CLI**：`kb status ls [workspace]`、`kb status add [workspace] [name] [--kind …] [--sort-order N]`、`kb status rm [workspace] [status] --migrate-to <name>`。workspace 支持 id 或名称，缺省按 cwd 解析（`--workspace` 与位置参数等价，显式给出时优先）；只给一个位置参数时按状态名处理（缺省工作区）。409 的状态字典错误（`WORKSPACE_STATUS_*`）由子命令原样打印文案并退出 **2**（不被全局包装成「已被占用（…）」），其余失败退出 1。

**CLI 列表口径（CLI-LIST-GUARD）**：`kb list-tasks --status <状态>` 先按该工作区（未指定 workspace 时按「任一工作区」）的状态字典校验，非法值 → 非 0 退出并列出可用状态（不再静默返回「（无任务）」）；`--json` **默认裁掉 `description` 正文**并标记 `description_omitted: true`，需要正文时显式 `--json --full`；表格模式本来就不输出正文。

**CLI 缺省工作区（OPT-02）**：`kb create-issue`、`kb status ls/add/rm`、`kb workspace-db enable`、`kb workspace-db snapshot export` 的工作区参数均可省略，缺省按 cwd 解析，并可用 `--workspace <id|名>` 显式指定（与位置参数等价，显式优先）。cwd 不属于任何工作区且全库只有一个工作区时回退到该区并在 stderr 提示；存在多个工作区时报错并列出候选（不猜）。`kb create-issue` 只给一个位置参数且它不匹配任何工作区时，按「当前工作区 + 该参数为标题」处理并在 stderr 提示。

**CLI 默认收敛（OPT-01 / ARCH-02）**：`kb list-tasks` 不带 `--status` / `--tree` 时，缺省只取「未完成（`kind ∈ open/started/review/blocked`）且无主（`claimed_by IS NULL`）」的卡，并在 stderr 首行提示 `默认已收敛为未完成无主卡，全量用 --all-status`；过滤通过 `GET /api/issues?kinds=open,started,review,blocked&unclaimed=1` 在服务端完成，CLI 不拉全量后本地筛。**口径写死：`kind=blocked` 的自定义状态卡归入「未完成」并展示**（阻塞仍需人处理，不隐藏）；`kb next` 仍只取「待规划」，行为不变。旧服务端不认 `kind=blocked`（400）时 CLI 自动回落到 `kinds=open,started,review`。`--all-status` 恢复改造前口径（整区全状态、含他人占用）；`--status <状态>` 显式覆盖缺省收敛；`--tree` 为保留整树上下文不做收敛；`--all` 跨区盘点同样适用缺省收敛，需要全量时配 `--all-status`。

**MCP**：`list_statuses` / `add_status`（`request_id` 作幂等键） / `remove_status`（`migrate_to` 走 query，无幂等键，与 REST 一致）；强制 `resolveWorkspaceId`，错误码透传（`WORKSPACE_STATUS_BUILTIN` / `WORKSPACE_STATUS_EXISTS` / `MIGRATION_TARGET_REQUIRED` / `MIGRATION_TARGET_INVALID`）。

## 7. comments

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/issues/:id/comments` | query：`limit? offset?` | `IssueComment[]`（ts,id 升序）；分页模式 `PageResult<{ id, author, ts, snippet(≤500 字符), has_more, attachments? }>`；图片元数据带 `delivery_state?: pending\|sending\|unknown\|delivered` | 404 任务不存在；400 分页参数非法 | routes.ts |
| `GET /api/issues/:id/pending-attachments` | query：`limit? offset?`（默认 50、最大 100） | `PageResult<DispatchAttachmentCandidate>`：仅返回该 Issue 的 pending/unknown 图片元数据，按评论时间、评论 ID、附件位置升序；每项含作者、500 code point 评论片段，不含路径 | 404 任务不存在；400 分页参数非法 | routes.ts |
| `GET /api/issues/:id/comments/:commentId` | query：`content_offset_chars?` `content_max_chars?` | 单条评论窗口及 `truncated`、续读 offset；含 `attachments?` | 404 任务不存在；404 `COMMENT_NOT_FOUND` 评论不存在 | routes.ts |
| `POST /api/issues/:id/comments` | body：`content: string`（可空，仅当有图片）、`workspace_id?`、`attachment_ids?: UUID[]`（唯一，最多 5；有图时 workspace_id 必填）、`agent_id?: string`。幂等 | `{ comment: IssueComment, woke: boolean, warning?: 'WAKE_FAILED'\|'IMAGE_DELIVERY_UNVERIFIED' }`。纯文字沿用用户评论唤醒；含图片时仅在当前 CLI/model 已验证时唤醒。附件元数据带 `delivery_state`：pending、sending、unknown、delivered。未知/失败时评论保持待读。WS comment.added + issue.changed；投递状态经 comment.delivery.changed 刷新 | 400 内容与图片同时空 / 字段非法；404 图片或任务不在指定空间；409 `ATTACHMENT_ALREADY_BOUND`；410 `ATTACHMENT_EXPIRED` | routes.ts |
| `POST /api/issues/:id/comments/consume` | — | `{ comments: IssueComment[], new_comment_ids: string[] }`。含附件的首条待读评论在 `delivered_at` 为空时阻止游标前进；`new_comment_ids` 不含该图片评论及其后的评论，也不含当前占用者（`agent:<claimed_by>`）自身的评论（未占用时不过滤）。无图片阻塞时沿用原有恰好一次游标语义 | 404 任务不存在 | routes.ts |

### 验收记录 CLI（ACCEPT-1，`kb accept`）

```
kb accept <issue-id> --verdict pass|fail --note "<验收依据>" [--reviewer <name>] [--request-id <uuid>]
```

- 只写一条固定格式评论，**不改卡片状态**：`【验收记录】verdict=<pass|fail>; reviewer=<name>; at=<ISO8601>`，第二行起为 `--note` 原文（固定格式供检索与审计，改动即破坏可读性）。
- 仅「待验收」卡可写；其它状态 exit 2 且不发评论（待规划用 `kb done` 提交验收，关闭用 `kb close`）。
- `reviewer` 缺省取 `KB_AGENT`，再缺省 `kb-cli`；`--request-id` 复用评论幂等通道，同一 id 重放不重复写评论。
- 退出码：0 成功；1 缺 `--verdict` / `--note` 或取值非法；2 当前状态不是「待验收」；服务端 409 等按全局退出码表。
- 与 `kb done` 的关系：`done` 是执行者提交（进行中 → 待验收，notes 落评论）；`accept` 是验收者留痕（状态不变）。要推进状态请显式执行 `kb close <issue-id>`（待验收 → 已关闭）。
- MCP 对应工具（MCP-C1）：`close_task`（`workspace_id`/`task_id`/`request_id`，可选 `fence`）、`reopen_task`（多 `status?`）、`accept_task`（`verdict` 默认 `pass`、`note?`、`reviewer?`，reviewer 缺省 `AGENTBOARD_AGENT_ID`）。三者与 CLI 同语义；`accept_task` 在非「待验收」卡上直接返回 `ACCEPT_STATUS_NOT_ACCEPTABLE` 且不发写请求。生命周期写工具必须显式或绑定 `workspace_id`，缺省返回 `WORKSPACE_REQUIRED`。

## 8. 占用事务（claim / release / done / fail）

响应均为平铺：`{ ...issue, comment: IssueComment \| null }`（claim 为 `{ ...issue, knowledge: TaskKnowledge }`；done 额外带 `git_commit`，见下方 GIT-OBSERVABLE）。四个端点均幂等；comment 非空时 WS 先 comment.added 后 issue.changed。

release / done / fail 按是否携带 `workspace_id`（query 或 body）走两条实现路径，错误语义不同（`routes.ts:381-397`）：

| 路径 | 实现 | 任务缺失 | 未占用 | 占用者≠agent_id | agent_id='user' |
| --- | --- | --- | --- | --- | --- |
| 不带 workspace_id | `releaseIssue` / `doneIssue` / `failIssue`（`claim.ts:71-149`） | 404 `NOT_FOUND` | done/fail → 409 `CONFLICT`；release 任何状态可释放 | 409 `NOT_TASK_OWNER` | done/fail 豁免所有者校验 |
| 带 workspace_id | `scopedFinish`（`claim.ts:22-35`） | 404 `TASK_NOT_FOUND` | 409 `NOT_TASK_OWNER` | 409 `NOT_TASK_OWNER` | 不豁免（须与 claimed_by 完全相等） |

带 `Idempotency-Key` 时必须携带 `workspace_id`（`routes.ts:384`），即只走第二条路径。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/issues/:id/claim` | body：`agent_id: string 非空`、`knowledge_enabled?: boolean`（默认 true）、`knowledge_query?: string 1-500` | `{ ...issue, knowledge }`。原子占用（status→进行中、session_id=null 纯登记不建会话；仅未占用且 status∈{待规划,进行中} 可领取），并发领取仅一个成功；留言游标置为领取前最新评论；存在未验证图片时停在首条图片评论之前。**依赖门禁（DEP-1）**：前置未解除时 409，文案 `存在未完成的前置任务：<title>(<short id>)…；完成后可领取`，守卫与占用更新在同一 IMMEDIATE 事务内；`services/dispatch.ts` 派发路径同样被拦 | 400 agent_id 为空；**409 `ISSUE_CLAIMED`** 已被占（文案 `已被 <agent> 占用；先 release 或换卡，勿重复 claim`）/ **409 `ISSUE_STATUS_NOT_CLAIMABLE`** 无人占用但 status∉{待规划,进行中}（文案 `状态不可领取（当前=<status>，需=待规划 或 进行中）；无人占用，待验收卡由 owner 验收或由父代理退回待规划`）/ 409 前置未解除（DEP-1）；404 `TASK_NOT_FOUND`（带 workspace_id 且任务缺失/不归属） | routes.ts、`claim.ts:83-91`（CLAIM-MSG） |
| `POST /api/issues/:id/transfer` | body 严格 `{ from_agent, to_agent, reason?, fence?, workspace_id? }`（`workspace_id` 缺省走已解析的工作区上下文） | `{ ...issue, comment, claim_fence }`：当前占用者把占用交给另一个 agent，`claimed_by=to_agent`、`claim_fence+1`（旧占用者 fence 立即失效，收尾落 `STALE_FENCE`）、租约/心跳按领取重新起算、`session_id` 与留言游标解绑；写一条 `author=system` 的 `任务交接：<from> → <to>（原因）` 评论并广播 `comment.added` + `issue.changed`。状态保持「进行中」 | 400 缺 `workspace_id` / `from_agent`=`to_agent` / 字段非法；404 `TASK_NOT_FOUND`；409 `NOT_TASK_OWNER`（非当前占用者）/ `STALE_FENCE` / 无人占用或状态非「进行中」（`CONFLICT`） | routes.ts:1465 |
| `POST /api/issues/:id/heartbeat` | body：`agent_id: string 非空`、`fence?: 非负整数`（或 `x-claim-fence` 头；缺席=软模式） | `{ claimed_by, claim_fence, claim_lease_until, last_heartbeat_at, stop_requested }`。仅当前占用者可续租；`stop_requested` 与 `GET /api/issues/:id/stop` 同源（同一个 `getStopState`、同一个 db），心跳一次即可知道是否被要求停止；新增字段向后兼容，`/stop` 端点保留。不进幂等表（重放无意义）。WS issue.changed | 400 `agent_id` 为空 / fence 非法；404 任务不存在；409 未占用 / `NOT_TASK_OWNER` / `STALE_FENCE`。**LEASE-GAP**：租约过期被清扫（`sweepExpiredLeases`）后占用清空、任务保留「进行中」，此时原代次仍可用本地 fence 调 `done` / `fail` 收尾（`fence` 必须显式传且等于当前 `claim_fence`；抢占会自增 fence → `STALE_FENCE`），服务端落 system 评论留痕；`fence` 缺席不享受该口子。**清扫保留 git 基线**（卡 9fa0d16f）：租约过期不再删 `issue_git_baseline`，原代次 done 仍能按基线自动提交 | routes.ts:1203 |
| `POST /api/issues/:id/release` | 不带 workspace_id：无需 body（用户强制释放）；带 workspace_id：body `agent_id: string 非空` | `{ ...issue, comment }`。状态→待规划、清空占用。不带 workspace_id：comment author=`system` 内容「用户强制释放」、任何状态可释放；带 workspace_id：comment author=`agent:<agent_id>` 内容「占用者释放任务」 | 不带 workspace_id：404 任务不存在。带 workspace_id：404 `TASK_NOT_FOUND`；409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id | routes.ts:398 |
| `POST /api/issues/:id/done` | body：`agent_id: string 非空`、`notes?: string`（空串等价不写评论）、`scope_paths?: string[]`（最多 200 项，提交范围声明：文件路径或目录前缀）、`client?: 'cli'\|'mcp'`、`changelog_ack?: boolean`、`board_only?: boolean`（N3-10：纯看板任务跳过自动提交，返回 `git_commit.status='skipped'`；与 `scope_paths` 互斥）、`changelog_id?: uuid`（SK-05 变更日志门禁：带 `client` 时以下任一即放行——`changelog_ack=true`（含 CLI `--no-changelog` / MCP `skip_changelog:true`）、`changelog_id` 指向本工作区一条活动日志、库中已存在 `issue_id=本卡` 且 claim 之后创建的日志；都不满足 → 400 `CHANGELOG_ACK_REQUIRED`，done 未执行。不带 `client` 的 REST 直调保持旧行为） | `{ ...issue, comment, git_commit: IssueCommitResult \| null }`（同 key 重放返回首次结果、含同一 `git_commit`，且不重复提交；其它情况见下方 GIT-OBSERVABLE）。状态→待验收、清空占用；notes 非空时落评论（author=`agent:<agent_id>`），否则 comment=null。GIT-ON-DONE 提交范围：只提交 `scope_paths` 命中的路径，其余路径不提交并以 system 评论列出清单；**未声明 scope 时一律不提交**（`reason=NO_SCOPE`，评论列出全部脏文件 + 可复制补救命令），不再按 claim 基线宽提交——这条同时覆盖并行占用场景；要纳入全部改动必须显式声明 `.`。**claim 前就已未提交的文件**（指纹与基线相同、不在变化集）：落在 `scope_paths` 内的会被强制提交，评论标注「claim 前就已修改、按声明范围强制提交」；不在范围内或未声明时一律不提交，改为评论列出清单 + 可直接执行的 `git add -- … && git commit -m … -- …` 补救命令（不静默跳过）。详见 `gitBaseline.ts` 头注释。**SCOPE-GUARD**：声明了 `scope_paths` 却零命中时，系统评论以「⚠ 声明范围零命中，本次未自动提交」开头，列出声明范围与未提交文件，并给出可直接执行的两条命令（`git add -- …; git commit -m … -- …`）；done 本身仍然成功（不阻塞已完成的卡）。CLI 侧 `--scope` 建议每个路径一个，不要写逗号串（PowerShell 会拆/并参数；含空格的值会给 stderr 警告）。**不能自动提交的三档原因**（`detectGitRepo`，`gitBaseline.ts`；done 本身仍成功，只落一条 system 评论并回显声明范围）：① `GIT_NOT_INSTALLED` — `git --version` 失败（如容器镜像未装 git）：`跳过自动提交：环境未安装 git（GIT_NOT_INSTALLED，<path>）；声明范围：…`；② `NOT_A_GIT_REPO` — git 有但目录不是仓库或目录不存在：`跳过自动提交：工作区不是 git 仓库（NOT_A_GIT_REPO，<path>），如需自动提交请在该目录 git init；声明范围：…`；③ `GIT_REPO_UNHEALTHY` — 是仓库但 `git status` 失败（index/HEAD 损坏、权限）：`跳过自动提交：git 仓库状态异常（GIT_REPO_UNHEALTHY，<path>）：<具体错误>；声明范围：…`。**GIT-OBSERVABLE（卡 9fa0d16f）**：响应字段 `git_commit = { status: 'committed'\|'nothing'\|'not-committed'\|'unavailable'\|'skipped', reason, note, pending: string[] } \| null`；`note` 即落评论正文（含原因与可直接执行的补救命令），`pending` 是仍未提交的路径。`not-committed` 的 `reason` ∈ `NO_SCOPE`（未声明 scope：一个文件都不提交，列出全部脏文件与补救命令）/ `NO_BASELINE`（无 claim 基线，历史卡或早期租约清扫；有脏文件即上报，不再静默早退）/ `COMMIT_FAILED`（有基线但 git 提交失败，如 index.lock 残留、hook 拒绝）/ `ZERO_HIT`（声明范围零命中）。`unavailable` 对应三种不可用原因码，语义仍是「自动提交不适用」。`skipped` 是显式声明 `board_only=true`：跳过自动提交、不产生 `NO_SCOPE`，`reason=BOARD_ONLY`、`pending=[]`。done 本身在以上所有情况都成功进入待验收。**knowledge_hint**（T5-03）：本卡尚无可用主题页时返回 `{ message, suggested_slug }`，否则 `null`；`message` 是收尾提示（门禁已由 `client` 入口强制并满足时不再重复催写变更日志），`suggested_slug` 按「标签优先、标题/描述关键词兜底」映射——`server`/`服务端`/`后端`/`数据`→`agentboard-server-data`，`web`/`ui`/`前端`→`agentboard-frontend-ux`，`cli`/`命令行`→`agentboard-cli-ux`，`test`/`测试`/`门禁`→`agentboard-testing-gates`，`缺陷`/`坑`/`规则`及未命中→`agentboard-pitfalls`。 | 400 agent_id 为空；400 `scope_paths` 超限或空串；400 `BOARD_ONLY_SCOPE_CONFLICT`（`board_only=true` 与非空 `scope_paths` 同传：显式互斥，不做静默取舍，done 未执行、状态与占用不变）；400 `CHANGELOG_ACK_REQUIRED`（带 `client` 且三条件都不满足）/ `CHANGELOG_NOT_FOUND`（`changelog_id` 不存在或不属于本工作区），done 未执行、状态不变。不带 workspace_id：404 任务不存在、409 `CONFLICT` 未被占用、409 `NOT_TASK_OWNER` 仅当 agent_id≠'user' 且≠占用者。带 workspace_id：404 `TASK_NOT_FOUND`、409 `NOT_TASK_OWNER` 未占用或占用者≠agent_id（'user' 不豁免） | routes.ts:399 |
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
| `GET /api/sessions` | query：`workspace`（必填） | `Session[]`（created_at,id 升序），合并运行时字段 `queued_count` `waiting_slot`（来源：sessionManager 内存态，不入库）、派生字段 `paused`（= `paused_at` 非空，BORROW-4.3）与列表派生字段 `preview` `source`（一次查回首条 user 消息，避免 N+1；旧会话无消息时 `preview` 为空串，不报错） | 400 缺 workspace；404 工作空间不存在 | routes.ts:1332 |
| `GET /api/sessions/:id` | — | `Session` + `queued_count` `waiting_slot` + 派生 `paused` | 404 会话不存在 | routes.ts:1360 |
| `GET /api/sessions/:id/queue` | — | `{ texts: string[] }`：当前内存排队文本副本（只读，无编辑接口） | 404 会话不存在 | routes.ts:439 |
| `GET /api/sessions/:id/messages` | query：`after?: 非负整数毫秒时间戳`（默认 0） | `Message[]`（ts 升序，ts>after） | 400 after 非法；404 会话不存在 | routes.ts:444 |
| `GET /api/sessions/:id/events` | query：`after_seq?: 非负整数`（默认 0） | `SessionEvent[]`（`session_id` `seq` `type` `payload` `created_at`，seq 升序、seq>after_seq）；BORROW-4.2：本表上线前的老会话返回 `[]`，不回填历史 | 400 after_seq 非法；404 会话不存在 | routes.ts:1231 |
| `POST /api/sessions` | body：`cli: string 非空`、`model?: string\|null`、`issue_id?: string`、`workspace_id?: string`（**issue_id 为空时必填**）、`prompt?: string`、`reuse_session?: 'last'\|'new'`（'last' 复用该任务已绑定会话的 adapter_session_id）、`knowledge_enabled?: boolean`、`knowledge_query?: string 1-500`、`selected_attachment_ids?: UUID[]`（仅 issue-bound session 可用，最多 100 个）、`retry_unknown_images?: boolean`（实际投递前缀含 unknown 时必须为 true） | 绑 issue：派发（自动 claim + 起首轮）；按评论顺序把所选图片截断为最多 5 张、总计 ≤20 MiB 的前缀；其余图片保持待读并追加 `另有 N 张未附`，返回 `{ ...session, knowledge, remaining_attachment_count }`。知识参考块（`knowledge_enabled` 默认开）只列 `id + knowledge:<id> + 标题 + scope/revision`，不内联正文，会话按需 `kb knowledge show <id>` 读取；无命中时 prompt 不含该块。图片输入能力未验证时不派发所选图片。自由会话返回 `Session`，不含剩余图片计数。WS：绑 issue 先 issue.changed，再 session.changed | 400 issue_id 为空未给 workspace_id 或图片ID未绑定 issue；400 未知字段（body 为 strict，含把 `prompt` 误写成 `promptTemplate` 的反例）；400 未知 CLI、选择 ID 超过 100、`IMAGE_DELIVERY_IN_PROGRESS`、`IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED` 或 `IMAGE_DELIVERY_UNVERIFIED`；404 任务 / 工作空间 / 图片不存在；409 `ISSUE_CLAIMED` 已被占用（CLAIM-MSG，文案含占用者） | routes.ts:456 |
| `POST /api/sessions/:id/messages` | body：`text: string 非空` | `{ queued: boolean }`；false=空闲立即起轮（状态回运行中），true=入队待合并（运行时变化经 WS session.runtime）。两种情况均先落 user 消息（WS message.added）。BORROW-4.3：会话已暂停（`paused_at` 非空）时恒返回 `true`，消息落库并入队，等恢复后按序交付 | 400 text 为空；404 会话不存在 | routes.ts:1453 |
| `POST /api/sessions/:id/stop` | — | `Session`（status=已结束）；kill 当前轮，队列保留（暂停标记不变） | 404 会话不存在 | routes.ts:1498 |
| `PATCH /api/sessions/:id` | body：`model?: 非空 string\|null`、`title?: 1-50 字 string\|null`（两者可同时给；null 均表示清空——model 回落 CLI 默认、title 回落派生标题）、`archived?: boolean`、`paused?: boolean`（BORROW-4.3，必须单独提交，不能与前三者同批） | 非 paused：`Session`（含派生 `paused`），WS session.changed；`paused=true`：`Session`（`paused=true`）并写 `session_event(type=session.paused)` + WS `session.paused`；`paused=false`：`Session`（`paused=false`，附加 `resume_after_seq`）并写 `session_event(type=session.resumed)` + WS `session.resumed`，随后消费暂停期队列 | 400 四键都缺 / model 空串 / title trim 后为空或超 50 字 / paused 与其它键同批；404 会话不存在 | routes.ts:1538 |

### 会话暂停 / 恢复（BORROW-4.3，`session.paused_at`，不重建表）

存储：`session.paused_at INTEGER NULL`（`db/migrations/sessionPaused.ts`，`ensureColumn` 幂等加列，老库自动补、连跑两次结果一致；**不重建 `session` 表**——`message` / `session_turn` / `session_event` 均有 FK 指向它，重建有级联清空风险）。存量行为 `NULL` = 未暂停。

语义（写死）：

- `paused_at` 非空即视为暂停；`session.status` 语义不变（仍是 `运行中 | 已结束 | 失败`），读接口另给派生字段 `paused`。
- 暂停只拦「开始新轮次」：**不 kill 正在执行的工具/子进程，不撤销已写入的步骤或消息**。工具步骤在 CLI 进程内，服务端无法逐步骤暂停，在途轮次会自然跑完。
- 暂停期间的入站消息照常落 `message` 行并入会话队列（`POST /api/sessions/:id/messages` 返回 `{ queued: true }`），**恢复后按入队顺序合并交付，不丢**。
- 恢复**不重放已完成步骤**：`session.paused` / `session.resumed` 本身各写一条 `session_event` 行，恢复响应带 `resume_after_seq`（恢复事件的 seq）；已完成消息/步骤的 seq 全部 ≤ 该值，客户端从 `GET /api/sessions/:id/events?after_seq=<resume_after_seq>` 之后续拉即可，服务端不重发 message、不重跑 turn。
- 重复暂停 / 未暂停时恢复均为幂等空操作（不重复写事件）。



### 轮次底座（CHAT-TURN1，`session_turn` + `message` 三列，无新增 HTTP 端点）

存储（`db/migrations/sessionTurn.ts`，`initSchema` 里在 `migrateSessionTitle` 之后执行；全幂等、**不回填空历史行**）：

- `session_turn(id, session_id → session(id) ON DELETE CASCADE, seq, state, current_index, plan_json, awaiting_json, usage_json, started_at, ended_at)`，`UNIQUE(session_id, seq)`；`state ∈ running | awaiting_input | awaiting_approval | failed | done | stopped`。
- `message.turn_id` / `message.step_id` / `message.meta_json`（旧行三列恒 `NULL` → 前端沿用旧渲染，验收 5）。
- `plan_json = [{ step_id, title, state }]`，`step_id` 轮内稳定（`s1/s2/…`，只追加不重排，供 CHAT-RETRY1 定位重跑点），步骤 `state ∈ pending | running | done | failed | awaiting`。
- `meta_json = { status, duration_ms, output_summary, tool_call_id, diff? }`；`diff.files[].patch` 由服务端按 **400 行/文件**截断并标 `truncated`。`tool_call_id` 暂用 `step_id` 充当关联键（适配器不给调用 id）。
- `awaiting_json = { reason, message?, at? }` 是**唯一的机器可判原因通道**：`failed` / `stopped` 必带 `reason`（本卡已落 `adapter_resolve_failed`、`adapter_run_failed`、`adapter_threw`、`adapter_exit_nonzero`、`image_delivery_unverified`、`attachment_mark_failed`、`image_attachment_selection_invalid`、`superseded`、`user_stop`、`turn_internal_error`、`server_restart`）；CHAT-AWAIT1 直接写 `awaiting_timeout` 即可，无需改表；CHAT-AWAIT1b 的超时基准是「最后一次心跳 + 15 分钟」（心跳持续延长窗口），并另有自进入阻塞起 2 小时的绝对上限（心跳不断也强制收口）。
- **唯一写入方是服务端 `sessionManager`**（`services/turnObservation.ts` 的 tracker 只在 `executeTurn` 内被调用），客户端没有写接口；`session.status` 未新增取值（仍是 `运行中 | 已结束 | 失败`，排队/等槽位继续走 `session.runtime`），`awaiting_*` 只落在 turn 上。
- 影响面：`GET /api/sessions/:id/messages` 返回体每条多三个字段（旧消息为 `null`），其余请求/响应形状不变。

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
| `GET /api/knowledge/pages/:id/revisions` | query：`scope`（workspace\|common）、`workspace_id?`、`limit? 1-50`（默认 20）、`offset?`、**`include_body? true\|false`（默认 false）** | `{ items: KnowledgeRevisionSummary[], next_offset }`（revision 降序；next_offset 在本页满 limit 时为 offset+limit，不预读下一页）。**列表项不含 `body_snapshot`（正文），只给 `body_bytes` / `body_chars` 摘要**；`include_body=true` 时才带 `body_snapshot`（兼容旧调用方） | 404 `KNOWLEDGE_NOT_FOUND`；400 分页参数 | knowledgeRoutes.ts:136 |
| `GET /api/knowledge/pages/:id/revisions/:revision` | query：`scope`、`workspace_id?`；路径参数 `revision` 为正整数 | `KnowledgeRevision` **全量快照**（含 `body_snapshot`、`sources`、`evidence`），供「点某版本看 diff」按需取单条 | 404 `KNOWLEDGE_NOT_FOUND` / `KNOWLEDGE_REVISION_NOT_FOUND`；400 `revision` 不合法 | knowledgeRoutes.ts:148 |
| `GET /api/knowledge/pages/:id` | query：`scope`、`workspace_id?` | `KnowledgePage` 全量 | 404 `KNOWLEDGE_NOT_FOUND` | knowledgeRoutes.ts:47 |
| `POST /api/knowledge/pages`（幂等） | body：`scope`、`workspace_id?`、`slug: string`（1-200，`/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/`，禁 `..`）、`title`（1-300）、`body_md`（1-100000）、`sources: 1-100`、`evidence: 1-100`、`actor`（1-100）、`change_note?`（≤2000）、`expires_at?: number\|null` | `KnowledgePage`（status=active、revision=1）。sources/evidence 规则：来源 id 唯一、证据须引用本版本来源、非 file 来源必须带 snapshot 摘录（≤2 KiB）、file 来源只存路径与 sha256 | 400 校验 / slug 非法 / 工作空间不存在；409 `KNOWLEDGE_EXISTS` 范围内 slug 重复 | knowledgeRoutes.ts:52 |
| `PUT /api/knowledge/pages/:id`（幂等） | body：`scope`、`workspace_id?`、`expected_revision: int ≥1`、`title? body_md? sources? evidence? expires_at?`（至少一个）、`actor`、`change_note?` | `KnowledgePage`（revision+1） | 400 校验（含合并后内容规则复验）；404 `KNOWLEDGE_NOT_FOUND`；409 `KNOWLEDGE_REVISION_CONFLICT`（details `current_revision`）；409 `KNOWLEDGE_STATE_CONFLICT` 页已 deleted（archived 页可修订，`knowledge.ts:56`） | knowledgeRoutes.ts:58 |
| `POST /api/knowledge/pages/:id/actions`（幂等） | body：`scope`、`workspace_id?`、`action: archive\|restore\|delete`、`expected_revision: int ≥1`、`actor` | `KnowledgePage` | 400 未知操作；404 `KNOWLEDGE_NOT_FOUND`；409 `KNOWLEDGE_REVISION_CONFLICT` / `KNOWLEDGE_STATE_CONFLICT`（前置：archive←active、restore←archived、delete←active\|archived；deleted 页拒绝一切操作，`knowledge.ts:56`） | knowledgeRoutes.ts:62 |

**BORROW-5.1 每页快照与单页提交**（决策 c0cb9509 选项 A，`services/knowledgePageCommit.ts`）：`POST /pages`、`PUT /pages/:id`、`POST /pages/:id/actions` 三个写端点成功后，把该页写成 `<ws>/.agentboard/snapshot/knowledge/<page_id>.md`（front matter：`id/slug/title/scope/revision/status/updated_at` + 正文），并只提交这一个路径（`git add -A -- <path>` + `git commit -- <path>`）。响应新增 `page_commit`：

- `{ path, relative_path, committed, commit, reason, skipped?, rollback_failed? }`；`scope=common` 或无对应工作区时为 `null`；
- 提交失败**不回滚知识页本身**（库是事实源），只在 `reason` 里给出原因（形如 `<阶段> 失败：<git stderr 首行>`，能直接看到 `index.lock` 等真因），且文件回滚到改动前（新建的删掉、已有的还原），不留半提交；
- 回滚自身失败（KB-SNAP-ROLLBACK）：`rollback_failed=true`，原因以 `；回滚失败（<还原快照文件|清暂存>）：<git stderr>` 拼进同一 `reason`，服务端另 `console.error` 一条含 `relative_path` 的日志；此时工作树/索引可能残留该页路径，需人工 `git status` 检查（不重试，可观测优先）。`git add` 未成功时不调 reset、不算回滚失败（索引里没有本次内容，锁未释放导致的 reset 失败是噪音）；
- `committed=false` 且 `skipped=true` 表示**不是失败**（无快照可提交 / 无变更），客户端不应报警；缺失 `skipped` 视为真实失败；
- CLI（KB-SNAP-SILENT）：`page_commit.committed=false && skipped!==true` 时，文本与 `--json` 模式都在 **stderr** 打印快照路径与 `reason`，并 **exit 1**；`--json` 的 stdout 仍是单个页面 JSON 文档（失败信号看退出码与 `page_commit`，不插入错误 JSON）；
- `archive`/`restore` 重写同一路径并由 front matter 的 `status` 标注归档态；`delete`（软删）则删除该页快照并提交删除；
- 内容未变化时不造空提交（`committed=true` 但 `commit` 指向已有 HEAD）；批量导入 `/pages/import` 不接线（一次请求多页，与「只含该页路径」冲突；KB-SNAP-IMPORT 方案 3 定案）：响应带显式跳过信号 `page_commit: { committed: false, skipped: true, reason, path: "", relative_path: "", commit: null }`，不是失败；CLI `kb knowledge import` 文本模式在 stderr 打印一行该 reason，`--json` 保持机器可读。


### 11.1 CLI 对应命令（`kb knowledge *`，`packages/cli/src/commands/knowledge.ts`）

| 端点 | CLI | 必填 | 备注 |
| --- | --- | --- | --- |
| `GET /api/knowledge/search` | `kb knowledge search <query>` | `<query>` | `--scope both` 默认；`--limit` 1-20 |
| `GET /api/knowledge/pages` | `kb knowledge list` | `--scope`（workspace\|common，`requiredOption`，缺省 exit 1，不按 cwd 猜） | 非 `--json` 每页一行，有下一页时打印 `下一页：--offset <n>` |
| `GET /api/knowledge/pages/:id` | `kb knowledge show <page-id>` | 无（`--scope` 可省略，省略时先 `resolve` 再取页） | `--history` 追加版本历史；显式 `--scope` 时行为与旧版一致 |
| `POST /api/knowledge/pages` | `kb knowledge create` | `--scope`、`--title`、`--slug`、`--domain`（必填）、`--stdin`、`--sources`/`--sources-file`、`--evidence`/`--evidence-file` | 缺项一次列全；字段级中文报错 |
| `PUT /api/knowledge/pages/:id` | `kb knowledge revise <page-id>` | `--scope`、`--expected-revision`、至少一个改动字段 | revision 冲突退出码 2 |
| `POST /api/knowledge/pages/:id/actions` | `kb knowledge action <page-id> <action>` | `--scope`、`--expected-revision` | `action` ∈ `archive\|restore\|delete` |

create 最小用法（PowerShell 复制可用；`sources.json`/`evidence.json` 见 `kb knowledge create --help`）：

```powershell
Get-Content body.md -Raw | kb knowledge create --scope common --title '缓存策略' --slug cache-policy --domain knowledge --stdin --sources-file sources.json --evidence-file evidence.json
kb knowledge show <page-id> --scope common
Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 1 --stdin --title '缓存策略 v2'
kb knowledge action <page-id> archive --scope common --expected-revision 2
```

`--sources[].content_hash` 取文件 sha256：`(Get-FileHash README.md -Algorithm SHA256).Hash.ToLower()`；或用 `--hash-from-file <source_id>=<path>`（可重复）自动按 source_id 精确回填，未匹配/文件不存在退出码 1 并点名。`captured_at` 取 `[DateTimeOffset]::Now.ToUnixTimeMilliseconds()`。

`--sources-file` / `--evidence-file` 读文件时先按字节剥 UTF-8 BOM 再 `JSON.parse`，命中时 stderr 打印「检测到 UTF-8 BOM，已剥离后解析」。

`--domain`（知识领域：accounts/knowledge/board/chat/ui/infra，create 必填）与 `--scope`（页归属：workspace/common）是两个独立维度，互不替代；示例 `--scope common --domain infra`。

### 11.1b CLI `--json` 输出形状（KB-CLI-3c，契约 knowledge:bb929054-1d44-4542-bb96-4530e42b0546）

- **列表类命令**（`list-tasks` / `list-spaces` / `knowledge list` / `changelog list` / `decisions` / `status ls` / `dep ls` / `accounts list`）→ `{ "items": [...], "next_offset": number | null }`；空结果是 `{"items": [], "next_offset": null}`，两个字段都出现，不省略。`dep ls` 的四组视图（blockers / blocked / related / duplicate）摊平成一条 `items`，每项多一个 `direction` 标明方向。
- **单对象命令**（`show` / `claim` / `done` / `close` / `settings` / `knowledge show` / `decision` / `changelog show` / `workspace-db *`）→ 对象直出，不套 `items`。
- 服务端本就返回 `{ items, next_offset }` 的分页视图（`knowledge search`、`knowledge revisions`、`changelog list`、`decisions`）原样透传，`next_offset` 缺省补 `null`。
- stdout 只放 JSON；提示/警告一律走 stderr。复算命令要按信封取数：`kb list-tasks --json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).items.length"`。
- 输出体积观测（ARCH-06，环境变量 `KB_METRICS`）：设为 `1` 时命令结束前向 **stderr** 追加一行 `[kb] cmd=<顶层命令名> out=<写入 stdout 的 UTF-8 字节数>B lines=<行数>`；`0`/未设完全不输出（stdout/stderr 与改造前逐字一致）。该行只走 stderr，不破坏 `--json` 的 `JSON.parse`，不改变退出码；嵌套命令取顶层名（如 `kb knowledge search` → `knowledge`）。

### 11.2 CLI 退出码表（`kb --help` 末尾同源，`index.ts` `EXIT_CODE_HELP`）

| 码 | 含义 | 典型命令与实测 |
| --- | --- | --- |
| 0 | 成功（`--help` / `--version` 同样 0） | `kb --version` / `kb done …` |
| 1 | 参数或用法错误、服务端非冲突错误（400/404/500）、看板服务不可达；命令未改动数据。含 `kb dep` 的「任务不存在」（`NOT_FOUND` / `TASK_NOT_FOUND`）与 `kb answer` 的 403 `DECISION_HUMAN_ONLY` | `kb done <不存在 id>` → `任务不存在`；`kb dep add <不存在 id> <前置>` → `任务不存在或不属于该工作区`；`kb answer <决策> --option 1`（agent 身份）→ `仅人类可回答决策…`；`kb delete-issue <id>` 缺 `--yes` → 只回显标题/状态、不发 DELETE；`kb delete-space <空间>` 缺 `--yes` → 只回显名称/路径；`kb nope` → `unknown command` |
| 2 | 冲突，命令未改动数据：占用（`已被 <agent> 占用`）/ `未被占用` / 非当前占用者 / 状态不可领取 / 决策锁（`DECISION_LOCKED`）/ 知识页 revision 冲突 / 幂等键复用 / 删除被阻塞（占用中、含子任务、仍有知识页或运行中会话）/ 任务 id 前缀多命中 / **结构环（`DEPENDENCY_PARENT_CYCLE`）** | `kb claim <已被占>`、`kb claim <待验收>`、`kb claim <有 open 决策的卡>`、`kb done <未占用>`、`kb delete-space <有知识页> --yes`、`kb dep add <子卡> <其祖先>` |
| 3 | `kb dep` 与待决策族（`kb ask` / `kb answer` / `kb ask-extend`）专用：依赖或决策参数错误（自环 / 跨工作区 / `VALIDATION_ERROR` / 选项不足 / 非法 grace 或 seconds） | `kb dep add <id> <同一 id>` → `不能依赖自身…`；`kb ask <id> --grace abc` → 参数非法 |
| 4 | `kb dep` 专用：依赖边不存在（仅 `dep rm`） | `kb dep rm <id> <无该边的前置>` → `依赖边不存在…` |

**`kb done` 退出码例外（GIT-OBSERVABLE，卡 9fa0d16f）**：done 已生效（状态→待验收；`--close` 时→已关闭）但自动提交未完成时，CLI 把「未提交 + 原因 + 可照抄补救命令」写 stderr 并以 **1** 退出；`--json` 仍只输出单个 issue JSON（读 `git_commit.status/reason`），不改变 stdout 结构。`git_commit.status='unavailable'`（未装 git / 非仓库 / 仓库损坏）只警告、退出码 0。**纯看板任务用 `kb done --board-only`（MCP `board_only: true`）显式跳过提交**：返回 `status='skipped' / reason='BOARD_ONLY' / pending=[]`，不列脏文件、不写 stderr、退出码 0；不带该参数时仍按 `NO_SCOPE` 报错并 exit 1。`done --close` 遇到阻断性提交缺口会**跳过 close**（退出码 1），修复后执行 `kb close <id>`。
受影响面：仓库内 `scripts/` 没有解析 `kb done` 退出码的脚本；需要改判的是外部编排（把 `kb done` 放在 `&&` 链里、或把退出码 0 当作「工作树已干净」的 cron / CI / agent 工作流）——改为读 `git_commit.status`。MCP 工具直连 REST（`apps/mcp/src/tools/tasks.ts`），不经 CLI，退出码不变，可直接使用新增的 `git_commit` 字段。

约定：原因一律写 stderr（`kb done` 的自动提交警告可多行，含补救命令）；`--json` 只改 stdout 结构，不改退出码。`done` 的「占用 2」与「参数 2」都以 2 上报，区别在文案（`未被占用：如需推进请先 kb claim…` vs 参数错误列表），脚本只按 2 判「当前不可完成」即可。

**`kb done` 收尾选项与变更日志门禁（SK-05）**：`--close-record`（CLI 先写一条带本卡 `issue_id` 的 changelog，再 done，子步骤失败不落 done）、`--no-changelog`（显式声明没有用户可见变更，与 `--close-record` 互斥）、`--board-only`（纯看板任务跳过自动提交，与 `--scope` / `--all` 互斥，返回 `skipped/BOARD_ONLY` 且退出码 0、不写 stderr）、`--all`（显式纳入全部未提交改动）。CLI 调 `POST /api/issues/:id/done` 时带 `client:'cli'` 与 `changelog_ack`（`--close-record` / `--no-changelog` 时为 true）。不带 ack 时服务端按顺序检查：请求里的 `changelog_id`（不存在 → 400 `CHANGELOG_NOT_FOUND`）、库中 `issue_id=本卡` 且 claim 之后创建的日志；都不满足 → 400 `CHANGELOG_ACK_REQUIRED`（CLI 退出码 1，done 未执行、状态不变）。先写日志走 `kb changelog create --issue <卡 id> --title … --type 修复 --stdin`。MCP 对应 `create_changelog` 的 `issue_id`、`complete_task` 的 `changelog_id` / `skip_changelog`。

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
| `session.paused` | `{ session_id, paused_at, session }` | BORROW-4.3：PATCH /api/sessions/:id `paused=true`（暂停只拦新轮次，不 kill 在途工具）；前端消费归后续聊天视图卡 |
| `session.resumed` | `{ session_id, paused_at: null, session, resume_after_seq }` | BORROW-4.3：PATCH /api/sessions/:id `paused=false`；`resume_after_seq` 是事件流续拉锚点（不重放已完成步骤）；前端消费归后续聊天视图卡 |
| `message.added` | `{ message: Message }` | 每条消息落库（user/assistant/event/error） |
| `clis.changed` | `{ clis: CliInfo[] }` | 服务启动探测完成后一次（`index.ts:67`）；运行期无刷新端点 |
| `account.notice` | `{ app_id, client_instance_id, message }` | 账号切换 safe-exit 降级：UIA 托盘退出失败后提示用户手动退出 WorkBuddy（ACC-05，`accountRoutes.ts` → provider broadcast）；前端仅提示不失效查询 |
| `session.plan` | `{ session_id, turn_id, plan: TurnPlanStep[], current_index }` | CHAT-TURN1 契约 #18：轮次计划**变更即推**（追加步骤 / 步骤收口 / 轮次收口各一次，同批变更合并）。`plan` 是快照副本，`current_index` 为当前打开步骤的下标（无步骤 = -1，轮次收口 = plan.length）。CLI 不声明计划，所以步骤 = 一次 `tool` 事件，无 tool 事件时 `plan` 为 `[]`（前端隐藏计划条） |
| `session.usage` | `{ session_id, turn_id, usage: TurnUsage }` | CHAT-TURN1 契约 #21：用量**合并节流**推送（窗口 `TURN_USAGE_THROTTLE_MS = 250ms`，窗口内的多次 delta 只在末尾推一次；轮次收口再推最终一次）。本卡无 CLI token 来源，`input/output/context_used_tokens` 按约 4 字符 = 1 token 估算并恒带 `estimated: true`，`cost_usd` / `context_limit_tokens` 为 `null`（不编造） |

**`session.plan` / `session.usage` / `session.turn` / `session.approval_request` / `session.paused` / `session.resumed` 在服务端侧走 `ServerWsEvent = WsEvent | TurnObservationEvent | DecisionEvent | SessionControlEvent`（`packages/shared/src/types.ts`），刻意没有并进 `WsEvent`**：`apps/web/src/api/ws.ts::eventToQueryKeys` 是对 `WsEvent` 的无 default 穷尽 switch，加成员会让前端 `tsc --noEmit` 直接失败。

## 13. 枚举汇总

| 枚举 | 取值 |
| --- | --- |
| IssueStatus | `待规划 \| 进行中 \| 待验收 \| 已关闭`（types.ts:1） |
| Priority | `低 \| 中 \| 高`（types.ts:2） |
| SessionStatus | `运行中 \| 已结束 \| 失败`（types.ts:3） |
| ModelInfo.source | `probed \| static \| manual`（types.ts:72） |
| Message.role | `user \| assistant \| event \| error`（types.ts:66） |
| CLI id（CliInfo.id / sessions.cli） | `codebuddy \| codex \| opencode \| dsh`（adapters/src/index.ts:14） |
| SessionTurnState（`session_turn.state`） | `running \| awaiting_input \| awaiting_approval \| failed \| done \| stopped`（CHAT-TURN1，types.ts） |
| TurnStepState（`plan_json[].state`） | `pending \| running \| done \| failed \| awaiting`（CHAT-TURN1） |

状态流转：issue 由 claim（→进行中）/done（→待验收）/fail、release（→待规划）驱动；PATCH 可直接改 status，但占用中禁改。session 由轮次生命周期驱动：运行中 →（正常/停止）已结束、（异常退出/起轮失败）失败。

## 14. accounts（`/api/managed-accounts`、`/api/account-operations`，accountRoutes.ts，ACC-05）

WorkBuddy Desktop 账号捕获/切换。设计见 `Docs/designs/accounts/2026-11-01-workbuddy-accounts.md` §6/§8 与 `Docs/DESIGNS.md`「账号 provider：WorkBuddy Desktop」。响应只含脱敏元数据（无 identity_hash、快照引用、信封或凭据字节）；同一 client_instance_id 的操作经 operationRunner 串行并独占锁；实例存在 recovery_required 操作时写类请求一律 409 `RECOVERY_REQUIRED`（先走 `POST /api/managed-accounts/:id/restore` 解冻，见下表）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| `GET /api/managed-accounts` | query：`app?`（`workbuddy_desktop` / `codebuddy_desktop` / `minimax` / `trae` / `qoder_cn` / `zcode`，与 `packages/shared` 的 `ManagedAppId` 一致（六值；`qoder_cn` / `zcode` 自 ACC-KB-B1S 起登记，provider 未实现，能力矩阵全关并给 `PROVIDER_NOT_IMPLEMENTED`）） | `Array<PublicManagedAccount & { is_current: boolean\|null }>`（created_at,id 升序；is_current 按 provider 只读身份比对，provider 未装配时 null）。**ACC-SW-VALID-A**：WorkBuddy 行额外带逐账号 `switch_available: boolean` 与 `switch_reason_code: 'PROVIDER_UNAVAILABLE'\|'TARGET_INSTANCE_MISMATCH'\|'SNAPSHOT_MISSING'\|null`（其余平台不填，前端回退平台级能力） | 400 app 非法 | accountRoutes.ts:174 |
| `POST /api/managed-accounts/:app/capture-current` | body：`display_name?`（1-100）、`target_account_id?`（UUID，仅 WorkBuddy；ACC-SW-VALID-A 协议行补齐入口） | `{ account: PublicManagedAccount }`；同步执行（preflight→快照 DPAPI 加密→复读身份）。传 `target_account_id` 时：读本机登录 uid 并算 `sha256(app_id + NUL + uid)` 与目标行 `identity_hash` 比对，匹配则在事务内把原行 `client_instance_id`/`identity_hash`/快照/签到凭据就地补齐（保留 id、名称、签到历史），本机取不到新 token 时按原 scope 解出旧签到凭据并重封装；不匹配则原行不变 | 400 `target_account_id` 非 UUID / 非 WorkBuddy 传了该字段；404 `NOT_FOUND` 目标账号不存在；409 `PROVIDER_UNVERIFIED`（codebuddy_desktop，details.reason_code=TARGET_KIND_UNCONFIRMED） / 409 `CLIENT_INSTANCE_NOT_FOUND` `CLIENT_VERSION_UNSUPPORTED`（非 5.9.3.x）`CLIENT_SCHEMA_UNSUPPORTED`（v1 明文）`CLIENT_NOT_RUNNING` `IDENTITY_UNAVAILABLE`（缺 uid）`IDENTITY_CHANGED` `ACCOUNT_EXISTS` `TARGET_IDENTITY_MISMATCH` `CHECKIN_CREDENTIAL_UNAVAILABLE`；409 `RECOVERY_REQUIRED` 实例冻结；503 `PROVIDER_UNAVAILABLE` / `VAULT_*` | accountRoutes.ts:186 |
| `POST /api/managed-accounts/:id/switch` | — | 202 `{ operation_id, operation: AccountOperation }`；执行异步，阶段 preflight→stop→snapshot→validate_target→write→start→verify→(rollback)，结果轮询 `GET /api/account-operations/:id` | 404 `NOT_FOUND` 账号不存在；409 `PROVIDER_UNVERIFIED` / `RECOVERY_REQUIRED`；切换失败码见下 | accountRoutes.ts:197 |
| `POST /api/managed-accounts/:id/restore` | body 可省略 | 202 `{ operation_id, operation: AccountOperation, recovered_operation_id, replayed: boolean }`。**解冻通道（ACC-KB-A3 已交付）**：取该实例最新的 `recovery_required` 操作，发起 `operation='restore'` 并经 operationRunner 收尾——原操作转 `failed` + `safe_error_code='RESTORED'`，实例随即不再被 `RECOVERY_REQUIRED` 挡住。**幂等**：已解冻过的实例再调返回原 restore 操作（`replayed=true`），不新建 operation 行、不会把已恢复实例二次置 failed。**B4S-3 起本端点也是唯一的回滚通道**：被冻结操作的 `recovery_ref`（= 快照 vault ref）存在且该平台注册了 `RestoreHandler` 时，端点会**真正把快照写回客户端**再解冻；处理器失败 → restore 操作 `failed`、实例保持冻结、可再次触发本端点重试；未注册处理器的平台保持原「人工确认已恢复/放弃恢复」语义 | 400 `id` 非 UUID；404 `NOT_FOUND` 账号不存在；409 `RECOVERY_NOT_REQUIRED` 该实例没有需要解冻的操作 | accountRoutes.ts:216、`services/accounts/restore.ts` |
| `PATCH /api/managed-accounts/:id` | body：`{ enabled: boolean }`（strict） | `PublicManagedAccount`（脱敏）。`enabled` 此前只有读取（签到授权 `ACCOUNT_DISABLED`、签到执行 `ACCOUNT_DISABLED`、前端参与判定），本端点补上写入路径（ACC-KB-A2） | 400 id 非 UUID / body 形状不对；404 `NOT_FOUND`；409 `ACCOUNT_BUSY`（该账号有排队或进行中的操作） | accountRoutes.ts:229、`db/repos/managedAccount.ts` |
| `DELETE /api/managed-accounts/:id` | — | `{ deleted: true, id }`；先删 vault 里的快照/签到凭据文件（`delete` 幂等），再删元数据行；`account_operation.account_id` 由 FK `SET NULL`，签到相关行 `CASCADE`。响应不含任何凭据/信封/快照引用 | 400 id 非 UUID；404 `NOT_FOUND`；409 `ACCOUNT_BUSY`（有排队或进行中的操作）/ `CHECKIN_AUTHORIZATION_EXISTS`（有未过期的签到授权）/ `RECOVERY_REQUIRED`（最近一次切换仍需恢复，快照是恢复依据）；503 `VAULT_UNAVAILABLE` | accountRoutes.ts:244 |
| `GET /api/managed-account-capabilities` | query：`app?`（同上四个枚举值；缺省返回全部） | `AccountCapability[]`（`app_id` + `capture`/`switch`/`checkin` 三态与原因码；含 minimax 客户端探测结果，60s 缓存） | 400 app 非法 | accountRoutes.ts:272 |
| `POST /api/accounts/import-credentials` | body：`{ platforms?: ('workbuddy'\|'trae'\|'minimax')[]（1-3，缺省全部）, actor?: string（≤100） }`（strict） | `CredentialImportResult`（逐平台 found/created/updated/skipped/error + 导入账号摘要；**不含 token/明文/路径**）。唯一入口：只在显式调用时读本机凭据，无启动或定时扫描（ACC-11）。单平台脚本默认 180s 超时，超时该平台 `error=EXPORT_TIMEOUT`（整批仍 200，不 500）。minimax 记录若带 `refreshToken`，vault 存 `{access_token,refresh_token,expires_at}` JSON 而非裸串（旧裸串仍兼容） | 400 body 非法；503 `VAULT_UNAVAILABLE` 凭据保险库未装配 | accountRoutes.ts:282 |
  - ACC-FIX-7：trae 平台在本端点短路（内存扫描对 Trae CN 实测无效且拖 3-4 分钟），恒返回 found=0/error=null；Trae 账号获取走 POST /api/managed-accounts/trae/capture-current。
| `POST /api/checkin-authorizations/start`（幂等，需 `Idempotency-Key`） | body：`{ account_id: uuid }`（strict） | 202 `{ authorization: CheckinAuthorization }`；为账号发起签到授权会话（回填凭据走 `attachCheckinCredential`，并把 `checkin_capability` 置 `supported`） | 400 body 非法；404 账号不存在；409 `PROVIDER_UNVERIFIED` / `CHECKIN_AUTH_UNSUPPORTED`（三平台均走本机凭据导入，不支持授权流程）/ `ACCOUNT_DISABLED`；503 `VAULT_UNAVAILABLE` | accountRoutes.ts:290 |
| `POST /api/checkin-authorizations/:id/poll` | — | `{ authorization, account }`；轮询授权状态，成功时落签到凭据 | 404 签到授权或账号不存在；409 `PROVIDER_UNVERIFIED` / `CHECKIN_AUTH_UNSUPPORTED` | accountRoutes.ts:304 |
| `POST /api/checkin-runs`（幂等，需 `Idempotency-Key`） | body：`{ app_id: 四枚举值, account_ids: uuid[]（1-50） }`（strict） | 202 `{ batch: CheckinBatch, replayed: boolean }`；建批次并后台逐账号执行；重放不重复提交 | 400 body 非法/账号不属于该产品；404 账号不存在；409 `ACCOUNT_BUSY`（同账号已有进行中操作）/ `PROVIDER_UNVERIFIED`；503 `VAULT_*` | accountRoutes.ts:315 |
| `GET /api/checkin-runs/:batchId` | — | `CheckinBatch`（逐账号 item 状态与固定错误码） | 404 批次不存在 | accountRoutes.ts:334 |
| `POST /api/checkin-runs/:batchId/cancel` | — | `{ batch_id, cancelled: uuid[], running: uuid[] }`；只撤销仍 `queued` 的项 | 404 批次不存在；409 `CHECKIN_BATCH_FINISHED` 批次已结束 | accountRoutes.ts:340 |
| `GET /api/account-operations` | query：`batch_id`（uuid，必填） | `AccountOperation[]`（created_at,id 升序） | 400 `batch_id` 非 UUID | accountRoutes.ts:350 |
| `GET /api/account-operations/:id` | — | `AccountOperation`（state/stage/safe_error_code，无敏感字段） | 404 `OPERATION_NOT_FOUND` | accountRoutes.ts:356 |

**签到凭据自愈（ACC-FIX-3，minimax）**：批次执行中 `queryStatus` / `submitCheckin` 返回 401（`CHECKIN_CREDENTIAL_INVALID`）时，runner 用 vault 内 `refresh_token` 调 `${origin}/oauth2/token`（`grant_type=refresh_token&refresh_token=…&client_id=mcode-public`，默认 15s 超时）续期**一次**；成功则 `vault.protect` 写回新载荷、更新账号 `checkin_credential_ref` 并重试当前动作，失败或无 `refresh_token` 维持 `CHECKIN_CREDENTIAL_INVALID`，不循环重试。日志/响应不含凭据与 refresh_token。

切换终态：`succeeded`；`failed`+`safe_error_code`=`EXIT_NOT_CONFIRMED`（未确认完全退出，未写任何数据）/ `TARGET_INSTANCE_MISMATCH` `TARGET_IDENTITY_MISMATCH` `SNAPSHOT_VERSION_MISMATCH` `TARGET_SNAPSHOT_INVALID` `SNAPSHOT_MISSING`（validate 拒绝，未写）/ `SWITCH_ROLLED_BACK`（写后失败已回滚并核验原账号）/ `VAULT_READ_FAILED`；`recovery_required`（写后失败且回滚未能核验恢复——实例冻结，同实例后续 capture/switch 409）。safe-exit 降级：UIA 托盘退出失败时广播 WS `account.notice` 请求用户手动退出并轮询退出签名（进程清零 + window-state mtime ≥ auth 写盘）；绝不强杀进程。

**S3 / S5 共用骨架（B4S-3）**：S3（`validate_target`）只回答「目标能不能用」——目标账号在、属于本产品、凭据可解且非空，**一律发生在写盘前**；S5（`verify`）回答「切换结果对不对」——必须用客户端此刻实际持有的凭据触发一次**需鉴权的服务端调用**，服务端不认这份凭据即判失败，**本地 token 比对只作辅助信号**，不拿它冒充服务端校验。平台没有服务端校验能力时如实报 `PROVIDER_NOT_IMPLEMENTED`（Trae / Qoder CN / ZCode 的能力矩阵即为此）。失败码清单（固定大写码，不含凭据与原始异常文本）：
- S3：`TARGET_ACCOUNT_NOT_FOUND` `ACCOUNT_APP_MISMATCH` `TARGET_CREDENTIAL_MISSING` `TARGET_INSTANCE_MISMATCH` `SNAPSHOT_MISSING`
- S5：`TARGET_IDENTITY_UNKNOWN`（目标身份取不到，没有比对基准）`TARGET_IDENTITY_MISMATCH`（客户端当前凭据与目标不一致）`PROVIDER_NOT_IMPLEMENTED` `SERVER_CREDENTIAL_REJECTED` `SERVER_IDENTITY_UNAVAILABLE` `SERVER_IDENTITY_MISMATCH`

MiniMax 的 S5 探针：拿客户端当前凭据调 `GET https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status`（带 `Authorization: Bearer`）；401/403 → `SERVER_CREDENTIAL_REJECTED`；响应里带身份标识就用它比对，没带就退到凭据中**服务端签名**的 JWT `sub`。探针由装配根（`index.ts`）注入，provider 本身默认不装配 → S5 报 `PROVIDER_NOT_IMPLEMENTED`。

**回滚接入 A3 restore（B4S-3）**：S5 失败 → 回滚到切换前的快照。回滚成功 → `failed` + `SWITCH_ROLLED_BACK`（原账号已恢复，实例不冻结）；回滚失败 → 把**快照 vault ref** 写进原操作的 `recovery_ref`、落 `recovery_required` 冻结实例，随后由 `POST /api/managed-accounts/:id/restore` 调平台 `RestoreHandler` 重放回滚（不另造恢复路径）；处理器失败则保持冻结、可再次触发。写盘失败（客户端文件**未被改动**，rename 原子替换）时 stage 退回 `validate_target`，实例不会被误冻成 `recovery_required`。

**共用切换骨架 S0–S5（B4S-4）**：`apps/server/src/services/accounts/switchFlow.ts` 的 `runSwitchFlow()` 是**一份流程**，provider 只提供各步回调（`SwitchFlowCallbacks`）。骨架负责：按固定步序调用并在每步开始前落 stage、**start/verify 失败必走回滚**、回滚收尾约定（provider 的 rollback 回调以抛错收尾：`SWITCH_ROLLED_BACK` = 已核验恢复、`RECOVERY_REQUIRED` = 未能恢复且实例冻结）。骨架**不判定**目标可用性（S3）、**不判定**切换结果（S5）、**不写**客户端（S4）。

调用图：

```
runSwitchFlow
  ├─ S0 preflight      → callbacks.preflight()        失败即中止（未触碰客户端）
  ├─ S1 stop           → callbacks.stop()             失败即中止（未触碰客户端）
  ├─ S2 snapshot       → callbacks.snapshot()         产出「回滚依据」
  ├─ S3 validate_target→ callbacks.validateTarget()   产出「要写的内容」；失败即中止（未写）
  ├─ S4 write          → callbacks.write(target)      失败即中止（文件未被改动，**不回滚**）
  ├─ S5 start          → callbacks.start()            失败 → 回滚
  ├─ S5 verify         → callbacks.verify()           失败 → 回滚
  └─ rollback          → callbacks.rollback(依据, cause)  以 SWITCH_ROLLED_BACK / RECOVERY_REQUIRED 收尾
```

两 provider 的回调表：

| 步 | WorkBuddy Desktop（`workbuddyDesktopProvider.ts`） | MiniMax（`minimaxDesktopProvider.ts`） |
| --- | --- | --- |
| S0 preflight | 版本/实例检查 + 目标快照三元组前置（`TARGET_INSTANCE_MISMATCH` / `SNAPSHOT_MISSING`） | 读 auth.json + 定位客户端 exe |
| S1 stop | UIA 托盘退出 → 降级 WS 提示手动退出 + 退出签名轮询（`EXIT_NOT_CONFIRMED`） | 客户端在跑则停掉并确认退出（`CLIENT_STOP_TIMEOUT` / `CLIENT_PROCESS_CONTROL_UNAVAILABLE`）；**阻断点归 preflight 语义**，stage 留在 `preflight` |
| S2 snapshot | 读盘 backup（回滚依据） | `vault.protect` 当前凭据（回滚依据 = 快照 ref） |
| S3 validate_target | 解密快照 + instance/identity/version 三元组 + 每文件 sha256（`TARGET_SNAPSHOT_INVALID` 等） | 共用 `validateTarget`（`TARGET_CREDENTIAL_MISSING` 等） |
| S4 write | 临时文件 + rename 原子替换（`SNAPSHOT_WRITE_FAILED`） | 临时文件 + rename 原子替换（`SWITCH_WRITE_FAILED`，stage 退回 `validate_target`） |
| S5 start | 启动 + 等三信号（启动日志 / 18488 监听 / 主窗口）任一（`STARTUP_TIMEOUT`） | 启动客户端进程 |
| S5 verify | 读回本地 uid 比对（`IDENTITY_VERIFY_FAILED`） | 本地 token 比对 + **服务端身份校验**（`SERVER_*`，见上） |
| rollback | 写回 backup + 重启 + 核验原账号（`SWITCH_ROLLED_BACK` / `RECOVERY_REQUIRED`） | 写回快照；失败则写 `recovery_ref` 并落 `RECOVERY_REQUIRED`（由 A3 restore 重放） |

Trae 仍未实现文件级切换：能力矩阵 `switch=false` + `PROVIDER_NOT_IMPLEMENTED`，不接入骨架。

**B4S 骨架验收对照（父卡 ACC-KB-B4S）**：

| 父卡范围项 | 落在哪 | 证据 |
| --- | --- | --- |
| 客户端在跑时拦住切换（不静默覆盖文件） | B4S-1 `clientProcess.ts` + `minimaxClientProbe` | `test/minimaxPreflightBlock.test.ts`（阻断时 auth.json 一字节不变） |
| 快照完整性（文件清单 + sha256 + 成对 `-wal`/`-shm`/`-journal`）、Trae 明文残留清理 | B4S-2 `clientSnapshot.ts` | 快照集合与 sha256 校验、缺 `-wal` 时拒绝 |
| 共用 S3 目标校验 / S5 服务端身份校验 | B4S-3 `switchStages.ts` | `test/switchStages.test.ts`（固定失败码清单、服务端身份比对） |
| 回滚失败落 A3 restore 解冻通道（不留永久冻结） | B4S-3 `restore.ts` 的 `RestoreHandler` | `recovery_ref` + restore 重放 + `replayed=true` 幂等 |
| S0–S5 收敛为一份共用流程 | B4S-4 `switchFlow.ts` | `test/switchFlow.test.ts`（步序、每步失败可定位、两平台全链路 dry-run） |

**已知缺口（如实记录，勿当作已达成）**：WorkBuddy 的 S5 仍是读本地 `.info` 的 `$.account.uid` 比对，**未触发需鉴权的服务端调用**（MiniMax 已按「服务端为准」实现）；WorkBuddy 的 restore 未注册 `RestoreHandler`，其解冻仍是「人工确认已恢复/放弃恢复」语义（可解冻，但不自动写回快照）。


## 14b. 额度与余额（`GET /api/managed-account-quotas`，accountRoutes.ts，ACC-QUOTA-01）

`GET /api/cli-account-quotas?account_id=<uuid>` 读取指定 `commandcode` CLI 账号，响应 `{ items: [QuotaResult], fetched_at }` 且仅含该账号的一条额度结果；缺少或非法 UUID 返回 400 `VALIDATION_ERROR`，账号不存在或来源不匹配返回 404 `NOT_FOUND`。

账号页三来源额度/余额聚合：**逐来源独立结果**（单来源失败不影响其它来源），服务端 60s 缓存 + 失败指数退避（60s 起，上限 10min），同来源并发只打一次第三方。取证结论（2026-11-03）：DeepSeek 走官方余额端点；OpenCode Go 走**本地 opencode 服务**的 usage 路由（ACC-QUOTA-02）；Codex 无公开窗口端点，固定 `unsupported`（不编造数据）。响应不含 token / identity_hash / 本机路径。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/managed-account-quotas` | query：`workspace_id?`（uuid；额度不按工作区切分，仅回显） | `{ items: QuotaResult[], fetched_at: number, workspace_id: string\|null }` | 400 `VALIDATION_ERROR`（workspace_id 非 uuid） | `services/quotas/quotaService.ts` |
**来源与分组（ACC-KB-B5S）**：来源从 3 个扩到 **8 个，分两组** —— `cli`（`deepseek` / `opencode_go` / `codex`，读本机 CLI 余额或本地额度快照）与 `platform`（`workbuddy` / `minimax` / `trae` / `qoder_cn` / `zcode`，读账号侧积分/套餐余量）。分组元数据在 `packages/shared` 的 `QUOTA_GROUPS` / `QUOTA_SOURCE_GROUP`，UI 必须分组展示（两套不同源、不同单位）。`QuotaWindow` 新增 optional `kind`（`rolling`/`weekly`/`monthly`/`credit`）与 `total`/`used`，`remaining` 语义不变。平台来源无凭据时如实返回 `status:'unsupported'` + `reason_code:'NO_CREDENTIAL'`（MiniMax 另注明缺少 `yy`/`x-timestamp`/`x-signature` 签名材料，待 B5S2），**不编造余额**。节流先取保守值：每来源并发 1、全局并发 2、成功结果 60s 缓存、429 走既有指数退避（60s 起 ×2，上限 10min），实测后再回写。

`QuotaResult`（ACC-KB-A4 起类型与来源清单只有一份，定义在 packages/shared/src/types.ts 与 constants.ts 的 QUOTA_SOURCE_IDS/QUOTA_SOURCE_LABEL；服务端 quotaService.ts 仅再导出）= { source: 'deepseek'\|'opencode_go'\|'codex', status: 'ok'\|'unsupported'\|'error', balance: number\|null, unit: 'CNY'\|'USD'\|null, windows: Array<{ name: string, remaining: number, reset_at: number\|null }>, fetched_at: number, reason_code: string\|null, detail: string\|null }`

- **deepseek**：`GET https://api.deepseek.com/user/balance`（Bearer）。key 走**多候选 + 逐个试**（ACC-QUOTA-03），按优先级：①`DEEPSEEK_API_KEY`（env）②`~/.deepseek/config.toml` 的 `api_key` ③`~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（**最低优先级的兼容来源**，DSH 私有格式、非官方约定，解析失败静默跳过）；依次打端点用第一个 200 的，命中来源在缓存生命周期内优先复用。`ok` 时给 `balance`/`unit`（优先 CNY）；无任何候选 → `unsupported` `CREDENTIAL_MISSING`；有候选但全部 401/403 → `error` `CREDENTIAL_INVALID`（`detail` 含「尝试过 N 个凭据来源」）；429 → `RATE_LIMITED`；5xx → `UPSTREAM_ERROR`；网络/超时 → `NETWORK_ERROR`；结构不符 → `UPSTREAM_SHAPE_UNEXPECTED`。
- **opencode_go**：走本地 opencode 服务 `GET {url}/api/experimental/usage/limits`（Basic `opencode:<~/.config/opencode/service.json password>`）。响应 `data.go.{rolling,weekly,monthly}={percent,limited,resetsAt}` → 三窗口（`5h`/`weekly`/`monthly`），`remaining = 100 - percent`、`used_percent = percent`、`reset_at = resetsAt`，`unit = '%'`、`detail` 给工作区名或限额提示。服务发现：`OPENCODE_SERVER_URL` 优先，否则 `netstat -ano` LISTENING 端口 ∩ `tasklist` 中名字含 `opencode` 的 PID（Windows）。不可用码：`OPENCODE_NOT_LOGGED_IN`（无 auth.json）/ `OPENCODE_AUTH_UNAVAILABLE`（无 service.json 口令）/ `OPENCODE_SERVER_NOT_RUNNING`（未发现本地服务）/ `OPENCODE_AUTH_FAILED`（401/403）/ `OPENCODE_ROUTE_UNSUPPORTED`（404）。
- **codex**（ACC-CODEX-QUOTA-IMPL）：只读**本机 rollout 快照**（零网络、零凭据）——扫描 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` 取 mtime 最新一份，读 `event_msg → payload.rate_limits`：`primary{used_percent, window_minutes:300, resets_at}` → `5h`、`secondary{window_minutes:10080}` → `weekly`（**只映射这两种窗口，Monthly 不展示**）；`resets_at` 为秒级 epoch（×1000 转毫秒）；`credits.balance` → `balance`/`unit=USD`，余额为 0 时 `detail="额度内"`（避免误读成欠费）。不可用码：`NO_CODEX_SESSIONS`（无 `~/.codex/sessions` 或无 rollout 文件）/ `NO_CODEX_RATE_LIMITS`（最新会话里没有 `rate_limits` 或窗口不可用）。不读 token 原文、不写 `.codex`、不请求 ChatGPT 后端（`/backend-api/codex/usage` 需浏览器 UA 才 200，本卡不启用，见 `Docs/research/accounts/2026-11-03-codex-quota.md`）。
- `windows[].reset_at` 为该窗口重置时刻（epoch ms），前端展示为本地 `HH:mm` + 剩余时长；无窗口概念时 `windows = []`。
**commandcode**（`GET /api/cli-account-quotas`）：按 `account_id` 精确读取一条 `cli_account` 的 `credential_ref`，使用 vault scope `commandcode` / `CLI_CLIENT_INSTANCE_ID` / 行内 `identity_hash` / `cli_credential`；不触发账号捕获。只读调用官方 `GET https://api.commandcode.ai/alpha/whoami?limits=1` 与 `GET /alpha/billing/credits?orgId=<whoami.org.id>`。credits 响应原始 body 中 `credits.{monthlyCredits,purchasedCredits,freeCredits}` 按官方客户端逐项截为非负后求和，`unit=USD`；同一 body 顶层 `windowLimits.{fiveHour,weekly}` 映射 5h rolling 与 weekly，`resetAt` 为 epoch 毫秒（0 → null）。缺凭据：200 + `unsupported/CREDENTIAL_MISSING`；401/403、网络失败或字段缺失：非 ok 且 `balance=null`；有效真实零值保持 `ok/0`。缓存按来源和 CLI 账号 id 隔离。

## 14c. 添加账号（协议级加号，`/api/add-account-*`，ACC-KB-B2S）

**不再依赖客户端进程在跑**：走平台自己的授权协议 —— 发起 → 用户在浏览器确认一次 → 轮询/回调 → 凭据落 vault → 建 `managed_account`。授权成功后新账号直接出现在 `GET /api/managed-accounts` 列表，**不需要重启客户端**。

凭据只在授权成功后落库：授权完成前握着的中间态（device_code / PKCE verifier / poll token / flow_id）只在 vault 的 `pending_credential` purpose 里，库里只留 sha256 与 ref；**放弃 / 超时 / 被拒**一律把待激活凭据删掉，不留孤儿 vault 文件、不留半条账号。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/add-account-protocols` | — | `{ items: AddAccountProtocolInfo[] }`（`app_id` / `protocol` / `provider_version` / `requires_browser` / `regions`；供前端向导渲染，**不含任何凭据**） | — | accountRoutes.ts |
| `POST /api/add-account-sessions` | body：`{ app_id: ManagedAppId, region?: 'cn'\|'global' }`（strict） | 202 `{ session: AddAccountSession }`；`session.authorization_url` 是要交给用户打开的授权地址，`user_code` 是需手工输入的码（没有则 null）。响应**不含**待激活凭据或 vault 引用 | 400 body 非法；409 `PROVIDER_UNVERIFIED`（该产品无协议 provider）/ `ADD_ACCOUNT_SESSION_EXISTS`（同产品已有进行中的加号会话）；503 `VAULT_UNAVAILABLE` / `TRAE_DEVICE_IDENTITY_UNAVAILABLE` / `TRAE_CALLBACK_PORT_UNAVAILABLE` | accountRoutes.ts、`services/accounts/addAccountAuthorization.ts` |
| `GET /api/add-account-sessions` | query：`app?` | `{ items: AddAccountSession[] }`（脱敏：剥离 pending secret 的 hash 与 vault 引用） | 400 app 非法 | accountRoutes.ts |
| `GET /api/add-account-sessions/:id` | — | `{ session: AddAccountSession }`（脱敏） | 404 会话不存在 | accountRoutes.ts |
| `POST /api/add-account-sessions/:id/poll` | — | `{ session, account }`；`pending` 时 `account` 为 null 且不产生任何落库副作用；`authorized` 时凭据按 `checkin` purpose 落库并建/更新账号（同一 app + 同一 uid 命中既有行，不产生重复账号） | 404 会话不存在；409 `AUTHORIZATION_NOT_PENDING` / `AUTHORIZATION_EXPIRED` / `PROVIDER_UNVERIFIED` | accountRoutes.ts |
| `DELETE /api/add-account-sessions/:id` | — | `{ session }`；会话置 `cancelled`，待激活凭据删除，**不建账号** | 404 会话不存在；409 `PROVIDER_UNVERIFIED` | accountRoutes.ts |

会话状态：`pending` → `authorized` / `failed` / `expired` / `cancelled`（状态 CAS，终态不可再轮询）。`safe_error_code` 记平台侧原因码（如 `MINIMAX_ACCESS_DENIED` / `ZCODE_FLOW_FAILED` / `QODER_IDENTITY_MISSING` / `WORKBUDDY_IDENTITY_MISSING` / `TRAE_CALLBACK_HOST_REJECTED`）。

**五平台协议**（端点形状取自本机产品源码与线上实测，见各实现的注释）：

| 平台 | 协议 | 发起 | 轮询 |
| --- | --- | --- | --- |
| `minimax` | RFC 8628 device grant + PKCE S256 | `POST {origin}/oauth2/device/code`（cn=`account.minimax.cn`，global=`account.minimax.io`；`client_id=mcode-public`、`scope=agent.default`、`audience=agent-backend`） | `POST {origin}/oauth2/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）；`pending`/`slow_down` 继续，`denied` 终止，`expired` 过期；token 响应须含 `access_token`+`refresh_token`+`token_type=bearer`+`expires_in`+`agent.default` scope，账号 uid 取 JWT `sub` |
| `zcode` | CLI 轮询流 | `POST https://zcode.z.ai/api/v1/oauth/cli/init`（头 `Authorization: Bearer <32B hex>`，body `{provider:'bigmodel'\|'zai'}`） | `GET /api/v1/oauth/cli/poll/{flow_id}`；`ready` 时取该区 `access_token` 与 `user.user_id` |
| `qoder_cn` | 自研设备授权 | 授权页 `https://qoder.com.cn/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id` | `GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`（404/202 = 未授权）；再 `GET /api/v1/userinfo` 取 uid |
| `workbuddy_desktop` | OneID 插件式 state | `POST {origin}/v2/plugin/auth/state?platform=workbuddy`（cn=`www.codebuddy.cn`，global=`www.workbuddy.ai`） | `GET /v2/plugin/auth/token?state=`（code `11217` = 未授权）；再 `GET /v2/plugin/login/account?state=`（Bearer + `X-Domain`），code `12151` = 未授权 |
| `trae` | OAuth 授权码 + PKCE S256 + 固定本地回调 | 授权页 `{login_host}/authorization`（22 参数，含 `code_challenge`、`auth_callback_url=http://127.0.0.1:17388/authorize`、`login_trace_id`、设备字段）；服务端在 127.0.0.1:17388 起回调监听（跨源探活回 200 + CORS） | 回调带 `authCodeInfo` + `userInfo` + `host` + `loginTraceID`；`loginTraceID` 必须等于发起时的 trace id；再 `POST {host}/trae/api/v3/oauth/ExchangeToken` |

**与共享知识页 `89c72721` 的两处差异（以源码/实测为准）**：① MiniMax `interval` 单位 —— 知识页写「毫秒需 /1000」，官方 CLI 源码只在 legacy `user_code` 轮询分支才除 1000，`device_code` 分支直接按秒用，线上实测 `interval=3` 亦为秒；② Qoder `client_id` —— 知识页写 `1c5e33e1-…`，本机 SDK 解出的 CN 实测值是 `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`。

**边界**：Trae 的 `device_id` 必须与客户端设备凭证同源（自造会被服务端 20403/20405 拒），故只从本机已装客户端**只读**取得（`product.json` 的 `iCubeApp.authConfig.TRAE[quality]` / `bootConfig.consoleHost`、`state.vscdb` 的 `storage.serviceMachineId`、`aha/TinyStorage` 的 `aha.device.device_id`），读不到即报 `TRAE_DEVICE_IDENTITY_UNAVAILABLE`，不自造。

## 14d. 无痕打开授权地址（`POST /api/browser/open-incognito`，browserRoutes.ts，ACC-INCOGNITO）

账号授权向导要求「开始授权」与手点「授权地址」都直接弹无痕窗口，与账号平台无关。前端（含 Tauri webview）无法指定普通窗口、也没有 opener 插件，因此由本机服务拉起系统浏览器。

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `POST /api/browser/open-incognito` | body：`{ url: string }`，只接受 http/https，长度 ≤2048 | 200 `{ opened_with: 'chrome'\|'edge'\|'brave'\|'default', mode: 'incognito'\|'normal', degraded_reason: string\|null }` | 400 `BROWSER_URL_INVALID`（缺 url / 空串 / 超长 / 非 http(s)）；502 `BROWSER_OPEN_FAILED`（所有候选与默认浏览器都起不来，`details.attempts` 列每个候选的失败原因） |

选择顺序：Windows 依次探测 Chrome（`--incognito --new-window`）/ Edge（`--inprivate --new-window`）/ Brave（`--incognito --new-window`）的常见安装路径；macOS 用 `open -na "<App>" --args ...`；Linux 依次试 `google-chrome` / `chromium` / `microsoft-edge` / `brave-browser`。全都不可用 → 降级系统默认浏览器普通窗口，返回 `mode='normal'` 与中文 `degraded_reason`，由前端展示可见提示（用户能感知这次不是无痕）。

安全边界：只接受 http/https；`spawn` 用参数数组、不经 shell 拼串；与既有 `/api` 一致无鉴权，依赖服务只监听本机回环（单机工具前提）。

## 15. system（`/api/system`，systemRoutes.ts，SYSTEM-RESTART）

服务自重启，供设置页「重启服务器」按钮调用。**无鉴权**，因此只允许本机回环地址触发（`req.ip` ∈ `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，本项目无反向代理，不读 `X-Forwarded-For`）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `POST /api/system/restart` | 无 body | `202 { restarting: true, old_pid, new_pid, log_path, started_at }`；新进程 stdout/stderr 重定向到 `log_path`；**先回 202**，再延迟约 200ms 关闭监听，轮询 `/api/version`（≤15s，须由 `new_pid` 应答）确认接管后才退出旧进程；不健康则重新监听并继续服务（前端据 `pid !== new_pid` 显示「已回退」） | 403 `RESTART_FORBIDDEN`（非回环）；409 `RESTART_PORT_CONFLICT`（目标端口被其它进程/另一个看板实例占用——未重启，旧进程继续服务，日志留「重启已拒绝」一行）；500 `RESTART_ENTRY_MISSING`（入口脚本不存在）/ `RESTART_SPAWN_FAILED`（新进程 spawn 失败——旧进程继续服务，监听未动）；503 `RESTART_UNAVAILABLE`（当前装配未启用重启，仅测试/非生产） | systemRoutes.ts |

顺序：回环校验 → 目标端口前置检查（409 时不动旧进程）→ 入口存在性 → `spawn`（`detached` / stdout+stderr 重定向到 `log_path` / `unref`）并等 `'spawn'` 事件 → 回 202 → 200ms 后 `server.close()` 停监听 → 轮询 `/api/version`（≤15s，须由 `new_pid` 应答）→ 健康则 `process.exit(0)`，不健康则重新 `listen()` 继续服务并写日志。新进程启动时对 `EADDRINUSE` 以 250ms 间隔重试最多 20 次（等旧进程让出端口）。

## 16. voice（`/api/voice`，voiceRoutes.ts，VOICE-1）

本地语音模型管理。候选清单在 `packages/shared/src/voiceModels.ts`（前后端共用），**不预置、绝不自动下载**：只有显式 `POST .../download` 才发起网络请求。模型目录 `dirname(db)/models/<model-id>/`（容器只挂 `/data`）；下载写 `model.bin.part`，完成后写 `model.meta.json` 再原子改名 `model.bin`；`sha256` 边下边算，不符则保留 `.part`。

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/voice/models` | — | `{ models: VoiceModelStatus[] }`；每项 `{ id, name, languages, streaming, note, dir, bytes_total, state, downloaded_bytes, present_files, missing_files, sha256_verified, error, error_message }`，`state ∈ not_downloaded / downloading / verifying / downloaded / failed` | — |
| `POST /api/voice/models/:id/download` | 无 body | `202 { model_id, task_id, reused, state }`；**按文件下载**（HF `resolve/<revision>/<path>`，先写 `<file>.part` 再原子改名）；同 id 重复调用**幂等复用**进行中的任务（`reused: true`、`task_id` 相同）；已下载完成同样 202（`state: downloaded`）；重试时**只补缺失/失败的文件**（已就绪文件跳过） | 404 未知模型；409 `VOICE_MODEL_URL_MISSING`（候选未配置 HF 仓库）/ `VOICE_MODEL_INCOMPLETE`（必需文件清单为空） |
| `GET /api/voice/models/:id/progress` | `?poll=1` 走一次性 JSON | SSE（`text/event-stream`）逐条 `data: { model_id, task_id, state, bytes, total, current_file, error, error_message }`（`bytes` 是**各文件总字节聚合**，`current_file` 为正在下载的文件），到 `downloaded` / `failed` 自动 `end`；`?poll=1` 返回同一结构 | 404 未知模型 |
| `DELETE /api/voice/models/:id` | — | `{ deleted: true, freed_bytes }`，删掉整个 `models/<id>/` | 404 未知模型；409 `VOICE_MODEL_BUSY`（该模型正在下载） |

### 聊天图片投递的适配器支持矩阵（CHAT-IMG-ADAPTER）

`POST /api/sessions/:id/messages` 带附件时先验「当前 CLI 是否真的支持图片入参」，不通过 → 400 `IMAGE_DELIVERY_UNVERIFIED`，**文案按适配器给可执行指路**（`services/imageDeliveryHint.ts`）：

| 适配器 | 判定依据 | 支持 |
| --- | --- | --- |
| codex | `codex exec --help` 是否含 `--image`（本机 0.166.0 含 `-i, --image <FILE>...`） | 是 → 每张图一个 `-i <path>` |
| opencode | `opencode run --help` 是否含 `--file`（本机 v2.2.5 含 `--file, -f string`） | 是 → 每张图一个 `--file <path>` |
| codebuddy | `--version === 2.179.2` 且 `model === minimax-m3.1-flash` | 是（其余组合 400，文案提示升级） |
| dsh | 本机只有 asar 形态、无法实测入参 | 否 → 文案建议换 codex / opencode / codebuddy |

400 文案示例（codebuddy 2.170.0）：「当前执行方式是 CodeBuddy 2.170.0（model=…）：图片输入要求 codebuddy 2.179.2 且 model=minimax-m3.1-flash，请升级 codebuddy 或换用 codex / opencode」。

### 识别会话（VOICE-2，`services/voiceSessions.ts`）

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `POST /api/voice/session` | `{ model_id?, language? }`（`language` 形如 `zh-CN`，归一成 `zh`；缺省取第一个已下载模型、语言 `zh`） | `201 { session_id, sample_rate: 16000, model_id, language, state, queue_position }` | 409 `VOICE_MODEL_MISSING`（没有已下载模型——**此时不加载原生模块**）/ `VOICE_LANGUAGE_UNSUPPORTED`（模型不支持该语言）/ `VOICE_MODEL_NOT_STREAMING`（非流式模型）/ `VOICE_MODEL_INCOMPLETE`（模型目录缺 encoder/decoder/joiner/tokens） |
| `WS /api/voice/session/:id` | 上行**二进制帧**：16kHz 单声道 **Float32 小端**（4 字节/采样，一帧任意长度）；文本帧 `{"type":"end"}` 等价于 stop | 下行 JSON：`{ type: 'state', state }`、`{ type: 'queued', position }`、`{ type: 'partial', text }`、`{ type: 'final', text, frames, reason }`、`{ type: 'error', code, message }` | 未知会话 → `error VOICE_SESSION_NOT_FOUND` + close 1008；重复连接 → `VOICE_SESSION_BUSY` |
| `POST /api/voice/session/:id/stop` | 无 body | `{ session_id, text, frames, state: 'ended' }`（WS 不可用时的回退路径） | 404 会话不存在 |

- 识别器**串行**（并发上限 1，`maxConcurrency` 可配）：同一时刻只有一个会话在跑，其余收到 `queued` 事件并带排队位次；前一个结束后自动 `state: running`。
- 会话空转 **15s** 自动结束（`idleTimeoutMs` 可配），下行最后一条是 `final` 且 `reason: 'idle'`。
- 原生模块 `sherpa-onnx-node` **延迟加载**：只有「模型已下载 + 真正要开流」时才 `import()`；无模型时创建会话直接 409，进程启动不碰原生模块。

下载错误码：`VOICE_DOWNLOAD_FAILED`（网络/HTTP 错误）、`VOICE_NO_SPACE`（`statfs` 预检剩余空间不足，未发请求）、`VOICE_CHECKSUM_MISMATCH`（该文件 sha256 不符——**删掉该文件的 `.part`，其它已成功文件保留**，重试只补这一个）、`VOICE_MODEL_INCOMPLETE`（必需文件缺失或校验不通过，不标 `downloaded`）。

校验强度：`encoder/decoder/joiner/model.int8.onnx` 按 HuggingFace LFS sha256 校验（值固定写在 `packages/shared/src/voiceModels.ts`，revision 已 pin 到具体 commit）；`tokens.txt` 上游只发 git blob、**没有 sha256**，采用**弱校验**（字节数相等 + 内容非空 + 首行含空格或 `<`，见 `weakFileLooksValid`）——弱校验只挡明显损坏/占位文件，不是密码学校验。`model.meta.json` 里逐文件记 `verified: 'sha256' | 'weak'`。

## 17. 设备身份与安全快照（ACC-KB-B6，`services/accounts/deviceIdentity.ts`）

方案 B：`managed_account` 增设备身份字段 + 一次性回填 + 校验。**字段可回滚，数据不可逆**——回填只写新 `device_identity_ref`，绝不覆盖旧 `client_snapshot_ref`。

| 列 | 含义 |
| --- | --- |
| `device_identity_ref` | 设备身份快照引用（`security/<account-id>`）；`NULL` = 未回填/不适用 |
| `device_identity_status` | `pending`（待回填或回填失败，可重试）/ `ok` / `not_applicable` |
| `device_identity_error` | 固定错误码（见下表），成功时清空 |
| `device_identity_updated_at` | 最后一次尝试回填的时间（epoch ms） |

固定错误码：`DEVICE_IDENTITY_PENDING`（未回填/待重试）、`DEVICE_IDENTITY_CAPTURE_FAILED`（客户端设备字段读不到）、`DEVICE_IDENTITY_SNAPSHOT_FAILED`（写安全快照失败）、`DEVICE_IDENTITY_VERIFY_FAILED`（回读校验不符）、`DEVICE_IDENTITY_NOT_APPLICABLE`（该平台无设备字段，如 MiniMax）。回填失败**不阻断、不回滚**，只写 `pending` + 错误码，后续可重试。

安全快照目录：`<dirname(db)>/security/<account-id>/`，含 `files/…` 与 `manifest.json`：

```json
{
  "schema": "agentboard.device-identity.snapshot/1",
  "account_id": "<uuid>",
  "created_at": 1793000000000,
  "files": [{ "path": "device-id", "bytes": 10, "sha8": "1a2b3c4d" }]
}
```

`sha8` = 该文件 sha256 的前 8 位。**写客户端登录文件前必须先落这份快照并 `verifySecuritySnapshot` 通过**（禁止无备份直改真实文件）；`writeSecuritySnapshot` 拒绝写空快照。

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

## 18. 知识页文本导入（`/api/knowledge/pages/import`，`services/knowledgeImport.ts`，KBIMP-1）

`POST /api/knowledge/pages/import`

请求体（`application/json`，`strict`，多余字段 400）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `scope` | `workspace` \| `common` | 必填 |
| `workspace_id` | string | `scope=workspace` 时必填 |
| `format` | `md` \| `txt` \| `json` | 必填 |
| `content` | string | 文件原文（前端读文件后原样上传） |
| `filename` | string? | 作为 `sources[0].locator` 与标题兜底 |
| `title` / `slug` | string? | 显式指定，优先于自动推导 |
| `category` / `landed` | enum? | 与知识页同一套枚举 |
| `labels` | string[]? | 知识页无 labels 字段，导入时忽略并回 `warnings` |
| `actor` / `change_note` | string? | 审计字段 |

响应：`{ pages: KnowledgePage[], warnings: string[], page_commit }`（json 数组会返回多条）。`page_commit` 恒为跳过信号 `{ committed: false, skipped: true, reason: '批量导入不落每页快照（…）', path: "", relative_path: "", commit: null }`（KB-SNAP-IMPORT 方案 3：本端点不接线 BORROW-5.1 每页快照，导入页在 git 审计链里无对应提交，属显式既定决策不是失败；接线与否以 `skipped` 字段判断，未来接线后该值自动变为真实提交结果）。

推导规则：

- `md`：`body_md` = 原文；标题取**首个 `# ` 一级标题**（首个非空行不是标题则不继续找），再退 `filename`（去扩展名），最后 `导入的 Markdown 页`；
- `txt`：`body_md` = 原文；标题取**首个非空行（≤80 字符）**，再退 `filename`；
- `json`：支持**单个对象**或**对象数组**（≤100 条）。每条映射 `{ title?, body|body_md, slug?, labels?, category?, landed? }`；
  缺 `title` 时用首行/`导入的知识页`；多余字段不写入正文，只进 `warnings`；**绝不把整段 JSON 当正文**。
- `slug`：未显式给出时由标题推导（保留 Unicode 字母数字，空白→`-`，非法字符折叠；空则 `import-<hash8>`）。

来源与证据（服务端必填，自动构造）：

- `sources: [{ source_id: 'import:<sha256 前 12 位>', source_type: 'file', locator: filename ?? '<import:{format}>', captured_at, content_hash: <sha256 hex 64> }]`
- `evidence: [{ source_id, locator }]`
- **`file` 来源不写 `snapshot`**（`validateKnowledgeContent` 会拒：本地代码来源只保存路径和 hash）；`content_hash` 必须是纯 64 位 hex（不能带 `sha256:` 前缀）。

限额与错误：

| 场景 | 状态码 | 错误码 |
|---|---|---|
| 正文 > 100000 字符 | 413 | `IMPORT_BODY_TOO_LONG` |
| 内容为空 | 400 | `VALIDATION_ERROR` |
| `scope=workspace` 缺 `workspace_id` | 400 | `VALIDATION_ERROR` |
| json 非对象/缺 body/数组空/超 100 条 | 400 | `VALIDATION_ERROR` |
| slug 冲突 | 409 | `KNOWLEDGE_EXISTS`（消息里给 `slug-2` 之类建议） |
| 请求体超过全局 JSON 上限 | 413 | 由 `express.json()` 默认 100kb 先拒（见下「已知限制」） |

落库：逐条复用 `createKnowledgePage`（页面行 + 首发修订 + 双链同步在同一事务内），失败不留半成品。

**已知限制（KBIMP-1B 实测）**：本路由已挂**路由级** `express.json({ limit: '2mb' })`，但 >100kb 仍会被**先执行的全局 parser** 拒：

- 挂载顺序 `app.use(express.json())`（`index.ts:154`，默认 100kb）→ 之后才 `/api` 路由（`:160`）；
- `express.json()` 对已解析请求会跳过，但**超限拒绝发生在先执行的那个 parser**，所以路由级 parser 放不大上限；
- 实测：导入端点 50kb → 200；**500kb → 413**（全局，码 `ATTACHMENT_TOO_LARGE`、文案「单张图片不能超过 10 MiB」）；>1MB → 同样 413；对照 `POST /api/issues/draft` 200kb → 413（全局 100kb 未放宽）。

要真正支持 1MB，需在 `index.ts` 里把该路径 parser 挂在全局之前（board-server 的文件，未改）：

```ts
app.use('/api/knowledge/pages/import', express.json({ limit: '2mb' }));
app.use(express.json());
```

替代：把导入上限调成 100kb，并把全局 `entity.too.large` 的文案改成中性描述。本接口自身的 `assertContentLimits`（>1MB → `IMPORT_TOO_LARGE`）与 `planImport`（>100k 字符 → `IMPORT_BODY_TOO_LONG`）已就位，只有在请求体能到达 handler 时才触发。

## 19. 并发语义（CLAIM-RACE）

**占用/流转全部是「单个 `IMMEDIATE` 事务内的条件 UPDATE」，并发安全由 SQLite 写锁 + `changes===1` 判定保证**：

| 操作 | 事务 | 条件 | 冲突返回 |
|---|---|---|---|
| `POST /api/issues/:id/claim` | `IMMEDIATE` | `WHERE id=? AND claimed_by IS NULL AND status IN ('待规划','进行中')` | 409 `ISSUE_CLAIMED`（已被占用，文案带占用者）/ `ISSUE_STATUS_NOT_CLAIMABLE`（状态不可领取） |
| `POST /api/issues/:id/done` | `IMMEDIATE`（读+写+评论同一事务，**事务内无 await**） | `WHERE id=? AND claimed_by=?` | 409 `NOT_TASK_OWNER`（占用已改变） |
| `POST /api/issues/:id/fail` | 同上 | `WHERE id=? AND claimed_by=? AND session_id IS ?` | 409 `NOT_TASK_OWNER` |
| `POST /api/issues/:id/release` | 同上 | `WHERE id=?`（用户强制释放） | 404（任务不存在） |
| `POST /api/issues/:id/close` / `reopen` | `IMMEDIATE` | 状态机前置判断 + `updateIssueInHierarchy` 的 CAS | 409 `ISSUE_CLAIMED` / `INVALID_TRANSITION` |

- **评论原子性**：done/fail/release 的自动评论用同步 `insertCommentRow` 在**同一事务**内落库（不再串 `addComment` 的异步段），因此「状态流转 + 评论」要么都成功要么都不写。
- **多实例/多进程**：`busy_timeout = 5000`（`db/connection.ts`）；写锁等待超时不再是 500，映射为 **409 `DB_BUSY`**「数据库正被其它操作占用（写锁等待超时），请稍后重试」。
- **测试证据**：`apps/server/test/claimRace.test.ts` —— 同进程 10 路 claim（1×200 + 9×409）、2 路 done（1+1）、done↔release（1+1）、**双进程同 DB** claim（仍 1 成功）、close/reopen（close 幂等、reopen 1×200+1×409），每类跑 3 次结果一致。
- **给 agent 的约定**：并发 claim 由服务端原子保证；遇 409 直接换卡或等释放，不要重试同一张卡的 claim。
## 附：知识图接口的正文摘要口径（GRAPH-API-PERF，2026-11-04）

`GET /api/knowledge/graph` 的节点里，`body_md` **不再是整篇正文**，而是正文前 **2000 字符**的摘要（常量 `GRAPH_TEXT_EXCERPT`，`db/repos/knowledge.ts`）；另外新增 `body_chars` 给全文长度。
关键词边只按此摘要计算（标题 + 前 2000 字符），全文不参与。

原因（实测）：库里存在 200 万字符级页面时，原实现把全文取回再对每页做 `entityTerms` + `trigrams`，24 节点的图接口耗时 **22–23 秒**；改为摘要 + `(status,scope,id)` 索引后同规模 **22ms**（夹具实测，200 页 78ms）。

## 20. 待决策（`/api/decisions`，decisionRoutes.ts，DEC-V4-API-EXTEND / DEC-V4-UNDO-SERVER / PERM-2）

| 方法 路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/decisions` | query：`workspace_id`（单区，兼容旧调用）；或 `scope=accessible`（有成员关系的全部工作区）；或 `workspace_ids=a,b`（逗号分隔，逐区校验、无权限的区静默跳过）。另支持 `state?`、`issue_id?`、`stale?`、`limit?`（≤500） | `{ decisions: DecisionListItem[], counts, capabilities }`；列表项含 `workspace_name` / `options[]` / `issue_priority` / `blocked_downstream_count` 与逐条 `capabilities`；跨区时 `counts` = 可访问区逐区之和 | 400 缺 `workspace_id`（且未给 `scope`/`workspace_ids`）/ `workspace_ids` 为空；401 `UNAUTHENTICATED`；403 `WORKSPACE_FORBIDDEN`（单区非成员 / `scope=accessible` 但零成员关系） |
| `GET /api/decisions/:id` | — | `{ decision, options, answers[] }`，`decision.capabilities` 按调用者角色投影 | 404 `NOT_FOUND`；401 `UNAUTHENTICATED`；403 `WORKSPACE_FORBIDDEN`（非成员） |
| `POST /api/decisions/:id/answer` | body：`option_id` / `option_ord` / `answer_text` 三选一，可带 `expected_revision` 修订 | 200 `{ decision }` | 401/403（见下方权限矩阵）；400 `VALIDATION_ERROR`；409 决策状态冲突 |
| `POST /api/decisions/:id/withdraw` | body：`by?`（缺省 `user`）、`reason`（必填） | 200 `{ decision }` | 401；403 `WORKSPACE_FORBIDDEN` / `ROLE_FORBIDDEN`（仅 owner 可撤回）；409 `DECISION_NOT_OPEN` 等 |
| `POST /api/decisions/:id/undo` | body：`by`（必填）、`expected_revision`（必填，≥0 整数） | 200 `{ decision, reverted_to: 'grace'\|'open', undo_window_ms: 6000, already_undone }` | 400 `VALIDATION_ERROR`；404 `DECISION_NOT_FOUND`；409 `UNDO_WINDOW_EXPIRED` / `UNDO_NOT_ANSWERED` / `DECISION_REVISION_CONFLICT` / `UNDO_CLAIMED_AFTER_LOCK` / `UNDO_FORBIDDEN_ACTOR` / `DECISION_WITHDRAWN` |
| `POST /api/decisions/:id/extend` | body：`seconds`（1–300 整数，必填）、`by?`（缺省 `user`）、`fence?`（传了就校验）、`workspace_id?`（显式传入即做跨区守卫） | 200 `{ decision_id, state: 'grace', grace_until, remaining_grace_seconds, extended_seconds, extension_count, max_extend_seconds }` | 400 `INVALID_SECONDS`；404 `DECISION_NOT_FOUND`；409 `DECISION_NOT_GRACE` / `EXTEND_LIMIT_EXCEEDED`（details `{ extended_seconds, max_extend_seconds }`）/ `STALE_FENCE`；403 `FORBIDDEN`（`workspace_id` 与决策工作区不一致） |

### 20.1 身份与权限（PERM-2）

**身份解析**：只认请求头 `X-AgentBoard-Actor`；没有该头 → 缺省 `user`（单机行为不变）。头存在但为空 / 超过 100 字符 / 含控制字符 / `agent:` 后名字为空 → **401 `UNAUTHENTICATED`**，绝不降级成 `user`。`user` 原样保留，其他值规范化为 `agent:<name>`。body 的 `by` / `answered_by` / `agent_id` 只保留原有业务语义（撤回人 / 回答人 / claim 的 agent），**不再用于反推权限身份**。

**错误分工**：

| HTTP | code | 触发 |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | 身份头非法（空 / 超长 / 控制字符） |
| 403 | `WORKSPACE_FORBIDDEN` | 身份有效，但不是目标工作区成员 |
| 403 | `ROLE_FORBIDDEN` | 是成员，但角色不够 |
| 403 | `DECISION_HUMAN_ONLY` | **回答口径：仅人类可答**。`POST /api/decisions/:id/answer` 的 body `answered_by` 不等于 `user`（agent 自答）时拒绝；CLI `kb answer` 默认发 `answered_by=<KB_AGENT 或 kb-cli>`、MCP `answer_decision` 配了 `AGENTBOARD_AGENT_ID` 时同样发 agent 身份，因此两端都会被拒 |

**仅人类可答（DEC-HUMAN-ONLY）**：唯一放行条件是 `answered_by=user`。agent 的合法出口只有「等人回答」与 `kb decision withdraw <id> --reason …`；两端错误文案同义（**都是中文**，MCP 侧另带 `DECISION_HUMAN_ONLY` 码），都指向「由人在看板『待决策』回答，或 withdraw 后重新 claim」。MCP 在带 `AGENTBOARD_AGENT_ID` 时把 `list/get` 的 `capabilities.can_answer` 覆写为 `false`，避免模型以为能自答。

**决策锁（`DECISION_LOCKED`）**：卡上有 open 决策（宽限超时已落锁）时，`kb claim` / `kb dep add` 等写操作返回 **409 `DECISION_LOCKED`**（CLI 退出码 2，文案说明「占用已释放、卡已回待规划、fence +1」与解锁路径）。它与 `ISSUE_CLAIMED` 不同：不是别人占着，而是必须等人类回答或撤回。

**角色矩阵**（`workspace_member`；迁移期既有工作区均已 seed 为 `user/owner`）：

| 动作 | owner | member | viewer | 非成员 |
| --- | --- | --- | --- | --- |
| 查看列表 / 详情 | ✓ | ✓ | ✓ | 403 |
| 回答决策 | ✓ | ✓ | 403 | 403 |
| 修订答案 | 本人 + 他人 | 仅本人 | 403 | 403 |
| 撤销回答（6 秒 undo） | 本人 + 他人 | 仅本人 | 403 | 403 |
| 撤回决策 | ✓ | 403 | 403 | 403 |
| 延长宽限 | ✓ | ✓ | 403 | 403 |
| 提问 `POST /api/issues/:id/ask` | 需持有效 claim | 需持有效 claim | 403 | 403 |

- 上表角色只对**人类**（`answered_by=user` / 身份头缺省 `user`）生效；agent 自答一律 403 `DECISION_HUMAN_ONLY`，不进入角色判断。
- `capabilities`（`can_answer` / `can_revise` / `can_undo` / `can_withdraw` / `can_extend`）由服务端按「角色 + 当前答案归属」计算，前端只按能力渲染；`can_undo` 只表示有资格，实际还受 6 秒窗口与 `expected_revision` 约束。
- 权限校验先于状态校验：403 路径不写库、不广播（`apps/server/test/decisionPermission.test.ts` 用逐字段快照 + broadcast spy 作证）。

撤销回答语义（DEC-V4-UNDO-SERVER）：

- 窗口固定 `6000ms`（服务端常量 `DECISION_UNDO_WINDOW_MS`），请求体不能覆盖；从最近一次回答/修订时刻起算，过期一律 409 `UNDO_WINDOW_EXPIRED`。
- 回滚目标取回答时快照 `answered_from_state`：回 `grace` 沿用原 `grace_until`（已过期则立即复用落锁逻辑，**宽限不因撤销续命**）；回 `open` 时卡保持「待规划」。
- 答案行只打 `revoked_at` / `revoked_by` 墓碑，**不物理删除**；`current_answer_id` 置空、`answer_revision` 不回退；`undone_at` / `undone_by` / `last_undone_revision` 记录最后撤销。
- `claimed_by` 不恢复、`claim_fence` 不回退；open 场景若已有人重新 claim → 409 `UNDO_CLAIMED_AFTER_LOCK`。
- 幂等：同一 `by` + 同一 `expected_revision` 在窗口内重复调用返回 200 `already_undone: true`，不写库、不重复广播。
- 广播 `decision.undone`（带 `reverted_to` / `last_undone_revision` / `undo_deadline_at`）与 `issue.changed`；幂等重放不广播。

延长语义：

- `grace_until = max(now, 原 grace_until) + seconds × 1000`：已过旧截止但尚未落锁的决策从 `now` 起续，不会被压缩；
- 累计 `extended_seconds` / `extension_count`，记录 `extended_by` / `extended_at`；**不改** `grace_seconds`、**不续** `claim_fence`、不改卡状态（落锁仍由 ticker 按新截止执行）；
- 上限 `max_extend_seconds = min(300, max(0, 600 - grace_seconds))`：原宽限 600 秒时不可延；
- WS 广播 `decision.extended`（带 `grace_until` / `extended_seconds` / `extension_count`）与 `issue.changed`。

CLI：

```
kb ask-extend <decision-id|≥8 位前缀> [--seconds 60] [--by <actor>] [--fence <n>] [--json]
```

退出码：`0` 成功；`1` 决策不存在 / 服务不可达 / 其它；`2` 非宽限中、超上限（409）、跨区（403）；`3` `--seconds` 或 id 前缀非法（不发请求）。

## 21. CLI / MCP 能力对照（ARCH-01）

口径：`有` = 有等价 MCP 工具（可能一个 CLI 命令对应多个工具）；`无` = 当前没有 MCP 版，但语义上不排斥；`永不提供` = MCP 是**远程语义**，该命令只操作本机文件 / 本机库 / 本机凭据 / 本机操作系统，远程调用没有意义或越权。

新增或删除 `kb` 顶层命令时**必须同步本表**：`apps/mcp/test/cliMcpParity.test.ts` 会解析 `packages/cli/src/index.ts`（含 `register*Commands` 模块）与本表并断言命令集合一致，缺行 / 未登记 / 「MCP 版」列取值非法都会失败。演练记录见该用例所在卡 ARCH-01 的完成备注。

| CLI 顶层命令 | MCP 版 | MCP 工具 | 说明 / 不提供原因 |
| --- | --- | --- | --- |
| `kb list-spaces` | 有 | `list_workspaces` | 只读工作区清单；本机 path 刻意不暴露 |
| `kb list-tasks` | 有 | `list_tasks` | 平铺/树两种读法；列表不含正文（正文走 `get_task`） |
| `kb next` | 有 | `next_tasks` | 与 `kb next --json` 同形，共用 shared boardViews |
| `kb stats` | 有 | `workspace_stats` | 与 `kb stats --json` 同形，共用 shared boardViews |
| `kb grep` | 永不提供 | — | 本机文件内容检索：需要本地路径与文件系统遍历，MCP 远程调用无意义 |
| `kb show` | 有 | `get_task` / `get_task_comments` | 任务正文与评论分别提供窗口化读取 |
| `kb claim` | 有 | `claim_task` | 原子领取，审计标签为 MCP 配置的 agent |
| `kb release` | 有 | `release_task` | 释放占用 → 待规划 |
| `kb comment` | 有 | `add_task_comment` | 文本评论；图片附件仅 CLI/HTTP 提供 |
| `kb accept` | 有 | `accept_task` | 结构化验收记录，不改卡状态 |
| `kb done` | 有 | `complete_task` | 完成 → 待验收；`scope`（string[]）同 CLI `--scope`，未声明时服务端不自动提交（`NO_SCOPE`），不是「只在 CLI 侧」；`board_only`（boolean）同 `--board-only`，与 `scope` 互斥（同传 400 `BOARD_ONLY_SCOPE_CONFLICT`，不静默取舍）；收尾门禁同 CLI：`changelog_id` 引用本工作区已有日志（**不等价** `--close-record`——后者是新建一条）、`skip_changelog` 等价 `--no-changelog` |
| `kb close` | 有 | `close_task` | 待验收 → 已关闭 |
| `kb reopen` | 有 | `reopen_task` | 已关闭/已废弃 → 指定状态 |
| `kb update` | 有 | `update_task` | 字段与状态更新，带 CAS |
| `kb delete-issue` | 有 | `delete_task` | 不可逆删除，占用中/含子卡拒绝 |
| `kb fail` | 有 | `fail_task` | 退回待规划并写失败原因 |
| `kb create-space` | 无 | — | MCP 以绑定工作区为运行前提，不负责登记工作区 |
| `kb delete-space` | 无 | — | 同上：工作区管理属本地/管理面操作 |
| `kb create-issue` | 有 | `create_task` | 建卡（含父卡、标签、优先级） |
| `kb move-issue` | 有 | `update_task` | 通过 `parent_issue_id` 改父卡（传 null 恢复根卡） |
| `kb knowledge` | 有 | `list_knowledge` / `read_knowledge` / `search_knowledge` / `find_knowledge_sources` / `create_knowledge` / `revise_knowledge` / `archive_knowledge` / `restore_knowledge` | 知识页读、检索、写与归档全链路 |
| `kb changelog` | 有 | `list_changelog` / `get_changelog` / `create_changelog` | MCP 只提供列表/详情/新建；更新与删除仍走 CLI。`create_changelog` 传 `issue_id` 归属本卡后，`complete_task` 无需 skip 即可过门禁（CLI 对应 `kb changelog create --issue <卡 id>`） |
| `kb accounts` | 永不提供 | — | 本机 CLI 账号与凭据切换：涉及本机凭据文件，MCP 远程语义下无凭据上下文且越权 |
| `kb dep` | 有 | `list_dependencies` / `add_dependency` / `remove_dependency` | 依赖边读写 |
| `kb status` | 有 | `list_statuses` / `add_status` / `remove_status` | 工作区状态字典 |
| `kb autostart` | 永不提供 | — | 本机 Windows 自启（注册表 Run 键 / vbs），远程调用无意义 |
| `kb shortcut` | 永不提供 | — | 本机桌面快捷方式（.lnk），远程调用无意义 |
| `kb workspace-db` | 永不提供 | — | 本机数据库下沉 / 回迁 / 快照：直接操作本机库与工作区目录，MCP 远程语义无意义 |
| `kb ask` | 有 | `ask_decision` | 提问并等待宽限 |
| `kb decisions` | 有 | `list_decisions` | 列待决策 |
| `kb decision` | 有 | `get_decision` / `withdraw_decision` | 决策详情与撤回（show / withdraw 子命令） |
| `kb answer` | 有 | `answer_decision` | 回答或修订决策答案 |
| `kb ask-extend` | 有 | `extend_decision_grace` | 延长宽限窗口 |
| `kb stop-check` | 有 | `stop_check` | 协作式停止检查 |

## 22. 专家团 teams（P3-A）

数据：`teams` / `team_members` 两张表落**中心库**（与 personas 同层，`workspace_id` 标归属）；成员会话行仍落归属工作区库，本表只存 `session_id` 引用。迁移 `apps/server/src/db/migrations/teams.ts`（纯追加、幂等）。

端点（均挂在 `/api` 下）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/teams` | 建团。体：`workspace_id` / `name`（≤50）/ `lead_session_id` / 可选 `max_turns_per_member`（1–200，默认 20）/ `budget_tokens`（≥1000，默认 200000）。lead 会话必须存在且属于同一工作区；一个 lead 会话最多带一个团（409）。成功 201，返回团详情 |
| GET | `/teams?workspace=<id>` | 按工作区列团（含成员快照），数组；缺 `workspace` 400 |
| GET | `/teams/:id` | 团详情：`{...team, members:[{session_id, role, agent_name, status, usage:{turns,tokens,tool_calls}, session}]}`；不存在 404 |
| POST | `/teams/:id/members` | 加成员。体：`cli` / `role`（≤30）/ `agent_name`（≤30）/ 可选 `persona_id`（必须存在）/ `model`。服务端按 `createSession` 建**自由会话**（`issue_id=null`，不绑任务），再补 persona；成功 201 返回团详情。团队已停止 409 |
| DELETE | `/teams/:id/members/:sessionId` | 移除成员：先停成员会话（不可用则跳过）再解绑；**不删会话历史**。成员不存在 404 |
| POST | `/teams/:id/stop` | 停团：`status='stopped'`，成员统一停轮；之后派活 409 |
| POST | `/teams/:id/dispatch` | 向成员派活。体：`session_id`（必须是本团成员）/ `prompt`（1–20000 字）。成功 202 `{team_id, member, queued, usage}` |

编排语义：

- **lead 每轮注入名册**：对「作为 lead 的会话」调 `POST /sessions/:id/messages` 时，服务端在用户消息前拼一段 `## 专家团「<name>」…` 名册块（成员角色/名/状态/轮次/tokens/session_id）。非 lead 会话原文不变。
- **派活指令**：lead 原消息中单独一行 `@成员名: 任务内容` 会被解析（按成员 `agent_name` 精确匹配），后台为该成员会话起一轮；成员结果（assistant 正文）在本轮收口后以 `## 成员回报（角色「名」）` 形式回传 lead（lead 运行中则排队）。派活指令**不**从注入的名册块解析（名册含示例，避免自触发）。
- **成本护栏**：派活前校验 ① 团队 `status=active` ② 成员 `turns < max_turns_per_member` ③ 团队累计 tokens `< budget_tokens`；任一不满足返回 409，文案说明具体原因。tokens 取该成员最后一轮 `session_turn.usage_json` 的 `input+output`，`tool_calls` 取该轮计划步骤数。
- **不使用 CLI 内生子代理**：成员一律独立会话，成员消息不经 lead 之外的通道外发（v1 口径）。

WS：以上写操作（建团/加删成员/停团/派活/成员轮次收口）广播 `team_update`：

```json
{ "type": "team_update", "team_id": "<uuid>", "status": "active|stopped",
  "members": [{ "session_id": "...", "role": "...", "agent_name": "...", "status": "idle|working|done|failed", "usage": { "turns": 0, "tokens": 0, "tool_calls": 0 } }],
  "reason": "created|member_added|member_removed|stopped|dispatch|member_done|member_failed|guardrail|snapshot|imported" }
```

`team_update` 已并入前端 `WsEvent`（P3-B：`apps/web/src/api/ws.ts` 收到后失效 teams 查询）。

退出码：沿用统一错误响应 —— 400 `VALIDATION_ERROR`（字段非法 / lead 或 persona 不存在 / lead 不属于该工作区）、404 `NOT_FOUND`（团/工作区/成员不存在）、409 `CONFLICT`（lead 已属其他团 / 团队已停止 / 成员轮次上限 / token 预算用尽）。

## 23. 专家包导入（`POST /api/expert-packages/import`，`services/expertPackage.ts`，P3-C）

从服务端本机目录解析 **WorkBuddy 专家包**，落成 AgentBoard 的 `personas` 与团队模板（`teams` / `team_members`），供专家组复用。只做格式兼容，不复制 WorkBuddy 代码。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/expert-packages/import` | 体：`workspace_id`（必须存在，uuid）/ `path`（专家包目录，绝对路径优先；相对路径按服务进程 cwd 解析，≤4096 字）。成功 201 |

兼容包结构（下列文件在包根目录或 `.codebuddy-plugin/` 子目录均可）：

- `plugin.json`（必填）：`name`（必填，≤50 字）、`expertType`（`agent`/`team`，可省）、`teamInfo.leadAgent`（`team` 必填）+ `teamInfo.memberAgents`（字符串数组，可省）
- `agents/*.md`（必填，≥1 个）：YAML frontmatter（`name` 必填且包内唯一；`displayName` / `description` / `profession` / `maxTurns` 可选）+ 正文即 persona 正文
- `settings.json`（可选）：合法 JSON 对象；`maxTurnsPerMember` / `maxTurns`（1–200）映射团队轮次上限

写入语义（**先整包校验再单事务落库**，任一步失败整包回滚）：

- 每个专家 → 一行 `personas`：`source='import'`、`package_path=专家包目录`、`name=displayName||name`（≤100）、`description`、`body_md=frontmatter 之后正文`（≤100000 字）
- 有 `teamInfo` → 一行 `teams` 模板：`source='import'`、`status='stopped'`、`package_path=目录`、`lead_session_id='import:<team-id>'` 占位、`max_turns_per_member=settings 值 ?? 20`
- 对应 `team_members`：`session_id='import:<team-id>:<序号>'` 占位、`role=profession||主理人|成员`（≤30）、`agent_name=displayName||name`（≤30）、`persona_id=导入的 persona`；成员 = `leadAgent` + `memberAgents`（去重，主理人在首位）
- 模板**无真实会话**（`import:` 前缀占位只为满足 NOT NULL/唯一索引，列表接口里 `session=null`），`status='stopped'` 使派活/加成员被 409 挡住——按模板开真实团由后续卡片负责，不在本端点内建会话

响应：`{ package: { name, path, type }, personas: [{id,name}], team: 团详情|null }`（`team` 详情与 `GET /teams/:id` 同形）。

错误：400 `VALIDATION_ERROR`（目录不存在 / 缺 plugin.json 或 agents/*.md / 坏 JSON / 缺 name / `teamInfo` 引用不存在的专家 / 字段超长）、404 `NOT_FOUND`（工作区不存在）、409 `CONFLICT`（同工作区已有同名团队模板 / 同一目录已导入过）。

WS：新建模板广播 `team_update`（`reason='imported'`，`status='stopped'`）。

## 24. 智能体人设 personas（`/api/personas`，personaRoutes.ts，P1-C / PERSONA-LIB）

人设（persona）是**全局资源**：定义落中心库 `personas` 表，不随工作区库下沉。会话与团队成员只保存 `persona_id` 字符串引用（无外键约束）。设置页「智能体人设」是**库管理入口**；某个会话用哪个人设仍到「会话设置 → 人设」绑定，二者不是同一入口。

端点（均挂在 `/api` 下）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/personas` | 列出全部人设（含 `body_md`，按 `created_at` 倒序，新建在前）；数组 |
| POST | `/personas` | 新建。体：`name`（必填，≤100）/ `description`（≤2000，缺省空串）/ `body_md`（必填，≤100000）。成功 200，返回新行（`source='user'`、`id` 为 uuid） |
| PATCH | `/personas/:id` | 局部更新。体至少含 `name` / `description` / `body_md` 之一（字段上限同新建）；`source` / `package_path` 不可改。成功 200 返回更新后行 |
| DELETE | `/personas/:id` | 删除；成功 204 无体 |
| POST | `/personas/draft` | 智能创建草稿（**不落库**）。体：`requirement`（1–4000 字）/ `adapter`（`dsh` / `codex` / `opencode` / `codebuddy`）。见下 |

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string(uuid) | 主键 |
| `name` | string | ≤100 字，必填 |
| `description` | string | ≤2000 字；缺省 `''` |
| `body_md` | string | 人设正文（Markdown），1–100000 字；作为系统提示词注入使用该人设的会话 |
| `source` | `builtin` \| `user` \| `import` | 内置 / REST 新建 / 专家包导入（§23 写入） |
| `package_path` | string \| null | `source='import'` 时为专家包目录；其余 `null` |
| `created_at` | number | 毫秒时间戳 |

语义：

- **builtin 只读**：`PATCH` / `DELETE` 命中 `source='builtin'` 返回 409 `CONFLICT`（文案分别为「builtin persona 不可修改」「builtin persona 不可删除」），包内置定义不可经 REST 篡改。
- **import 可改可删**：`source='import'` 与 `user` 一样走 PATCH / DELETE；`package_path` 只作来源标记，不参与鉴权。
- **悬空引用**：`session.persona_id` 无外键。写入侧校验存在——`PATCH /sessions/:id` 传 `persona_id` 时 persona 必须存在（否则 400 `VALIDATION_ERROR`），加团队成员时 `persona_id` 同理；起轮侧按缺失**静默跳过**（查不到就不注入人设，会话照常跑，不报错）。
- **智能创建草稿**（`POST /personas/draft`）：复用任务卡智能创建的 `DraftRunner`（一次性 `runTurn`，不建会话、不占 claim）与 120s 超时。模型须返回严格 JSON：`{ name, description, role, tone, boundary, domain, warnings[] }`；缺省段落归一化为空串，`role` 必填。结构不合法自动重试 1 次。响应只含草稿字段，**不落库**；用户确认后由前端拼 `## 角色 / ## 语气 / ## 边界与禁忌 / ## 擅长领域` 小节，再走 `POST /personas`。personas 是全局资源，无 workspace 维度，因此不写 `issue_draft_audit`。
- 交叉引用：§23 专家包导入逐专家写入 `source='import'` 的 persona；团队模板成员的 `persona_id` 指向这些行。

错误码：

- 400 `VALIDATION_ERROR`：字段缺失/超长、PATCH 空体、`adapter` 非法、`requirement` 为空。
- 404 `NOT_FOUND`：`PATCH` / `DELETE` 的 persona 不存在；`POST /personas/draft` 在路由未加载时表现为统一 404（旧进程）。
- 409 `CONFLICT`：`builtin` 人设改/删。
- 503 `ADAPTER_UNAVAILABLE`：草稿生成前探测到执行方式不可用（附原因）。
- 502 `PERSONA_DRAFT_FAILED`：适配器调用失败。
- 422 `PERSONA_DRAFT_INVALID`：两次输出都不是合法结构（已重试 1 次）。
- 504 `DRAFT_TIMEOUT`：草稿生成 120s 未完成。
