# 全仓代码审查报告（2026-11-07）

- 工作区：任务看板 `e41eb0fb-c367-43cf-a99d-6dc5239a5694`（`D:\WorkSpaces\任务看板`）
- 审查方式：Skill `open-code-review-delegate`（OCR v1.13.4 提供规则集，由宿主 agent 自行审阅）
- 性质：**只读审查**。本报告不含任何业务代码改动；改动项一律以任务卡承接。
- 审查范围：`apps/server`、`apps/web`、`apps/mcp`、`packages/cli`、`packages/shared`、`packages/adapters`、`scripts/`、`desktop/`
- 取证基线：工作树 HEAD（2026-11-07，多会话并行改动中，未提交改动不计入本次结论）

---

## 0. 结论摘要

| 档次 | 条数 | 说明 |
|---|---|---|
| 真缺陷 | 7 | 有明确触发条件与可观测后果，建议按卡修 |
| 设计债 | 7 | 不改不错、但会持续抬高改动成本或埋点 |
| 风格偏好 | 3 | 不单独立卡，随门禁或相关卡顺带处理 |

**整体判断**：工程质量高于常见内部工具水平——类型纪律（`apps/server`、`apps/web` 的 `any` 为 0）、测试量（服务端 159 个测试文件、前端 158 个）、SQL 全参数化、附件路径与 Content-Disposition 处理严谨、账号凭据不落日志。问题集中在三类：**启动期时序假设与代码不一致**、**边界健壮性（超时/脏数据/错误码）**、**单文件体积膨胀带来的协作成本**。

**与既有性能链的关系**：本报告不重复 PERF-3/4/5/6/8/9 的结论，只引用（见 §5）。本次新增的性能相关结论仅 2 条（§2.1 启动时序、§3.5 `synchronous` 默认值），且均非首屏路径。

---

## 1. 覆盖与方法

### 1.1 规模

| 目录 | 非测试文件 | 行数 |
|---|---|---|
| `apps/server/src` | 170 | 33,232 |
| `apps/web/src` | 176 | 36,196 |
| `apps/mcp/src` | 8 | 1,089 |
| `packages/cli/src` | 36 | 6,536 |
| `packages/shared/src` | 10 | 1,078 |
| `packages/adapters/src` | 11 | 1,660 |
| `scripts` | 18 | 2,905 |
| `desktop/src-tauri/src` | 2 | 826 |
| **合计** | **431** | **83,522** |

复算：`node -e "…"`（按目录递归统计 `*.ts|tsx|js|mjs|rs`，排除 `node_modules/dist/target` 与 `*.test.*`）。

### 1.2 方法（三层）

1. **逐行通读**（15 个文件，约 8.5k 行）：`apps/server/src/index.ts`、`api/routes.ts`（错误处理与附件/会话段）、`db/repos/issue.ts`、`db/connection.ts`、`db/resolver.ts`、`db/schema.ts`、`db/migrations/issueDependency.ts`、`services/sessionManager.ts`、`services/attachments.ts`、`services/claimLease.ts`、`services/decisionGrace.ts`、`apps/web/src/api/client.ts`、`components/board/Board.tsx`、`packages/cli/src/api.ts`、`apps/mcp/src/apiClient.ts`。
2. **规则扫描**（全 431 文件）：按 OCR 下发的 system rule 逐条机检——`var` 声明、宽松相等、`eval`/`new Function`、字符串形式 `setTimeout`、`innerHTML`/`dangerouslySetInnerHTML`、`@ts-ignore`、`any` 密度。
3. **真实数据取证**：对 `%APPDATA%\AgentBoard\agentboard.db`（40MB，只读打开）执行 `sqlite_master` 索引清点与 `EXPLAIN QUERY PLAN`，验证索引假设；同时以源码 SQL 与查询计划对照。

### 1.3 覆盖与未覆盖（诚实声明）

