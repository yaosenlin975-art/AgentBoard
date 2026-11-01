# LLM Wiki 解剖调研报告
> 研究时间：2026-11-01 | 类型：技术 | 深度档：standard

## 执行摘要

- 研究对象为 `nashsu/llm_wiki` 固定提交 `e08cfce65aad8b76b13546a081c1a8d4422b70c3`，对应 v0.6.13；它是基于 LLM Wiki 方法模式的桌面实现，并另含 Node MCP package。[F1-1][F1-5]
- 数据以项目目录中的原始来源和 Markdown wiki 为主；项目 UUID、来源相对路径、导入队列和缓存均带项目范围。[F1-2][F2-2][F3-1]
- Ingest 的两阶段概述不是固定两次模型调用；长来源分块处理会随输入规模增加分析调用，模型请求总数未运行计数。[F1-3][F2-3][F2-4]
- `search_project` 有关键词排序、可选向量融合和一跳 wiki 链接扩展；README 概述写两跳，两处证据的具体路径不同，不能合并成全局承诺。[F1-4][F2-7][F2-8]
- MCP 写页面默认只创建，覆盖需显式允许；Rust writer 有进程级 mutex、原子替换与字节回读验证。MCP 输入契约未提供 expected-version 字段；与 ingest 同页并发结果未运行验证。[F1-7][F3-6]
- 接收方 AgentBoard 已有任务、评论、会话、项目工作目录和多种 CLI agent，但当前源码未显示知识条目、附件、全文检索、MCP server 或知识权限模型。[T0]

## R1 对象定义与边界

`nashsu/llm_wiki` 是一个桌面端知识管理应用，按 Raw Sources、Wiki、Schema 的文件层组织资料，基于 Karpathy 的 LLM Wiki 模式；它不是该抽象方法本身。[F1-1][F1-2] 固定版本包含 Tauri v2 / Rust 桌面后端、React / TypeScript 界面、Rust HTTP API 与 Node.js MCP package。README、源码和 MCP package metadata 所声明的许可证类型分别是主仓 GPL-3.0、MCP package MIT。[F1-5][F1-12]

本报告覆盖固定提交中项目目录持久化、导入与更新、查询接口、MCP/API 写入和多工具协作边界。代码证据来自 GitHub 固定提交；AgentBoard 接收方证据来自本工作区 README、Docs、skill 和直接相关源码静态检查。未 clone、安装或运行产品，模型输出、客户端握手与并发结果不作为已验证事实。

## R2 解剖

### 分层架构与工程约束

桌面端以 Tauri v2 承载 React 19 / TypeScript / Vite 前端和 Rust 后端；MCP server 是独立 Node.js package，通过 stdio 接收工具调用并连接桌面应用的 HTTP API。源码中的 API 默认监听 `127.0.0.1:19828`，设置 LAN 访问后可以绑定 `0.0.0.0`；MCP client 默认指向本机 API。写入、embedding 和 Agent chat 路由要求 API token，一般只读 API 是否免 token 由配置决定。[F1-5][F1-8][F1-9]

MCP client 可用 `LLM_WIKI_API_BASE_URL` 指定 API 地址，用 `LLM_WIKI_API_TOKEN` 提供认证；Rust 侧 `LLM_WIKI_BIND_HOST` 可覆写监听 host。配置改变的是 Node client 的连接地址或 Rust API 的绑定地址，不改变工具本身的项目绑定契约。[F1-8][F1-9][F1-10]

项目主体是本地目录。`raw/sources/` 保存输入来源，`wiki/` 保存生成或编辑的 Markdown 页面，`purpose.md` 与 `schema.md` 为项目目标和知识结构文件，`.llm-wiki/` 保存项目身份、队列、缓存和同步状态等元数据。[F1-2][F2-2] 每个项目目录下的 `project.json` 保存稳定 UUID；应用注册表把 UUID 映射到当前文件系统路径、名称和最近打开时间。导入任务使用 UUID 和项目相对 source path，因此目录移动时可由注册表解析当前路径。[F3-1]

队列存储的是工作状态，不是 wiki 正文。保存时先捕获待保存任务的 JSON snapshot，再将写入排队，防止较早的异步状态晚于较新的状态落盘；写入失败时采用 best effort，内存队列仍为当前运行态数据。切换项目会先写入暂停快照，将遗留的 processing 再改成 pending 并再次保存；应用重启或项目打开后，processing 也回到 pending。用户暂停状态只属于当前会话，不随项目切换或应用重启保存。[F3-4]

