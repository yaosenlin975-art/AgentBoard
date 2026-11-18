# Agent 使用流程与上下文成本优化设计
- status: approved
- date: 2026-11-18
- card: -
- supersedes: -

## 1. 需求与目标

用户目标：降低 AgentBoard 使用过程中的上下文消耗，同时减少 agent 完成任务所需的命令往返。

目标：

- 技能启动只加载高频流程、硬门禁和最小命令，详细口径按需读取。
- CLI / MCP 的默认结果适合 agent 决策，完整机器数据显式获取。
- 用两个窄聚合入口减少「读卡、领卡、准备收尾、写记录、done」的往返。
- 建立可复现的 token / 字节预算检查，防止后续文档和 schema 反弹。
- 保留现有 REST 契约、claim fence、幂等、变更日志门禁、设计页门禁和 Git 提交口径。

非目标：

- 不移除 `agentboard_*` 旧别名；其去留归既有卡 `f78d7465`。
- 不新增服务端业务事务、数据表、迁移或第二套状态机。
- 不增加远程 MCP transport、常驻压缩代理或第三方运行时依赖。
- 不改变 REST 直调兼容性；精简默认仅作用于 CLI / MCP agent 出口。

反目标：

- 为省 token 隐藏领卡失败、未提交、门禁拒绝或未验证状态。
- 把业务路径、完整正文或整段历史默认塞进 JSON。
- 让技能拆分后硬门禁只存在于难以发现的参考文件。
- 用新聚合命令绕过 `kb done --scope` 提交或 `--manual git commit`。

## 2. 实测基线

环境：`D:\Workspaces\AgentBoard`，2026-11-18；MCP 走真实 stdio `initialize + tools/list`，token 用 `tiktoken cl100k_base`。

| 对象 | 实测 |
|---|---|
| MCP `tools/list` | 84 条；主名 42、旧别名 42 |
| MCP 原始 JSON | 119,783 bytes |
| MCP 工具元数据 token | 3,869 |
| MCP 主名 token | 1,892 |
| MCP 旧别名额 token | 1,978 |
| 8 份 `SKILL.md` | 61,844 chars；48,844 tokens |
| `using-agentboard` | 37,409 chars；24,111 tokens |
| `executing-task` | 12,074 chars；7,111 tokens |
| `brainstorming` | 16,942 chars；5,417 tokens |
| `swing-dev` | 11,471 chars；8,321 tokens |

基线复算：

```powershell
node apps/mcp/scripts/list-tools.mjs --json
python -c "import json,tiktoken; d=json.load(open('.logs/mcp-tools-list.json',encoding='utf-8')); e=tiktoken.get_encoding('cl100k_base'); print(len(e.encode(json.dumps(d['tools'],ensure_ascii=False))))"
```

## 3. 方案比较与选型

| 方案 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| A. 只压缩输出和 schema | 保留技能结构，缩短描述与默认返回 | 改动小；技能启动成本基本不变 | 不单独采用 |
| B. 渐进披露 + 精简默认 + 体积门禁 | 技能入口短化，细则按需读取；CLI/MCP 默认精简；CI 防反弹 | 收益最大；需维护路由与兼容测试 | **采用** |
| C. B + 工作流聚合入口 | 增加 `kb work` / `kb finish`，MCP 对应 `start_task` / `finish_task` | 再减往返；增加少量接口面 | **采用** |
| D. 通用 MCP 压缩代理 | 由代理重写 schema 或动态发现工具 | 可减小元数据，但增加常驻进程、协议兼容与故障面 | 否决 |

### 开源选型

`github-commercial-scout` 当前未安装，本轮用 GitHub API 和项目 README 核验。

