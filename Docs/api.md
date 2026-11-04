# AgentBoard HTTP API 参考

本文件是 REST + WebSocket 接口的完整参考，以 `apps/server/src/api/routes.ts`（及其中挂载的 `knowledgeRoutes.ts`、`accountRoutes.ts`）当前实现为准；表内 `routes.ts:n` / `knowledgeRoutes.ts:n` 为行号锚点。设计概要见 `Docs/设计文档.md` §6.1。

## 1. 服务与配置

- 启动命令、后台常驻：见 `README.md`「启动」节。
- 监听地址：仅 `127.0.0.1:<port>`（`index.ts:122`），REST 前缀 `/api`，WebSocket 路径 `/ws`。
- 默认：端口 8787，并发上限 3，图片配额 1 GiB、暂存 TTL 24h、清理周期 1h，DB `%APPDATA%\AgentBoard\agentboard.db`（`config.ts`）。
- 端口误判：DSH 桌面端插件经 DSH web server 暴露独立数据源，对其请求返回 401 时见 `README.md`「与 DSH 任务看板插件的边界」。
- 配置文件 `%APPDATA%\AgentBoard\config.json`（非 Windows 回退 `~/.config/AgentBoard/`），字段 `port` / `dbPath` / `maxConcurrentTurns` / `attachmentQuotaBytes` / `attachmentStagedTtlMs` / `attachmentCleanupIntervalMs`；首次启动写回默认值，文件损坏按默认处理且不覆盖原文件（`config.ts`）。
- 环境变量 `AGENTBOARD_PORT`（正整数）、`AGENTBOARD_DB`（非空路径）：仅启动期覆盖，不写回 config.json；`GET /api/settings` 不回显 env 覆盖值（`config.ts:88-95, 98-105`）。
- 环境变量 `AGENTBOARD_WORKBUDDY_REGION`（`cn` / `global`，缺省 `cn`；非法值启动即报错）：决定 WorkBuddy 签到与额度请求的计费域，同样仅启动期生效、不写回 config.json、`/api/settings` 不回显（`config.ts`、`services/accounts/platformHosts.ts`）。CN = `https://www.codebuddy.cn`（有业务成功证据），Global = `https://www.workbuddy.cn`（区域备用线路）；`unknown` 区域在装配期直接抛 `CHECKIN_REGION_UNSUPPORTED`，不回落默认域。
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
| `GET /api/settings` | — | `{ port, dbPath, db_path, maxConcurrentTurns, attachmentQuotaBytes, attachmentStagedTtlMs, attachmentCleanupIntervalMs }`（仅 config.json 持久化值；`db_path` 是对外规范名、`dbPath` 是持久化键，两者同值同出） | — | routes.ts |
| `PATCH /api/settings` | body：`port?: int 1-65535`、`db_path?: string 非空`（对外名，`dbPath` 为兼容别名；两者同时出现且不一致 → 400）、`maxConcurrentTurns?: int ≥1`、附件数值设置均为安全正整数（至少一个；未知键忽略） | 与 `GET /api/settings` **同形**的新配置（含 `db_path`）；并发和附件设置即时生效；迁移进行中改 db 路径 → 409 `DB_MIGRATION_BUSY` | 400 未提供字段 / 取值非法 | routes.ts |

﻿### 后端改动上线口径（源码新 ≠ 运行新）

后端改动必须 **重建 dist + 重启服务**，否则端口上跑的仍是旧代码（RESTART-PROXY 的起因就是 8787 上跑旧 dist，`/api/version` 连 `instance_id` / `proxy_env` 都没有）。

