# 空白使用者试用记录 · 第 5 轮（2026-11-10）

## 0. 方法与环境

- 身份：对 AgentBoard 一无所知的空白使用者，只读 `README.md`、`Docs/api.md`、`skills/*/SKILL.md` 与 `kb <cmd> --help`，**不读 `src/`，也不读 `apps/*/test/`**。
- 基线：`f52b0df [14a5d708]` 之前的 R5-01~R5-04 收尾版本（三包重建后）。
  开工前：`pnpm --filter @agentboard/server --filter @agentboard/cli --filter @agentboard/mcp build`（三包均 Done）。
- 临时实例（不碰线上 8787）：
  - `node apps\server\dist\index.js`，环境 `APPDATA=D:\WorkSpaces\任务看板\.trial-r5\appdata`、
    `AGENTBOARD_DB=D:\WorkSpaces\任务看板\.trial-r5\db\agentboard.db`、`AGENTBOARD_PORT=18984`。
  - `GET /api/version` 回读 `db_path` 与上述一致；临时工作区 `b9783abe-68fc-49cf-af1c-d3442a1f58db`（名 `R5工作区`，
    路径 `D:\WorkSpaces\任务看板\.trial-r5\work`）。
- 独立 git 仓库做脏工作树：`.trial-r5\work` 单独 `git init`，提交 `init base`（`3b6d7d9`）后故意留脏：
  `tracked.txt`（已修改）+ `unrelated-a.txt` / `unrelated-b.txt`（未跟踪）。真实仓库未做提交类操作。
- CLI：`node packages\cli\dist\index.js --server http://127.0.0.1:18984 …`，`KB_AGENT=blank-r5`。
- MCP：stdio 客户端 `.trial-r5/scratch/mcp-call.mjs`（initialize 2024-11-05 → notifications/initialized → tools/call），
  环境 `AGENTBOARD_BASE_URL=http://127.0.0.1:18984`、`AGENTBOARD_WORKSPACE_ID=<临时工作区>`、`AGENTBOARD_AGENT_ID=blank-r5`。
- 试用卡全部建在临时库里，随实例丢弃；实例已停止。

---

## 1. 结论摘要

| 项目 | 条数 | 明细 |
| --- | --- | --- |
| 本轮 8 组操作 | 8 | 通过 6、需要绕路 1、只是别扭 1（另发现 3 条同类别扭） |
| 本轮新发现 | 5 | T5-01（绕路） / T5-02~T5-05（只是别扭） |
| 挡住任务的项 | 0 | 8 组操作全部可完成；T5-01 只是错误码与文档不一致，行为本身正确 |
| 修复状态 | 5/5 | 全部已修并现场复验（见 §4） |

一句话：R5-01~R5-04 的修复全部生效（board-only 无多余 stderr、门禁满足后不催日志、changelog 归属可见、
MCP 互斥真正拒绝、自占用文案不再甩锅）；本轮只剩错误码/文案/文档级不一致，已随 R5-05 一并收口。

---

## 2. 逐组结果

### 2.1 纯看板收尾（文本模式）：**通过**

```
kb create-issue … 'R5-G1 纯看板收尾取证' → b2033dda-51ea-4d19-a0da-c7376219ea5e
kb claim b2033dda…
kb changelog create --workspace <ws> --issue b2033dda… … → a1e00e7a… 归属:b2033dda…（exit 0）
kb done b2033dda… --board-only
→ 已完成 / 状态: 待验收（占用已释放）；stderr 为空；提示只讲知识页，未催变更日志
```

### 2.2 互斥参数（CLI）：**通过**

```
kb done <卡> --board-only --scope tracked.txt → exit 1
--board-only 与 --scope / --all 不能同时使用：纯看板任务不提交任何文件
kb show → status=进行中，claimed_by=blank-r5（未被改动）
```

### 2.3 `--no-changelog` 收尾：**通过**

```
kb done <卡> --no-changelog --board-only → exit 0，状态待验收，stderr 为空，提示未催日志
```

### 2.4 changelog 归属：**通过（CLI）/ 补充发现 T5-05（MCP）**

```
changelog create --issue 00000000-0000-4000-8000-000000000000 → exit 1
  issue_id … 不存在或不属于本工作区；请先用 kb show <id> 确认任务 id，或省略 --issue 写无归属日志。
changelog list/show → 归属:b2033dda-51ea-4d19-a0da-c7376219ea5e
changelog show --json → "issue_id": "b2033dda-…"
```

MCP `create_changelog` 的成功响应里没有 `issue_id`（T5-05）。

### 2.5 MCP complete_task 互斥：**行为通过，错误码不一致（T5-01）**

```
complete_task {task_id, board_only:true, scope:["tracked.txt"]} →
  isError=true, code=INVALID_ARGUMENT；卡仍进行中、tracked.txt 仍为 M、HEAD 未变
complete_task {task_id, board_only:true} → ok:true, status=待验收, git_commit=skipped/BOARD_ONLY
```

行为正确（拒绝、不提交、不改状态），但 `Docs/api.md:1122` 写的是 `BOARD_ONLY_SCOPE_CONFLICT`。

### 2.6 MCP add_dependency 自占用：**通过**

```
add_dependency {task_id: A（本人占用）, blocker_task_id: B} →
  code=ISSUE_CLAIMED
  "The task is claimed by you (blank-r5); finish it with complete_task / fail_task, or release_task, before adding a blocker."
```

