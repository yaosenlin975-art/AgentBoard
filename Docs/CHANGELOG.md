# CHANGELOG.md

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