| 步骤 | 命令 |
| --- | --- |
| 构建 | `pnpm --filter @agentboard/server build`（或 `pnpm -r build`） |
| 重启 | `pnpm server:ensure`（未监听会拉起；已监听会复用，**不会**换代码）→ 需要换代时用 `POST /api/system/restart` |

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
﻿﻿| 两条拉起路径 | `pnpm server:ensure`（启动器）与 `POST /api/system/restart`（服务内 `performRestart` → `spawnDetached` → `restartChildEnv`）**共用 `@agentboard/shared` 的 `ensureProxyEnv`**：宿主有代理变量且未显式设 `NODE_USE_ENV_PROXY=0` → 子进程 env 注入 `=1`。RESTART-PROXY（`8d0bb480`）之前只有启动器注入，任何一次 restart 都会丢代理 |
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

### KBIMP-1B2 json 数组逐条 `category` / `landed`

`format: 'json'` 的数组逐条取值，**逐条字段优先于请求顶层**：

| 情形 | 结果 |
| --- | --- |
| 本条有 `category` / `landed` | 用本条的值 |
| 本条 `category: null` / `''` | 本条未指定（不继承顶层）→ 归一为 `legacy` |
| 本条 `landed: null` / `''` | 本条「未落地」（不继承顶层）→ `design` 归一为 `proposed`，其它分类 `null` |
| 本条没有这两个键 | 继承请求顶层的 `category` / `landed` |
| 本条值非法 | **400** `VALIDATION_ERROR`，message 指明第几条与可选值（例：`第 2 条 landed 非法：done（可选 landed / partial / proposed；null 表示未落地）`） |

缺省归一规则不变：缺失/未知 `category` → `legacy`；`design` 缺 `landed` → `proposed`；非 `design` 类 `landed` 恒为 `null`。

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
| `GET /api/issues` | query：`workspace`（必填）、`status?`（**该工作区已定义的任意状态名**：内置五状态 + 自定义；分页与非分页都生效）、`limit? offset?` | `Issue[]`（sort_order,created_at,id 升序）；分页模式 `PageResult<TaskPreview>`（id 升序；description 截取默认 12000 字符并附 `description_truncated` `next_description_offset_chars`） | 400 缺 workspace / 分页非法 / `status` 不属于该工作区（文案列出可用状态）；404 工作空间不存在 | routes.ts |
| `POST /api/issues`（幂等） | body：`workspace_id: string`、`title: string 非空`、`description?: string`、`priority?: '低'\|'中'\|'高'`（缺省 中）、`labels?: string[]`（缺省 []） | `Issue`（status=待规划、sort_order=0）；WS issue.changed | 400 校验失败；404 工作空间不存在 | routes.ts:268 |
| `POST /api/issues/draft` | body：`workspace_id`、`requirement: string 1-4000`、`adapter: 'dsh'\|'codex'\|'opencode'`、`priority?: '低'\|'中'\|'高'` | **不落库**：`{ cards: [{ local_id, title, description, labels, warnings }], title, description, labels, warnings }`（MULTI-DRAFT：多条需求按原话分条，1 条 1 张卡，最多 10 张；顶层字段镜像 `cards[0]` 以兼容旧单读法；`splitRequirementItems` 只切分不推断，模型条数不符时按原文逐条兜底）。`description` 固定三段（`## 背景` / `## 要求` / `## 验收`），模型没给的段落写「未提供」，**不补需求、不编验收条件**；`labels` 只保留工作区已有标签，自造的丢弃并进 `warnings`；一次性适配器调用（不建会话/不占 claim），超时 120s；审计写 `issue_draft_audit`（只记 adapter/耗时/成败/warning 数，不记需求原文） | 400 参数非法（adapter 不在三家内、requirement 空/超长）；404 工作空间不存在；422 `DRAFT_INVALID_OUTPUT`（JSON 不合法，已重试 1 次）；502 `DRAFT_ADAPTER_FAILED`；504 `DRAFT_TIMEOUT` | routes.ts（`services/smartCreateDraft.ts`） |
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
| `DELETE /api/workspaces/:workspaceId/statuses/:statusId` | query：`migrate_to`（**必填**，目标状态名）、`workspace_id?` | 200 `{ removed, migrate_to, migrated_issue_count }`；同事务把该状态下的卡全部改成 `migrate_to` 再删行。`migrated_issue_count` = **实际迁移卡数**：先 `SELECT COUNT(*)` 该状态卡数再 UPDATE，两者不等则 500 `MIGRATION_COUNT_MISMATCH` 回滚（宁可报错也不谎报 0）；该状态本来没卡时为真实的 `0` | 400 `MIGRATION_TARGET_REQUIRED` 缺 migrate_to / `MIGRATION_TARGET_INVALID` 目标不存在或等于自身 / `workspace_id` 不一致；409 `WORKSPACE_STATUS_BUILTIN` 内置不可删；500 `MIGRATION_COUNT_MISMATCH` 计数不一致（已回滚）；404 `NOT_FOUND` 状态或工作空间不存在 | workspaceStatusRoutes.ts |

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

