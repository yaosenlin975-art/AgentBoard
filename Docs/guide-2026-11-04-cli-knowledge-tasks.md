# AgentBoard 当前工作区 CLI 与知识/任务操作指引

- 日期：2026-11-04
- 适用：在工作区「任务看板」（`e41eb0fb-c367-43cf-a99d-6dc5239a5694`，`D:\WorkSpaces\任务看板`）内用 `kb` 操作知识与任务的人或 agent
- 性质：可执行指引。命令按 2026-11-04 实测的 CLI help 与真实运行结果编写
- 关联：`skills/using-agentboard/SKILL.md`（技能条款）→ 本文档（命令细节）；CLI 演进链见 `1cb07910`

## 0. 先确认「你在哪个工作区」

```bash
kb list-spaces --current          # 只列 cwd 解析到的当前工作区（已落地）
kb list-tasks                     # 不带 --workspace 时按 cwd 解析（已落地）
kb list-tasks --all               # 跨工作区只读盘点（不得据此 claim/done/fail）
```

实测（2026-11-04）：

```
$ kb list-spaces --current
id                                    name  path
e41eb0fb-c367-43cf-a99d-6dc5239a5694  任务看板  D:\WorkSpaces\任务看板

$ kb list-tasks          # 直接输出本工作区任务表，无需 --workspace
id                                    状态   优先级  labels       占用者  评论  parent_issue_id  标题
4908a07e-…                            已关闭  中    缺陷,server   -       4    -               删除 issue 时级联清理关联会话与消息
```

## 1. 现状边界：哪些「能直接用」，哪些「还要显式传参」

| 能力 | 现状 | 说明 |
| --- | --- | --- |
| `kb list-tasks` / `kb list-spaces` | **已按 cwd 解析** | 不带 `--workspace` 即当前工作区；跨区用 `--all`（只读） |
| `kb knowledge list/show/search/create/revise/action` | **仍必须显式传参** | `--scope workspace --workspace <id>` 两个都要 |
| `kb changelog list/create/show` | **仍必须显式传参** | `--workspace <id|名>` 必填 |
| 知识页 `--category` / `--landed` | **只能走 REST** | CLI 无这两个参数（见 §5 待落地） |

实测报错（说明 B 阶段尚未落地）：

```
$ kb knowledge list
error: required option '--scope <scope>' not specified

$ kb changelog list
error: required option '--workspace <id|名>' not specified
```

## 2. 知识页：建 → 回读 → 修订 → 归档（真跑过）

```bash
WS=e41eb0fb-c367-43cf-a99d-6dc5239a5694

# ① 建页：正文走 --stdin，sources/evidence 走 --sources-file/--evidence-file（避开 Windows 引号地狱）
kb knowledge create --scope workspace --workspace "$WS" \
  --title "CLI 知识任务指引自测页" --slug guide-selftest-20261104 \
  --sources-file sources.json --evidence-file evidence.json \
  --stdin < body.md

# ② 回读（确认 page id 与 revision）
kb knowledge show <page-id> --scope workspace --workspace "$WS"

# ③ 修订（CAS：必须带 --expected-revision）
kb knowledge revise <page-id> --scope workspace --workspace "$WS" \
  --expected-revision 1 --stdin < body-v2.md

# ④ 归档（action: archive | restore | delete）
kb knowledge action <page-id> archive --scope workspace --workspace "$WS"
```

**字段形态（`--sources-file` 内容，已实测可跑）**：

```json
[
  {
    "source_id": "file:Docs/guide-2026-11-04-cli-knowledge-tasks.md",
    "source_type": "file",
    "locator": "Docs/guide-2026-11-04-cli-knowledge-tasks.md",
    "captured_at": 1793766000000,
    "content_hash": "<sha256 of the file bytes>"
  }
]
```

`evidence` 同理，`source_id` 必须指向同一次写入的某个 `sources` 项。

> 为什么优先 `--sources-file`：`--sources` 要传一整段 JSON 字符串，PowerShell 会把双引号吃掉或把 `\` 当转义，实际几乎不可用。

## 3. 变更日志：写与读（真跑过 list，create 格式已实测）

```bash
WS=e41eb0fb-c367-43cf-a99d-6dc5239a5694