| 模块 | 覆盖 |
|---|---|
| 启动时序、DB 连接/迁移/仓储、附件、会话状态机、决策宽限、REST 错误处理 | 逐行通读 + 查询计划取证 |
| Web 数据层（client / WS / Board 交互） | 逐行通读 |
| CLI HTTP 层、MCP HTTP 层、adapters spawn、desktop 两文件、打包脚本 | 逐行通读 |
| 账号体系（`services/accounts/**`，约 5k 行）、声音/SSE、知识星图渲染（pixi 1.2k 行）、测试代码本身 | **仅规则扫描 + 抽样**，不做结论性判断 |
| 测试覆盖率数字 | 未重跑（工作树多会话并行改动中，重跑结果不可归因） |

---

## 2. 真缺陷（按严重度）

### 2.1 [高] 启动期单例锁顺序倒置：迁移与租约清扫发生在加锁之前

- **证据**：`apps/server/src/index.ts:308-311`（`openDb` → `initSchema` → `sweepExpiredLeases`）、`index.ts:326`（`recoverOnBoot` 打开工作区库）先执行；`index.ts:348` 才 `acquireServerLock`。而 `index.ts:343` 的注释原文是「**必须先于 openDb**——同一个 DB 被两个进程打开会互相踩 WAL」。
- **触发条件**：同一 `configDir + dbPath` 出现两个启动进程。真实路径：桌面壳双击两次、`pnpm server:ensure` 与手工 `node dist/index.js` 并发、`POST /api/system/restart` 接班进程与旧进程重叠。
- **后果**：两个进程可同时跑 `ALTER TABLE … ADD COLUMN` 迁移。迁移实现是「先 `PRAGMA table_info` 判断列是否存在再 ALTER」（`db/schema.ts:174-179`、`db/migrations/*.ts` 同模式），非原子——两边都读到「列不存在」时，后者抛 `duplicate column name` 并在加锁前崩溃；同时两边都会执行 `sweepExpiredLeases`，可能互相清掉对方刚写入的租约。
- **建议**：把「加锁」提到 `openDb` 之前。锁不依赖 DB（只用 `configDir/config.dbPath/port`），可安全前置；`initSchema`、`sweepExpiredLeases`、`recoverOnBoot` 全部后移。验收：写一个双进程并发启动的集成测试，断言第二个进程在 openDb 之前就以退出码 4 退出，且第一个进程的迁移无 `duplicate column` 日志。

### 2.2 [中] `/api/issues` 列表对 `labels` 裸 `JSON.parse`，单行脏数据打挂整块看板

- **证据**：`apps/server/src/db/repos/issue.ts:178` — `labels: JSON.parse(row.labels) as string[]`。`labels` 是 TEXT 列，无 JSON 约束。
- **触发条件**：任一 `issue.labels` 不是合法 JSON（旧版本写入、手工改库、迁移残留、外部工具写入）。
- **后果**：`listIssues` 抛 `SyntaxError` → `errorHandler` 记未处理错误 → 500。看板只剩错误态，且**所有**工作区的列表请求都受影响（该列在 SELECT 必选字段里）。
- **建议**：`safeParseLabels()`（失败回 `[]` 并 `console.warn` 一条带 issue id 的定位日志），并补一条启动期的数据体检（统计非法 labels 行数，落日志）。验收：构造一条非法 labels 的行，`GET /api/issues` 仍 200、该卡 labels 为 `[]`。

### 2.3 [中] Web 与 CLI 的 HTTP 客户端没有超时，服务卡住时前端永久 loading、CLI 永久挂起

- **证据**：`apps/web/src/api/client.ts:51-56` — `fetch(path, {...})` 无 `signal`；`packages/cli/src/api.ts:169` — 同样无 `AbortSignal`/超时。对照：`apps/mcp/src/apiClient.ts:86-87` 明确 `setTimeout(() => controller.abort(), 10_000)`，说明这是遗漏而非设计取舍。
- **触发条件**：服务进程存活但不响应（better-sqlite3 是同步驱动，长事务或大查询会把事件循环按住；写锁长等待超过 `busy_timeout` 之外的场景）。
- **后果**：Web 端 `useQuery` 永远 `isLoading`，用户无法区分「慢」与「死」；CLI `kb` 命令挂死，用户只能 Ctrl+C；MCP 侧正常超时，三端行为不一致。
- **建议**：Web 统一 `AbortSignal.timeout(15_000)`（上传单独放宽到 60s），超时抛 `ApiError(code='TIMEOUT')` 并给出可重试文案；CLI 用同一常量，退出码沿用现约定。验收：起一个只接受连接不回包的假服务，Web 15s 内进入错误态、CLI 15s 内退出且 stderr 有可读文案。

