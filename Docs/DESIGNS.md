# DESIGNS.md

AgentBoard 落地整体设计。需求与方案论证见 `设计文档.md`，变更记录见 `CHANGELOG.md`。

## 1. 定位

本地任务看板：人管理任务流转，四家 CLI agent（codebuddy / codex / opencode / dsh）经统一适配层无头执行任务，占用锁保证一任务一占用者。

## 2. 架构与模块划分（pnpm monorepo）

```
apps/server/        Express + better-sqlite3 + ws；REST/WS 唯一入口，静态托管 apps/web/dist
apps/web/           React 19 + Vite + Tailwind 4；三区布局（工作空间 | 看板 | 右侧面板）
apps/mcp/           官方 MCP TypeScript SDK 2.4.0；stdio tool server，仅通过本机 REST 调任务与知识服务
packages/adapters/  四家 CLI 适配器 + 统一事件协议（text/tool/error/end）
packages/cli/       kb 命令行（commander；list-spaces/list-tasks/show/create-issue/move-issue/delete-issue/claim/comment/done/fail）
packages/shared/    契约类型（Issue/IssueTreePage/Workspace/Session/Message/Comment、事件协议）
skills/agentboard/  SKILL.md（agent 自助领取流程）
Docs/               设计、变更、待测文档
```

依赖规则：web ↔ server 只经 REST/WS；cli ↔ server 只经 REST；adapters 不反向依赖 server。

## 3. 核心数据流