文件监视器将项目内文件变化记录成同步队列；源码描述只在 `enabled && autoIngest` 时把 `raw/sources/` 的新增或修改提交 ingest 队列。同步记录对不超过 32 MiB 的文件保存 MD5，Linux 默认周期重扫间隔 10 秒，其它平台为 60 秒；`source-watch-defaults.json` 未读，因此监视器与自动 ingest 的实际默认开关状态暂缺。此处描述的是源码配置，未观察运行中监视事件。[F2-6]

### 核心算法、数据结构与更新路径

README 将 ingest 概括为分析与生成两个顺序阶段：先识别实体、概念、主张、证据及其与已有 wiki 的关系，再生成 `FILE` / `REVIEW` 内容块。分析/生成阶段读取项目 schema、purpose、wiki index 和 overview 等上下文。[F1-3][F2-3] “两阶段”是主流程概述，不是每份来源固定两次模型请求。超预算来源会按标题与段落边界切块，目标 chunk 为来源预算的 55%，限制在 12,000–60,000 字符；相邻块有 8% 重叠，限制在 800–3,000 字符；每块更新至多 15,000 字符的 global digest 并保存检查点。因此长来源会逐块分析，实际调用数依输入规模而变；未运行模型请求计数。[F2-4] 输出 token 预算也按模型 context 窗口选择：小于 128k 时默认 8,192 tokens，context 达到 128k、256k、512k 时分别选 16,384、24,576、32,768 tokens。[ingest.ts constants](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L58-L61)；[selection](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L2856-L2862)

`IngestTask` 包含 task id、project UUID、项目相对 source path、folder context、状态、时间、错误与重试数；状态包括 pending、processing、done、failed 和 cancelled。默认 worker limit 为 1，重试上限为 3 次；每个项目的队列写入 `.llm-wiki/ingest-queue.json`。队列处理允许准备阶段并发，提交按 task-start 顺序预留；ingest、Save-to-Wiki 和 deep research 的项目文件提交由项目路径 mutex 排队。该 mutex 是以项目路径为 key 的 promise chain，操作结束或抛错后在 `finally` 释放；源码没有实现 timeout、fairness 或 re-entrancy detection。切换项目时 abort 活动任务、等待已进入提交段的写入完成，把 processing 重置为 pending 并保存；重新打开时恢复该项目队列。[F2-1][F3-4]

来源身份取自 `raw/sources/` 目录下相对路径，来源摘要位于 `wiki/sources/<slug>.md`。SHA-256 ingest cache 以来源身份记录来源正文哈希、成功写出的文件路径和时间戳；命中要求来源哈希相同且每个既有输出路径仍存在。检查函数不比较 wiki 输出文件内容，因此只按这个缓存判断，手动修改但仍存在的输出页不会单独触发 cache miss。只有有写入结果且没有硬失败或未恢复截断时才更新缓存。[F2-2][F2-6][F3-3]

导入写入时，日志页追加，index / overview 列表页整体重写；内容页读取旧页并执行 `mergePageContent`，来源等 frontmatter 数组合并，正文不同则请求合并。若现有页只归属于当前来源，重导入可替换旧正文；多来源页保留其他来源内容并走合并。来源更名迁移函数要求调用方先由 watcher hash 确认是内容相同的移动，然后更新来源引用、摘要路径和缓存身份；发生错误时尝试回滚已完成的写入。删除来源时，系统清理 source、解析产物及 ingest cache，扫描 wiki 页的 `sources` frontmatter：仍有来源的页重写来源列表，唯一来源页进入 wiki 页、embedding 与来源媒体删除级联。[F2-5][F3-2][F3-5]

### 查询算法与接口契约

Tauri `search_project(project_path, query, ...)` 要求项目路径和非空查询；`top_k` 默认 20、范围限制为 1–50，结果响应含 mode、results、token_hits、vector_hits 和 graph_hits。关键词检索扫描项目 wiki Markdown，最多 10,000 个文件；标题词权重 5、正文词权重 1，精确文件名加 200，标题短语加 50，正文短语每次加 20 且最多计 10 次。向量索引可选；存在向量命中时以 `1/(60+rank)` 融合关键词和向量排名。该接口路径的 graph expansion 在最终结果窗口预留 15%–30%，最多取 20 个 seed 的一跳链接邻居。[F2-7][F2-8]

