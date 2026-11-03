# AgentBoard 四份技能文档实测缺陷报告（2026-11-03）

试点范围：按 `using-agentboard` / `writing-task` / `executing-task` / `handoff` 四份 SKILL.md 原文各走一遍真实流程，动作全部落在沙盒工作区 `skill-trial`（id `4218b1f0-71ce-4c4c-9a7d-f76f2dda59e1`，`D:\tools\tmp\skilltrial-ws`），未污染「任务看板」工作区的真实卡。

## 环境与基线

| 项 | 实测值 |
| --- | --- |
| kb CLI | `0.1.0`；PATH 上是 `C:\Users\31633\AppData\Roaming\npm\kb.cmd` 的 node shim |
| 服务 | `http://127.0.0.1:8787` 200；测试页 `http://127.0.0.1:5174` 200 |
| Shell | PowerShell `5.1.26100.9444`（无 `pwsh` 7） |
| 沙盒工作区 | `kb create-space skill-trial D:\tools\tmp\skilltrial-ws` → exit 0 |
| 执行场景 | 玩具项目 `toy-health`：A 实现 `GET /health`、B 补回归测试、C 写 README；B、C 用 `kb dep add` 挂在 A 后 |

场景落点证据（已跑通的判定为 ✅ 不计入缺陷表）：

- `kb create-space`、`kb create-issue`、`kb list-tasks --workspace`、`kb show`、`kb claim`、`kb comment --stdin`、`kb done --notes`、`kb fail --reason`、`kb dep add/ls/rm`、`kb list-tasks --status` 非法值报错、`kb knowledge list --status all --include-expired`、`kb knowledge show --scope`、`kb knowledge revise --expected-revision`（命中与 CAS 冲突两条分支）全部可用。
- `kb dep` 退出码与文档完全一致：自环 3（`不能依赖自身…`）、任务不存在 4（`任务或依赖不存在`）、成功 0。
- `kb dep ls <卡> --workspace <id>` → `error: unknown option '--workspace'`，exit 1，与 `using-agentboard` 第 101 行描述一致。
- `--stdin` 经 `cmd /c "kb comment <id> --stdin < file"` 提交多行中文正常，无乱码。

## 缺陷清单

