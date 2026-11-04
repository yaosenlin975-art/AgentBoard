# 工作区变更日志设计
- status: proposed
- date: 2026-11-02
- card: -
- supersedes: -

## 状态

- 设计已获用户确认；尚未实施，运行效果待验收。
- 目标：以 AgentBoard 工作区变更日志替代 `Docs/CHANGELOG.md` 的后续项目功能变更记录，并在 AgentBoard UI 与 CLI 中维护。
- 本文只定义设计；实现、历史迁移、按迁移结果删除旧文件和更新全局规则尚未执行。

## 1. 需求

### 1.1 用户目标

- 在所选工作区内查看和维护项目功能新增、修复和重要调整。
- UI 与 CLI 共用同一套服务端 API 和 SQLite 数据。
- CLI 提供日志创建、查询、修改、删除能力。
- AgentBoard 工作区日志成为项目功能变更记录的唯一真源；不与 `Docs/CHANGELOG.md` 双写。
- 后续将用户级 `AGENTS.md` 中关于 `CHANGELOG.md` 的维护要求替换为使用 AgentBoard 工作区变更日志。替换范围仅限对应条款。

### 1.2 范围

- 工作区级产品变更记录，需指定工作区。
- Markdown 正文、标题、变更类型、发生时间、创建与更新归属及时间、并发版本。
- Web 查看、筛选、分页和 CRUD；CLI 使用同一 REST API 执行 CRUD。
- 将现有 `Docs/CHANGELOG.md` 历史条目一次性导入指定工作区，并核对后停止向旧文件追加新记录。

### 1.3 不在范围

- 任务执行、会话消息、评论或代理操作审计。
- 从 Git 提交、任务或会话自动推断产品变更。
- 发布版本管理、release notes 自动生成或 CI 发布流程。
- 对日志正文保存完整编辑修订历史。

## 2. 当前项目能力

- SQLite `workspace` 表保存 `id/name/path/created_at`；项目通过 `initSchema` 执行幂等迁移。
- 服务端使用 Express 路由和 SQLite repository；工作区 REST 已有列表、创建、删除操作。
- Web 的 `App` 在看板和知识库面板间切换；顶部栏展示当前工作区，左栏负责选择工作区。
- CLI 使用 Commander 命令组、公共 HTTP 请求函数和 JSON 输出模式。知识库 CLI 已有工作区参数解析、列表分页、正文 stdin、CRUD 请求和 CAS 参数模式。
- 当前知识库修订记录是不可更新、不可删除的历史快照；变更日志需要可修改和可删除，不复用其历史语义。
- `Docs/CHANGELOG.md` 是仓库级开发变更文档，当前条目包含实现细节、测试和运行记录；它不是按工作区隔离的应用数据。
- `C:\Users\31633\.agents\AGENTS.md` 与 `C:\Users\31633\.codex\AGENTS.md` 是普通文件，含相同的 CHANGELOG 维护条款；`C:\Users\31633\.dsh\AGENTS.md` 也是普通文件，含项目级 DESIGNS、CHANGELOG、PENDING_TESTS 维护条款。三个文件均位于用户级配置目录；本设计仅替换 CHANGELOG 对应条款，其他条款保持原文。

## 3. 方案选型

### 3.1 推荐方案：AgentBoard SQLite 产品记录

- SQLite 为唯一持久化真源。
- Express 提供工作区作用域 REST CRUD；Web 和 CLI 共同调用。
- Web 复用 React Query、现有面板切换、Markdown 显示与表单能力。
- CLI 复用 Commander、HTTP 请求和 `--json` 输出模式。
- 不新增运行时依赖。

匹配度高，改动集中在一张 SQLite 表、一个 scoped REST router、共享类型、Web 工作区面板和 CLI 命令。与文件真源相比，不需在 Web 与 CLI 两处实现文件锁、文件权限处理和 Markdown 段落重写，也避免 DB 与文件双写。

### 3.2 未采用的候选工具