| 候选 | 版本 / 许可证 | 匹配与成本 | 结论 |
|---|---|---|---|
| `yashdhingra0/mcp-token-lint` | v0.2.0；MIT；Python 3.10+ | 可测量 `tools/list` token 并设预算；新增 Python 工具链 | 只作测量参考，不移植 |
| `fernforge/mcp-tokenlint` | v0.1.1；MIT；TypeScript | 可离线打分和建议；无稳定 npm 发布 | 只作设计参考，不依赖 |
| `Nithinfgs/mcpweigh` | 无版本标签；MIT；Node 18+ | 零依赖、可 CI；成熟度和发布状态较弱 | 不采用 |
| `freehul/progressive-skill` | v3.2.1；MIT；Python | 渐进披露与预算控制思路可借鉴；绑定 Hermes 且已停止维护 | 不移植 |

结论：使用仓库内 Node 脚本做确定性字符 / 字节预算，不引入第三方依赖。本轮不复制候选仓库代码或资源，因此不涉及保留其 LICENSE / NOTICE。

## 4. 技能渐进披露

### 4.1 入口文件

每个 `SKILL.md` 只保留：

- 何时使用 / 不使用；
- 启动绑定、停止条件和硬门禁；
- 高频命令的最小可执行形态；
- 参考文件路由表；
- 失败时该停、该重试或该转哪个技能。

以下内容移出入口：

- 完整命令参数表、历史实测、源码锚点、重复故障分支；
- 长篇故障解释、平台细节、提交原因码全表；
- 知识页字段样例、变更日志参数大全、交接产物完整模板。

### 4.2 参考文件

按技能目录增加 `references/`，保持一个主题一个文件：

```text
skills/using-agentboard/
  SKILL.md
  references/commands.md
  references/workspace-and-git.md
  references/knowledge-and-changelog.md
  references/troubleshooting.md

skills/executing-task/
  SKILL.md
  references/parallel-dispatch.md
  references/finish-checklist.md

skills/brainstorming/
  SKILL.md
  references/design-and-git.md

skills/handoff/
  SKILL.md
  references/handoff-records.md

skills/swing-dev/
  SKILL.md
  references/worker-loop.md
```

参考文件只在对应分支明确出现时读取。入口路由必须写清触发条件与路径；不得要求 agent 每次把整个目录读完。

### 4.3 单一事实源

- 工作区边界、claim/done 硬门禁、Git 提交口径只保留一个权威位置；其他技能引用，不复制全文。
- 相同命令示例只在命令参考中出现一次；入口只给高频形态。
- `AGENTS.md` 的硬规矩继续保留；技能引用它，不回贴完整规则。
- 设计、知识卡、变更日志、交接各自只保留一份内容口径。

### 4.4 目标

首版目标不是固定 token 数，而是可验证的下降：

- `using-agentboard/SKILL.md` 相对基线下降 ≥ 60%；
- 高频组合 `using-agentboard + executing-task` 下降 ≥ 50%；
- 每份入口 `SKILL.md` 不超过 12,000 chars；
- 任一参考文件不超过 20,000 chars；
- 入口中不出现完整的身份前缀规则、全量退出码表、全部命令参数或历史实测段落。

## 5. CLI 精简输出

### 5.1 默认与完整模式

| 命令 | 默认 agent 输出 | 完整输出 |
|---|---|---|
| `kb show` | 卡面核心字段、最近评论摘要、描述窗口 | `--full` 或 `--json` 保持兼容数据 |
| `kb claim` | 领取结果 + fence + 工作区 + 有界卡面 | `--full` 保留现有详情与知识片段 |
| `kb done` | 状态、释放结果、提交状态、失败原因 | `--json` 保持现有对象 |
| `kb list-tasks` | 现有短字段继续裁剪正文 | `--full` 不变 |

`--json` 是脚本契约：已有字段不退化为文本摘要。若精简 JSON，必须新增显式 `--brief`；不得让既有脚本默认少字段。

### 5.2 文本输出

- 单条命令尽量只打结论、状态和下一步。
- 重复工作区 id、help、复算命令只在排障或用户请求时输出。
- `KB_METRICS=1` 继续记录 stdout 字节与行数，作为回归指标。
- 输出顺序稳定，成功与错误均保留退出码语义。