| # | 场景 | 技能文档的原话（或摘要） | 我实际执行的命令 | 实际结果/报错 | 是否按文档能完成 | 严重度 | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | handoff | 第 6 步「If no exact-slug page exists, create one using that slug and a title/body containing the issue ID」；第 7 步「Use real source and evidence records required by the current CLI/API schema」——全文未定义 sources/evidence 的字段 | `kb knowledge create --scope workspace --workspace <ws> --slug handoff-<uuid> --title "…" --stdin < body.md`（不带 --sources/--evidence） | exit 1，stderr：`create 必须提供 --stdin、--sources 和 --evidence` | 否 | P0 阻断 | 改文档：正文给出 sources/evidence 的最小 JSON 示例与必填字段（`source_id`/`source_type` file\|url\|agent/`locator`/`captured_at` 毫秒/`content_hash` sha256/`evidence.source_id`+`locator`），并写明 `captured_at` 单位 |
| 2 | handoff | 第 7 步要求真实 source/evidence（即命令行传 JSON）；全族技能假定 `kb` 是普通可执行文件 | PS 5.1 下 `kb knowledge create … --sources '[{"source_id":…}]'`（变量传参、`cmd /c` 传参、`Get-Content -Raw \| kb` 三种写法） | 三种写法均 exit 1，`Expected property name or '}' in JSON at position 2`；根因：`kb.cmd` 是 shim + PS 5.1 原生参数引号剥除。最终只能用 `node dist/index.js` 直接 spawn argv 才成功（页面 `73c20696-b81c-4f5d-b870-d56d589e22df` rev1） | 否 | P0 阻断 | 改文档 + 改 CLI：文档补 Windows 下的可用写法（node spawn 或 `--sources @file.json`）；CLI 增加 `--sources-file <path>` / `--evidence-file <path>` 绕过 argv 转义 |
| 3 | executing-task | 第 4 条「If claim reports an occupied issue or exit code 2, stop and report the conflict to the parent」 | `kb claim af76bb1e-…`（该卡状态为「待验收」、占用者为空） | exit 2，stderr `已被占用` | 否（照文档会误报「他人占用冲突」） | P1 误导 | 改 CLI：状态不可领取时报具体原因（如「状态待验收不可领取」）；文档补这条文案分支 |
| 4 | using-agentboard | 「收尾与提交（GIT-ON-DONE）」：`kb done --scope` 按 GIT-ON-DONE 提交，「只提交声明范围内的路径」 | ① 沙盒（非 git 仓库）`kb done <id> --notes … --scope toy-health`；② git 仓库内 `kb done <本卡> --scope Docs/skill-trial-report-2026-11-03.md`（该仓库另有 26 处他人未提交改动） | ① exit 0，零 git 输出；`git rev-parse` 在沙盒 exit 128 `not a git repository` → 声明范围被静默忽略，无警告无回执。② 行为正确：`git log -1 --stat` = `ebe87c6 … 1 file changed, 80 insertions(+)`，只含声明路径 | 部分（git 仓库内成立；非 git 静默失效） | P1 误导 | 改 CLI：非 git 工作区或路径不匹配时打印「跳过提交：非 git 仓库 / 无匹配路径」；`done` 回执回显实际 scope 列表 |
| 5 | using-agentboard | 「任务四状态：待规划 → 进行中 → 待验收 → 已关闭」 | `kb status ls 4218b1f0-…`；`kb list-tasks --status 已完成` | 内置状态实为 5 个：待规划/进行中/待验收/已关闭/**已废弃**；`--status 已完成` exit 1 `未知状态：已完成（…可用状态：待规划 / 进行中 / 待验收 / 已关闭 / 已废弃）` | 否 | P1 误导 | 改文档：四状态改五状态，并补 `kb status ls/add/rm` 三个命令（当前速查表完全没收录自定义状态字典） |
| 6 | using-agentboard / writing-task | 「调用即绑定」：把 `<id> <name> <path>` 写进**本轮第一条** `kb comment` | writing-task 流程建了 3 张卡但按规定不 claim、不评论；实体卡评论只在 executing-task 阶段发出 | 该条款在 writing-task 场景无处落地；且未 claim 卡的 `kb comment` 返回 `未唤醒（任务未被占用，仅留言）` | 否 | P1 误导 | 改文档：把「首条评论」改为「首次看板写操作前在场的卡评论，或 written plan 首行」；`--scope` 之外给出无评论场景的替代落点 |
| 7 | using-agentboard | 开工前必读「区分事实与提议：`category=open` 或 `design` 且 `landed=proposed/partial` 的页不得当成已实现的事实」 | `kb knowledge create …` 成功后 `kb knowledge list --status all` 回读 | 返回 `"category": "legacy", "landed": null`；`knowledge create/revise` 无任何 category/landed 选项 | 否 | P1 误导 | 改文档或改 CLI：要么补 `--category` / `--landed` 参数，要么删掉这条不可执行的判据 |
| 8 | handoff | 第 6 步「If creation returns the slug uniqueness conflict (`KNOWLEDGE_EXISTS` / HTTP 409)」 | 同 slug 二次 `kb knowledge create` | exit 2，stderr 仅 `范围内已存在该 slug`，无 `KNOWLEDGE_EXISTS`、无 HTTP 码 | 部分（能看出冲突，但匹配不了文档给的判定串） | P1 误导 | 改文档：按实际中文文案+退出码 2 判定；或改 CLI 在 stderr 加错误码 |
| 9 | handoff / 全局 | 「中文/长文用 `--stdin`」「bash：`kb comment <id> --stdin <<'EOF'`」「BOM 纪律只谈仓库内文本文件」 | `Get-Content -Raw -Encoding UTF8 body.md \| kb knowledge revise <id> --stdin --expected-revision 1` | revise 成功 rev1→rev2，但页面正文首字符被写成 U+FEFF（回读 body 以 `# README` 开头），即 PS 5.1 管道在 stdin 注入了 BOM | 部分（写入成功但内容被污染） | P1 误导 | 改文档：`--stdin` 必须走 `cmd /c … < file` 或 node spawn，禁止 PS 5.1 管道；CLI 侧对 body 首字节 BOM 做剥离 |
| 10 | executing-task | 「Use only the commands and status transitions documented by the AgentBoard guide」+ `using-agentboard` 速查表只列 `done --notes … --scope` | `kb done <已 done 的卡> --notes … --scope toy-health,Docs`（逗号写法） | exit 2，stderr 同时打出 `警告：--scope 值含空格…请重复传参` 与 `未被占用`；主因是卡已非占用态，警告把注意力带偏 | 否（无法据退出码定位真因） | P1 误导 | 改 CLI：先判占用再判参数，错误按优先级只报主因；文档补 `done/fail/create-issue/delete-issue` 的退出码表（现在只有 claim/dep 有） |
| 11 | writing-task | 拆子任务判据「改动跨 ≥2 个包或端（`apps/web` + `apps/server`、`packages/*`、`apps/mcp`）」 | 对玩具项目 `toy-health`（单目录、无 packages）套用该判据 | 判据引用 AgentBoard 仓库专有目录，通用项目里「跨 ≥2 个包或端」无定义，无法判定 | 否 | P1 误导 | 改文档：判据抽象成「跨 ≥2 个可独立构建/发布的单元或端（前端/后端/CLI/插件等）」，专有目录仅作例子 |
| 12 | writing-task | 「计划开头固定一行 `工作区：<name>（<id>）<path>`…缺这行视为计划未完成」；同文又禁止把计划落成文件、禁止为记录计划而 claim | 按流程建 3 张卡时产生「计划」 | 四份技能都没规定计划载体（卡面？评论？父代理上下文？），子代理侧该行无处可写，只能写进首条评论或卡描述 | 否（可判定性缺失） | P1 误导 | 改文档：明确计划落在父卡描述首行或本轮首条评论，并说明子代理无父卡时的替代 |
| 13 | 全族 | 四份技能均未提 `delete-issue` / `move-issue` / `status` / 删工作区；清理只在「跨工作区」段落出现 | `kb delete-issue <id>`（无 --yes）；`kb delete-issue <占用中的卡> --yes`；`DELETE /api/workspaces/<id>` | 无 --yes → exit 1 + 确认提示；占用中 → exit 2 `占用中禁止删除`；工作区删除 → 409 且响应 body 为空，CLI 无对应命令 | 否（沙盒/试点清理无文档路径） | P1 误导 | 改文档：补一节「试点与清理」（delete-issue 两个退出码、占中先 fail 再删、工作区不可删的现状）；或改 CLI 增加 `kb delete-space` |
| 14 | using-agentboard | 「`-d` … 多行走 UI 或 API」（CLI help 原文）；writing-task 失败分支假设「`-d` 长文被引号/换行截断」 | `$d = @"…多行…"@; kb create-issue <ws> "<标题>" -d $d` | 多行 `-d` 实际完整写入（`kb show` 回读三行原文俱在）；带半角双引号的 `-d` 才会炸：exit 1 `unknown option '--test。…'` | 部分（不含双引号即可） | P2 体验 | 改 CLI help：删掉「多行走 UI 或 API」，改为「多行可用，但内容不得含半角双引号」；文档补这条引号禁忌 |
| 15 | using-agentboard | 「测试页与正式页（TEST-PAGE，强制）：界面验证一律走测试页 URL」 | 本轮 3 张卡均为后端/文档卡，无界面 | 条款只规定 UI 任务，对无界面卡无豁免说明 | 是（不适用），但条款缺分支 | P2 体验 | 改文档：加一句「无界面改动的卡不触发 TEST-PAGE，notes 写『无界面改动，未做界面验证』」 |
| 16 | using-agentboard | 「默认只查、只领、只写当前工作区」+「`kb dep` 无 `--workspace` 选项」 | `kb dep add/ls/rm` 对沙盒卡；cwd 在「任务看板」工作区内 | dep 无工作区过滤（设计如此），跨区建边只能靠人自觉；本轮 cwd 属「任务看板」而写入目标是 `skill-trial`，全部写入依赖当轮用户授权 | 部分 | P2 体验 | 改文档：给出「用户指定另一个工作区做试点」的标准话术（授权范围、越界声明写法），现在只能自行拼 |
| 17 | handoff | 「Determine the caller's agent identity from the runtime or explicit `KB_AGENT` setting. Do not assume the CLI default.」 | `kb --help`、`kb claim` | CLI 无 `whoami`/`status` 身份查询；身份只在 claim 输出 `（agent: kb-cli）` 和评论作者 `[agent:kb-cli]` 里出现 | 部分（claim 后才知道） | P2 体验 | 改 CLI：加 `kb whoami`；文档写明身份回显位置 |
| 18 | executing-task / using-agentboard | 「`kb comment` 写进展总结」 | 卡已由我 claim 后 `kb comment <id> --stdin < file` | 输出 `评论已写入: <id>` 紧跟 `未唤醒（任务未被占用，仅留言）`——与「占用者: kb-cli」矛盾 | 是（写入成功） | P2 体验 | 改 CLI 文案：改为「已留言，未唤醒会话」并区分「未占用」与「无活跃会话」 |
| 19 | using-agentboard | 「开工前必读：先看工作区知识 `kb knowledge list …`」 | `kb knowledge list --scope workspace --workspace <ws> --limit 20` | 非 TTY 下先打印一行噪声 ` [] rev:`，再输出 JSON（未传 `--json`），格式随是否重定向而变 | 是（人可读，脚本易错） | P2 体验 | 改 CLI：统一 `--json` 语义，去掉 `[] rev:` 调试行 |
| 20 | writing-task | 建卡命令写作 `-d "<目标/范围/边界/验收>"`、`--labels <标签>` | `kb create-issue <ws> "<标题>" -d "<多段文本>" -l "技能,文档,调研"` / `-l "技能 文档 调研"` | 均可用；`-l` 与 `--labels` 等价，逗号与空格都拆；但 `-d` 内半角双引号会 exit 1（见 #14） | 是 | P2 体验 | 改文档：把「`-d` 内不得含半角双引号，需引用请用「」」写成硬约束 |

## 结论一：技能文档与 CLI 不一致的条目（最有害）

1. **#1/#2 知识页写入契约**：文档要求 sources/evidence，却不给字段与 JSON 示例；Windows 下命令行根本无法直接传该 JSON。handoff 这条链按文档走到第 6 步必断。
2. **#3 claim 文案**：`待验收` 卡报 `已被占用`，直接触发 executing-task「报告占用冲突并停手」的规定，把「状态不可领」误判成「他人占用」。
3. **#4 GIT-ON-DONE**：文档只说「只提交声明范围内的路径」。git 仓库内实测成立（commit 只含 1 个声明路径，未卷入仓库里 26 处他人改动），但非 git 工作区静默 exit 0、无提示、无回执，你不知道它到底提交了没有。
4. **#5 状态数**：文档四状态 / CLI 五状态（多「已废弃」），且速查表没有 `kb status` 自定义状态字典。
5. **#7 category/landed**：文档把 `category=open`、`landed=proposed/partial` 当硬判据，CLI 无任何设置入口，新建页恒为 `legacy`/`null`。
6. **#8 slug 冲突判定串**：文档给的 `KNOWLEDGE_EXISTS`/409 在 CLI 输出中不存在，只有中文文案 + exit 2。
7. **#10 退出码覆盖**：文档只为 claim/dep 定义了退出码；`done`（占用 2 / 参数 2）、`delete-issue`（缺 --yes 1 / 占用 2）全部未定义。

## 结论二：文档缺失导致我卡住的步骤

- **知识页 sources/evidence 字段**（#1）：无 schema、无 `captured_at` 单位、无 `source_type` 取值表，只能反查 CLI 源码/MCP 定义。
- **Windows 下 JSON 参数写法**（#2）：文档的 PS 段只教 `Get-Content -Raw | kb comment --stdin`，对 `--sources` 完全无解；我最后靠 `node dist/index.js` + spawn argv 才写进去。
- **`--stdin` 的 BOM 纪律**（#9）：BOM 章节只覆盖仓库文件，没覆盖 stdin 正文，PS 5.1 管道污染了交接页正文。
- **计划载体**（#12）：四份技能禁止落盘、又要求「计划首行」，子代理侧没有合法落点。
- **试点/沙盒清理路径**（#13）：删卡两个退出码、占用先 `fail` 再删、工作区 409 不可删，全部无文档。

## 结论三：最该先改的 3 条

1. **#1 + #2 合并修**：在 `handoff` 补 sources/evidence 最小 JSON 示例 + 字段表，同时给 CLI 加 `--sources-file/--evidence-file`。这是唯一让人「完全做不到」的环节，且没有任何绕法能靠读文档推出来。
2. **#3 claim 状态门禁文案**：把「状态不可领取」和「已被占用」分成两条 stderr 文案与不同提示；否则 executing-task 的停手规则会被系统性误触发。
3. **#4 GIT-ON-DONE 失败可见化**：非 git、路径不匹配、scope 为空都要打一行明确跳过原因并回显实际 scope；让 `--scope` 的承诺可验证。

## 附：本轮动作留痕

- 沙盒工作区：`skill-trial`（`4218b1f0-71ce-4c4c-9a7d-f76f2dda59e1`）`D:\tools\tmp\skilltrial-ws`
- 试点卡（已全部删除，`kb list-tasks --workspace <ws>` 现返回「（无任务）」）：
  - `af76bb1e-6774-474a-98dc-f3eb679cf54c` 实现 GET /health 返回 JSON（done→待验收，notes 含工作区 id/路径/改动文件/跨区声明/验证结果）
  - `873902d3-e464-4acb-aab9-75067703cafe` 为 /health 补最小回归测试（被 `af76bb1e` 阻塞，claim exit 2 验证通过，后删除）
  - `bd932c43-d9ee-4d0a-b5f4-893179a31ec7` README 记录 /health 接口契约（交接试点：知识页 + 评论 + 交接待续 fail）
  - 探针卡：`NL-PROBE 8b4ee6e2-…`、`LABEL-PROBE d5f5f0b1-…`、`LABEL-PROBE2 288bfcd3-…`（均删除）
- 遗留：知识页 `73c20696-b81c-4f5d-b870-d56d589e22df`（slug `handoff-bd932c43-…`）已 archive（rev3）；沙盒工作区无法删除（`DELETE /api/workspaces/<id>` → 409 空 body，CLI 无命令），保留。
- 产品代码零改动；沙盒玩具项目留在 `D:\tools\tmp\skilltrial-ws\toy-health`（`package.json`、`server.js`）。
