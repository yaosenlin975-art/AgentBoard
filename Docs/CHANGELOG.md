# CHANGELOG.md

## [2026-11-01] 聊天视图补「标记待验收」入口（issue 0699a18c）

- web `ChatPanel.tsx`：顶部工具条停止按钮左侧新增「标记待验收」（`chat-done-btn`）；显示条件为会话 `issue_id` 非空、关联任务占用中（`claimed_by` 非空，经 DetailPanel 同款 `['issue', issue_id]` query 取数）且会话非已结束/失败；点击 POST `/api/issues/:id/done` `{agent_id:'user'}`，onSuccess 失效 `['issue', id]` 与 `['sessions']`，错误走现有 actionError，成功后占用释放按钮自然消失（看板卡片经既有 WS issue.changed 失效刷新）；自由会话与无 issue 数据不渲染；停止按钮与其逻辑未动。
- web `chat.test.tsx`：mockChatApi 补 GET `/api/issues/:id` 与 POST `/api/issues/:id/done`（含服务端占用释放模拟）；新增 3 例——占用中显示按钮、点击调用正确端点与 body 且成功后按钮消失、自由会话不渲染且不拉取 issue。web 全量 105 例通过，tsc 通过。设计文档 §5.2 已有「会话与任务详情提供标记待验收」表述未改。

## [2026-11-01] kb list-tasks 输出补齐 labels 与评论（issue e5c6609c）

- cli `listTasks.ts`：文本表格新增 labels（逗号连接，空显示 `-`）与评论（`comment_count` 数字）两列；`--json` 输出不变（透传 Issue，天然含 `comment_count`）。
- cli `cli.test.ts`：ISSUE 夹具补 `comment_count`；list-tasks 表格用例覆盖多标签逗号连接、空标签 `-`、评论数渲染；对齐沿用 render.ts 现状（`table()` 不做 CJK 宽度修正）。

## [2026-11-01] thinking 事件贯通到聊天折叠块（issue 92b9e5a0）

- adapters `types.ts`：UnifiedEvent 新增 `{type:'thinking'; delta:string}`。
- adapters `dsh.ts`：行协议 `thinking` 事件（text 字段）归一为 thinking 事件，不再忽略；text/tool_call/final 等其余行为不变。
- adapters `codex.ts`：`item.completed` 且 `item.type==='reasoning'` 时取 `text` 摘要字段归一为一条 thinking 终值事件（与 agent_message 同为终值路径，无重复风险）；无 text 字段/空文本不映射；`item.started`/`item.updated` 的 reasoning 中间态维持忽略。
- adapters codebuddy/opencode：行协议无 thinking/reasoning 事件（codebuddy 仅 assistant text/tool_use；opencode 仅 text/tool_use/error），维持不动，补轻量忽略断言。
- server `sessionManager.ts`：thinking delta 缓冲 thinkingBuf，tool/error/end 及无 end 兜底处与 text 同点位 flushThinking——落一条 `role='event'`、`content=JSON.stringify({kind:'thinking', text})` 消息；空缓冲不落；session.event 广播照常（web 流式区不渲染 thinking）。
- shared `types.ts`：WsEvent `session.event` 事件类型并集补 `'thinking'`（广播 UnifiedEvent 直传，类型必需）；Message role 枚举与 message 表 schema 未动。
- web `MessageList.tsx`：event 消息 content JSON 解析归类——`kind==='thinking'` 渲染「思考」折叠块（details 默认收起，`data-testid=thinking-block-<id>`，正文纯文本）；含 name/input 走既有工具块；两者不匹配按原文展示（兜底不变）。
- 测试：adapters dsh/codex thinking 映射用例更新（含 started/updated reasoning 忽略、无文本字段不发）、codebuddy/opencode 补不发断言；server sessionManager 新增 thinking 聚合/切分/广播与无 thinking 不落空块 2 例；web chat 新增思考折叠块开合与旧格式渲染 2 例。设计文档 §7.5 已有「tool/thinking 事件折叠块」表述未改。