该 Tauri command 的参数还包含可选 `include_content`、`query_embedding` 与 `embedding_config`；响应按 token/vector/graph hits 保留来源通道，随后提供统一 results 列表。项目路径是该接口的必填范围参数，所以本条接口证据描述的是选定项目内查询，不表示应用级公共经验库或跨项目合并检索。[F2-7]

README 的检索流程写两跳图扩展；已解剖的 Tauri `search_project` 路径写一跳扩展。[F1-4][F2-8] 两条证据描述的接口路径并不相同，现有材料不能排除仓库内另有两跳流程，也不能将 README 的两跳概述直接套用到 `search_project`。是否由不同查询入口造成差异，列在 R6。

MCP 源码声明 `llm_wiki_search`、`llm_wiki_read_page`、`llm_wiki_write_page` 和 `llm_wiki_embed_page` 等工具；其中写入工具允许在 `wiki/` 下创建或显式覆盖 Markdown 页，正文上限 2 MiB，默认拒绝覆盖已存在页面。README 工具清单未列出 write/embed 两项，能力边界按固定提交源码记录。[F1-6][F1-7] 写入时 Rust `WIKI_WRITE_LOCK` 保护该 writer，文件经临时文件原子替换、持久化后逐字节回读校验，失败时尝试恢复原始字节；该锁的证据说明 writer 内串行与写后校验，不等于 expected-version / compare-and-swap。[F1-7][F3-6]

写入入口还会规范化 wiki 相对路径、将目标限制在项目 wiki 目录并拒绝覆盖符号链接；显式覆盖时，先保留原文件字节和文件历史基线，再写临时文件并同步到磁盘，随后重读并按字节比较。校验失败时尝试恢复先前字节；首次创建且验证失败时尝试删除未验证文件。这些机制检查的是路径范围与本次写入持久化结果，不是调用方读到的旧版本是否仍为当前版本。[F1-7][F3-6]

多个 MCP 子进程可以分别绑定项目并连接应用 API；当前已查契约不含按用户角色区分知识页读写权限的规则。MCP server 使用 stdio 与本地 HTTP API；写入类路由要求 token。源码和 issue 尚不能证明 Codex、DSH、WorkBuddy 不同版本的握手、UI 更新或跨设备协作结果。[F1-8][F1-9][F1-10]

## R3 构成要素账本

| 要素 | 规格 / 参数 | 默认值或边界 | 来源 |
|---|---|---|---|
| 桌面端 | Tauri v2、Rust；React 19、TypeScript、Vite | Rust ≥1.88；Node.js ≥20 | [F1-5] |
| MCP package | Node.js、`@modelcontextprotocol/sdk`；stdio 到桌面 HTTP API | SDK `^1.29.0`；API `127.0.0.1:19828` | [F1-5][F1-8] |
| 项目身份 | `.llm-wiki/project.json` UUID；应用注册表映射当前路径 | 稳定 UUID；每项目目录 | [F3-1] |
| 导入任务 | projectId、sourcePath、folderContext、状态、retryCount 等 | worker 1；retry 上限 3 | [F2-1] |
| 长文分块 | 源预算 55%，chunk 12,000–60,000 字符；重叠 8%，800–3,000 字符；digest ≤15,000 字符 | 达到来源预算时进入分块路径 | [F2-4] |
| 生成输出预算 | context <128k 时 8,192 tokens；≥128k 为 16,384；≥256k 为 24,576；≥512k 为 32,768 | 依模型 context 配置选择 | [ingest.ts constants](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L58-L61)；[token selection](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L2856-L2862) |
| ingest cache | 来源正文 SHA-256 + 写入路径列表 + 时间戳 | 每项目 `.llm-wiki/ingest-cache.json`；输出路径需存在 | [F2-6][F3-3] |
| 查询接口 | 项目路径 + query；扫描最多 10,000 Markdown；结果 top_k | 默认 20，最大 50 | [F2-7][F2-8] |
| 写页面 | `wiki/*.md`；UTF-8 正文 ≤2 MiB | 默认 create-only；覆盖需显式允许 | [F1-7] |
| 搜索向量 | LanceDB 本地向量索引 | 默认关闭；需 embedding 配置 | [F1-4] |

## R4 运转机制