## 6. MCP 精简

### 6.1 工具描述

- 每个工具描述以「何时使用 + 返回什么」为主，不复制参数说明。
- 参数必填、范围、默认值放字段 description，避免工具级与字段级重复。
- 共享 `request_id`、`workspace_id`、`fence` 文案收敛为常量，只解释一次。
- 删除不会改变调用的历史背景和长句；错误恢复说明只保留会导致错误操作的必要条件。

### 6.2 默认返回

新增 `compact` 策略用于 agent 高频读：

- 任务列表只返回 id、标题、状态、优先级、占用、父卡、阻塞数。
- 任务详情默认返回核心字段和有界描述；评论与依赖按需调用。
- 写操作回执只返回 id、status、claimed_by、fence、commit 状态、门禁结果。
- 所有截断都返回可续读字段，不静默丢正文。

兼容规则：

- 旧工具名和旧输入字段保留。
- 默认 structuredContent 可减少可选字段，但必须保留既有必选语义字段。
- 完整数据走 `detail=true` 或现有专用读取工具。

## 7. 聚合工作流

### 7.1 `kb work <issue-id>`

一次完成：

1. 解析任务与工作区；
2. 检查状态、占用、决策锁和依赖的只读前置；
3. 调用现有原子 claim；
4. 保存 claim fence；
5. 返回紧凑工作包。

参数：

```text
kb work <issue-id> [--workspace <id|名>] [--comments <n|all>] [--no-knowledge] [--request-id <uuid>] [--full]
```

默认工作包：

```json
{
  "issue": {
    "id": "<uuid>",
    "title": "...",
    "status": "进行中",
    "priority": "高",
    "labels": [],
    "parent_issue_id": null
  },
  "workspace": { "id": "<uuid>", "name": "...", "path": "..." },
  "description": "...",
  "description_truncated": false,
  "next_description_offset_chars": null,
  "blockers": [],
  "claim_fence": 12,
  "comments": [],
  "knowledge": []
}
```

约束：

- 只有 claim 成功才返回 `status=进行中`。
- claim 冲突、依赖、决策锁继续按原错误码与退出码返回。
- 工作包不自动执行命令、不读取业务文件、不改任务描述。
- `--full` 回退为现有 `claim` 详情语义。

### 7.2 `kb finish <issue-id>`

`finish` 是现有 `done --close-record` 的短入口，不新增业务能力：

```text
kb finish <issue-id> --notes-file <path> --title <changelog-title> --type 新增|修复|调整
  [--knowledge-page <id>] [--scope <path>]... [--close] [--no-changelog] [--board-only]
  [--request-id <uuid>]
```

行为：

- 默认等价 `done --close-record`；
- `--no-changelog` 时等价普通 `done --no-changelog`；
- 参数校验、知识页存在性、changelog 创建、done、自动提交和门禁全部复用现有实现；
- 子步骤失败仍不执行 done；
- 输出只给结果、提交状态、记录 id 与下一步。

不增加：

- 自动创建知识页；
- 自动生成变更日志标题或正文；
- 自动选择提交范围；
- 批量 finish。

### 7.3 MCP 工具

新增两个工具：

| 工具 | 作用 |
|---|---|
| `start_task` | 调用 `kb work` 同一组合路径，返回紧凑工作包 |
| `finish_task` | 调用 `kb finish` 同一路径，完成 changelog + done |

旧 `claim_task`、`complete_task`、`create_changelog` 保留。新工具不成为唯一入口，不复制服务端逻辑。

## 8. 接口与实现边界

- CLI 聚合在 `packages/cli/src/commands/` 新增窄编排模块，复用现有 API client 与 claim fence 存储。
- MCP 聚合调用同一 REST 序列；不直连数据库。
- 不为聚合新增 REST 事务。若未来需要原子 changelog+done，单独做服务端设计。
- `start_task` 的 claim 仍是唯一原子写；其他读取失败不能伪装成 claim 成功。
- `finish_task` 的幂等键沿用 done 的 `request_id`；changelog 派生键沿用现有规则。