## [2026-11-01] 「有新消息」未读统计脱离聊天面板存活（issue 6def6819）

- web 新增 `state/unreadCollector.ts`：message.added → markUnread 从 ChatPanel 提升到 wsBus 全局层（模块加载即 `subscribeWsEvents`，非组件生命周期），面板收起、切 detail 视图等 ChatPanel 未挂载期间的新消息同样计数；当前会话消息不计；session.deleted → clearUnread（非当前会话被删时未读条目不再残留）。
- `ChatPanel.tsx`：静态 import unreadCollector（模块图加载即生效，与 streamingStore 同路径）；删除 useWsEvent 内 markUnread 分支（防双计），其余 WS 处理分支不动。
- `panelStore.ts`：unread 随 `agentboard.panel` 持久化（zustand persist partialize 增 unread），重水合经 sanitizeUnread 容错（非对象回空对象、非正整数条目剔除），刷新后未读恢复。
- 清零路径核查：全部入口（TopBar 聊天按钮、RightPanel 窄条、切换器选项、新建会话、派发对话框、详情 SessionList）均经 openChat 打开对应会话即清零，无绕过入口。
- 被删会话未读条目取舍：session.deleted 即 clearUnread 置 0（非删除键），0 值不显示徽标、不进 TopBar 总数，重水合 sanitize 顺带剔除；非当前会话被删时 ChatPanel 不挂载也覆盖。
- 新增/更新测试：web `unreadCollector.test.tsx` 4 例（ChatPanel 未挂载计数 + TopBar/切换器徽标 + openChat 清零；多会话独立；当前会话不计；session.deleted 清条目）、`panelStore.test.ts` 改 2 例（unread 持久化与 rehydrate 恢复；脏数据回空/剔除）；web 全量 100 例通过，tsc 通过。

## [2026-11-01] 看板卡片显示评论数徽标（issue f40adf54）

- shared：`Issue` 新增必填 `comment_count: number`（查询列非落库列，CLI --json 输出附加该字段）。
- server `db/repos/issue.ts`：getIssue/listIssues SQL 加子查询 `(SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = i.id) AS comment_count`；IssueRow/rowToIssue 同步映射。
- web `IssueCard.tsx`：`comment_count > 0` 渲染 `💬 N` 徽标（title 提示保留），0 条整块隐藏。
- web `api/ws.ts`：`comment.added` 失效范围从仅 `['comments', issue_id]` 扩为 `['comments', issue_id]` + `['issues']`（载荷无 workspace_id，按前缀失效全部看板列表，与 DetailPanel 既有 `['issues']` 粒度一致）+ `['issue', issue_id]`（详情 issue 对象含 comment_count）。
- 新增测试：server `db.test.ts` 1 例（无评论 0、加 2 条后 getIssue/listIssues 均 2 且不串到其他任务）；web `board.test.tsx` 1 例（💬 2 显示、0 条隐藏）+ 1 例（comment.added 按 eventToQueryKeys 失效后评论数刷新）、`ws.test.ts` comment.added 断言更新；Issue 测试夹具（ws/detail/board/WorkspaceList）补 comment_count。全仓 343 例通过（shared 3 / adapters 91 / cli 27 / web 95 / server 127）；web/server/cli tsc 通过。

## [2026-11-01] kb comment 默认 agent 身份 kb-cli（issue a5481220）

- `packages/cli/src/commands/comment.ts`：请求体 `agent_id` 改恒传 `ctx.agentId`（KB_AGENT 优先，默认 kb-cli），不再直读环境变量；未设 KB_AGENT 时服务端作者记为 `agent:kb-cli` 而非 `user`，修正此前默认身份触发唤醒的问题。服务端唤醒逻辑不动（仅 author=user 唤醒，语义正确）。
- `packages/cli/src/index.ts`：comment 命令 `--help` 描述同步新语义；Ctx 结构与默认值逻辑不变。
- claim/done/fail 已统一走 `ctx.agentId`，无需改动。
- 测试：cli.test.ts comment 默认路径与 --stdin 用例改断言 `{ content, agent_id: 'kb-cli' }`，KB_AGENT=coder-bot 覆盖用例保留；服务端 `comments.test.ts` 已有「agent/system 作者不触发唤醒」用例，不重复新增。

