# DESIGNS.md

AgentBoard 落地整体设计。需求与方案论证见 `设计文档.md`，变更记录见 `CHANGELOG.md`。

## 1. 定位

本地任务看板：人管理任务流转，四家 CLI agent（codebuddy / codex / opencode / dsh）经统一适配层无头执行任务，占用锁保证一任务一占用者。

## 2. 架构与模块划分（pnpm monorepo）

```
apps/server/        Express + better-sqlite3 + ws；REST/WS 唯一入口，静态托管 apps/web/dist
apps/web/           React 19 + Vite + Tailwind 4；三区布局（工作空间 | 看板 | 右侧面板）
packages/adapters/  四家 CLI 适配器 + 统一事件协议（text/tool/error/end）
packages/cli/       kb 命令行（commander；list-spaces/list-tasks/show/claim/comment/done/fail）
packages/shared/    契约类型（Issue/Workspace/Session/Message/Comment、事件协议）
skills/agentboard/  SKILL.md（agent 自助领取流程）
Docs/               设计、变更、待测文档
```

依赖规则：web ↔ server 只经 REST/WS；cli ↔ server 只经 REST；adapters 不反向依赖 server。

## 3. 核心数据流

- **SQLite 单库**（默认 `%APPDATA%\AgentBoard\agentboard.db`；`AGENTBOARD_PORT` / `AGENTBOARD_DB` 环境变量覆盖）：workspaces、issues（含 claimed_by/claimed_at/session_id）、sessions、messages、issue_comments。
- **占用锁**：claim 原子事务 `WHERE claimed_by IS NULL AND status IN ('待规划','进行中')`，并发仅一成功；占用中禁状态变更（409），字段/评论仍可编辑。解除仅 agent `done`/`fail` 或用户强制释放。
- **轮次执行**：POST /api/sessions（派发）→ 事务内 claim + 建 session → 起无头 CLI 进程（工作目录 = 工作空间路径）→ stdout 逐行经适配器归一为 text/tool/error/end → WS `session.event` 推送 + message 表落库。后续轮以 adapter_session_id resume。
- **并发上限**：进程槽位可配（默认 3），超限轮次排队等空闲槽位；运行中新消息入会话队列，轮次结束后合并为一条 prompt 自动续轮。
- **评论唤醒**：用户评论 + issue 占用中且有绑定会话 → 空闲起一轮 / 运行中入队合并；未占用仅留言。评论入库与唤醒在服务端同一函数内完成。
- **错误与重启**：CLI 异常退出 → 会话"失败" → 占用释放 + issue 回"待规划" + system 评论；服务重启后"运行中"会话按失败处理。
- **done/fail**：done → "待验收"释放占用（notes 落 `agent:<cli>` 评论）；fail → "待规划"释放占用（reason 落评论）。

## 4. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 服务 | Express + better-sqlite3 + ws | 单进程本地服务 |
| 适配 | spawn（shell:false）+ 逐行 stdout 解析 | win32 .cmd 垫片经 cmd.exe /d /s /c 包装 |
| CLI | commander + 全局 fetch（Node ≥20） | 退出码 0 成功 / 1 失败 / 2 已被占用(409) |
| 前端 | React 19 + Vite + Tailwind 4 + react-query 5 + zustand + dnd-kit | WS 事件映射 react-query invalidation |
| 模型探测 | --help 静态清单 → CLI 动态命令 → 空清单手输，三级降级 | 探测失败回退，不输出猜测列表 |

## 5. 已知边界

- `kb comment` 经 POST /comments 固定 author='user'；agent 身份徽标仅出现在 done/fail notes（`agent:<cli>`）。
- 适配器只解析 stdout，子进程 stderr 不落事件流（codebuddy 实测轮次零输出时无法从事件定位原因）。
- dsh rc 版接口破坏性变更：适配器做版本判断 + 明确报错；本机 dsh.cmd 当前损坏（loader 报错），未实机验证。
