# CHANGELOG.md

## [2026-10-31] agentboard skill 补 kb CLI 缺失处理分支

- SKILL.md 前置条件补自检命令 `kb --version`（流程第一步，输出版本号即 CLI 可用）。
- 新增"故障分支"：命令不存在（127）→ 在 AgentBoard 仓库 `packages/cli` 执行 `npm link` 装机并复验，工作空间无该仓库时报告"kb CLI 未安装"并给出安装命令；与服务未启动（1）查服务、任务被占用（2）换任务并列区分。

## [2026-10-31] 修复看板卡片标题被裁与聊天会话刷新丢失

- 看板列卡片列表容器加 `overflow-y-auto`（列内滚动），IssueCard 根加 `shrink-0`（内容超高不再被等比压缩），标题第二行与底部元信息行不再被卡片底边裁掉；空列占位与 dnd-kit 拖拽行为不变。
- 服务端新增 `GET /api/sessions/:id`：返回完整 Session，不存在 404（复用 getSession，语义同 `/sessions/:id/messages`）。
- panelStore 接入 zustand persist（localStorage 键 `agentboard.panel`）：持久化 view/issueId/sessionId/chatSession/rightOpen，unread 不持久化；新增 `clearSession` 动作。
- ChatPanel 会话解析改三态：liveSession ?? 匹配的 chatSession ?? 按 sessionId 拉 `GET /api/sessions/:id`；拉取 404/失败清空 sessionId 回空态，不悬挂"会话加载中…"；当前工作空间暂无会话时空态提示"会话归属创建时所选的工作空间，可切换左侧工作空间查找"。
- DetailPanel 持久化 issueId 失效（issue 已删除）沿用既有错误处理；新增测试：server `/api/sessions/:id` 两例（存在/404）、web panelStore 持久化一例、ChatPanel 按 id 恢复一例（404 回空态）与空态归属提示一例。

## [2026-10-31] 修复聊天区新增消息顶开整页布局

- App 根容器 `min-h-screen` → `h-screen overflow-hidden`：恢复高度链（根有确定高度 → 中区 flex-1 生效），消息增长不再撑开整页滚动，各区域改为内部滚动。
- 左栏工作空间 aside 加 `overflow-y-auto`（列表过长自身滚动）；Board / RightPanel / ChatPanel / DetailPanel / MessageList 各级链核对无需改动（TopBar 已有 shrink-0，Board 列行与 DetailPanel/MessageList 已有 overflow 内滚结构）；新增 `App.test.tsx` 断言根容器与左栏滚动类。

## [2026-10-31] spawn 崩溃防御与模型真下拉

- 适配器 spawn 崩溃防御：`spawnLineChild` 挂 child `'error'` 处理器，spawn 失败（如 ENOENT）按异常退出归一——error.message 写入 stderr 尾部环形缓冲、failure promise 以 `SpawnFailedError`（code `SPAWN_FAILED`，message 含命令名与原始原因）reject、exit/close 事件流照常触发；`collectOutput` 据此 reject，`whereCommand` 把 finder 自身 spawn 失败归一为空结果（探测不抛错）。CLI 不存在时 `GET /api/clis/:id/models` 走 detect 未安装 → 200 空数组，服务进程不再因 unhandled `'error'` 崩溃。
- opencode `listModels`：`models` 两步探测改经 `resolveSpawnForm` 解析后的 cmd/prefix（与 detect/runTurn 一致），修复 win32 下裸 `opencode` 直 spawn 必 ENOENT。其余三家适配器核对无同类问题（codex/dsh listModels 为静态清单，codebuddy 已走解析 form）。
- web 模型字段改真下拉：新增共享组件 `ModelField`（react-query 拉 `/api/clis/{cliId}/models`；models 非空渲染 select——空值选项 + 模型列表 + 末尾"手动输入…"，选手动切文本输入、旁有"返回列表"回下拉；models 空/查询失败/cliId 空渲染纯文本输入）。`NewSessionDialog` 与 `ModelSelector`"修改模型"弹窗接入（testid 不变；留空清除与 loadLastModel/saveLastModel 语义保留）。

## [2026-10-31] 工作空间创建体验