## [2026-11-01] 运行中会话后台流式内容不丢（issue cc97a886）

- web 新增 `state/streamingStore.ts`：`Map<sessionId, string>` 模块级单例（zustand）缓存各会话流式文本，API `appendDelta`/`clearStream`/`getStream`/`useStream`；收流挂在 wsBus 全局层（模块加载即 `subscribeWsEvents`，非组件生命周期）：session.event text delta → `appendDelta(session_id, delta)`，assistant `message.added` → `clearStream(session_id)`，与当前选中会话无关。
- `ChatPanel.tsx`：移除本地 `streaming` state 与 useWsEvent 内按「当前会话」过滤的 text 累积分支（避免双计）；流式区改渲染 `useStream(sessionId)`——切会话即读对应累积、面板收起/切视图/组件卸载内容不丢；mergeMessages 收到 assistant 消息按 `message.session_id` 清对应会话 buffer（覆盖 WS 断连期间 catchUp 补齐落库后的残留场景）。
- 服务端 flush 时机与 WS 事件结构不变；切会话不再清空流式内容（原 `setStreaming('')` 移除，改为按会话读取 store）。
- 新增测试：web `chat.test.tsx` 2 例（流式期间切到 B 后台继续累积且不串显、切回显示完整累积；收起面板再展开内容不丢且收起期间 delta 继续累积）+ beforeEach 重置 streaming store 隔离用例；web 全量 94 例通过。

## [2026-11-01] 队列长度与等待槽位状态可见（issue 6778718c）

- shared：`WsEvent` 新增 `session.runtime`（载荷 session_id、queued_count、waiting_slot）；`Session` 类型增可选运行时字段 `queued_count`/`waiting_slot`（不入库，sessions 接口响应时合并）。
- `sessionManager.ts`：`SessionState` 增 `waitingSlot`；`acquireSlot` 增 onWait 回调（确需排队时同步触发，排队顺序与并发上限语义不变），beginTurn 在真等待时置位、获槽后复位（含 stop 弃轮）；新增导出 `getSessionRuntime(sessionId)` 返回队列长度/等待标志/排队文本副本；新增 `broadcastRuntime`，触发点：sendToSession 入队后、等待置位/复位后、轮尾队列合并清空后、stop 使等待标志复位时（stop 后计数未变则不发）。
- `routes.ts`：GET /api/sessions 列表与 GET /api/sessions/:id 合并 `queued_count`/`waiting_slot`（不回传文本）；新增 GET /api/sessions/:id/queue → `{texts}`（只读，停止后可查，会话不存在 404）。
- web：ChatPanel 订阅 `session.runtime` 校正本地计数与等待标志（入队乐观 +1 保留，事件到达即校正为服务端值）；切换会话/刷新从 sessions query 字段初始化（修复此前纯本地计数切会话即丢的缺陷）；轮 end 不再本地清零，等服务端合并后 runtime(queued_count=0) 校正；顶部工具条 waiting_slot 时显示「等待槽位」徽标；queuedCount>0 展示「查看队列内容」折叠面板（GET /sessions/:id/queue 打开即拉，只读）；`eventToQueryKeys` 对 session.runtime 不触发 invalidation。
- 新增测试：server `sessionManager.test.ts` 2 例（入队计数/副本/广播与轮尾归零广播；maxConcurrentTurns=1 等待置位复位广播、等槽位期间 stop 复位且队列保留）、`api.test.ts` 2 例（sessions 字段合并 + runtime 广播 + /queue 文本；=1 时 waiting_slot 响应可见与释放复位）；web `chat.test.tsx` 改 1 例（end 清零改等服务端 runtime）+ 增 2 例（sessions 字段回填与 runtime 校正、队列内容展开查看）、`ws.test.ts` 1 例（session.runtime 不失效查询）。

