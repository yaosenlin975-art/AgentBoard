# AgentBoard

本地任务看板：人管理任务流转（待规划 → 进行中 → 待验收 → 已关闭），codebuddy / codex / opencode / dsh 四家 CLI agent 经统一适配层无头执行任务。带占用锁（一任务一占用者）、评论唤醒、聊天会话与 `kb` 命令行。

## 前置要求

- Node.js ≥ 20
- pnpm（经 corepack：`corepack enable`）
- 可选：四家 CLI agent（codebuddy / codex / opencode / dsh）；未安装的项在看板中标"未安装"禁用

## 启动

```bash
corepack pnpm install
corepack pnpm -r build
node apps/server/dist/index.js
```

打开 http://127.0.0.1:8787 （web 已随 server 静态托管；未构建 web 时仅 API 可用）。

- 数据库默认 `%APPDATA%\AgentBoard\agentboard.db`，配置 `config.json` 同目录。
- 环境变量覆盖：`AGENTBOARD_PORT`、`AGENTBOARD_DB`。

## kb 命令行

agent 或脚本经 `kb` 与看板交互：

```bash
corepack pnpm --filter @agentboard/cli build
cd packages/cli && npm link   # 或直接 node packages/cli/dist/index.js <命令>
```

```bash
kb list-spaces
kb list-tasks [--workspace <id|名>] [--status 待规划]
kb show <issue-id>
kb claim <issue-id>                # 原子领取；已被占用退出码 2
kb comment <issue-id> "内容"       # 长文/中文用 --stdin
kb done <issue-id> --notes "..."   # 完成 → 待验收
kb fail <issue-id> --reason "..."  # 失败 → 待规划
```

- 服务地址：`--server <url>` 或环境变量 `KB_SERVER`（默认 `http://127.0.0.1:8787`）。
- agent 身份：环境变量 `KB_AGENT=<名字>`；未设 KB_AGENT 时默认 kb-cli，agent 评论不触发唤醒。

## Skill（agent 自助领任务）

把 `skills/agentboard/` 目录复制或链接到 agent 生态的 skills 目录（如 `~/.agents/skills/agentboard`），或随工作空间提供。SKILL.md 定义领取 → 执行（以 `kb show` 实时拉取为准）→ `kb comment` 汇报 → `kb done`/`kb fail` 收尾的完整流程与占用规则。

## 文档

- `Docs/设计文档.md`：需求、方案、接口、UI 布局
- `Docs/DESIGNS.md`：落地架构与数据流
- `Docs/CHANGELOG.md`：变更记录
- `Docs/PENDING_TESTS.md`：人工验收清单