1. 用户或监视器将来源放入项目 `raw/sources/`；文件导入可进入项目持久队列。项目身份解析到当前目录路径，来源身份按其相对目录生成。[F2-2][F2-6][F3-1]
2. 队列读取 task 对应来源，先检查项目 cache。若来源 SHA 相同且缓存内所有输出路径都存在，则跳过主要 ingest 生成流程；若来源变化或任一输出文件丢失，重新处理。[F2-6][F3-3]
3. 可用 LLM 配置下读取来源及 schema、purpose、wiki index、overview。预算足够时进入分析与生成主阶段；超预算来源分块后逐块分析并记录 digest/checkpoint，长来源会产生多于单次分析阶段的模型调用；实际次数未运行计数。[F2-3][F2-4]
4. 生成的 FILE blocks 经路径和内容处理后进入提交区。项目队列按启动顺序取提交 turn；项目 mutex 让队列 ingest 与其他项目文件提交依次运行。对于已有内容页，系统读取 old page，根据来源集合决定正文替换或合并，再写文件；完成条件满足时记录 ingest cache。[F2-1][F2-5][F3-2][F3-4]
5. 文件内容变化可由监视路径转成新的 ingest queue 项目任务；来源内容没变且输出路径未缺失时缓存检查可以命中。来源移动或删除走单独生命周期路径：更名迁移引用、摘要路径和缓存身份；删除依据来源 frontmatter 保留或删除 wiki 页并清理相关 embedding / media。[F2-6][F3-3][F3-5]
6. 查询端接收 project path 和 query，对项目 wiki Markdown 扫描排序，可选向量排名融合和链接图扩展，返回 query mode 与结果集。MCP `search` / `read_page` 工具把调用者连接到选定项目；agent 写入使用 MCP write_page，经 Rust writer 锁、原子替换及字节回读验证。[F1-6][F1-7][F2-7][F2-8][F3-6]

这条路径在源码层从来源进入项目目录、生成 Markdown、提交到 wiki 并供查询接口读取是闭合的。模型生成质量、文件变更监视器时序、UI 更新、多 MCP client 并发写、源删除期间故障处理均未运行验证；因此本节只报告代码走查，不把执行表现作为验收结论。

## R5 移植清单