## [2026-11-01] dsh 模型只读：能力位 supportsModelSelection + UI 禁用模型选择（issue 35202421）

- shared `CliInfo` 与 adapters `AgentAdapter` 新增 `supportsModelSelection` 能力位：codebuddy/codex/opencode=true，dsh=false（dsh 无模型 CLI flag，模型由 CLI profile 配置决定；进程级全局共享状态，不做按次派发改写）。
- `dsh.ts` runTurn：删除「model 非空发提示 error 事件」逻辑，opts.model 静默忽略（不进参数，其余行为不变）。
- server `cliDetect.ts` refreshClis 载荷透传能力位，GET /api/clis 携带该字段。
- web：`ModelField`（新建会话/修改模型弹窗共用）对 supportsModelSelection=false 的 CLI 渲染禁用控件 + 标注「由 profile 配置决定」；`DispatchDialog` 同规则禁用 select/手输切换、不预填、提交不带 model。
- 新增测试：adapters registry 能力位 1 例、dsh runTurn model 静默用例改断言；server `cliDetect.test.ts` 载荷透传 1 例、`api.test.ts` /api/clis 载荷断言更新；web `ModelField.test.tsx` 3 例（dsh select/输入框禁用+文案、非 dsh 行为不变）、`detail.test.tsx` 1 例（dsh 控件禁用+提交 model=null、非只读不受影响）。

## [2026-11-01] 派发弹窗预填可编辑历史备注（issue ce182056）

- `DispatchDialog.tsx`：打开时经 `GET /api/issues/:id/comments` 拉取评论，最近 10 条 ts 升序渲染为 `## 历史备注\n- [author] content` 追加到预填 prompt 末尾（`dispatchTemplate.ts` 新增 `renderHistoryNotes`，与服务端输出逐字符一致）；无评论不追加该段、不显示提示，原静态"后端自动追加"提示改为有评论时显示可删改说明；提交时 prompt 原样上传。
- `dispatch.ts` `dispatchIssue`：追加前检测渲染结果已含 `## 历史备注` 则跳过追加、原样使用（含 promptTemplate 整体替换路径），避免前端预填后服务端双份；`renderHistoryNotes` 格式与 10 条上限不变，缺失时仍由服务端补齐。
- 新增测试：server `test/dispatch.test.ts` 2 例（prompt 已含历史备注段不追加、已含且有评论仍原样）；web `src/test/detail.test.tsx` 3 例（3 条评论预填升序、编辑后提交体携带编辑文本、无评论不含历史备注）+ 既有默认值用例改断言无评论不预填不显示提示。

## [2026-11-01] done/fail/release 自动评论补 WS 推送（issue d3e137d2）

- `claim.ts` 的 `doneIssue`/`failIssue`/`releaseIssue` 返回值改为 `{ issue, comment }`（导出类型 `ClaimActionResult`）：`comment` 为本次自动评论（done 无 notes 时为 null）；签名参数、状态流转、事务原子性不变。
- `routes.ts` 三端点（POST /issues/:id/done|fail|release）：`comment` 非空时在既有广播外补 `comment.added`，顺序与手动评论端点一致（先 comment.added 后 issue.changed）。
- 响应 JSON 保持 issue 字段平铺 + 附加 `comment` 字段（无评论为 null）：CLI done/fail 与 web DetailPanel 按顶层 issue 字段消费，不受影响；未改 `{issue, comment}` 包裹结构以免破坏既有消费方。
- 新增测试：`api.test.ts` 1 例（done 带 notes → comment.added 内容为 notes 且先于 issue.changed、done 无 notes 不广播、fail reason 评论广播、release system 评论广播、响应 comment 附加）；`claim.test.ts` 三函数用例补返回 comment 断言。

