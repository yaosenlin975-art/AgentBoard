# AgentBoard 共享知识库设计

- 日期：2026-11-01
- 状态：AgentBoard 内建知识库与数据库、FTS5 trigram、REST、CLI、Web 已实现；MCP 知识工具已实现。MCP 真实子进程和客户端接入仍待验收。
- 范围：AgentBoard 本地共享知识库；工具调用复用 `/api/knowledge/*`，不建第二套存储或搜索逻辑。

## 1. 需求分析

### 已确认需求

| 项 | 已确认内容 |
|---|---|
| 使用者 | Codex、DSH、WorkBuddy 等 LLM 工具中的 agent 共用；agent 通常写资料，用户查看，agent 在编写项目代码时读取。 |
| 知识范围 | 项目知识彼此隔离，另有一个通用经验公共库；任务检索同时查询当前项目知识和公共经验。此“公共”指当前 AgentBoard 实例内跨工作空间可见，不指互联网公开。 |
| 产品路线 | 在 AgentBoard 内建知识库。 |

### 设计提案（未获用户确认）

- 优先复用现有 Node/TypeScript、Express、SQLite 和 `kb` CLI；用 SQLite FTS5 本地检索。当前构建是否启用 FTS5、是否包含 `trigram` tokenizer 尚未验证。
- 首版不默认使用 embedding、自动 LLM 知识编译或查询改写；普通任务不增加固定多次 LLM 调用。若要加入这些能力，另行确认。
- 项目知识首版映射到 AgentBoard `workspace.id`；该实现选择、来源、版本、写权限和注入默认值以本文提案为准，均待确认。

### 目标

- agent 可按明确工作空间写入项目知识，并显式写入跨项目公共经验。
- 任务使用知识时，在单次本地检索中合并当前工作空间与公共范围；其他工作空间内容不得进入结果。
- 用户可浏览、搜索条目、查看来源证据、版本、归档与过期状态。
- 每次更新有版本号与来源；并发版本冲突返回 `409`，不静默覆盖。
- 知识检索使用本地检索，不发起额外 LLM 请求（检索引擎为 FTS5 是提案）。

### 非目标

以下首版范围均为设计提案：

- 不把工作空间文件、评论或聊天自动批量导入知识库。
- 不默认添加 embedding、自动摘要、自动 LLM 知识编译、远程搜索或云同步。
- 不新增多用户、团队角色、跨设备共享或互联网服务。
- 不改变 Issue 状态机、agent claim 锁或聊天轮次队列。
- 不在本轮引入 `llm_wiki` 源码、MCP package 或其他第三方代码。

## 2. 当前系统与术语