- **SQLite 单库**（默认 `%APPDATA%\AgentBoard\agentboard.db`；`AGENTBOARD_PORT` / `AGENTBOARD_DB` 环境变量覆盖）：workspaces、issues（含 parent_issue_id、claimed_by/claimed_at/session_id）、sessions、messages、issue_comments。
- **任务层级**：issue 以同 workspace 自引用 `parent_issue_id` 表示单父树，增量迁移设置 `ON DELETE RESTRICT`；服务事务校验父级与环，更新触发器保护同空间关系和防环。旧平铺列表不变，`GET /api/issues/tree` 按 parent/status 和 `(sort_order,created_at,id)` keyset 分页，返回祖先上下文、子项数及后代关闭进度。父任务有未关闭后代时任意状态更新路径均返回冲突；有子项的节点不能删除。workspace 整体删除在级联前清空其内部父引用。
- **任务层级客户端**：CLI `create-issue --parent`、`move-issue --parent|--root`、`list-tasks --tree` 复用 REST 与 CAS/幂等键；MCP 复用既有 12 个任务工具，list 支持单层 tree cursor，create/update 传父字段；另有经批准的唯一破坏性工具 `agentboard_delete_task`（透传 `DELETE /api/issues/:id`，不可逆，占用中或含子任务被拒）。
- **任务树界面**：平铺看板保持默认并可切换任务树。根与展开节点分别按游标读取直接子项；查询键区分根作用域与父任务 ID。状态/文本筛选从工作空间任务索引计算命中项及祖先，只展开必要路径并续读到全部目标节点；每节点独立显示状态、占用与后代关闭进度。创建子任务使用父节点，移动父级使用 `expected_updated_at` CAS；单个活动移动编辑状态保存在树视图级，冻结表单打开时版本并在行跨父级重挂载后保留目标；409 展示打开版本、当前版本及重开提示，不覆盖服务端最新树数据。关闭未完成后代的父项会禁用“已关闭”，有子项的详情删除操作会说明阻塞原因并禁用删除。窄屏以两列显示展开控件和完整标题/进度，状态与操作移至下一行；宽屏恢复横向排列。
- **模型字段**：新建会话与修改模型共用 `ModelField`。模型请求期间显示加载状态；失败可重试，成功空列表保留手输；旧缓存值不在当前清单时仍显示并标明状态。清单加载后可返回下拉列表选择，也可切换手输；只读 CLI 保持禁用编辑并说明模型由 profile 决定。
- **占用锁**：claim 原子事务 `WHERE claimed_by IS NULL AND status IN ('待规划','进行中')`，并发仅一成功；占用中禁状态变更（409），字段/评论仍可编辑。解除仅 agent `done`/`fail` 或用户强制释放。
- **MCP 任务契约**：ID 操作提交 `workspace_id` 并由服务端校验；带范围的完成、失败、释放以占用者条件 SQL 在事务中执行。任务编辑支持 `expected_updated_at` CAS；增量触发器在时间不递增时设为旧值加一，覆盖评论、会话恢复及直接 SQL 修改。旧 UI 的人类强制操作单独保留，不作为 MCP 工具。
- **统一 MCP**：12 个任务工具与 6 个知识工具经共享 REST client 调用现有 API；Workspace 绑定、知识 scope、request_id 幂等键和结构化业务错误在适配层映射。SDK schema 错误按 SDK `tools/call` 输入校验响应返回。所有知识读结果含 content 与 structuredContent 总长度不超过 40,000 个序列化字符；正文按 Unicode code point 续读，sources/evidence 按数组项分页，历史按实际返回 revision 数续读。
- **幂等写入**：Idempotency-Key 使用 UUID；actor、HTTP 操作、资源、规范化 body/query hash 与响应在 domain mutation 的同一事务保存，保留至少 24 小时。重放不再次广播或唤醒。外部唤醒在提交后执行，未完成结果保留 pending 状态；进程中断后重放返回 OPERATION_UNKNOWN，不再次触发，可能需人工检查一次未送达唤醒。未携带 key 的旧客户端保留原契约。
- **分页正文**：携带 limit/offset 的工作空间、任务和评论请求返回 items/next_offset，按 id ASC；旧无分页请求保留数组。描述和单评论正文按 Unicode code point 窗口续读，默认 12,000、最大 40,000；评论列表只返回 500 字符片段，不消费未读游标。
- **评论图片**：PNG/JPEG/WebP 以 raw bytes 上传到私有存储；10 MiB/张、5 张/评论。SQLite 增量表记录 staged/attached 元数据、提交关联、配额预留、清理账本与图片投递状态。投递状态为 pending、sending、unknown、delivered；服务启动把残留 sending 标记为 unknown。图片能力同时校验已成功探测的 CLI 版本和模型；CodeBuddy 当前仅启用 2.179.2 + MiniMax-M3.1-Flash。历史图片按 Issue scope 分页选择，单批按最旧顺序截断为最多 5 张且 ≤20 MiB，并返回仍待读数量。全局槽位取得后、适配器调用前以 SQLite immediate 事务复核选中 ID 并预留状态；unknown 只接受与当前确认对应的 ID。unknown 结果不自动重发；实际投递前缀含 unknown 时须显式确认 `retry_unknown_images`。图片回执只表示 CLI 轮次返回成功，不代表看板业务任务完成。consume 仅在 `delivered_at` 非空时推进评论游标。下载按 Workspace 或 Issue 关联校验，不从客户端接收服务端路径。
- **评论图片界面**：文件选择、粘贴与拖放共用待发送附件状态；附件先以本地预览显示并上传到当前 Workspace，全部成功后才与评论一同提交。提交失败保留正文与已上传附件；历史图片使用 Issue 作用域下载 URL，评论 WebSocket 事件刷新同一评论查询。
- **轮次执行**：POST /api/sessions（派发）→ 事务内 claim + 建 session → 起无头 CLI 进程（工作目录 = 工作空间路径）→ stdout 逐行经适配器归一为 text/tool/error/end → WS `session.event` 推送 + message 表落库。后续轮以 adapter_session_id resume。
- **并发上限**：进程槽位可配（默认 3），超限轮次排队等空闲槽位；运行中新消息入会话队列，轮次结束后合并为一条 prompt 自动续轮。
- **评论唤醒**：纯文字用户评论 + issue 占用中且有绑定会话 → 空闲起一轮 / 运行中入队合并；未占用仅留言。含图片评论仅在当前 CLI 版本和模型组合通过合成图输入验证后唤醒。附件元数据展示 pending、sending、unknown、delivered；发送失败或服务重启把在途投递标为 unknown，保留未读。普通文字留言不夹带旧图片；再次派发包含 unknown 图片时必须显式确认。文件仅在附件/评论删除事务提交后回收；失败保留账本，由 1 小时周期清理重试。暂存默认 24 小时过期；配额、过期时间和清理周期可在 `/api/settings` 调整。
- **错误与重启**：CLI 异常退出 → 会话"失败" → 占用释放 + issue 回"待规划" + system 评论；服务重启后"运行中"会话按失败处理。
- **done/fail**：done → "待验收"释放占用（notes 落 `agent:<cli>` 评论）；fail → "待规划"释放占用（reason 落评论）。