### 2.4 [中] 看板批量改状态无并发上限、部分失败不收敛

- **证据**：`apps/web/src/components/board/Board.tsx:191-205` — `Promise.all([...selectedIds].map(id => api.patch(...)))`。
- **触发条件**：选中数十张卡一次性改状态；中途任一请求失败（409 占用、网络抖动）。
- **后果**：① 选 N 张就并发 N 个 PATCH，服务端同步 SQLite 会被这些写请求排队放大成秒级卡顿；② `Promise.all` 首个 reject 即中止控制流，**成功写入的卡不会触发 `invalidateQueries`**，选中态也不清空，界面与库短暂不一致（只能等 WS 帧自愈）；③ 用户按提示「重试」会重复 PATCH 已成功的卡。
- **建议**：并发池（4–6）+ `Promise.allSettled`；失败的 id 保留在选中集并逐条列出原因；无论成败都执行一次 `invalidateQueries`。验收：人为让第 3 张卡返回 409，断言其余全部落库、失败卡仍被选中且展示原因。

### 2.5 [中] 桌面壳端口硬编码 8787，设置页改端口后壳会启动失败或连错实例

- **证据**：`desktop/src-tauri/src/server_process.rs:25` — `pub const PORT: u16 = 8787;`；`main.rs:65` 用 `base_url()` 导航。而端口是持久化设置：`apps/server/src/config.ts:125-127`（从 `config.json` 读 `port`）。
- **触发条件**：用户在设置页把端口改成非 8787 并重启。
- **后果**：桌面壳仍探活/导航 `127.0.0.1:8787`，启动判定失败 → 显示 shell 错误页；若 8787 上恰好有另一实例，则连到错误的数据。
- **建议**：壳启动时读 `<configDir>/config.json` 的 `port`（读不到再退回 8787），并让 `base_url()` 接收端口参数。验收：把 `config.json` 的 port 改成 8790，壳能正常拉起并导航到 8790。

### 2.6 [低] SQLite 约束错误未映射，参数类失败一律 500

- **证据**：`apps/server/src/api/routes.ts:1871-1897` — 已映射 `ApiError` / `INVALID_JSON` / `entity.too.large` / `SQLITE_BUSY`，其余落到 500 `INTERNAL`。
- **触发条件**：任何 `SQLITE_CONSTRAINT*`（CHECK/UNIQUE/FK）从仓储层漏到路由层——例如新增字段时漏写前置校验。
- **后果**：调用方（CLI/MCP/前端）只看到「内部错误」，无法区分「我传错了」与「服务端炸了」；CLI 退出码塌成 1。
- **建议**：`SQLITE_CONSTRAINT` → 400 `CONSTRAINT_VIOLATION`、`SQLITE_READONLY` → 503，message 只回约束名不回 SQL 原文。验收：构造一次 CHECK 违例，断言 400 且 body 有 `code`。

### 2.7 [低] `config.json` 非原子写

- **证据**：`apps/server/src/config.ts:205-210` — `writeFileSync(configFilePath(), …)` 直接覆盖。
- **触发条件**：写设置时进程被杀、断电、磁盘满。
- **后果**：留下半截 JSON；`readPersistedFile` 的 `catch` 会静默回默认值（`config.ts:109-117`），用户设置**无提示丢失**（含 `dbPath`）。
- **建议**：写临时文件 + `renameSync` 原子替换；解析失败时在启动日志里显式提示「配置文件损坏，已按默认启动」。

---

## 3. 设计债