WorkBuddy Desktop 账号捕获/切换。设计见 `Docs/design-2026-11-01-workbuddy-accounts.md` §6/§8 与 `Docs/DESIGNS.md`「账号 provider：WorkBuddy Desktop」。响应只含脱敏元数据（无 identity_hash、快照引用、信封或凭据字节）；同一 client_instance_id 的操作经 operationRunner 串行并独占锁；实例存在 recovery_required 操作时写类请求一律 409 `RECOVERY_REQUIRED`（先走 `POST /api/managed-accounts/:id/restore` 解冻，见下表）。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| `GET /api/managed-accounts` | query：`app?`（`workbuddy_desktop` / `codebuddy_desktop` / `minimax` / `trae` / `qoder_cn` / `zcode`，与 `packages/shared` 的 `ManagedAppId` 一致（六值；`qoder_cn` / `zcode` 自 ACC-KB-B1S 起登记，provider 未实现，能力矩阵全关并给 `PROVIDER_NOT_IMPLEMENTED`）） | `Array<PublicManagedAccount & { is_current: boolean\|null }>`（created_at,id 升序；is_current 按 provider 只读身份比对，provider 未装配时 null） | 400 app 非法 | accountRoutes.ts:174 |
| `POST /api/managed-accounts/:app/capture-current` | body：`display_name?`（1-100） | `{ account: PublicManagedAccount }`；同步执行（preflight→快照 DPAPI 加密→复读身份） | 409 `PROVIDER_UNVERIFIED`（codebuddy_desktop，details.reason_code=TARGET_KIND_UNCONFIRMED） / 409 `CLIENT_INSTANCE_NOT_FOUND` `CLIENT_VERSION_UNSUPPORTED`（非 5.9.3.x）`CLIENT_SCHEMA_UNSUPPORTED`（v1 明文）`CLIENT_NOT_RUNNING` `IDENTITY_UNAVAILABLE`（缺 uid）`IDENTITY_CHANGED` `ACCOUNT_EXISTS`；409 `RECOVERY_REQUIRED` 实例冻结；503 `PROVIDER_UNAVAILABLE` / `VAULT_*` | accountRoutes.ts:186 |
| `POST /api/managed-accounts/:id/switch` | — | 202 `{ operation_id, operation: AccountOperation }`；执行异步，阶段 preflight→stop→snapshot→validate_target→write→start→verify→(rollback)，结果轮询 `GET /api/account-operations/:id` | 404 `NOT_FOUND` 账号不存在；409 `PROVIDER_UNVERIFIED` / `RECOVERY_REQUIRED`；切换失败码见下 | accountRoutes.ts:197 |
| `POST /api/managed-accounts/:id/restore` | body 可省略 | 202 `{ operation_id, operation: AccountOperation, recovered_operation_id, replayed: boolean }`。**解冻通道（ACC-KB-A3 已交付）**：取该实例最新的 `recovery_required` 操作，发起 `operation='restore'` 并经 operationRunner 收尾——原操作转 `failed` + `safe_error_code='RESTORED'`，实例随即不再被 `RECOVERY_REQUIRED` 挡住。**幂等**：已解冻过的实例再调返回原 restore 操作（`replayed=true`），不新建 operation 行、不会把已恢复实例二次置 failed。**B4S-3 起本端点也是唯一的回滚通道**：被冻结操作的 `recovery_ref`（= 快照 vault ref）存在且该平台注册了 `RestoreHandler` 时，端点会**真正把快照写回客户端**再解冻；处理器失败 → restore 操作 `failed`、实例保持冻结、可再次触发本端点重试；未注册处理器的平台保持原「人工确认已恢复/放弃恢复」语义 | 400 `id` 非 UUID；404 `NOT_FOUND` 账号不存在；409 `RECOVERY_NOT_REQUIRED` 该实例没有需要解冻的操作 | accountRoutes.ts:216、`services/accounts/restore.ts` |
| `PATCH /api/managed-accounts/:id` | body：`{ enabled: boolean }`（strict） | `PublicManagedAccount`（脱敏）。`enabled` 此前只有读取（签到授权 `ACCOUNT_DISABLED`、签到执行 `ACCOUNT_DISABLED`、前端参与判定），本端点补上写入路径（ACC-KB-A2） | 400 id 非 UUID / body 形状不对；404 `NOT_FOUND`；409 `ACCOUNT_BUSY`（该账号有排队或进行中的操作） | accountRoutes.ts:229、`db/repos/managedAccount.ts` |
| `DELETE /api/managed-accounts/:id` | — | `{ deleted: true, id }`；先删 vault 里的快照/签到凭据文件（`delete` 幂等），再删元数据行；`account_operation.account_id` 由 FK `SET NULL`，签到相关行 `CASCADE`。响应不含任何凭据/信封/快照引用 | 400 id 非 UUID；404 `NOT_FOUND`；409 `ACCOUNT_BUSY`（有排队或进行中的操作）/ `CHECKIN_AUTHORIZATION_EXISTS`（有未过期的签到授权）/ `RECOVERY_REQUIRED`（最近一次切换仍需恢复，快照是恢复依据）；503 `VAULT_UNAVAILABLE` | accountRoutes.ts:244 |
| `GET /api/managed-account-capabilities` | query：`app?`（同上四个枚举值；缺省返回全部） | `AccountCapability[]`（`app_id` + `capture`/`switch`/`checkin` 三态与原因码；含 minimax 客户端探测结果，60s 缓存） | 400 app 非法 | accountRoutes.ts:272 |
| `POST /api/accounts/import-credentials` | body：`{ platforms?: ('workbuddy'\|'trae'\|'minimax')[]（1-3，缺省全部）, actor?: string（≤100） }`（strict） | `CredentialImportResult`（逐平台 found/created/updated/skipped/error + 导入账号摘要；**不含 token/明文/路径**）。唯一入口：只在显式调用时读本机凭据，无启动或定时扫描（ACC-11） | 400 body 非法；503 `VAULT_UNAVAILABLE` 凭据保险库未装配 | accountRoutes.ts:282 |
| `POST /api/checkin-authorizations/start`（幂等，需 `Idempotency-Key`） | body：`{ account_id: uuid }`（strict） | 202 `{ authorization: CheckinAuthorization }`；为账号发起签到授权会话（回填凭据走 `attachCheckinCredential`，并把 `checkin_capability` 置 `supported`） | 400 body 非法；404 账号不存在；409 `PROVIDER_UNVERIFIED` / `CHECKIN_AUTH_UNSUPPORTED`（三平台均走本机凭据导入，不支持授权流程）/ `ACCOUNT_DISABLED`；503 `VAULT_UNAVAILABLE` | accountRoutes.ts:290 |
| `POST /api/checkin-authorizations/:id/poll` | — | `{ authorization, account }`；轮询授权状态，成功时落签到凭据 | 404 签到授权或账号不存在；409 `PROVIDER_UNVERIFIED` / `CHECKIN_AUTH_UNSUPPORTED` | accountRoutes.ts:304 |
| `POST /api/checkin-runs`（幂等，需 `Idempotency-Key`） | body：`{ app_id: 四枚举值, account_ids: uuid[]（1-50） }`（strict） | 202 `{ batch: CheckinBatch, replayed: boolean }`；建批次并后台逐账号执行；重放不重复提交 | 400 body 非法/账号不属于该产品；404 账号不存在；409 `ACCOUNT_BUSY`（同账号已有进行中操作）/ `PROVIDER_UNVERIFIED`；503 `VAULT_*` | accountRoutes.ts:315 |
| `GET /api/checkin-runs/:batchId` | — | `CheckinBatch`（逐账号 item 状态与固定错误码） | 404 批次不存在 | accountRoutes.ts:334 |
| `POST /api/checkin-runs/:batchId/cancel` | — | `{ batch_id, cancelled: uuid[], running: uuid[] }`；只撤销仍 `queued` 的项 | 404 批次不存在；409 `CHECKIN_BATCH_FINISHED` 批次已结束 | accountRoutes.ts:340 |
| `GET /api/account-operations` | query：`batch_id`（uuid，必填） | `AccountOperation[]`（created_at,id 升序） | 400 `batch_id` 非 UUID | accountRoutes.ts:350 |
| `GET /api/account-operations/:id` | — | `AccountOperation`（state/stage/safe_error_code，无敏感字段） | 404 `OPERATION_NOT_FOUND` | accountRoutes.ts:356 |

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