## [2026-11-01] 删除任务级联清理关联会话与消息（issue 4908a07e）

- `DELETE /api/issues/:id`（非占用中）改为级联清理：先逐个 `stopSession` 停掉绑定会话的运行中轮次（无在途轮次时幂等，不 kill、仅状态落库已结束），再在同一事务内按会话显式删 message → 删 session → 删 issue（不依赖 FK CASCADE 语义）；占用中仍 409 且不删。
- session repo 新增 `listSessionsByIssue`/`deleteSession`；message repo 新增 `deleteMessagesBySession`；表 DDL 与既有 FK 行为不变。
- 新增 WS 事件 `issue.deleted`（载荷 issue_id、workspace_id）与 `session.deleted`（载荷 session_id），事务提交成功后广播；shared WsEvent 类型同步补充。
- web 接入：`eventToQueryKeys` 对 `issue.deleted` 失效看板 issue 缓存、对 `session.deleted` 失效会话列表；ChatPanel 收到当前会话 `session.deleted` 后经 panelStore 新增 `removeSession` 清选中与未读计数回空态（详情页删除入口的二次确认 UI 既有，未改动）。
- 新增测试：server `test/deleteCascade.test.ts` 3 例（级联删除无残留+广播载荷、占用中 409 不删、运行中绑定会话先停后删）；web `ws.test` 2 例、`panelStore.test` 2 例、`chat.test` 2 例（当前/非当前会话删除后切换器剔除与空态）。

## [2026-11-01] 设置入口接入真实配置（端口/并发上限/主题，issue 65898a1b）

- 服务端新增 `GET /api/settings`：返回 config.json 持久化值与默认合并结果（环境变量覆盖不参与，端点只反映持久化值）；新增 `PATCH /api/settings`：zod 校验（port 1-65535、dbPath 非空、maxConcurrentTurns ≥1，至少一个字段，未知键忽略）后写回 config.json 并返回新值。
- `config.ts` 新增 `readSettings`/`writeSettings`；字段级容错合并提取为 loadConfig/readSettings 共用，loadConfig 既有语义（缺失写回、环境变量覆盖）不变。
- `sessionManager` 新增 `setMaxConcurrentTurns`：PATCH 并发上限变更时即时生效，校验同 init（非法 ValidationError、未装配报错）。
- 设置弹窗重写：打开拉取真实配置回填端口/并发上限/DB 路径，保存走 PATCH（400 展示服务端错误，成功静默关闭）；提示"端口 / DB 路径修改后需重启服务生效；并发上限即时生效"；主题并入弹窗三选项（浅色/深色/跟随系统，选中态高亮），localStorage 持久化与即时切换保留，顶栏循环按钮行为不变。
- `theme.ts` 主题状态改模块级单一来源（useSyncExternalStore）：弹窗显式选择后顶栏循环按钮标签同步刷新，`setTheme`/`cycleTheme`/`useTheme` 对外行为不变。
- 新增测试：server `test/settings.test.ts` 7 例（GET 默认值/文件值/env 不参与、PATCH 持久化回读、四类非法值 400、并发上限=1 后第二会话轮次排队、setter 装配与校验；配置隔离用 APPDATA 指向临时目录）；web `src/test/SettingsDialog.test.tsx` 4 例（回填、PATCH 请求体、400 错误展示、主题三选项即时生效+localStorage+选中态）。

## [2026-11-01] kb claim 占用任务的用户评论留言游标（issue 0afcf471）