| 候选 | 当前版本与许可证 | 用途和匹配 | 集成成本及验证 |
| --- | --- | --- | --- |
| [Changesets](https://github.com/changesets/changesets) | CLI `3.0.3`；MIT | 面向 monorepo 的包版本计划、changelog 和发布流程；不提供工作区 UI/API CRUD。 | 项目 Node/pnpm 环境可运行，但需引入发布流程及 changeset 文件，和手工维护工作区产品记录不匹配。仅核对官方仓库与发布信息，未安装、未运行。 |
| [git-cliff](https://github.com/orhun/git-cliff) | `2.14.2`；Apache-2.0/MIT | 从 Git 历史与 Conventional Commits 生成 Markdown changelog；不提供工作区 UI/API CRUD。 | 有 Windows 构建，但需维护提交规范和生成流程；适用于仓库发布文档，不适用于本需求的手工产品记录。仅核对官方仓库与发布信息，未安装、未运行。 |

不移植候选代码，不新增第三方运行时包。

## 4. 数据模型

新增 `workspace_change_log` 表：

| 字段 | 类型与约束 | 用途 |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | UUID。 |
| `workspace_id` | TEXT NULL，关联 `workspace(id) ON DELETE SET NULL` | 当前工作区关联；移除工作区后置空，日志记录保留。 |
| `origin_workspace_id` | TEXT NOT NULL | 创建时记录的原工作区 ID，不设外键，永久保留。 |
| `origin_workspace_name` | TEXT NOT NULL | 创建时记录的原工作区名称快照。 |
| `origin_workspace_path` | TEXT NOT NULL | 创建时记录的原工作区路径快照。 |
| `title` | TEXT NOT NULL | 日志标题。 |
| `body_md` | TEXT NOT NULL | Markdown 正文。 |
| `change_type` | TEXT NOT NULL，建议 CHECK `新增/修复/调整/历史` | 新增日志只允许新增、修复或调整；`历史` 只供旧 CHANGELOG 导入，不接受普通 UI/CLI 创建。 |
| `occurred_at` | INTEGER NOT NULL | 变更发生时间，Unix 毫秒。新增时默认当前时间，可修改。 |
| `created_by` | TEXT NOT NULL | 创建者归属标记。 |
| `updated_by` | TEXT NOT NULL | 最后修改者归属标记。 |
| `created_at` | INTEGER NOT NULL | 创建时间，Unix 毫秒。 |
| `updated_at` | INTEGER NOT NULL | 最后修改时间，Unix 毫秒，单调递增。 |
| `revision` | INTEGER NOT NULL DEFAULT 1 | CAS 修订号。 |
| `legacy_source_key` | TEXT UNIQUE NULL | 旧日志导入条目标识；普通新增为 NULL，用于导入幂等和对账。 |

原工作区 ID/名称/路径快照只在创建日志时写入，不随工作区改名、路径变化或删除而变。校验 `workspace_id IS NULL OR workspace_id=origin_workspace_id`。增加活跃工作区索引 `(workspace_id, occurred_at DESC, id DESC)` 和归档索引 `(origin_workspace_id, occurred_at DESC, id DESC)`。活动列表过滤 `change_type`，标题与正文提供字面子串搜索 `q`，须将 SQL LIKE 通配符按字面转义。所有列表按 `occurred_at DESC,id DESC` 排序，`id` 为稳定次序；编辑正文/标题不改变排序，只有显式修改 `occurred_at` 才会使位置重排。`created_at/updated_at` 独立记录记录生命周期时间。

新增最小导入回执表 `workspace_change_log_import`，保存 `source_path`、`origin_workspace_id`、`source_sha256`、`entry_count`、`imported_at`，以来源路径、原工作区 ID 和 SHA-256 唯一标识一次成功应用。回执随日志事务提交；不依赖活动工作区外键。预览返回源文件 SHA-256；应用必须提交该预览 SHA，服务端在写入前重新计算并要求完全匹配，随后在同一事务内写入日志行和回执。相同 SHA 的重放幂等；变更源文件必须重新预览、应用并对账。预览须列出新增、已导入和内容不一致条目；无法自动判定一致的条目阻止源文件删除，直到完成对账。

`created_by/updated_by` 只表示 CLI/UI 提供的操作归属，不承担身份认证。Web 使用固定 `user` actor；CLI 使用现有 `ctx.agentId`。工作区移除时 `ON DELETE SET NULL` 保留日志和原工作区快照；不级联删除变更日志。

## 5. Web UI

- 顶部栏增加「变更日志」入口，与「看板」「知识库」并列；没有当前工作区时禁用入口并提示先选择工作区。
- 当前工作区日志以竖向时间轴呈现，最新条目在顶端；日期按浏览器本地日历分组，条目可展开查看完整 Markdown 正文。
- 点击入口显示当前工作区日志面板；切换工作区后重新加载该工作区数据，不保留上一工作区的选中记录或编辑草稿。
- 列表显示发生时间、类型、标题、修改人和更新时间；支持标题/正文字面搜索、类型筛选、分页和清空筛选。
- 正文渲染复用 `MarkdownView`；新建/编辑使用现有表单和文本输入，不新增 UI 库。
- 新增/编辑使用 Markdown 文本输入；标题、类型、正文必填，日期使用本地日期时间控件并转换为 Unix 毫秒。
- 活跃工作区日志支持新增、查看、编辑和删除。删除需在确认框中显示目标标题，只删除该条日志且带当前 CAS revision。
- 提供独立的「历史工作区日志」入口，显示已移除工作区的名称、路径快照和日志数量；进入后仍为按日期分组的竖向时间轴，但只读，且不混入活跃工作区日志列表。首版不提供恢复关联。
- 移除工作区确认框按现有删除路由说明影响：会级联删除关联任务、评论、会话、消息和附件记录并回收附件；存在阻止删除的知识页时，显示现有失败结果。操作保留磁盘项目目录和本功能新增的变更日志；日志可从「历史工作区日志」查看。不改变现有工作区删除语义。
- 写入成功后刷新当前页；CAS 冲突提示重新加载并保留尚未提交的输入。
- 查询错误、空列表、无搜索结果、加载中和无工作区均显示可理解状态。

## 6. REST API

活动日志接口限定在 URL 中指定的工作区；先确认该工作区存在。记录 ID 与路径工作区不匹配时返回同一 `CHANGELOG_NOT_FOUND` 404，避免跨工作区探测。归档接口通过不可变 `origin_workspace_id` 明确读取已移除工作区记录，只提供只读查询，不能混用活动工作区作用域。

| 方法与路径 | 请求 | 响应与约束 |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId/changelog` | `limit` 默认 50、范围 1–100；`offset` 默认 0；可选 `change_type`、`q`。 | `{ items, next_offset }`；仅返回该工作区记录，按 `occurred_at DESC,id DESC` 排序。 |
| `POST /api/workspaces/:workspaceId/changelog` | `title`、`body_md`、`change_type`；可选 `occurred_at`；必需 `actor`。 | `201` 返回完整记录；支持 `Idempotency-Key`。 |
| `GET /api/workspaces/:workspaceId/changelog/:id` | 无。 | 返回完整记录。 |
| `PATCH /api/workspaces/:workspaceId/changelog/:id` | 至少一个可编辑字段；必需 `expected_revision` 与 `actor`。 | 原子 CAS 更新，返回新记录和递增 `revision`。 |
| `DELETE /api/workspaces/:workspaceId/changelog/:id` | JSON body 含 `expected_revision` 与 `actor`；支持 `Idempotency-Key`。 | CAS 删除，成功返回 204。 |
| `GET /api/changelog/archived-workspaces` | `limit`、`offset`。 | 分页列出仍有日志的已移除工作区快照及记录数；从 `workspace_id IS NULL` 的日志记录分组得出。 |
| `GET /api/changelog/archived-workspaces/:originWorkspaceId/entries` | `limit`、`offset`；可选 `change_type`、`q`。 | 仅返回指定原工作区 ID 的归档日志，按 `occurred_at DESC,id DESC` 分页。 |
| `GET /api/changelog/archived-workspaces/:originWorkspaceId/entries/:id` | 无。 | 返回归档日志详情。 |

- 创建与变更复用现有 `Idempotency-Key` 语义：UUID key 按 actor、HTTP 方法、路径和请求体绑定；同一请求重放不重复写入，key 重用到不同请求返回 409。
- 更新和删除在事务中检查 `expected_revision`；并发版本过期返回 `409 CHANGELOG_REVISION_CONFLICT`，details 给出当前 revision。
- 校验错误使用现有 `{ error: { code, message, details? } }` 错误信封。工作区不存在返回 404；记录不存在或不属于该工作区返回 `404 CHANGELOG_NOT_FOUND`；非法查询、类型或正文返回 400。
- 不新增 WebSocket 广播。Web 的本地 CRUD 后刷新 query；CLI 写入后 Web 在重新进入、手动刷新或常规焦点刷新时读取最新数据。
- 现有工作区删除路由会级联删除关联任务、评论、会话、消息和附件记录并回收附件；存在阻止删除的知识页时按现有行为拒绝。变更日志使用 `ON DELETE SET NULL` 保留并归档，原归属快照保持不变；磁盘项目目录不删除。该工作区不再出现在活动工作区列表；日志通过上列归档端点读取。不在本设计中修改其他删除语义。
- 单条活动日志删除仍使用当前 `expected_revision`，并在 UI 确认后物理删除该条记录。归档日志首版只读。

## 7. CLI

新增 `kb changelog` 命令组；活动日志 CRUD 必须通过 `--workspace <id|名称>` 解析活动工作区，并请求第 6 节同一 REST API。历史归档通过显式只读命令读取。

| 命令 | 参数建议 |
| --- | --- |
| `kb changelog list` | `--workspace`、`--type`、`--query`、`--offset`、`--limit`。 |
| `kb changelog show <id>` | `--workspace`。 |
| `kb changelog create` | `--workspace`、`--title`、`--type`、`--stdin`、`--occurred-at`、`--request-id`。 |
| `kb changelog update <id>` | `--workspace`、`--expected-revision`，至少一个字段更新选项；正文使用 `--stdin`。 |
| `kb changelog delete <id>` | `--workspace`、`--expected-revision`、`--request-id`。 |
| `kb changelog archived-workspaces` | `--offset`、`--limit`；仅列出仍有日志的已移除工作区快照。 |
| `kb changelog list-archived` | `--origin-workspace-id`、`--type`、`--query`、`--offset`、`--limit`；只读。 |
| `kb changelog show-archived <id>` | `--origin-workspace-id`；只读。 |

- `--json` 返回与 REST 对应的完整 JSON 数据；普通模式输出列表摘要或单条 Markdown 正文。
- `--request-id` 是可选 UUID，重试同一写入时复用；不同 payload 不得复用同一 key。
- 删除命令必须给出当前 revision；服务端 CAS 冲突时保留原记录并输出可读错误。
- 活动 workspace 命令不接受已移除 workspace ID；读取归档必须显式使用 `--origin-workspace-id`。归档命令不提供 create/update/delete。

具体参数别名、普通输出排版和 CLI 子命令的英文名称可由实施者按现有 Commander 风格定稿。

## 8. 旧 `Docs/CHANGELOG.md` 迁移与停写

- 迁移前将现有文件作为只读输入；解析 `## [YYYY-MM-DD] 标题` 与其下正文，按条目保存日期、标题和原 Markdown 正文，不丢弃旧文本或臆断原条目类型。导入条目标记 `change_type='历史'`，普通 UI/CLI 新增不能选择该类型。
- 迁移必须由用户或实施者显式选择唯一目标工作区；不得自动扫描、导入或删除其他项目的日志。
- 预览模式计算源文件 SHA-256，显示目标工作区、可解析条数、无法解析条目、新增/已导入/内容不一致条目和重复导入结果；有无法解析或无法判定一致的内容时不得静默跳过。
- 应用必须绑定预览 SHA-256，应用前重新计算当前源文件 SHA-256；不匹配则中止并要求重新预览。写入日志、`legacy_source_key` 与导入回执在同一事务中提交；相同 SHA 重放幂等。失败时不得留下部分导入结果。
- 迁移完成后对照源文档 SHA-256、标题/日期/条目数和数据库记录，并抽样核对正文。产品 API、CLI、Web 的必要读写验收通过后，按“导入→对账→规则切换→删除源文件”顺序执行受控切换。删除前再次计算源文件 SHA-256，必须与已导入回执一致；不一致时停止删除，重新预览、导入并对账，不删除新增未迁移内容。
- 旧文件保持到全部条目完整导入且对账通过；在最终校验与删除间不得追加或修改源文件。发生不一致时保留源文件，完成重新导入与对账后再继续切换。
- 若 `Docs/CHANGELOG.md` 已被 Git 跟踪，删除提交保留 Git 历史中的原文件版本；日志历史由 AgentBoard SQLite 持续保存。
- 规则切换后，后续产品功能变更只通过 AgentBoard UI 或 CLI 新增，不再向旧文件追加，不双写。
- 该迁移只针对显式选定工作区及仓库中的 `Docs/CHANGELOG.md`，不遍历或清理其他项目目录。

## 9. 全局 `AGENTS.md` 规则后续差异

产品 API、CLI、Web 的必要读写验收通过，旧文件导入并对账后，仅在以下三个实际用户级文件替换 CHANGELOG 对应条款：

- `C:\Users\31633\.agents\AGENTS.md`
- `C:\Users\31633\.codex\AGENTS.md`
- `C:\Users\31633\.dsh\AGENTS.md`

只替换 CHANGELOG 对应句；在 `.dsh` 文件中保留 DESIGNS、PENDING_TESTS 和其他规则原文。替换为：

- 功能新增、修复和重要调整完成并审查后，在对应工作区通过 AgentBoard UI 或 `kb changelog` 记录；不记录任务执行、会话活动或代理过程。`Docs/CHANGELOG.md` 历史完整导入对账后删除；后续项目变更以 AgentBoard 工作区变更日志为唯一真源。

在三个副本同步替换 CHANGELOG 对应条款，不改其他规则。执行顺序为：API/CLI/Web 必要读写验收通过、导入、对账、规则切换、重新核对源 SHA-256 后删除旧文件；任一不一致均停止删除，保留旧文件并重新预览、导入、对账。

## 10. 验收依据

- REST 和 CLI 的创建、列表、详情、更新、删除均操作同一 SQLite 记录；CLI 变更能在 Web 刷新后显示，反之亦然。
- 切换工作区后列表、搜索、分页、详情和写操作严格按当前工作区隔离；跨工作区记录 ID 返回 404。
- CAS 并发测试证明旧 revision 更新或删除返回 409，记录保留；匹配的 Idempotency-Key 重试不会创建重复记录。
- 搜索只按标题/正文字面包含匹配，类型筛选、分页排序稳定，空查询与清空筛选恢复完整列表。
- Web 新增、编辑、确认删除、Markdown 正文、加载/错误/空态及冲突保留输入均可完成；刷新后数据一致。
- CLI 文本和 `--json` 模式覆盖 CRUD、分页筛选、workspace 缺失/错误、请求体 stdin、CAS 冲突与幂等重放。
- 旧文件预览返回 SHA-256；应用只接受匹配的预览 SHA 并原子写入日志和导入回执。源文件变化时应用中止；删除前重新 hash 必须匹配最后一次成功导入回执，新增或不一致条目未完成对账时不删除。重复运行无重复行；解析失败不会部分写入；Git 已跟踪的历史内容仍可从历史提交读取。
- API、CLI、Web 的必要读写验收通过后，受控迁移顺序为导入、对账、规则切换、删除；删除前源 SHA 校验失败则停止，保留源文件并重新预览、导入、对账。
- 删除工作区后，确认现有路由级联删除任务、评论、会话、消息和附件记录并回收附件；存在知识页时现有路由拒绝删除；磁盘目录未被删除；变更日志表记录仍存在、`workspace_id` 置空，原 ID/名称/路径快照完整；活动工作区列表不混入归档；历史工作区入口和 CLI 归档命令可读回。活动日志单条删除仍要求用户确认和有效 CAS；归档日志只读。
- `AGENTS.md` 的 CHANGELOG 对应条款仅在三个目标副本同步替换；DESIGNS、PENDING_TESTS 和其他规则差异为零。

## 11. 已确认的数据保留与迁移决定

- 旧 `Docs/CHANGELOG.md` 的完整导入对账结束后删除旧文件；Git 已跟踪时保留原提交历史。只导入用户显式选择的工作区，不自动扫描或删除其他项目。
- 移除工作区不删除磁盘项目目录或变更日志；日志转为归档，只读查看。恢复关联不进入首版。
- 删除单条活动日志仍允许，但必须明确选择并通过 CAS；这与移除工作区不同，不级联删除工作区日志。

新日志类型 `新增/修复/调整`、列表默认分页大小 50、正文使用 Markdown 为实现默认值，可在编码时按现有项目规范调整。

## 12. AgentBoard 计划卡映射

- LOG01 后端与 SQLite/REST 契约：`f9c176e1-3f34-4a3e-8227-2b39886eab70`。
- LOG02 CLI CRUD、旧文件 preview/apply 和退役前源 SHA 复核，依赖 LOG01：`06e08856-b3e9-4b5e-ad19-de93522270df`。
- LOG03 Web 时间轴、CRUD 与历史工作区只读界面，依赖 LOG01：`728450a2-cee0-451f-b237-899461f63a11`。
- RULE-CHANGE01 三副本 CHANGELOG 规则切换、旧文件导入对账及受控删除，依赖 LOG01/02/03：既有卡 `e22cc2de-86ad-4572-b9fa-63c53b713904`，补充计划评论 `d2c92295-bc22-43b8-9537-37dbdd7ab8c6`。
- RULE-DSH02 仅迁移 `.dsh/AGENTS.md` 的 PENDING_TESTS 条款至具体任务评论，保留 CHANGELOG 旧规则直到日志功能切换，依赖 RULE-CHANGE02 `af2ed71c-a91e-4c9d-87d3-6d990d355aae`：`95546b87-39a0-4065-9343-90e79b6430f4`。
- 所有新建计划卡保持「待规划」，不占用；日志实现及迁移未执行。