## 4. 技术选型

知识存储：新增 `knowledge_page` 与不可变 `knowledge_revision`；Workspace/公共范围由表约束与带范围的 repository 共同校验。每次改动在事务内以 revision CAS 更新页面并保存完整来源、证据与状态快照；归档、恢复和软删除均追加版本。知识引用阻止工作空间级联删除。

知识检索：SQLite FTS5 trigram 索引由页面触发器同步；至少三个 Unicode 字符按字面 phrase 检索，一至两个字符在限定范围内以转义 LIKE 查询。SQL 统一过滤 Workspace/common、状态和有效期，标题权重 5、正文 1，返回来源与证据。

知识入口：`/api/knowledge` 提供搜索、分页列表、页面、历史和版本写入，`kb knowledge` 经 HTTP 调用同一 repository。按页面 ID 的操作必须显式指定项目或公共范围；来源和证据在事务写入前统一校验。

任务知识：派发与 claim 共用 `getTaskKnowledge`，默认以标题、标签、描述进行最多五个本地字面查询并去重，上限五页；自定义查询只执行一个查询。派发引用块不超过 6,000 字符，已有引用区块不重复追加。检索失败返回安全警告，不撤销领取或阻止派发。自由聊天与 show 不自动查询。

知识界面：顶部入口切换任务板与知识视图，Workspace 改变时重置内容；页面显示来源、版本和状态，维护动作使用当前 revision 并确认。窄屏用原生 Workspace 选择框替代固定侧栏。

| 层 | 选型 | 说明 |
|---|---|---|
| 服务 | Express + better-sqlite3 + ws | 单进程本地服务 |
| 适配 | spawn（shell:false）+ 逐行 stdout 解析 | win32 .cmd 垫片经 cmd.exe /d /s /c 包装 |
| CLI | commander + 全局 fetch（Node ≥20） | 退出码 0 成功 / 1 失败 / 2 已被占用(409) |
| MCP | `@modelcontextprotocol/server` 2.4.0 (Apache-2.0) + Zod 4 | 本机 stdio；不启 API、不读写业务数据库；仅访问 loopback REST |
| 前端 | React 19 + Vite + Tailwind 4 + react-query 5 + zustand + dnd-kit | WS 事件映射 react-query invalidation |
| 模型探测 | --help 静态清单 → CLI 动态命令 → 空清单手输，三级降级 | 探测失败回退，不输出猜测列表 |

## 5. 已知边界

账号基础使用独立 `managed_account` / `account_operation` 表，不进入共享知识或 MCP。凭据仅存 Windows 当前用户 DPAPI 密文文件，额外 entropy 绑定产品、安装实例、身份 hash 与用途；数据库只持有 UUID 引用。DPAPI 经固定 PowerShell 脚本与 stdin 管道调用，不把凭据放入命令行。操作锁为本地单服务进程内锁；恢复引用在操作账本保存，启动时将中断写入归类为 recovery_required、中断签到归类为 unknown。WorkBuddy Desktop 捕获/切换已按 ACC-05 实现（见下节），但 UIA 托盘退出自动化与跨账号真实闭环未真机验收（PENDING_TESTS）；codebuddy_desktop 契约未确认，保持 PROVIDER_UNVERIFIED。

### 账号 provider：WorkBuddy Desktop（ACC-05）