- issue 表加列 `last_seen_comment_id TEXT`（NULL=无游标）：建表 DDL 同步更新；`initSchema` 启动时 `PRAGMA table_info` 检查缺列则 `ALTER TABLE ADD COLUMN`（存量库自动迁移）。
- `claimIssue` 同一 UPDATE 内将游标置为当前最新评论 id（领取输出视为已读，无评论为 NULL）；release/done/fail 释放 UPDATE 内游标置 NULL。
- 新端点 `POST /api/issues/:id/comments/consume`：事务内读全部评论、计算游标后的新评论 id 数组（时间序；游标 NULL 或失效视为全部待读）、推进游标到最后一条（无评论置 NULL）；重复调用第二次 new 必为空（恰好一次）。返回 `{comments, new_comment_ids}`；web 详情页 `GET /api/issues/:id/comments` 保持纯读。
- kb CLI `show`：评论改经 consume 端点拉取并标注——文本模式新评论行 `[新] ` 前缀，`--json` 每条评论加 `is_new` 布尔；consume 返回 404 等 HTTP 层失败（旧服务端）降级 GET comments 纯读不标注。
- web 评论区 hint 三态：绑定会话占用"将唤醒 <agent>"（woke 展示不变）/ kb 自助领取占用（session_id=null）"留言待 agent 下次读取" / 未占用"仅留言"。
- 新增测试：server `test/consume.test.ts` 6 例（claim 前评论视为已读、恰好一次、404、绑定会话 woke 回归、release/done 重置）；web 三态 hint 覆盖（新增 kb 占用态 1 例）；cli show consume 主路径/is_new/降级 4 例。
- 文档：设计文档 §5.8 用户发评论改双通道表述（绑定会话实时唤醒 / kb 占用待读恰好一次消费）、UI 提示三态；§6.1 接口表补 consume 行；agentboard SKILL.md 汇报节改为"CLI 领取无实时唤醒，留言 [新] 标注待下一次 kb show 消费"。

## [2026-10-31] 修复 kb CLI 网络层失败裸输出无上下文

- `packages/cli/src/api.ts`：fetch 网络层失败（TypeError，非 HTTP 非 2xx）在非 ECONNREFUSED 时不再直抛裸 `fetch failed`，统一包装为 `看板服务不可达（<服务地址>，用 --server 指定；<原始 message>）`，原始 message 取 cause 链各层去重拼接（undici 外层常为 "fetch failed"，真实原因在 cause）；原错误挂 `cause` 保留。ECONNREFUSED 分支"看板服务未启动"文案与 HTTP 非 2xx 行为不变。
- 新增测试：非法端口（99999）触发网络层失败 → 退出码 1，stderr 含友好文案、服务地址与原始 message。

## [2026-10-31] 修复 kb CLI 经 npm link 启动静默失效

- CLI 入口守卫（`packages/cli/src/index.ts`）改两侧 realpath 归一比较：argv[1] 经 `realpathSync` 归一后与 `import.meta.url` 比较，npm link 装机（junction/符号链接）启动时不再因链接路径与真实路径严格不等而跳过 `main()`；argv[1] realpath 失败视为不匹配，vitest 直接导入仍不触发。
- 新增回归测试 `packages/cli/test/entry.test.ts`：临时目录建 dist 目录 junction（Windows junction 仅目录目标可用，文件 symlink 需特权），真实进程 `node <链接>/index.js --version` 断言输出 0.0.0、退出码 0；dist 未构建时跳过。旧守卫下该测试失败、新守卫通过（已做负向验证）。

## [2026-10-31] agentboard skill 补 kb CLI 缺失处理分支

- SKILL.md 前置条件补自检命令 `kb --version`（流程第一步，输出版本号即 CLI 可用）。
- 新增"故障分支"：命令不存在（127）→ 在 AgentBoard 仓库 `packages/cli` 执行 `npm link` 装机并复验，工作空间无该仓库时报告"kb CLI 未安装"并给出安装命令；与服务未启动（1）查服务、任务被占用（2）换任务并列区分。
- exit 1 报错识别由匹配错误文本改为按退出码判断：实测连接被拒（ECONNREFUSED）才报"看板服务未启动（…）"，其余失败（如端口 1 的 `bad port`）stderr 只有裸 `fetch failed`。

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