### 3.1 [中] `apps/server/src/api/routes.ts` 1904 行承载全部 REST 路由

单文件内含 issues / sessions / attachments / knowledge / decisions / accounts / voice / settings / system 全部端点。后果：任何两张卡只要碰路由就必须串行（RULE-2 的实际成本来源，近期 PERM、PERF、DEC 三条线都为此排队）；评审 diff 噪声大。
**建议**：按域拆 `api/routes/{issues,sessions,attachments,knowledge,decisions,accounts,system}.ts`，`createRouter` 只做装配。**先纯搬迁不改语义**，一次一域，每域单独验收（端点清单不变、测试全绿）。风险：搬迁期与在飞路由卡冲突，必须排在 PERF-4/PERM/DEC 全部落地之后。

### 3.2 [中] 前端 197 处字面量 `/api/...` 路径散落在 63 个文件

CLI 有 `packages/cli/src/api.ts` 统一封装，MCP 有 `apps/mcp/src/apiClient.ts`，**Web 没有等价物**（`apps/web/src/api/client.ts` 只封装了 `get/post/patch` 动词，路径仍由调用方拼）。后果：契约变更要全仓 grep；路径拼错只能在运行时暴露。
**建议**：新增 `apps/web/src/api/endpoints.ts`，把请求按域收敛成函数（`listIssues(wsId, params)` / `patchIssue(id, body)`…），组件只调函数。可分域渐进迁移，不要求一次改完。

### 3.3 [中] `issue` 列表每行仍要执行 6 个附加子查询

`issue.ts` 的列表 SELECT 为每行拼上 `comment_count`、4 个决策相关列、`dependency_violation`（recursive CTE）。PERF-5 修好了 `comment_count` 的索引退化，PERF-4（`97a67f45`）负责字段裁剪与分页——**本报告不另立卡**，仅补充证据：即使裁到最小字段集，只要请求里含 `dependency_violation`，每行仍跑一次递归 CTE，成本随「该卡的阻塞子树大小」增长，最坏是 O(行数 × 子树)。
**建议**：并入 PERF-4 的验收项——`dependency_violation` 改为默认不返回，仅详情端点按需计算。

### 3.4 [中] 无 ESLint / Prettier / CI 门禁

根 `package.json` 只有 `build`/`test`/`package` 系列，无 `lint`，仓库无可用的 eslint 配置，`.github/` 不存在。后果：`any`/`@ts-ignore`/未使用变量/宽松相等只能靠人盯；目前 `apps/server`、`apps/web` 的 `any` 计数为 0 是纪律而非机制。
**建议**：最小可用门禁——`typescript-eslint`（先只开 `no-explicit-any`、`no-unused-vars`、`eqeqeq`）+ `prettier --check`，挂到根 `prebuild`；存量错误用 `--max-warnings` 基线冻结，逐步清零。

### 3.5 [低] SQLite 未设 `synchronous`，WAL 下仍是 FULL

- **证据**：`apps/server/src/db/connection.ts:8-10` 只设 `journal_mode=WAL`、`busy_timeout`、`foreign_keys`。
- **后果**：每次事务提交 fsync；配合 better-sqlite3 的同步 API（在主线程执行），写事务会直接把事件循环按住。心跳、租约、评论、决策都是高频写。
- **建议**：评估 `synchronous=NORMAL`（WAL 下的标准配置：掉电最多丢最后若干已提交事务，不会损坏库）。需先在隔离实例上量一次写吞吐与 WAL 增长，再决定是否改默认值。

### 3.6 [低] 三个超大组件文件缺少子模块边界

`apps/web/src/components/decisions/DecisionCard.tsx`（1128 行）、`components/knowledge/pixiGraph.ts`（1200 行）、`components/settings/AccountsPanel.tsx`（848 行）。都是「组件 + 内联子视图 + 工具函数」混编，单测只能整块挂载。
**建议**：不专门立卡；下次因需求修改其中任一文件时，顺手把纯函数/子视图提取到同目录子文件。

### 3.7 [低] Web 侧从不发送 `X-AgentBoard-Actor`，浏览器永远是 `user` 身份