- 契约唯一依据 `Docs/verification/2026-11-01-workbuddy-desktop-contract.md`「2026-11-01 授权观测」：目标实例 `D:\Program Files\WorkBuddy\WorkBuddy.exe` 5.9.3（HKCU 卸载项绑定）；`instance_id = sha256("workbuddy_desktop"+NUL+小写规范 exe 路径)`；auth 根 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（固定每用户路径 → 每产品单活跃实例）；数据根 `~/.workbuddy`；stable UID=`$.account.uid`（36 字符，token 轮换不变，文件哈希不能做身份判据）；schema v2 判据=敏感字段 `{$wbEncrypted:1,envelope}` 信封；C 盘 4.22.5 陈旧实例与多安装共享认证位置均 unsupported。
- 架构：`apps/server/src/services/accounts/workbuddyDesktopProvider.ts` = 流程状态机（契约路径常量+探针全部可注入）+ 默认 PowerShell 探针（版本/进程/UIA 托盘/启动信号）。快照本体（.info 整文件字节 + `storage/skeleton/account-snapshot.json`，各带 sha256 与产品版本）经 SecretVault DPAPI 加密落 `<db目录>/accounts/`；DB 只存 `identity_hash=sha256(uid)`、`uid_sha256_8` hint 与 UUID 引用；信封值不解析、不入库、不进日志与错误消息。
- 捕获 `captureCurrent`（operation=capture，经 operationRunner 串行）：preflight（exe 存在/版本 5.9.3.x/运行态）→ 读身份（缺 uid / v1 明文 schema / 未运行 → 固定错误码拒绝）→ 快照加密落库 → 复读身份比对（变化删引用放弃）→ 新建账号或同身份换快照引用（token 轮换）。
- 切换 `switchAccount` 状态机（operation=switch，同实例独占锁）：preflight（实例/版本/目标存在）→ safe-exit（两段式：UIA 托盘退出 ≤10s → 失败经 WS `account.notice` 提示手动退出 + 轮询退出签名）→ backup（完全退出后读盘）→ validate-target（解密快照，app/instance/uid8/产品版本/文件 sha256 校验，任一不符固定错误码拒绝、不写）→ atomic-write（同目录临时文件+rename，目标地址按 role 映射当前契约路径）→ restart（三信号任一：启动日志对/127.0.0.1:18488/WorkBuddy 主窗口）→ identity-verify（复读 uid==目标）。
- 降级与失败恢复：退出签名 = 本实例进程清零 且 `window-state.json` mtime ≥ auth 写盘（WM_CLOSE 只隐藏托盘不算退出）；未确认退出 → `EXIT_NOT_CONFIRMED`，未写任何客户端数据，绝不 taskkill/强杀。写后失败（启动超时/身份核验失败）→ rollback（再次 safe-exit → 写回 backup → 重启 → 核验原 uid）：核验通过 → `SWITCH_ROLLED_BACK` 收尾 failed；核验失败 → `recovery_required` 冻结实例（同实例后续 capture/switch 一律 409，直至 restore 操作解冻）。busy/unsaved 契约上不可判定：`canCloseSafely()` 恒 `{safe:false}`。
- API（`apps/server/src/api/accountRoutes.ts`）：`GET /api/managed-accounts?app=`（脱敏列表+is_current）、`POST /api/managed-accounts/:app/capture-current`、`POST /api/managed-accounts/:id/switch`（202+operation_id，结果轮询 `GET /api/account-operations/:id`）；codebuddy_desktop 一律 `PROVIDER_UNVERIFIED`。签到能力未验证，registry 中 checkin 关闭。


- `kb comment` 经 POST /comments 固定 author='user'；agent 身份徽标仅出现在 done/fail notes（`agent:<cli>`）。
- 适配器只解析 stdout，子进程 stderr 不落事件流（codebuddy 实测轮次零输出时无法从事件定位原因）。
- dsh rc 版接口破坏性变更：适配器做版本判断 + 明确报错；本机 dsh.cmd 当前损坏（loader 报错），未实机验证。

## 6. 运维工具：自启与桌面快捷方式

kb autostart / kb shortcut 零 npm 依赖，全部经 winrun.ts 封装 spawn（stdin 恒 ignore、必挂 error 事件、windowsHide、参数数组不经 shell；reg/PowerShell 的 OEM 码页输出先按 UTF-8 解码、出现替换符按 GBK 重解码）。