- 新增工作空间弹窗加"浏览…"按钮：服务端 `POST /api/system/pick-folder` 经 PowerShell（`-NoProfile -NonInteractive -STA -Command` 参数数组、不经 shell）弹 `FolderBrowserDialog`，选中返回 `{path}`、取消返回 `{path:null}`、spawn/脚本失败 500 `PICK_FOLDER_FAILED`、已有窗口打开 409 `PICK_FOLDER_BUSY`（模块级 in-flight 守卫，finally 复位）；请求中按钮禁用并提示"请在弹出的窗口中选择文件夹"。
- 工作空间名称留空兜底：`POST /api/workspaces` name 允许空串（缺键仍 400），空 → 从 path basename（去尾部 `/`、`\` 后取最后一段）命名；弹窗内 name 未手动改过时随路径实时预填 basename，手动改过不再覆盖。

## [2026-10-31] 初版实现

- 脚手架：pnpm monorepo（apps/server、apps/web、packages/adapters、packages/cli、packages/shared、Docs）。
- 契约：shared 类型包（Issue/Workspace/Session/Message/Comment、统一事件协议）。
- 服务端数据层：SQLite（better-sqlite3）建表 + claim 原子领取事务（并发仅一成功）。
- 适配器：codebuddy / codex / opencode / dsh 四家无头执行器，统一事件协议（text/tool/error/end），win32 .cmd 垫片经 cmd.exe 包装；codex 选用 `exec --json`（实机验证 session_id 取 thread.started.thread_id）。
- 会话管理：轮次编排（新建/resume）、运行中消息排队与合并、停止（kill 当轮保留队列）、并发槽位上限默认 3、异常退出按失败处理并释放占用。
- 评论服务：评论入库与唤醒路由同函数完成（占用中起轮/入队合并，未占用仅留言）；CLI 探测缓存（四家版本号）。
- REST + WS 装配：工作空间/issue/claim/release/done/fail/comments/sessions/messages/stop 接口；WS 推送看板变更与会话事件流；POST /api/sessions 支持 model 留空与 reuse_session。
- kb CLI：list-spaces / list-tasks / show / claim / comment（--stdin）/ done（--notes）/ fail（--reason）；`--server` > `KB_SERVER` > 默认 8787；409 → 退出码 2；`--json` 原始输出。
- Web：Vite + React 19 脚手架、顶栏（工作空间/CLI 徽标/状态）、工作空间列表；四列看板 + dnd-kit 拖拽（乐观排序、占用卡禁拖）；右侧面板双视图（任务详情：字段编辑/评论时间线/会话列表/条件操作区/派发弹窗；聊天视图）。
- 聊天视图：流式渲染（ws delta 拼接）、tool/thinking 折叠块、排队计数、停止按钮、会话切换器、模型修改下一轮生效。
- 构建：server 静态托管 apps/web/dist（存在时启用 SPA fallback）。
- Skill：`skills/agentboard/SKILL.md`（领取→执行→汇报流程、占用规则、kb 用法）。
- 文档：DESIGNS.md / CHANGELOG.md / PENDING_TESTS.md / README.md；全链路冒烟（kb CLI 全命令、REST、web 托管、codebuddy 最小派发）。

## [2026-10-31] 完成审计修复

- 适配器：LineChild 增加 stderr 尾部 30 行环形缓冲；exitCode≠0 或 exit 0 零事件且无会话 ID 时，发送含 stderr 尾部的诊断 error 事件并落会话消息。
- 适配器：.cmd/.bat 垫片改为解析 shim 内容直取 node 入口启动（替代 cmd.exe 包装；实测 cmd.exe 包装丢参数致交互模式挂死）；spawn stdin 改为 ignore，防 CLI 等待输入。
- 评论：POST comments 支持可选 agent_id → author=`agent:<id>`；kb comment 经 `KB_AGENT` 环境变量上报作者。
- 接口：补 `GET /api/issues/:id`（kb show 用）；`PATCH /api/sessions/:id` 支持修改 model（下一轮生效）。
- 冒烟结论：codex 端到端闭环（派发→真实执行→assistant 内容"OK"→会话"已结束"→强制释放回收）；codebuddy 本机 401（CODEBUDDY_AUTH_TOKEN 对 CLI 直连失效），转人工项；dsh 本机 shim 损坏，转人工项。
- 顶栏聊天入口与右缘常驻窄条（首次进入即可达聊天视图）。