# 写：正文用 --stdin，类型只能是 新增|修复|调整（历史 仅供导入）
kb changelog create --workspace "$WS" --title "某次改动" --type 调整 --stdin < changelog.md

# 读：按发生时间倒序，支持类型/字面搜索过滤
kb changelog list --workspace "$WS" --limit 20
kb changelog list --workspace "$WS" --type 调整 --query 技能
kb changelog show <changelog-id> --workspace "$WS"
```

实测 `kb changelog list --workspace <id> --limit 3` 返回按时间倒序的条目（含 `[类型] 时间 rev:N by:agent` 头行 + 正文）。

## 4. 任务：建卡 → 领取 → 评论 → 完成 → 关闭 → 删除（真跑过）

```bash
WS=e41eb0fb-c367-43cf-a99d-6dc5239a5694

# ① 建卡（-l 会按 [,，\s]+ 拆分并去重；≤4 个领域词）
kb create-issue "$WS" "[SELFTEST] 指引示例卡" -p 低 -l 测试,文档

# ② 看卡 + 查依赖（claim 前必做：状态不是「待规划」会被拒）
kb show <issue-id>
kb dep ls <issue-id>

# ③ 领取（退出码 2 = 已被占用 或 状态不允许）
kb claim <issue-id>

# ④ 评论（长文/中文用 --stdin）
kb comment <issue-id> --stdin < comment.md

# ⑤ 完成（→ 待验收，释放占用；--scope 必须逐条传）
kb done <issue-id> --notes "说明" --scope Docs --scope skills

# ⑥ 关闭（待验收 → 已关闭）
kb close <issue-id>

# ⑦ 重开（已关闭/已废弃 → 指定状态）
kb reopen <issue-id> --to 待规划

# ⑧ 改字段（不含状态）
kb update <issue-id> --title "新标题" --priority 中 --labels web,server

# ⑨ 删除（不可逆；占用中或含子任务会被拒；必须 --yes）
kb delete-issue <issue-id> --yes
```

## 5. 待落地（CLI 演进链 `1cb07910`）

| 阶段 | 内容 | 现状 | 影响本文档的哪一节 |
| --- | --- | --- | --- |
| A | 统一 cwd 解析（`list-spaces --current`、`list-tasks` 缺省按 cwd、`--all` 只读） | **已落地**（实测通过） | §0 |
| B | 知识与日志复用当前工作区（`knowledge`/`changelog` 不再强制 `--workspace`） | **未落地** | §1、§2、§3 —— 当前仍必须显式 `--scope workspace --workspace <id>` / `--workspace <id>` |
| C | 知识页 `--category` / `--landed` CLI 参数 | **未落地** | §1 末行；当前只能走 REST：`POST /api/knowledge/pages`、`PATCH /api/knowledge/pages/:id` |

B/C 落地后，本文档 §2、§3 里的 `--workspace`/`--scope` 可省略；在那之前**不要省略**，否则 CLI 直接报 `required option` 错误。

## 6. 常见坑（实测）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `error: required option '--scope <scope>' not specified` | B 未落地 | 补 `--scope workspace --workspace <id>` |
| `error: required option '--workspace <id|名>' not specified` | B 未落地 | 补 `--workspace <id>` |
| `kb claim` 返回「已被占用」（退出码 2） | 可能不是被占用，而是**状态不是待规划** | 先 `kb show <id>` 看 `status` |
| `kb done` 报 `未被占用` | done 只能对自己 claim 的卡 | 先 `kb claim` |
| `--scope a,b` 被 PowerShell 拆坏 | 逗号串被拆/合并 | 逐条传：`--scope a --scope b`（CLI 会打 SCOPE-GUARD 警告） |
| 知识页 slug 冲突 | 同 scope 下 slug 唯一 | 改走 `kb knowledge revise`，不新建重复页 |

## 7. 相关

- 技能条款：`skills/using-agentboard/SKILL.md`（工作区边界、开工前必读、收尾与提交）
- 接口细节：`Docs/api.md`
- 标签治理：`Docs/governance-2026-11-04-labeling.md`

---

## 8. 实测输出与必踩坑（2026-11-04 真跑记录）

以下命令均在 `D:\WorkSpaces\任务看板`（工作区 `e41eb0fb-c367-43cf-a99d-6dc5239a5694`）真实执行过。

### 8.1 知识页全链路（create → show → revise → archive）

```
$ kb knowledge create --scope workspace --workspace <ws> \
    --title "CLI knowledge selftest page" --slug guide-selftest-20261104 \
    --sources-file g-src.json --evidence-file g-ev.json --stdin < body.md