| 要素 | 对应原对象何处 | 原对象侧形态（代码 / 数据 / 内容 / 前置条件） | 接收方缺口（代码 / 数据 / 内容 / 外部依赖） | 移植量级 | 可核验依据 |
|---|---|---|---|---|---|
| 来源导入与 wiki 生成 | `ingest.ts` 分析、生成、FILE block 写入；`source-lifecycle.ts` 导入、移动、删除 | 代码：分析→生成→提交；数据：项目目录 raw sources、wiki 与 cache；内容：来源引用 frontmatter、Markdown 页；前置：项目目录及可用 ingest LLM。 | 代码：无服务端文档解析或 ingest 接口；数据：无知识条目/来源模型；内容：已有 README、Docs、skill、任务文本，但具体纳入来源及公共库入库规则未定；外部依赖：有本机 CLI agent，ingest 模型映射待核实。 | **独立子系统**；T0 当前没有文档解析/知识持久化代码。 | 原对象：[ingest.ts](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L779-L785)；[source-lifecycle.ts](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/source-lifecycle.ts#L448-L577)；接收方：`apps/server/src/db/schema.ts:4-29`、`apps/server/src/api/routes.ts:169-418`、`apps/server/src/services/sessionManager.ts:315-342` |
| 项目隔离、任务队列与缓存 | `project-identity.ts`、`ingest-queue.ts`、`ingest-cache.ts` | 代码：UUID 到项目路径注册、队列恢复；数据：项目 UUID、source path、状态、SHA-256 和输出路径；内容：每项目来源和 wiki 文件；前置：可读写本地项目目录及应用注册表。 | 代码：有 Workspace 与任务领取，但无知识范围隔离/队列；数据：SQLite 有 workspace/issue/comment/session/message，无知识来源状态；内容：项目任务和文件可按工作目录使用，公共经验归属规则未定；外部依赖：本地 SQLite 已接入，无知识外部存储。 | **独立子系统**；现有 Workspace 是任务分组，不是知识库 ACL。 | 原对象：[ingest-queue.ts](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest-queue.ts#L12-L23)；[project-identity.ts](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/project-identity.ts#L2-L13)；接收方：`apps/server/src/db/schema.ts:5-28`、`packages/cli/src/commands/listTasks.ts:13-31`、`apps/server/src/config.ts:9-39,77-95` |
| wiki 搜索与读取 | `search.rs` 的 `search_project`，MCP search/read 工具 | 代码：关键词排序、可选向量融合、链接扩展；数据：项目 wiki Markdown 与可选 LanceDB embeddings；内容：Markdown 页面及关联来源；前置：project path 与非空 query，向量路径另需 embedding 配置。 | 代码：无全文或知识检索 API；数据：无文档索引/知识页模型；内容：Docs/README/skill 及任务文本存在，运行时 SQLite 数量未核实；外部依赖：无搜索服务接入，向量 embedding provider 对接待核实。 | **独立子系统**；T0 现有 issue 查询不是知识检索。 | 原对象：[search.rs API](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src-tauri/src/commands/search.rs#L12-L60)、[ranking/graph](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src-tauri/src/commands/search.rs#L350-L413)、[vector merge](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src-tauri/src/commands/search.rs#L497-L553)；接收方：`apps/server/src/api/routes.ts:169-418`、`apps/server/src/db/schema.ts:4-29`、`README.md:50-56` |
| agent/MCP 工具接口 | `mcp-server/src/index.ts`、`src-tauri/src/api_server.rs` | 代码：Node stdio MCP client bridge 到桌面 HTTP API；数据：project binding、API token 和工具参数；内容：wiki search/read/write/embed；前置：桌面应用运行、API 开启、写入 token、工具端兼容 MCP。 | 代码：当前 `kb` CLI 接本地 HTTP API，未见 MCP server；数据：没有应用级 user/role/ACL；内容：工具可处理任务和评论，没有知识工具；外部依赖：MCP 客户端/WorkBuddy 版本接入未核实。 | **独立子系统 + 第三方接入**；接入界面和外部 MCP client 均非当前实现。 | 原对象：[MCP tools](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/mcp-server/src/index.ts#L172-L200)、[project binding](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/mcp-server/src/index.ts#L43-L63)、[API auth](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src-tauri/src/api_server.rs#L395-L417)；接收方：`README.md:24-48`、`Docs/设计文档.md:12,209-217,313-318`、`apps/server/src/index.ts:64-84,113-119` |
| 页面写入、更新与来源删除 | `tools.rs` wiki writer；`ingest.ts` page merge；`source-lifecycle.ts` 删除级联 | 代码：create-only writer、显式覆盖、来源归并和 provenance cascade；数据：Markdown bytes、sources frontmatter、文件历史、可选 embedding/media；内容：按来源归属的 wiki 页；前置：写入 API token、项目 wiki 路径及写权限。 | 代码：当前没有知识页写入/覆盖/删除接口；数据：没有文档版本、来源关系或删除级联记录；内容：agent 通常写、用户查看，具体修改/删除边界未定；外部依赖：知识页操作由本地文件系统支持，无知识服务接入。 | **独立子系统**；T0 只有任务、评论、消息的业务写接口。 | 原对象：[Rust writer](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src-tauri/src/agent/tools.rs#L687-L747)、[ingest merge](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/ingest.ts#L2236-L2289)、[source deletion](https://github.com/nashsu/llm_wiki/blob/e08cfce65aad8b76b13546a081c1a8d4422b70c3/src/lib/source-lifecycle.ts#L448-L577)；接收方：`apps/server/src/db/schema.ts:4-29`、`apps/server/src/api/routes.ts:169-418`、`apps/server/src/services/comments.ts:31-90` |

## R6 未解问题

### 证据与运行边界

- README 的检索说明为两跳图扩展；已查 Tauri `search_project` 路径为一跳。现有证据不足以判断 README 描述的是另一查询路径还是文档未同步；未全仓核验所有查询入口。[F1-4][F2-8]
- MCP writer 和 ingest 在各自读取路径中出现 Rust mutex 与 TypeScript 项目锁，但源码没有建立两者的共享锁关系。MCP 写入 schema 未见 expected-version 参数；这是接口契约事实，不代表所有写入入口无版本保护。跨路径同页覆盖结果未实跑。[F1-7][F3-6]
- 未运行 ingest、Tauri API、MCP client 或模型请求；长文分块时实际调用次数、model configuration 和不同模型兼容性未验证。[F1-3][F2-3][F2-4]
- 未运行两个 MCP client 同时写同页、MCP 与 ingest 并发写、改写已缓存输出页后重新导入、项目切换中断及来源移动/删除故障注入。[F1-10][F3-3][F3-4][F3-5]
- F1 引用 Issue #828 报告特定 macOS/Apple Silicon/Ollama 组合下 embedding 超时；未独立复现，不能外推到其他设备或 provider。[F1-11]
- AgentBoard AppData SQLite 未打开，运行时任务、评论、消息条数未核实。[T0]

### Brief Open questions

- 项目知识隔离与通用经验公共库范围已由用户确认；公共经验的认定规则、纳入责任和两个范围的统一检索实现没有当前产品证据。[T0]
- Codex、DSH、WorkBuddy 等 agent 的具体版本、MCP 握手与写入行为未验证；接收方 AgentBoard 当前资料只列 codebuddy、codex、opencode、dsh CLI。[F1-10][T0]
- agent 写入是否包含修改/删除、用户是否维护知识、知识库 ACL 和项目/公共范围的可见性未定义为当前产品实现。[T0]
- 来源范围、刷新责任、删除后的版本保留和跨设备共享边界未定。[T0]

### Findings follow-ups 处置记录

| 来源条目 | 处置 | 理由 |
|---|---|---|
| F1 suggested follow-up：两 MCP client 同页写、覆盖与 UI 更新 | 留入本节 | 需要固定版本运行验证；本轮未启动应用。 |
| F1 suggested follow-up：LAN 与各 client 的 URL/token | 留入 Brief Open questions | 跨设备配置与客户端实测未在本轮完成。 |
| F1 suggested follow-up：DSH / WorkBuddy stdio 兼容 | 留入 Brief Open questions | 依赖各工具具体版本，本轮未运行客户端。 |
| F3 suggested follow-up：MCP 与 ingest 并发同页 | 留入本节 | 必须实跑多写入口并发行为，静态锁代码不能替代。 |
| F3 suggested follow-up：手改输出页后的 cache 行为 | 留入本节 | 缓存函数的判据已读，UI/CLI/API 上层行为未运行。 |
| F2 suggested follow-ups | 无 | F2 标注 `none`。 |

## R7 信息来源

- `[F1-1]–[F1-4]`：仓库 README、仓库内 `llm-wiki.md`；项目一手文档。检索“两跳”结论来自 README 概述，条目与源路径见 [F1.md](findings/F1.md)。
- `[F1-5]–[F1-10]`：固定提交中的 Cargo/npm manifest、MCP server、Rust API/bind/writer 与 MCP 项目绑定源码；源代码。写入权限和绑定结论分别按具体 MCP/API 契约引用，索引见 [F1.md](findings/F1.md)。
- `[F1-11]`：GitHub Issue #828；社区报告，未独立复现。索引见 [F1.md](findings/F1.md)。
- `[F1-12]`：仓库根 `LICENSE` 与 MCP `package.json`；许可证类型声明。索引见 [F1.md](findings/F1.md)。
- `[F2-1]–[F2-6]`：固定提交的 `ingest-queue.ts`、`ingest-commit-coordinator.ts`、`source-identity.ts`、`ingest.ts`、`ingest-cache.ts`、`file_sync.rs`、`project-file-sync.ts`；源代码。索引见 [F2.md](findings/F2.md)。
- `[F2-7]–[F2-8]`：固定提交 `src-tauri/src/commands/search.rs` 的 Tauri `search_project` 具体接口；源代码。索引见 [F2.md](findings/F2.md)。
- `[F3-1]–[F3-6]`：固定提交 `project-identity.ts`、队列/提交协调器、`project-mutex.ts`、`ingest.ts`、`ingest-cache.ts`、`source-lifecycle.ts`、`wiki-page-delete.ts`、`src-tauri/src/agent/tools.rs`；源代码。索引见 [F3.md](findings/F3.md)。
- `[T0]`：AgentBoard 工作区 README、Docs、`apps/server`、`apps/web`、`packages` 与 agentboard skill 的静态检查记录；本地源代码和项目文档。[T0 接收方现状](findings/T0-接收方.md)

结论未基于运行时模型或并发测试；本轮没有安装模型、启动 MCP/API server 或连接 Codex、DSH、WorkBuddy 客户端。