账号页三来源额度/余额聚合：**逐来源独立结果**（单来源失败不影响其它来源），服务端 60s 缓存 + 失败指数退避（60s 起，上限 10min），同来源并发只打一次第三方。取证结论（2026-11-03）：DeepSeek 走官方余额端点；OpenCode Go 走**本地 opencode 服务**的 usage 路由（ACC-QUOTA-02）；Codex 无公开窗口端点，固定 `unsupported`（不编造数据）。响应不含 token / identity_hash / 本机路径。

| 方法 路径 | 请求 | 响应 | 错误 | 源 |
| --- | --- | --- | --- | --- |
| `GET /api/managed-account-quotas` | query：`workspace_id?`（uuid；额度不按工作区切分，仅回显） | `{ items: QuotaResult[], fetched_at: number, workspace_id: string\|null }` | 400 `VALIDATION_ERROR`（workspace_id 非 uuid） | `services/quotas/quotaService.ts` |
**来源与分组（ACC-KB-B5S）**：来源从 3 个扩到 **8 个，分两组** —— `cli`（`deepseek` / `opencode_go` / `codex`，读本机 CLI 余额或本地额度快照）与 `platform`（`workbuddy` / `minimax` / `trae` / `qoder_cn` / `zcode`，读账号侧积分/套餐余量）。分组元数据在 `packages/shared` 的 `QUOTA_GROUPS` / `QUOTA_SOURCE_GROUP`，UI 必须分组展示（两套不同源、不同单位）。`QuotaWindow` 新增 optional `kind`（`rolling`/`weekly`/`monthly`/`credit`）与 `total`/`used`，`remaining` 语义不变。平台来源无凭据时如实返回 `status:'unsupported'` + `reason_code:'NO_CREDENTIAL'`（MiniMax 另注明缺少 `yy`/`x-timestamp`/`x-signature` 签名材料，待 B5S2），**不编造余额**。节流先取保守值：每来源并发 1、全局并发 2、成功结果 60s 缓存、429 走既有指数退避（60s 起 ×2，上限 10min），实测后再回写。

