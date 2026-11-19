---
name: using-agentboard
description: AgentBoard 看板技能族入口：技能路由、工作区边界、无卡不动手、kb CLI 高频命令与收尾提交。触发词：AgentBoard、任务看板、看板、领卡、建卡、拆卡、依赖、kb 命令、kb CLI、工作区绑定、待决策。不适用：纯咨询、只读调研、单条命令查询；执行已派卡用 executing-task。
---

# Using AgentBoard

AgentBoard 用 `kb` 管理「工作空间」下的任务。本文件是技能族唯一权威入口；流程技能只写各自流程，冲突时以本文件为准。

## 权威来源

按顺序取第一个可读路径：

1. `AGENTBOARD_SKILL_ROOT` 指向的技能根或 SKILL 全路径；
2. 当前工作区下的 `skills/using-agentboard/SKILL.md`；
3. 旧环境 `D:\WorkSpaces\任务看板\skills\using-agentboard\SKILL.md`。

`AGENTBOARD_SKILL_ROOT` 指向目录时，解释为 `<根>/using-agentboard/SKILL.md`。全部不可读即停手，报告「权威文档缺失」；不得凭记忆写看板。

## 动作路由

| 目标 | 技能 |
| --- | --- |
| 需求澄清、设计批准 | `brainstorming` |
| 把已批准设计拆成卡 | `writing-task` |
| 执行明确派发的卡 | `executing-task` |
| 交接、暂停、换人 | `handoff` |
| 批量清理待规划卡 | `swing-dev` |
| 需要用户拍板 | `ask-user` |
| 知识页运营 | `kb-curator` |
| 命令、绑定、故障排查 | 本技能 |

只查高频命令看下文；完整命令与退出码读 `references/commands.md`。工作区与 Git 细则读 `references/workspace-and-git.md`。知识页、变更日志与设计落库读 `references/knowledge-and-changelog.md`。服务、CLI、平台故障读 `references/troubleshooting.md`。

## 硬门禁

1. **先绑定工作区**：技能启动先跑 `kb list-spaces --current`。歧义、无匹配或 cwd 不属于任何已登记工作区时停手，不猜。绑定结果至少含 id、name、path。
2. **默认只写当前工作区**：`kb list-tasks` 缺省按 cwd 解析；`--all` 只做跨区只读盘点。任何跨区写入先说明影响面并取得用户当轮授权。
3. **无卡不动手（RULE-1）**：任何实现性修改先建卡并 `kb claim`；已有同内容卡就复用。运行时语义变更的卡必须先写「调用点 / 断言 / 探针」扫描清单。提交必须带本卡 UUID。
4. **派工前查占用（RULE-2）**：`kb show <完整 UUID>` 核对 `status`、`claimed_by`、决策锁；同一文件同时只允许一个 owner。他人占用不抢、不释放。
5. **卡是事实源**：开工、受阻、阶段完成、收尾前重拉 `kb show`；不把领取时快照当最新内容。
6. **接线必须有证据（RULE-3）**：新增 REST 路由、WS 事件、ticker、CLI 命令或 DB 迁移，必须证明真实 app 可触达，或把接线交给有 `blocks` 边的另一张卡。
7. **先设计后实现**：新功能或实质改变接口/数据/验收，先经 `brainstorming` 获批准，再 `writing-task`。

## 绑定与越界

- cwd 落在已登记工作区根之下时，取最长前缀命中的根；命中多个不同根或不属于任何工作区时停手。
- junction / 软链接先解析实体路径，再比较；Windows 路径不区分大小写并去尾分隔符。
- 写前自问：属于哪个工作区、是否当前工作区、跨区是否获当轮授权。三问答不全即停手。
- 要改其他卡或工作流归属的文件，先在相关卡留：`改动声明：<文件> ｜ <YYYY-MM-DD HH:mm 本地> ｜ <意图>`。
- 引用其他工作区原文时写全「工作区 id + 相对路径 + 文件名」。

## 高频命令

```powershell
kb list-spaces --current
kb list-tasks [--workspace <id|名>] [--status <状态>] [--all-status]
kb next [--workspace <id|名>] [--limit N]
kb stats [--workspace <id|名>]
kb show <issue-id> [--mark-read] [--comments <n|all>]
kb claim <issue-id> [--no-knowledge] [--request-id <uuid>]
kb work <issue-id> [--no-knowledge] [--request-id <uuid>]
kb comment <issue-id> <text>          # 多行用 --stdin
kb dep ls <issue-id>
kb dep add <issue-id> <blocker-id>
kb dep rm <issue-id> <blocker-id>
kb release <issue-id>
kb done <issue-id> --notes-stdin --scope <path>
kb finish <issue-id> --notes-stdin --title '<标题>' --type 新增|修复|调整 --scope <path>
kb fail <issue-id> --reason '<原因>'
kb close <issue-id>
kb reopen <issue-id> [--to <状态>]
kb changelog list|create
kb knowledge list|show|search|create|revise|import|link
kb ask <issue-id> --question '<一句话>' --option '<标签|后果>' --option '<标签|后果>'
kb decisions [--state open|grace|answered] [--issue <id>] [--stale]
kb stop-check <issue-id>
```

`kb --json` 放子命令前；例如 `kb --json show <id>`。列表支持 ≥8 位唯一前缀，但卡面、依赖边和提交信息一律写完整 36 位 UUID。

## 任务流转

- 状态：待规划 → 进行中 → 待验收 → 已关闭；另有已废弃和自定义状态。
- `claim` 成功即 `进行中` 并写入 fence；`done` 到 `待验收`，`fail` 回 `待规划`，两者释放占用。
- `accept` 只写验收记录，不改状态；`close` 只接受待验收且所有后代已关闭。
- blocker 只有到「待验收 / 已关闭」才算解除。被依赖挡住时换卡或等前置，不删边绕过。
- 遇到 409 先读 stderr：已被占用、状态不可领取、依赖未解除、决策锁不是同一件事。

## 执行与收尾

1. `kb show` 读最新卡面，`kb dep ls` 确认前置。
2. `kb claim`；成功后保存返回的 fence，工作目录切到工作区 path。
3. 关键节点用 `kb comment` 汇报；`kb show` 的 `[新]` 评论按需 `--mark-read`。
4. 收尾前确认知识页决策和变更日志出口，再按实际修改逐条传 `--scope`。
5. 有用户可见变更优先：
   `Get-Content -Raw notes.md | kb done <id> --close-record --changelog-title '<标题>' --type 新增|修复|调整 --notes-stdin --scope <path>`
6. 无用户可见变更：加 `--no-changelog`。无法完成：`kb fail`。需要用户拍板：`ask-user`。

完整提交原因码、路径规则和状态回读见 `references/workspace-and-git.md`；知识页、证据、设计页回改见 `references/knowledge-and-changelog.md`。

## 停止条件

- 工作区未绑定、跨区未授权、卡归属不一致。
- 权威技能文档缺失。
- 他人占用、未解除 blocker、open decision 阻止 claim。
- 需要用户决定产品/数据/接口取舍。
- 收尾回报缺工作区、改动清单、跨区声明、验证结果。

遇到停止条件只报实际状态；不自行改边、不强释放、不伪造验证。

## 平台与优先级

- PowerShell 含 `" & | \` 的参数用单引号，长文走 `--stdin` / `--notes-stdin`；先设 `$OutputEncoding = New-Object System.Text.UTF8Encoding($false)`。
- 仓库文本一律 UTF-8 无 BOM；写入后跑 `node scripts/check-bom.mjs`。
- 用户当轮明确指令 > 技能条款 > 默认行为。偏离技能须在回报里写明。