- 自启：HKCU Run 键值固定 wscript.exe "<repo>\scriptsgentboard.vbs" autostart；install 前置检查 apps/server/dist/index.js，端口取 %APPDATA%\AgentBoard\config.json（缺省 8787），并把 node 路径/仓库/日志目录/端口正则重写进 vbs 顶部 Const 区（重复 install 可刷新端口；Run 键同值时跳过 reg add 但仍刷新 vbs）。uninstall 仅当现值含 agentboard.vbs 才删（非自家值报错不动），vbs 文件保留。
- scripts/agentboard.vbs：双模式（autostart 隐藏拉起；open 探测 /api/version 就绪后开默认浏览器，未起先拉起再轮询 ≤20×1500ms，30s 超时 MsgBox 报日志路径）；服务进程经 cmd.exe /c 包装实现 >> 日志与 2>&1 重定向（外层双引号防 cmd 剥引号），ASCII 内容，未配置占位符时运行报错退出。
- 快捷方式：PowerShell WScript.Shell COM 建 AgentBoard.lnk（[Environment]::GetFolderPath('Desktop') 兼容 OneDrive 重定向；TargetPath=wscript.exe、Arguments=vbs open、IconLocation=apps/web/public/agentboard.ico、工作目录=仓库根）；create 前置检查 ico 存在与 vbs 已配置（未 install 拒绝），remove 仅删桌面存在的 AgentBoard.lnk。
- 图标：apps/web/public/agentboard.png（1024）与 agentboard.ico（256/64/48/32/16）由 Pillow 脚本生成（gemini-image 两次网络失败后按任务规则兜底）；四列看板卡片扁平几何、深蓝底白板高对比，16px 仍可辨列结构。
- 三命令非 Windows 统一报「仅支持 Windows」退出 1；命令/参数/vbs 常量重写/注册表解析均导出纯函数供测试（cli.test.ts 假 Runner + 临时仓库）。

## 7. 任务依赖关系

依赖以独立边表 `issue_dependency`（`blocked_issue_id` ← `blocker_issue_id`）落地：blocker 解除后被阻塞卡才可 claim。不改 `parent_issue_id` 层级语义，不做看板内连线图与自动排期。

- **数据模型**（`apps/server/src/db/migrations/issueDependency.ts`，在 `initSchema` 注册，幂等）：`issue_dependency(blocked_issue_id, blocker_issue_id, created_at)`，两端 `REFERENCES issue(id) ON DELETE CASCADE`，主键 `(blocked_issue_id, blocker_issue_id)`，`CHECK (blocked_issue_id <> blocker_issue_id)` 挡自环；索引 `idx_issue_dep_blocked`、`idx_issue_dep_blocker`。
- **两个触发器**（与 `taskHierarchy.ts` 同风格，直接写库绕不过）：`BEFORE INSERT` 校验两端同 `workspace_id`，否则 `RAISE(ABORT)`（跨工作区依赖禁止）；`BEFORE INSERT` 用递归 CTE 从 blocker 沿边可达 blocked（插入后成环）即 `RAISE(ABORT)`。服务层先判错误码，触发器兜底。
- **解除判定唯一口径**：`isBlockerResolved(status) = status ∈ {待验收, 已关闭}`（`apps/server/src/services/dependency.ts`）。`done` 即算解除，避免人工验收堵死流水线。claim 守卫、REST 列表投影、CLI 输出、MCP 输出、UI 角标全部调用该函数，禁止各处复制判断。
- **claim 守卫**（`apps/server/src/services/claim.ts`）：claim 事务内先 `unresolvedBlockers(issueId)`，非空即 `ConflictError`（409），文案 `存在未完成的前置任务：<title>(<short id>) ×N；完成后可领取`；事务内复查防 TOCTOU。`done`/`fail`/`release` 不受依赖影响，不因未解除而卡住收尾。
- **`ISSUE_CLAIMED` 语义**：`claimed_by IS NOT NULL` 的卡不得新增前置——`POST /api/issues/:id/dependencies` 返回 409 `ISSUE_CLAIMED`，文案「任务已被占用，请先 release 再新增前置」；CLI 侧映射退出码 2。与 claim 的「已被占用」同码不同因。单卡前置上限 `MAX_DEPENDENCY_EDGES` = 50。
- **REST 三端点**（`apps/server/src/api/routes.ts`；全部要 `workspace_id`，写操作走既有幂等中间件并广播 `issue.changed`）：`GET /api/issues/:id/dependencies` → `{ blockers, blocked }`，`DependencyRef = { issue_id, title, status, resolved }`；`POST /api/issues/:id/dependencies`（body `workspace_id`、`blocker_issue_id`）→ 201；`DELETE /api/issues/:id/dependencies/:blockerId` → 204。错误码：400 `VALIDATION_ERROR`（缺 `workspace_id`）/ `DEPENDENCY_SELF`（自环）/ `CROSS_WORKSPACE_DEPENDENCY`（跨区）；404 `TASK_NOT_FOUND` / `NOT_FOUND`（blocker 或边不存在）；409 `DEPENDENCY_EXISTS`（重复）/ `DEPENDENCY_CYCLE`（成环）/ `ISSUE_CLAIMED`。
- **Issue 三个计数字段**（可选，非落库列）：`blocked_by_count`、`blocked_by_open_count` 由 `issue_dependency` 单次预聚合，`resolved` 由 `isBlockerResolved` 推出；无前置时 0/0/true。`GET /api/issues` 与树/分页接口统一追加，既有字段不变。
- **CLI**（`packages/cli`，`kb dep ls|add|rm`）：`ls <issue-id>` 列前置与被阻塞者（状态 + 解除标记）；`add <issue-id> <blocker-id>` 建边；`rm <issue-id> <blocker-id>` 删边。`kb dep` **没有** `--workspace` 选项（传了 `unknown option`，退出码 1）；写通道由 CLI 先 `GET /api/issues/:id` 取卡所属 `workspace_id` 再上送——即「按卡所属工作区判定」，卡不属于当前工作区即越界。退出码由子命令自带映射、不改全局 `toExit`：0 成功；2 `DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED`；3 `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR`；4 `NOT_FOUND` / `TASK_NOT_FOUND`；每码一句中文文案。
- **CASCADE 解锁评论**（`unlockCommentsForDeletedBlocker`）：blocker 卡被删除时边随 `ON DELETE CASCADE` 消失，同事务给每个被阻塞卡插 `author=system` 评论「前置 <title>(<short id>) 已删除，依赖自动解除」，并广播 `comment.added`，避免依赖静默消失。
- **MCP**（`apps/mcp/src/tools/dependencies.ts`）：`agentboard_list_dependencies` / `agentboard_add_dependency` / `agentboard_remove_dependency` 与 REST 同构，错误码经 `structuredContent.error.code` 原样透传，`message` 用本地安全文案。
- **UI**（`apps/web`）：看板卡片角标「等 N 项」（未解除数 > 0）与淡色「依赖已清」；详情面板依赖编辑器（添加/移除前置）；树视图锁标与父卡汇总；claim 前前端先拦并展示 blocker 清单，服务端 409 兜底（前端拦截不是唯一防线）。