- **证据**：全仓 `X-AgentBoard-Actor` 仅出现在服务端与 CLI/MCP 侧；`apps/web/src/api/client.ts` 从未设置该头。
- **定性**：这是 PERM-2 明示的「单机行为零变化」取舍，**不是鉴权漏洞**——但浏览器内的 4 角色矩阵（viewer/member/owner）实际不可达，权限相关 UI 只能靠改请求头或集成测试验证。
- **建议**：不立卡。在 `Docs/api.md` 的鉴权段补一句「Web 客户端固定以 `user` 身份写入，角色能力仅对 CLI/MCP 生效」，避免后续复审把它当漏洞重复立项。

---

## 4. 风格偏好

| # | 现象 | 处理 |
|---|---|---|
| S1 | `!= null` / `== null` 共 30+ 处（`routes.ts:1567,1585`、`sessionManager.ts:454` 等），与 OCR 默认规则「禁止宽松相等」冲突 | 不改代码：ESLint 配 `eqeqeq: ["error","always",{"null":"ignore"}]`，把 null 判断作为显式例外 |
| S2 | 部分注释把「必须」写成自然语言（§2.1 的 `index.ts:343` 即为反例），与实现脱节后无人发现 | 关键不变量改写成可执行断言或集成测试，注释只做补充 |
| S3 | `scripts/package-portable.mjs:107-120` 的 `copyTree` 用 `statSync`（跟随软链）递归，pnpm 布局下的软链会被展开；若出现环会无限递归 | 改 `lstatSync`，显式决定「跳过」或「解引用并记录」；打包后加一条软链计数断言 |

---

## 5. 与既有性能链的关系（引用，不重复立项）

| 既有结论 | 承接卡 | 本报告态度 |
|---|---|---|
| `issue_comment(issue_id)` 缺索引导致 `comment_count` 逐行全表扫 | 【PERF-5】`c98392ac` | 已修（待验收）。本次只读库复核：`issue_comment` 上已有 `idx_issue_comment_issue` |
| 首屏两条相同 `/api/issues` 全量请求 | 【PERF-6】`cf75a266` | 不重复 |
| 一次写评论触发 4 条全量请求（WS 全域失效） | 【PERF-8】`a21b8549` | 不重复 |
| 列空态与加载态不可区分、计数用 0 冒充 | 【PERF-9】`751c2729` | 不重复 |
| `/api/issues` payload 收敛（字段裁剪 + 分页 + counts） | 【PERF-4】`97a67f45` | 不重复；§3.3 建议并入其验收 |
| 首屏取证与基线 | `Docs/audit-2026-11-07-perf3-first-screen.md`（`b95530da`） | 直接引用 |

**本次复核推翻的一个假设**：不存在「`issue` 表缺 `workspace_id` 索引」的问题——只读库 `EXPLAIN QUERY PLAN` 显示列表查询走 `issue_parent_order`（`(workspace_id, parent_id, sort_order)`）。此项**不建卡**。

---

## 6. 已核查但判定「非缺陷」的项（避免后人重复怀疑）

| 怀疑点 | 核查结论 |
|---|---|
| SQL 注入 | 全仓 SQL 均为 `prepare` + 参数绑定；未发现模板串拼值 |
| 附件路径穿越 | `services/attachments.ts` 用 UUID 作存储键，`file_name` 只入元数据，读取按 id 定位，无用户可控路径拼接 |
| 命令注入 | `routes.ts` 的 pick-folder 用 `spawn` + 数组参数，无 `shell: true`；`credentialImport` 同样无 shell |
| XSS | 两处 `dangerouslySetInnerHTML`（`KnowledgePrintView.tsx:80`、`ViewToolbarShell.tsx:22`）均为模块常量样式，非用户内容 |
| SSE / 定时器泄漏 | `voiceRoutes.ts` 的 250ms ticker 在 `close`/`finish` 双路径清理；`decisionGrace` ticker 支持注入与 `stop()` 幂等 |
| 凭据进日志 | `credentialImport.ts:256-261` 的审计行只含 platform/计数/耗时；错误统一收敛成固定错误码，不回传原文 |
| 分页游标被伪造 | `issue.ts:475-489` 的 `decodeTreeCursor` 包了 try/catch，非法游标抛 `ValidationError`（400），不是 500 |
| PIXI 资源泄漏 | `KnowledgeGraph` 卸载路径调用 `app.destroy()` |
| WAL 并发互踩 | `busy_timeout=5000` + `SQLITE_BUSY → 409 DB_BUSY` 已具备；问题只在启动时序（见 §2.1） |