## 9. 预算门禁

新增 `scripts/check-agent-context.mjs`：

- 通过 stdio 读取真实 `tools/list`；
- 统计原始 JSON bytes、主名工具数、完整工具 token / char 代理值；
- 统计 8 个 `SKILL.md` 与参考文件字符数；
- 校验入口和参考文件上限；
- 输出稳定 JSON，失败退出 1；
- 默认不引入 tokenizer 依赖；以 UTF-8 bytes 与 chars 作为确定性代理，另允许测试环境中用已有 `tiktoken` 做人工复核。

建议门禁：

```text
SKILL entry <= 12,000 chars
reference <= 20,000 chars
using-agentboard entry reduction >= 60%
using + executing reduction >= 50%
MCP tools/list JSON <= 140,000 bytes
```

基线用 checked-in 数据文件记录；门禁比较当前值与基线，不依赖机器 tokenizer。

## 10. 打包与兼容

- 便携包继续携带 8 个技能目录，并复制其 `references/`。
- `REQUIRED_SKILLS` 数量和名称不变。
- manifest 自动覆盖新增参考文件。
- 自检除 `SKILL.md` 外，校验入口路由引用的参考文件存在。
- `AGENTS.md`、`scripts/package-portable.mjs`、`scripts/portable/verify-rules.mjs`、`scripts/portable/README.txt` 只在技能数量或打包约束变化时同步修改；新增参考文件不改变 8 技能清单。

## 11. 验收

1. 技能：
   - 8 个入口均可读，路由引用文件全部存在；
   - `using-agentboard` 入口下降 ≥60%，高频组合下降 ≥50%；
   - 抽查「领卡、done、决策、交接、知识页」每个流程的硬门禁仍能在入口或一跳参考中找到。
2. CLI：
   - `kb work` 成功领取并输出 fence；冲突、依赖、决策锁的退出码与原 `claim` 一致；
   - `kb finish` 默认写 changelog 后 done；`--no-changelog` 不写日志；
   - 失败时 done 不执行，自动提交与 fence 语义不变；
   - `--json` 与 `KB_METRICS=1` 可复算。
3. MCP：
   - `start_task` / `finish_task` 出现在真实 `tools/list`；
   - 成功、冲突、门禁拒绝、截断续读均有结构化结果；
   - 旧工具名继续可调用。
4. 预算：
   - `node scripts/check-agent-context.mjs` 通过；
   - 人为超限时退出 1 并报告具体文件 / 指标。
5. 打包：
   - `pnpm package:portable --no-zip` 通过；
   - 包内参考文件齐全，manifest 与自检通过。

## 12. 风险与回滚

- 技能拆分可能让低频规则难发现：入口保留明确触发词与一跳路由，并用 grep 验收交叉引用。
- 默认精简可能破坏依赖可选字段的脚本：`--json` 默认保持兼容，精简文本与新增 `--brief` 分离。
- 聚合入口可能被误当成自动完成实现：名称与帮助限定为 claim 工作包 / changelog + done，不执行代码。
- 新增两个 MCP 工具会略增 schema：仅新增窄 schema，同时压缩现有重复描述；预算门禁比较总成本。
- 回滚 CLI / MCP 聚合只需移除新命令与工具注册，不影响现有 claim/done。
- 回滚技能结构需恢复原入口文件；参考文件可作为独立文档保留，不参与加载。

## 13. 留给实现者的决定

- `--brief` 的具体字段白名单，以现有调用点和测试为准确认。
- `kb work` 评论摘要条数与描述默认窗口；默认沿用现有 5 条、12,000 chars。
- 参考文件是否按技能拆 2–4 个主题文件；不得合并成新的单篇大文档。
- 预算基线的精确字段与阈值微调，但不能取消下降目标。