d37befc0-bdac-41b3-b0e2-b87d39f77678 [workspace] rev:1 CLI knowledge selftest page

$ kb knowledge show d37befc0-… --scope workspace --workspace <ws>
d37befc0-… [workspace] rev:1 CLI knowledge selftest page

$ kb knowledge revise d37befc0-… --scope workspace --workspace <ws> \
    --expected-revision 1 --stdin < body-v2.md
d37befc0-… [workspace] rev:2 CLI knowledge selftest page

$ kb knowledge action d37befc0-… archive --scope workspace --workspace <ws> --expected-revision 2
d37befc0-… [workspace] rev:3 CLI knowledge selftest page
```

### 8.2 变更日志读取

```
$ kb changelog list --workspace <ws> --limit 3
34d66803-… [新增] 2026-11-04 11:31:43 rev:1 账号管理：删除账号改为两步确认
a57d3577-… [调整] 2026-11-04 11:02:46 rev:1 swing-dev 技能经 darwin-skill 三轮配对评审优化
85a7eda6-… [调整] 2026-11-04 10:47:43 rev:1 账号管理页改为六行总览（ACC-PANEL-03）
下一页：--offset 3
```

### 8.3 任务全生命周期（create → claim → comment → done → close → delete）

```
$ kb create-issue <ws> "[SELFTEST] 指引示例卡" -p 低 -l 测试,文档
已创建任务: 0ae9aad0-4f0f-4e5a-8d9a-e6260a6306b5 [SELFTEST] 指引示例卡
状态: 待规划

$ kb claim 0ae9aad0-…
领取成功（agent: board-doc-ops）

$ kb comment 0ae9aad0-… --stdin < cmt.md
评论已写入: 56b94b76-…

$ kb done 0ae9aad0-… --notes "Selftest done" --scope Docs
已完成: 0ae9aad0-…  状态: 待验收（占用已释放）

$ kb close 0ae9aad0-…
已关闭: 0ae9aad0-…  状态: 已关闭

$ kb delete-issue 0ae9aad0-… --yes
已删除任务: 0ae9aad0-…（不可恢复）

$ kb show 0ae9aad0-…
任务不存在
```

### 8.4 必踩坑（按踩到顺序）

| # | 坑 | 报错原文 | 处理 |
| --- | --- | --- | --- |
| 1 | `knowledge action` 缺 CAS | `error: required option '--expected-revision <n>' not specified` | 补 `--expected-revision <当前 revision>` |
| 2 | `--sources-file` 的 JSON 里用反斜杠路径 | `--sources 不是合法 JSON：Bad escaped character in JSON at position 34` | JSON 内路径用正斜杠（`Docs/guide-x.md`）或双反斜杠 |
| 3 | PowerShell 传 `--sources-file` 时被 shim 误解析 | 同上（被当成 `--sources` 的值） | 用 `node <cli dist>/index.js …` 直调，或 cmd 上下文调用 |
| 4 | 中文正文经 PowerShell 管道传给 `--stdin` 变乱码 | 正文首字符/整段变成 `?` | 用 `cmd /c "chcp 65001>nul & kb … --stdin < file.md"`（文件为 UTF-8 无 BOM） |
| 5 | `kb knowledge list` / `kb changelog list` 省略 `--workspace` | `required option '--scope <scope>'` / `required option '--workspace <id|名>'` | B 阶段未落地，必须显式传（见 §5） |

### 8.5 关于 `1cb07910` 三阶段的实测对照

| 阶段 | 声明 | 实测 |
| --- | --- | --- |
| A | `list-spaces --current`、`list-tasks` 缺省按 cwd、`--all` 只读 | **已落地**：`kb list-spaces --current` 返回本工作区；`kb list-tasks` 不带 `--workspace` 直接输出本工作区任务 |
| B | knowledge/changelog 复用当前工作区 | **未落地**：两条命令仍报 `required option` |
| C | 知识页 `--category`/`--landed` | **未落地**：`kb knowledge create --help` 无这两个参数；只能走 REST |