### 2.7 slug 建议：**值合理，规则未文档化（T5-03）**

```
无标签、标题「命令行输出太啰嗦」→ knowledge_hint.suggested_slug = agentboard-cli-ux
其余无关键词的卡 → agentboard-pitfalls
```

`knowledge_hint` / `suggested_slug` 及映射规则在 `Docs/api.md` 与 8 份技能中均无说明。

### 2.8 文档一致性抽查：**通过（含两处文案问题 T5-02 / T5-04）**

- 纯看板收尾：`exit 0`、`stderr` 空、`git_commit.status=skipped/reason=BOARD_ONLY`、无提交 —— 与文档一致。
- 门禁缺失：`kb done <卡> --board-only` → exit 1，三条出口齐全，状态不变。
- `--close-record` 一步式：exit 0，`收尾记录: changelog=0e3e2bff…`。
- `changelog_id`：MCP 传已有日志 → ok，日志条数 5→5（未新建）——与 `Docs/api.md:1122`「引用已有日志」一致。
- 问题：门禁运行时提示把 `changelog_id` 挂在 ② `--close-record` 下（T5-02）；技能速查示例缺 `--workspace`（T5-04）。

---

## 3. 本轮新发现

| 编号 | 级别 | 位置 | 现象 | 期望 |
| --- | --- | --- | --- | --- |
| T5-01 | 绕路 | MCP `complete_task` ↔ `Docs/api.md:1122` | 互斥返回 `INVALID_ARGUMENT`，文档写 `BOARD_ONLY_SCOPE_CONFLICT` | 统一错误码 |
| T5-02 | 只是别扭 | CLI done 门禁 400 文案 | ② 把「MCP 传 `changelog_id`」与 `--close-record` 并列，暗示等价 | 拆成 ② 新建 / ③ 引用已有 |
| T5-03 | 只是别扭 | `knowledge_hint` / `suggested_slug` | 字段与 slug 映射规则未文档化 | `Docs/api.md` 补字段与映射表 |
| T5-04 | 只是别扭 | `using-agentboard` / `executing-task` 示例 | `changelog create --issue` 示例缺 `--workspace`，cwd 不在该工作区时 exit 1 | 示例补 `--workspace` |
| T5-05 | 只是别扭 | MCP `create_changelog` / `list_changelog` | `summarizeEntry` 丢弃 `issue_id`，CLI/JSON 有 | MCP 回显 `issue_id`（无归属为 `null`） |

---

## 4. 修复与现场复验（R5-05）

| 编号 | 修复 | 复验证据 |
| --- | --- | --- |
| T5-01 | MCP 前置校验改抛 `BOARD_ONLY_SCOPE_CONFLICT` | 重建后实测 `complete_task {board_only,scope}` → `isError=true, code=BOARD_ONLY_SCOPE_CONFLICT`，卡仍进行中 |
| T5-02 | 门禁文案拆为 ①②③④，明确 ③ 是引用已有日志 | 实测 stderr：`② …（一步式：CLI 先新建…）；③ MCP complete_task 传 changelog_id 引用一条已有日志（不是新建，区别于 ②）` |
| T5-03 | `Docs/api.md` done 段补 `knowledge_hint` 字段与映射表 | 文档已更新；映射与实测 `命令行→agentboard-cli-ux`、其余→`agentboard-pitfalls` 一致 |
| T5-04 | 两处技能示例 + 门禁 ① 文案补 `--workspace <当前工作区>` | 实测门禁 ① 已带 `--workspace`；技能示例已同步 |
| T5-05 | `summarizeEntry` 回显 `issue_id` | 实测 `create_changelog` → `data.entry.issue_id=<卡 id>` |

测试与门禁：MCP `changelog.test.ts` + `tasks.test.ts` 全绿；服务端 `gitOnDone.test.ts` 全绿；
`node scripts/check-bom.mjs` → `OK（扫描 8298 个文本文件，新增 BOM 0 个）`。

---

## 5. 收敛结论：已知不修 + 理由

以下为**明确不修**项，不再开第 6 轮：

| 项 | 理由 |
| --- | --- |
| `kb changelog create --issue` 不按卡 id 反推工作区（cwd 不在该工作区时必须显式 `--workspace`） | 工作区解析以 cwd 为准是全局约束（跨工作区写入必须显式授权）；按卡反推会引入第二个解析源，可能把日志写进调用者并不在的工作区。现已在技能示例与门禁文案里补 `--workspace`，报错文案本身已给出明确指引。 |
| MCP `create_changelog` 的 `created_by` 取自 `AGENTBOARD_AGENT_ID`，与 CLI 的 `KB_AGENT` 不共享 | 两个入口各自读自己的环境变量是既有设计；同一 agent 在 CLI/MCP 混用时应把两个变量设为同一值，属使用约定，不是缺陷。 |
| 模板/主题 slug 的完整映射仍可能随新领域扩展而调整 | 当前规则（标签优先 + 标题/描述关键词兜底）已文档化在 `Docs/api.md`；新增领域词只改常量表，不需要改调用方，留待真实需求出现时再扩。 |

第 5 轮之后：**挡住项 0、绕路项 0、只是别扭项 0**（全部已修或列入上表）。本轮为收敛轮。