AgentBoard 是 Node.js ≥20、TypeScript、pnpm monorepo；server 使用 Express 5、`better-sqlite3` 12.11.1、Zod 4 与 WebSocket，web 使用 React 19、Vite 7、Tailwind 4。数据库连接开启 WAL、`busy_timeout=5000` 与外键；server 默认端口 8787，监听 `127.0.0.1`。[根 `package.json`](../package.json#L1-L9) · [server package](../apps/server/package.json#L1-L26) · [SQLite connection](../apps/server/src/db/connection.ts#L1-L11) · [server bind](../apps/server/src/index.ts#L108-L119)

现有数据对象是 `workspace`、`issue`、`issue_comment`、`session`、`message`。Workspace 表示一个唯一本地目录路径；没有独立 Project 实体。issue、session 都关联 `workspace_id`，agent CLI 进程以该工作空间路径为 cwd。[schema](../apps/server/src/db/schema.ts#L5-L29) · [shared types](../packages/shared/src/types.ts#L1-L28) · [sessionManager](../apps/server/src/services/sessionManager.ts#L359-L377)

“项目知识”首版提案固定映射到 AgentBoard `workspace.id`：`scope='workspace'` 时 `workspace_id` 必填；`scope='common'` 时为 NULL。实现按此契约，不额外引入 Project 表。用户确认了项目隔离需求，但没有确认 Workspace 与业务 Project 的长期等价关系；若后续要在一个 Workspace 内拆多个知识项目，需另做数据迁移设计。

现有 CLI `kb` 通过本地 HTTP API 工作，含 `list-spaces/list-tasks/show/claim/comment/done/fail`；`KB_AGENT` 记录 CLI 自报身份，不是鉴权凭据。UI 派发模板将 issue 标题、描述、工作空间路径及最近 10 条评论放入 prompt；`kb claim` 返回 issue、评论和工作空间路径；自由会话与任务会话均绑定 workspace。[kb CLI](../packages/cli/src/index.ts#L1-L104) · [dispatch prompt](../apps/server/src/services/dispatch.ts#L19-L33) · [prompt assembly](../apps/server/src/services/dispatch.ts#L91-L115) · [claim context](../packages/cli/src/commands/claim.ts#L7-L26)

当前源码直接重核后，knowledge / attachment / FTS 相关的数据表、接口和实现仍未出现；现有 SQLite 仅存任务与会话内容。Workspace 删除会直接删除 workspace 行，依赖现有外键级联删除 issue/session；新增知识外键时必须改为阻止静默级联删除。[schema](../apps/server/src/db/schema.ts#L5-L29) · [workspace deletion route](../apps/server/src/api/routes.ts#L173-L195) · [workspace repository](../apps/server/src/db/repos/workspace.ts#L31-L34)

### 权限基线

server 只绑定本机回环地址；已查启动装配没有用户登录或角色中间件。当前设计文档以单机单用户为假设。知识库首版沿用该边界：本机操作系统账户是访问边界；agent id 只用于审计记录，不能作为安全身份或 ACL。[server startup](../apps/server/src/index.ts#L62-L70) · [server bind](../apps/server/src/index.ts#L108-L119) · [CLI agent id](../packages/cli/src/index.ts#L34-L41) · [existing design assumptions](./设计文档.md#L1-L19)

## 3. 方案选型

用户已选择 AgentBoard 内建路线。下表保留已研究方案与简化替代的匹配情况，不表示用户同意本稿中尚未确认的数据和权限提案。

| 方案 | 版本 / 许可证 | 功能匹配与兼容性 | 移植成本、验证状态与结论 |
|---|---|---|---|
| **AgentBoard 原生 SQLite + FTS5** | 现有 `better-sqlite3` 12.11.1，MIT；Node.js ≥20。FTS5 是 SQLite 编译能力，不新增 npm 包。[安装包 metadata](../node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/package.json) | 与现有 REST、`kb` CLI、SQLite 单库和本机服务一致；可用 `workspace_id` 与 `common` scope 作联合检索。 | 新增知识表、repository、REST、CLI 和只读浏览 UI；不加第三方运行服务。锁文件与本机 package metadata 显示 better-sqlite3 版本和 MIT 声明；当前安装构建是否启用 FTS5 未验证，作为实现前置验收。它是内建路线下的检索实现提案，不是用户已确认项。[package](../apps/server/package.json#L10-L27) · [lockfile](../pnpm-lock.yaml#L1034-L1037) |
| **nashsu/llm_wiki 独立应用 + MCP** | 固定版本 v0.6.13，commit `e08cfce65aad8b76b13546a081c1a8d4422b70c3`；仓库根声明 GPL-3.0，MCP package v0.4.26 metadata 声明 MIT。[release](https://github.com/nashsu/llm_wiki/releases/tag/v0.6.13) · [root LICENSE](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/LICENSE) · [MCP package metadata](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/mcp-server/package.json#L15-L30) | 已有 Raw Sources / Wiki / Schema、项目内来源生命周期、MCP 与本地 API；但桌面实现是 Tauri/Rust + React，MCP 连接独立应用 API，数据位于项目目录。它不是可直接嵌入 AgentBoard 的 Node/SQLite 模块。[研究报告 R1–R5](../research/llmwiki/REPORT.md#r2-解剖) | 映射 Workspace、公共库、任务上下文和现有 DB 需要另建集成/服务边界；静态源码已研究，未安装或运行。作为机制参考，不作为运行依赖或代码来源。若后续拟移植/复制代码，是否保留 LICENSE、NOTICE 等文件须另行确认；本轮不引入代码。 |
| Workspace Markdown + 文件扫描 | 使用现有文件与 Node 文件系统，无新增 package。 | 能读当前工作目录文件；不能自然表达跨 workspace 公共库、来源版本和 CAS 更新边界，且当前服务没有文档文件检索接口。 | 表面改动少，但无法闭合公共库和任务联合检索需求；不作为本设计路线。此项为基于当前目录模型的对比，不是独立实现验证。 |

**选型提案：AgentBoard 原生 Node/SQLite；首版用 FTS5。** 用户已选内建路线，未确认本段检索实现细节。不默认增加 embedding 或 LLM 查询重写。FTS5 和 trigram 的实际构建支持在实现前验证；若当前 `better-sqlite3` 不支持，先报告结果并重新确认替代方案，不静默添加依赖或降级成不等价检索。

## 4. 架构与数据流提案

知识读写共用 Express REST/API 和 SQLite，不开第二个数据库服务。`knowledge` server 模块负责 workspace/common scope 校验、FTS 查询、版本写入和状态流转。`kb` CLI 与统一 AgentBoard MCP 是 agent 客户端；MCP 同时提供任务板和知识工具，知识工具调用同一 REST API，不直连数据库、不持有第二份知识内容。web 提供知识浏览与显式维护操作。MCP 工具范围、Workspace 绑定、输出窗口和错误契约见[统一 MCP 设计](./design-2026-11-01-unified-mcp.md)。MCP 客户端实际接入尚未验收。

实施时不得编辑既有 pinned DDL：`Docs/实施计划.md` 明确要求保留核心表契约，`schema.ts` 也标记 DDL 不得改动。知识相关表、索引、FTS 虚表通过新的幂等增量迁移函数建立，并在现有 `initSchema` / `migrateIssueColumns` 流程之后调用；不修改现有 `workspace`、`issue`、`session` 等表定义。迁移顺序应兼容现有用户数据库。[pinned contracts](./实施计划.md#L24-L111) · [schema initialization](../apps/server/src/db/schema.ts#L3-L43)

### 写入流程

1. Agent 调用 `kb knowledge create` 或 `kb knowledge revise`；默认 scope 为当前 issue 的 Workspace。
2. 请求显式给出 `scope`、标题、Markdown 内容、来源引用和证据；公共 scope 必须显式指定 `scope=common`。
3. server 校验 scope 与 workspace 对应关系、字段长度、slug 唯一性、来源证据格式和 `expected_revision`。
4. 同一 SQLite 事务保存页面当前版本、追加 revision snapshot、更新 FTS 项。事务任一部分失败时全部回滚。
5. 同 slug 重复创建返回 `409 KNOWLEDGE_EXISTS`；revision 不匹配返回 `409 KNOWLEDGE_REVISION_CONFLICT` 并返回当前 revision 编号；不做静默覆盖或 LLM 自动合并。

### 检索流程

1. `kb knowledge search` 或 task dispatch 传入当前 `workspace_id`、query 和 scope。
2. repository 只查询 `scope=common` 与 `scope=workspace AND workspace_id=current`；其他 workspace 不进入候选集。
3. SQL 过滤非 active、已过期或已删除页面，再从 FTS5 排序，返回标题、片段、revision、scope、来源和证据位置。
4. UI、CLI、dispatch 共用同一 API 与排序实现，避免为不同 agent 维护不同结果逻辑。

## 5. 数据结构提案

以下表为提案，字段类型采用当前 SQLite 约定；统一使用 `INTEGER` 毫秒 Unix 时间戳，JSON 字段在写入时用 Zod 校验。

### `knowledge_page`

| 字段 | 类型 / 约束 | 用途 |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUID |
| `scope` | `TEXT NOT NULL CHECK(scope IN ('workspace','common'))` | 项目知识或公共经验 |
| `workspace_id` | `TEXT NULL REFERENCES workspace(id) ON DELETE RESTRICT` | `workspace` scope 必填；`common` scope 必须为 NULL |
| `slug` | `TEXT NOT NULL` | scope 内稳定页面键；路径化或限制字符集由 schema 约束 |
| `title` | `TEXT NOT NULL` | 显示标题与 FTS 标题字段 |
| `body_md` | `TEXT NOT NULL` | 当前 Markdown 正文 |
| `status` | `TEXT NOT NULL CHECK(status IN ('active','archived','deleted'))` | 归档/删除为软状态；过期由时间判断 |
| `revision` | `INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)` | 当前 revision，CAS 基准 |
| `expires_at` | `INTEGER NULL` | 可选失效时间；NULL 表示未设期限 |
| `created_by`, `updated_by` | `TEXT NOT NULL` | 审计标签；不是授权凭据 |
| `created_at`, `updated_at` | `INTEGER NOT NULL` | 毫秒时间戳 |

表级检查约束保证 scope 与 workspace_id 一致。`workspace` 删除知识引用使用 `RESTRICT`，保留已有内容；若存在知识页，Workspace 删除返回冲突并说明先归档或显式删除知识。已有 Workspace 删除接口必须增加此冲突映射，不得让外键级联静默清除知识。[current delete route](../apps/server/src/api/routes.ts#L192-L195)

索引提案：

- `UNIQUE(workspace_id, slug) WHERE scope='workspace' AND status <> 'deleted'`
- `UNIQUE(slug) WHERE scope='common' AND status <> 'deleted'`
- `(scope, workspace_id, status, updated_at DESC)` 浏览索引
- `expires_at WHERE expires_at IS NOT NULL` 过期筛选索引

### `knowledge_revision`

| 字段 | 类型 / 约束 | 用途 |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | revision UUID |
| `page_id` | `TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE RESTRICT` | 页面身份 |
| `revision` | `INTEGER NOT NULL` | 单页递增版本号 |
| `title_snapshot`, `body_snapshot` | `TEXT NOT NULL` | 不可变的版本完整快照 |
| `sources_json` | `TEXT NOT NULL` | 来源标识、URI、文件行号/章节和来源类型 |
| `evidence_json` | `TEXT NOT NULL` | 支撑片段、定位、采集时间；URL 来源可保存摘要 hash |
| `change_kind` | `TEXT NOT NULL CHECK` | `create/update/archive/restore/delete` |
| `status_snapshot` | `TEXT NOT NULL` | 本版本对应的 `active/archived/deleted` 状态 |
| `expires_at_snapshot` | `INTEGER NULL` | 本版本对应的有效期；NULL 表示未设期限 |
| `change_note` | `TEXT NOT NULL DEFAULT ''` | 改动摘要 |
| `actor` | `TEXT NOT NULL` | `user` 或 agent 标签，仅用于审计 |
| `created_at` | `INTEGER NOT NULL` | 毫秒时间戳 |

唯一索引 `(page_id, revision)`。新建和每次更新都写完整 snapshot、状态、期限、来源与证据；不以“只记录差异”替代当前版本读取。每个来源对象含稳定 `source_id`、`source_type`、`locator`、毫秒 Unix 时间 `captured_at` 和必填 SHA-256 `content_hash`。同一个逻辑来源在后续修订中沿用 `source_id`；每个 revision 中的 locator/hash/snapshot 是该版本捕获态，旧快照不可变。对本地代码来源只记录文件路径、行段和该行段内容 hash，不默认复制源码。对外部文本或 agent 结论，随 revision 保存最多 2 KiB UTF-8 的证据摘录 `snapshot`；hash 对应采集到的来源内容，不复制原文全文。文件移动或改名不会自动修复 locator；调用方需重新定位来源并提交新 revision。设计提案要求每个知识版本至少有一条来源，技术事实条目还要有证据定位；校验细则待确认。

### FTS5 检索表

提案使用 SQLite FTS5 trigram tokenizer：`knowledge_fts(page_id UNINDEXED, title, body_md, tokenize='trigram')`。页面创建/更新/归档/删除在同一事务更新索引；搜索通过 `page_id` join `knowledge_page`，且必须带当前 Workspace 和 common 双 scope 条件。FTS 表本身不作为权限边界。

trigram 对连续字符片段建索引，不做中文分词。长度至少 3 个 Unicode code point 的查询走 FTS5 子串匹配；长度 1–2 个 code point 的短查询改用参数化 `LIKE` 子串扫描：先应用当前 scope、active 和 expiry 条件，仅在符合范围的页面中扫描标题/正文；使用 `ESCAPE '!'` 和参数绑定，将输入中的 `!` 转为 `!!`、`%` 转为 `!%`、`_` 转为 `!_`，再首尾添加 `%` 作字面子串匹配。FTS 输入统一转义为字面查询，不接受调用方原始 FTS 运算符。短词结果按标题命中、当前 Workspace 优先、`updated_at DESC` 排序。Unicode 长度以 code point 计算。当前安装构建的 FTS5/trigram 支持待实测。

## 6. 检索与排序提案

- 查询范围：当前 `workspace_id` 的页面与 `common` 页面并集；不得查询其他 Workspace。
- 输入：issue 标题、描述和 labels；清洗成字面词项后参数化传给 FTS5，限制查询长度，避免任意 FTS 运算符造成语法错误。
- 长度至少 3 个 Unicode code point：标题和正文使用 trigram FTS5，字段权重提案为标题 5、正文 1，使用 FTS5 `bm25` 排序（分数从小到大）。1–2 字符短查询使用上一节的字面子串回退，标题命中优先。相同排序等级时当前 Workspace 页面在 common 之前，再按 `updated_at DESC` 稳定排序。
- 返回数量：默认 5 条，上限 20 条；dispatch context 总正文上限提案为 6,000 字符，每条最多 1,200 字符；超限按条目边界截断并保留来源引用。
- 正常查询只返回 `status='active'` 且 `expires_at IS NULL OR expires_at > now` 的页面；归档、软删除、过期页面可在人类浏览器的筛选页查看，不进入默认任务上下文。
- 不用向量、LLM query rewrite 或摘要；本地 FTS 查询不增加模型请求。若后续加入向量或生成式摘要，需另行确认延迟、费用、索引和隐私边界。

以上权重、数量、截断上限及并列排序均为提案，需验收时用真实任务查询确认。

## 7. 来源、版本、并发与生命周期

### 来源与证据

- Workspace 条目保留 Workspace scope，不自动复制到 common。
- Common 写入必须调用方显式指定 `scope=common`；不从相似文本自动推断共享范围。
- 新建或修订必须提交来源引用；事实性内容要求至少一条 evidence，包括引用片段与文件路径/行号、URL/章节等定位信息。
- 初始来源集合由 agent 通过 `kb` 主动提交；README、Docs、代码、issue 评论、聊天和外部文档不会自动抓取。具体哪些来源可进入公共库仍待确认。

### 更新冲突

更新必须携带读取时的 `expected_revision`。server 在 SQLite transaction 中执行 revision 条件更新；影响行数为 0 时返回 409，并让调用方读取最新版本后重新决定。两个 agent 基于相同 revision 写入时，只有一个能成功；失败方不会自动合并或覆盖。

### 归档、过期与删除

- `archive`：保留页面、所有 revision 与证据；默认检索排除，UI 可浏览和恢复。
- `expires_at`：可选时间戳。每次搜索/列表时按当前时间判断并排除默认结果；UI 按同一规则显示过期。没有后台监控、实时过期推送或自动删除；默认不自动设有效期限。
- `delete`：提案为用户确认的软删除，保留 tombstone、revision 和 evidence；不物理删除。不提供无确认的 bulk delete。
- 知识行被 revision 外键引用；工作空间删除在知识尚存时拒绝。导出、永久物理清除策略待确认。

### 并发与本机数据库

沿用当前 SQLite WAL、5 秒 busy timeout 与外键设置；SQLite transaction 覆盖页面更新、revision insert 和 FTS 更新。CAS 解决“写入者基于旧版本提交”的覆盖问题，SQLite transaction 保证多个 SQL 变更原子提交；两者职责不同。`better-sqlite3` 当前单进程同步接口可复用现有 repository 模式；跨进程锁、LAN 写入或多主机并发不在首版范围。[connection.ts](../apps/server/src/db/connection.ts#L5-L11)

## 8. Agent 接口与任务上下文

### `kb` CLI 与统一 AgentBoard MCP 共用知识 API

建议首版 CLI 命令形状：

```text
kb knowledge search <query> --workspace <id|name> [--scope both|workspace|common] [--limit 5] [--json]
kb knowledge show <page-id> [--history]
kb knowledge create --scope workspace|common [--workspace <id>] --title <title> --stdin --sources <json> --evidence <json>
kb knowledge revise <page-id> --expected-revision <n> --stdin --sources <json> --evidence <json>
kb knowledge action <page-id> archive|restore|delete --expected-revision <n>
```

这些命令仍调用现有 HTTP API，不直接读写 SQLite；长内容沿用现有 stdin 使用方式。JSON 响应包括 page id、scope、workspace、revision、status、正文、来源和 evidence。

统一 AgentBoard MCP 已作为任务板与共享知识库的共同接入面进入设计；当前实现模块清单没有 MCP server，知识 REST API 也仍是提案。MCP 通过同一 REST API 调用知识服务，不复制索引或写入逻辑。MCP 工具目录、stdio 进程、Workspace 绑定、权限边界及客户端兼容验收见[统一 MCP 设计](./design-2026-11-01-unified-mcp.md)。Codex、DSH、WorkBuddy 的实际握手兼容性仍待按当前客户端版本验证。

### REST API 契约提案

| 方法 | 路径 | 主要参数 / 返回 |
|---|---|---|
| `GET` | `/api/knowledge/search?workspace_id=&q=&scope=both&limit=5` | 必需 workspace_id、query；返回结果摘要、score、scope、revision、source/evidence locator |
| `GET` | `/api/knowledge/pages?workspace_id=&scope=&status=` | 人类浏览分页列表；common 查询不需 workspace_id，workspace 查询必须提供 |
| `GET` | `/api/knowledge/pages/:id` | 页面当前版本、来源、evidence 与状态 |
| `GET` | `/api/knowledge/pages/:id/revisions` | 按 revision 递减返回历史快照 |
| `POST` | `/api/knowledge/pages` | scope、workspace_id、slug、title、body_md、sources、evidence、expires_at；重复键返回 409 |
| `PUT` | `/api/knowledge/pages/:id` | `expected_revision`、title/body_md/sources/evidence/expiry；冲突返回 409 |
| `POST` | `/api/knowledge/pages/:id/actions` | `action=archive|restore|delete` 与 `expected_revision`；写入 revision/tombstone |

Zod schema 校验参数；错误使用现有 `{error:{code,message}}` 格式。写入 API 只接受服务端验证后的 scope，不允许客户端直接传 FTS 条件拼接 SQL。

### Dispatch 注入提案

Dispatch UI 增加 `knowledge_enabled` 开关和可编辑 `knowledge_query`。默认 query 由 issue 标题、描述、labels 生成；用户可修改。`dispatchIssue` 在模板与历史备注渲染后，以 issue 的 Workspace 和该 query 查询当前 Workspace + common；结果只拼接一次到最终 prompt，位置在 `sessionManager.sendToSession` 之前。知识块包含页面标题、scope、revision、来源定位和限长摘录。来源文本作为引用数据，不作为任务指令；agent 仍遵循现有任务指令。禁用、无命中时不拼空区块。

默认启用是提案；用户可在每个 Dispatch 关闭。CLI `kb claim` 默认检索一次，提供 `--no-knowledge` 显式关闭；自由聊天不自动查询；`kb show` 不重复注入。知识查询失败不阻断任务派发或 claim：沿用原 prompt/claim 结果，并在 Dispatch UI 或 CLI 显示明确警告。未命中时不加空区块。检索只执行本地查询，不调用 LLM。最大 5 条 / 总计 6,000 字符为提案参数。

CLI claim 的 JSON 在现有 Issue 字段上增加同一形状的 `knowledge` 对象：`{ enabled, query, items }`；text 输出保留现有字段行，命中时追加知识区块。每个 item 使用统一字段 `id, scope, workspace_id, revision, title, snippet, sources, evidence`。失败时保留旧 issue/comment/workspace 输出，在 stderr 给警告。当前 prompt 已包含 issue 信息和最近 10 条评论；现有 `dispatchIssue` 在创建 session 前渲染 prompt，最后调用 `sendToSession`。知识块需与历史备注使用不同标题；默认模板、调用方自定义模板、CLI claim 共用 scope filter 和结果字段。[dispatch.ts](../apps/server/src/services/dispatch.ts#L19-L33) · [prompt and send order](../apps/server/src/services/dispatch.ts#L91-L115) · [claim](../packages/cli/src/commands/claim.ts#L7-L26)

## 9. 人类浏览与本机权限

在现有 React 应用增加“知识”入口：工作空间 selector、`项目知识 / 公共经验` scope 切换、搜索框、结果列表、详情正文、来源/evidence、当前 revision 与版本历史。提供归档、恢复、显式软删除和 expiry 编辑；此页面用于用户阅读及显式维护，不默认打开全文编辑器。

### 公共库写入策略（提案，待确认）

- Agent 默认写当前 Workspace；写入 common 必须显式指定 `scope=common`，并附来源/evidence。
- Common 创建成功后立即为 `active`，即可被所有 Workspace 联合查询；本方案不设置发布审批队列。用户可在 UI 归档公共页，停止其默认检索。
- Common 条目经上述 revision/CAS 更新；所有 revision 对用户可查看。Agent 可新建和显式修订，但不得无确认地覆盖、静默删除或物理删除。
- 归档、软删除均为明确 API/CLI 动作，带 `expected_revision`；默认不自动物理清理。

当前单用户、本机回环 API 没有可信 agent/user 身份。该策略在首版只能约束调用协议和审计记录，不能声称“仅人类可删除/发布”的安全 ACL；`KB_AGENT` 字段可伪报。若用户要求角色级权限或人类审批后才能发布公共知识，需要增加可信本机授权机制，属于未决范围，不在本文已定方案内。

## 10. 验收标准

1. **FTS5 中英文检索**：在打包使用的 `better-sqlite3` 12.11.1 上创建 `tokenize='trigram'` virtual table。准备正文 `SQLite WAL checkpoint improves consistency`，执行 `kb knowledge search "WAL checkpoint" --workspace A`，预期返回该页；准备正文 `缓存失效后重新建立倒排索引`，分别执行 `kb knowledge search "缓存失效" --workspace A` 与 `kb knowledge search "缓存" --workspace A`，两次均预期返回该页，短查询走参数化 LIKE 回退。当前未验证，成功前不把检索能力标为可交付。
2. **双 scope 隔离**：建 Workspace A、Workspace B 与 common 样例；A 的 `scope=both` 仅返回 A + common，B 仅返回 B + common；common-only 不返回项目页。
3. **搜索与排序**：标题命中高于正文弱匹配；limit 默认 5、最大 20；过期、归档、删除页不进入默认结果；结果可回溯到 revision 和证据 locator。
4. **版本与 CAS**：创建重复 slug 返回 409；同一旧 revision 的两个更新只接受一个，另一个收到 409；失败更新不改变正文、revision 或 FTS 结果；历史正文和来源保留。
5. **明确生命周期**：归档后仍可浏览历史；软删除可在 UI 中确认并显示 tombstone；过期只影响默认查询，不自动销毁数据；带知识页面的 Workspace 删除被拒绝并返回清晰冲突。
6. **任务上下文**：派发/claim 上下文只包含当前 Workspace + common；其他 Workspace 结果为零；free chat 和 `kb show` 刷新不重复自动注入；只产生本地 FTS 查询，不触发额外模型调用。
7. **工具复用**：CLI JSON 与 REST 返回相同字段；UI/CLI 使用同一 repository 与 scope filter。Codex、DSH 和 WorkBuddy 的实际命令/MCP 兼容性分别在确定客户端版本后验证。
8. **人的浏览**：能在 Workspace 与 common 之间切换，查看来源、证据、revision 和过期/归档状态；任一 scope 不可见其它 Workspace 内容。
9. **回归**：既有 issue/workspace/session/comment API 和 claim/dispatch 行为保持原契约；Workspace 外键限制不会静默级联清除知识。

以上是设计验收标准，不代表本轮已实现或已实测。本轮未运行测试、FTS5 检查、服务或任何 LLM client。

## 11. 待确认项

以下均为开放决策，不能按用户已同意处理：

1. “项目”首版是否就以 AgentBoard `workspace.id` 为知识 scope。
2. Common 写入规则：本稿提案为显式 scope + 必需来源/evidence + CAS 后可搜索；是否需要用户审批后才可被其他 Workspace 搜索。
3. `KB_AGENT` 是自报标签；本机单用户假设下是否接受无 agent 角色 ACL，或要求额外本机授权。
4. 可写来源范围：workspace 文件、`Docs/`、代码行、issue/comment、聊天内容、外部 URL 哪些允许进库，以及谁负责更新。
5. 过期默认值、归档与软删除后的保存周期、物理清除和导出策略。
6. WorkBuddy 当前版本通过 `kb` CLI 还是 MCP 接入；本轮没有实测其客户端能力。
7. 当前打包 SQLite 是否启用 FTS5 `trigram` tokenizer，及中英文样例与 1–2 字符 LIKE 回退是否通过；未确认前不能开始依赖 FTS5 的实现验收。
8. 若以后移植或分发 `llm_wiki` 代码/资源，是否保留 LICENSE、NOTICE、MCP MIT metadata 等文件；本轮没有引入第三方代码。