## 8. 知识星图 PIXI 渲染层

知识星图按 Obsidian 星图逆向文档用 `pixi.js@7.2.4` 重建，取代已废弃的 sigma 路线（sigma 4 是 instanced WebGL、没有 display object 树，做不出每帧收敛的透明度插值、逐帧文字淡出、节点反向缩放与线宽反比）。渲染层在 `apps/web/src/components/knowledge/pixiGraph.ts`（1102 行）；布局与数据在 React 侧与 worker，渲染层只负责画。

- **三层容器与骨架**（`createPixiGraph(host, options)` → handle `{ host, update, zoomBy, resetView, refreshColors, changed, snapshot, destroy }`）：`Application`（`backgroundAlpha:0`、`antialias:true`、`autoStart:false`、`resolution:1`）把 canvas 挂到 host；`stage` 下三层——`background`（`Graphics.drawRect(0,0,1e4,1e4)`，alpha 0，`eventMode:'static'`）、`hanger`（`Container`，节点与连线全挂这里）、`watermark`（`Text('Powered by AgentBoard')`，`anchor(1,1)`，alpha 0.5，`zIndex 3`）。圆固定画在 (100,100) 半径 100，靠 scale 缩放、不重建 geometry；每帧顺序为逐节点 → 逐连线 → 水印 → `sortChildren()` → WebGL 绘制。
- **帧循环**：`requestAnimationFrame` 自绘；无变化 61 帧后停帧（`IDLE_FRAME_LIMIT=60`），一次 `changed()` 跑 62 帧；每帧按「离屏幕中心最近」补建最多 50 个节点（`MAX_CREATE_PER_FRAME`）。透明度与平移每帧收敛 10%（`FADE_RATIO=0.9`）。
- **视觉映射**（`lib/graphVisualFormulas.ts` 纯函数，逐值可核对）：`getSize = max(8, min(3·√(weight+1), 30)) × nodeSizeMultiplier`；`nodeScale = √(1/scale)`；`textAlpha = clamp(log2(scale)+1-fTextShowMult, 0, 1)`；`lineWidth = fLineSizeMult/scale`；`fontSize = 14 + size/4`；`weight` 取正向 ∪ 反向邻居数；双向边去重只画字典序大的那条；11 个语义色经 CSS 变量取色。
- **交互**（DOM 监听 + 距离命中，不走 PIXI event system；相机参数自持、React 只展示）：滚轮 `1.5^(-Δ/120)`，scale 上限 8 下限 1/128，放大锚点=鼠标、缩小锚点=中心，缩放每帧收敛 15%（`ZOOM_LERP=0.85`）；平移带惯性（`shouldKeepPanInertia`）；拖拽固定 `fx/fy`；点击阈值 5px（`CLICK_DISTANCE_SQ`）；hover 时非邻居透明度降到 0.2（`FQ`）；键盘方向键、±、加速键。
- **力导向 worker**（`lib/forceLayoutWorker.ts` + `lib/forceLayout.ts`）：module worker，`setTimeout(1000/60)` 驱动 tick（不是 rAF），alpha 衰减到 `alphaMin` 后停 tick 并回传 `{ positions, alpha, idle, ticks }`；主线程只更新坐标、不重建对象。初始布局 `layoutGraph(iterations:120)`；力参数滑杆默认 centerStrength 0.1 / repelStrength 1000 / linkStrength 1 / linkDistance 250。
- **差量更新**（`update(next)`）：同 id 节点复用（`objectStats.reused`），消失的节点与连线 `destroy()`；weight 变化重算 `size` 与 `fontSize`；双向边去重集合重算；hover 仅在节点消失时清（避免「悬停 → 重渲染 → 高亮消失」）；末尾 `changed()` 触发重绘。
- **局部图**（`lib/localGraph.ts`，照文档 `PQ()`）：`localHopWeight(jumps, hop) = 30 - 30/jumps × hop`，中心固定 30、最后一跳恒 0，`jumps` 夹紧到 1–5；权重只影响节点半径，故离中心越远节点越小。四个开关：正向（forelinks）/ 反向（backlinks）/ 相邻链接（interlinks 还原命中集合之间的边）/ 隐藏孤立（hideOrphans）；无向 BFS 复用 `buildAdjacency` 与 `bfsDepths`，与 hover/聚焦高亮共用同一套邻接实现。
- **控件面板**（`GraphControls.tsx`）：宽 240px、右上角、可滚动且隐藏滚动条；四个折叠区 `mod-filter` / `mod-color-groups` / `mod-display` / `mod-forces` 默认收起；区头按钮 close（×）/ open（齿轮）/ animate（魔棒，仅全局图）/ reset（恢复默认）。颜色与边框全部来自 `index.css` 的 `--kb-graph-*` 变量（亮/暗两套），组件内不写死色值。
- **无 WebGL 降级**（`KnowledgeGraph.tsx`）：先探测 `getContext('webgl2') ?? getContext('webgl')`，非 null 才动态 `import('./pixiGraph')`（jsdom 无 WebGL，静态引入会让测试套件报 `WebGL2RenderingContext is not defined`）。渲染状态 `pending | webgl | no-webgl | failed`；`no-webgl` 显示「当前环境不支持 WebGL，已切换为列表视图」，`failed` 显示「星图渲染器初始化失败，已切换为列表视图」。
- **包体**：PIXI 按需引子包（`@pixi/core`/`app`/`display`/`graphics`/`sprite`/`text`/`events`），不做全量 import；`vite.config` 未配 `manualChunks`，靠动态 import 自动分包。`apps/web/dist/assets` 实测（`pnpm -r build`，2026-11-03）：`index-*.js` 614.38 kB（gzip 187.06，主 chunk，触发 500 kB 警告）、`pixiGraph-*.js` 351.14 kB（gzip 106.72，惰性 chunk）、`markdownRenderer-*.js` 344.19 kB（gzip 104.85）、`forceLayoutWorker-*.js` 3.45 kB、`index-*.css` 47.13 kB。