`QuotaResult`（ACC-KB-A4 起类型与来源清单只有一份，定义在 packages/shared/src/types.ts 与 constants.ts 的 QUOTA_SOURCE_IDS/QUOTA_SOURCE_LABEL；服务端 quotaService.ts 仅再导出）= { source: 'deepseek'\|'opencode_go'\|'codex', status: 'ok'\|'unsupported'\|'error', balance: number\|null, unit: 'CNY'\|'USD'\|null, windows: Array<{ name: string, remaining: number, reset_at: number\|null }>, fetched_at: number, reason_code: string\|null, detail: string\|null }`

- **deepseek**：`GET https://api.deepseek.com/user/balance`（Bearer）。key 走**多候选 + 逐个试**（ACC-QUOTA-03），按优先级：①`DEEPSEEK_API_KEY`（env）②`~/.deepseek/config.toml` 的 `api_key` ③`~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（**最低优先级的兼容来源**，DSH 私有格式、非官方约定，解析失败静默跳过）；依次打端点用第一个 200 的，命中来源在缓存生命周期内优先复用。`ok` 时给 `balance`/`unit`（优先 CNY）；无任何候选 → `unsupported` `CREDENTIAL_MISSING`；有候选但全部 401/403 → `error` `CREDENTIAL_INVALID`（`detail` 含「尝试过 N 个凭据来源」）；429 → `RATE_LIMITED`；5xx → `UPSTREAM_ERROR`；网络/超时 → `NETWORK_ERROR`；结构不符 → `UPSTREAM_SHAPE_UNEXPECTED`。
- **opencode_go**：走本地 opencode 服务 `GET {url}/api/experimental/usage/limits`（Basic `opencode:<~/.config/opencode/service.json password>`）。响应 `data.go.{rolling,weekly,monthly}={percent,limited,resetsAt}` → 三窗口（`5h`/`weekly`/`monthly`），`remaining = 100 - percent`、`used_percent = percent`、`reset_at = resetsAt`，`unit = '%'`、`detail` 给工作区名或限额提示。服务发现：`OPENCODE_SERVER_URL` 优先，否则 `netstat -ano` LISTENING 端口 ∩ `tasklist` 中名字含 `opencode` 的 PID（Windows）。不可用码：`OPENCODE_NOT_LOGGED_IN`（无 auth.json）/ `OPENCODE_AUTH_UNAVAILABLE`（无 service.json 口令）/ `OPENCODE_SERVER_NOT_RUNNING`（未发现本地服务）/ `OPENCODE_AUTH_FAILED`（401/403）/ `OPENCODE_ROUTE_UNSUPPORTED`（404）。
- **codex**（ACC-CODEX-QUOTA-IMPL）：只读**本机 rollout 快照**（零网络、零凭据）——扫描 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` 取 mtime 最新一份，读 `event_msg → payload.rate_limits`：`primary{used_percent, window_minutes:300, resets_at}` → `5h`、`secondary{window_minutes:10080}` → `weekly`（**只映射这两种窗口，Monthly 不展示**）；`resets_at` 为秒级 epoch（×1000 转毫秒）；`credits.balance` → `balance`/`unit=USD`，余额为 0 时 `detail="额度内"`（避免误读成欠费）。不可用码：`NO_CODEX_SESSIONS`（无 `~/.codex/sessions` 或无 rollout 文件）/ `NO_CODEX_RATE_LIMITS`（最新会话里没有 `rate_limits` 或窗口不可用）。不读 token 原文、不写 `.codex`、不请求 ChatGPT 后端（`/backend-api/codex/usage` 需浏览器 UA 才 200，本卡不启用，见 `Docs/research-2026-11-03-codex-quota.md`）。
- `windows[].reset_at` 为该窗口重置时刻（epoch ms），前端展示为本地 `HH:mm` + 剩余时长；无窗口概念时 `windows = []`。
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

响应：`{ pages: KnowledgePage[], warnings: string[] }`（json 数组会返回多条）。

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