---

## 7. 建卡清单（按主题）

父卡：【CR-0｜AUDIT】`51122c99-19d4-41f1-83b1-7f02e87bc9d7`（全 13 张子卡挂其下）

| 卡号 | 主题 | 文件/位置 | 急迫度 | 完整 UUID |
|---|---|---|---|---|
| CR-1 | 启动单例锁顺序倒置 | `apps/server/src/index.ts:308-348` | 高 | `3eb48104-20fe-4172-bc85-490739530e12` |
| CR-2 | Web HTTP 超时（含上传） | `apps/web/src/api/client.ts:51-92` | 中 | `90ef3830-23ef-44bc-a713-9b25528142e3` |
| CR-3 | CLI HTTP 超时与可读报错 | `packages/cli/src/api.ts:169` | 中 | `b759a183-34b5-4624-b401-5efdd3d992b0` |
| CR-4 | 批量改状态并发上限 + 部分失败收敛 | `apps/web/src/components/board/Board.tsx:191-205` | 中 | `d8da678a-8758-4303-8e2b-54006336a33a` |
| CR-5 | `labels` 容错解析 + 数据体检 | `apps/server/src/db/repos/issue.ts:178` | 中 | `2547aeca-2ca7-4e58-b759-a9541fb345b2` |
| CR-6 | 桌面壳端口读 `config.json` | `desktop/src-tauri/src/server_process.rs:25` | 中 | `8fef7dfc-fb63-48ca-abed-223fd8e8ce0a` |
| CR-7 | SQLite 约束/只读错误码映射 | `apps/server/src/api/routes.ts:1871-1897` | 低 | `3cc1c822-aff8-46d2-802e-830109f2cb1f` |
| CR-8 | `config.json` 原子写 + 损坏提示 | `apps/server/src/config.ts:205-210` | 低 | `cef433d5-269e-4876-8af7-8133600b1cc7` |
| CR-9 | Web API 端点注册表 | `apps/web/src/api/` | 中（债） | `1e8b0085-59fa-4bf3-ad13-00b270404aca` |
| CR-10 | `routes.ts` 按域拆分 | `apps/server/src/api/routes.ts` | 中（债，须排队） | `58f2626c-e6c5-4f0a-85bf-b5f0dab7266f` |
| CR-11 | ESLint/Prettier 最小门禁 | 仓库根 | 中（债） | `cfb2d389-c70f-4c40-80ba-aa1af359035f` |
| CR-12 | SQLite `synchronous` 评估 | `apps/server/src/db/connection.ts:8-10` | 低（债） | `2013349b-3a88-4d10-9a4d-37ddf2da35cb` |
| CR-13 | 打包脚本软链处理 | `scripts/package-portable.mjs:107-120` | 低（债） | `17958103-0f02-455e-90c5-5ed06df77d31` |

**拆分说明**：§2.3 的「Web + CLI 无超时」跨两个包，按 `writing-task` 的拆分阈值拆成 CR-2 / CR-3 两张独立卡，不合成一张。
**未建卡的结论**：§3.3（每行 6 个子查询）并入 PERF-4 `97a67f45` 的验收项；§3.6（超大组件）随下次改动顺手处理；§3.7（Web 不发送 actor 头）与 §4 三条风格偏好不单独立卡，理由已在对应小节写明。

---

*本报告为只读审查产物。报告中每条结论均带「文件:行」或可复算命令，未验证项已在 §1.3 显式声明。*
