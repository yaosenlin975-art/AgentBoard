# kb 三边同步与报错修正 · Spec（2026-11-10 实测）

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）D:\WorkSpaces\任务看板

## 1. 实测快照（只读，全部为本轮现场结果）

| 对象 | 实测结果 |
| --- | --- |
| `kb --version` | `0.1.0`（CLI 包版本，`packages/cli/src/version.ts` 读 package.json） |
| `kb --help` 顶层命令 | 34 个：list-spaces / create-space / delete-space / create-issue / list-tasks / next / stats / grep / show / claim / release / comment / accept / done / close / reopen / update / move-issue / delete-issue / fail / knowledge / changelog / dep / status / accounts / autostart / shortcut / workspace-db / ask / decisions / decision / answer / ask-extend / stop-check |
| 每个子命令 `--help` | 34/34 可读，退出码 0 |
| MCP `list-tools` | 主名 42、alias 42、`tools/list` 84 条（`apps/mcp/scripts/list-tools.mjs`，走真实 initialize） |
| 技能文件 | `skills/` 8 份：using-agentboard / writing-task / executing-task / handoff / swing-dev / ask-user / brainstorming / kb-curator |
| 打包同源清单 | `package-portable.mjs`、`verify-rules.mjs` 的 `REQUIRED_SKILLS` 均为 8 项，与 AGENTS.md 一致 |

结论：能力面（CLI 34 命令 / MCP 42 主名 / 8 技能）本身齐平，问题集中在**文档口径过期**与**报错文案误导**，不是功能缺失。

## 2. A 类：文档 ↔ 实现差异（12 条）

| # | 位置 | 文档写的 | 实测 | 裁决 |
| --- | --- | --- | --- | --- |
| A1 | `skills/using-agentboard/SKILL.md` L113 | `kb move-issue --clear-root` | `--clear-root` 是 unknown option（exit 1）；实现只认 `--root`（`move-issue --help`） | **改实现**：move-issue 增加 `--clear-root` 作为 `--root` 同义别名（与 `kb update --clear-root` 对齐），`--root` 保留 |
| A2 | using-agentboard L15/L137；`skills/ask-user/SKILL.md` L67/L77/L104 | `kb decision <id>` | 实测 `unknown command 'abcdef12'`（exit 1）；实现需 `kb decision show <id>` | **改实现**：`kb decision <id>` 缺省等价 `decision show <id>`；文档同时写明 `show|withdraw` 子命令 |
| A3 | `kb --help` 末尾退出码表；`Docs/api.md` L644 退出码表 | 3 = `kb dep` 专用 | 实测 `kb ask --grace 700` → 3；`kb ask-extend <不存在>` → 3 | **改文档/help**：3 覆盖 `kb dep` + 待决策族（ask/answer/ask-extend）；using-agentboard 已写对 |
| A4 | using-agentboard L14；`Docs/api.md` L652 | `dep add` 传不存在 id → exit 4 | 实测 exit 1；`dep.ts` 注释明确 4 只给「依赖边不存在」，任务不存在走通用 1（CLI-02 有意口径） | **改文档**：任务不存在 = 1，4 仅 dep 边不存在 |
| A5 | `Docs/api.md` L652 | 文案「任务或依赖不存在」 | 实现「任务不存在或不属于该工作区」 | **改文档**（批 2 再补 ref 与下一步，见 B4） |
| A6 | using-agentboard 速查 L106 | 未记默认收敛与 `--all-status` | `kb list-tasks` 缺省只列「未完成且无主」，全量需 `--all-status` | **补文档** |
| A7 | using-agentboard 速查 | 未记 `kb next` / `kb stats` / `kb update --due-time --clear-due` | 三者在 `--help` 中真实存在 | **补文档** |
| A8 | `README.md` L215 | `kb create-issue <workspace> <title>` | `-d` 必填，照抄 exit 1「描述不能为空」 | **改 README**：加 `-d '<描述>'` |
| A9 | `README.md` L221 | `done` 在非 git 工作区「状态仍转、exit 1」 | 非 git 只警告 exit 0；exit 1 专指「已生效但自动提交未完成」（NO_BASELINE/COMMIT_FAILED/ZERO_HIT） | **改 README** |
| A10 | `skills/executing-task/SKILL.md` L79 | 标题含双引号可用 `--description-stdin` | `create-issue` 无此选项（实测 unknown option，exit 1） | **改文档**：只保留 `--title-stdin`，长描述先建卡再 `kb update --description-stdin` |
| A11 | using-agentboard「写知识页」 | `kb knowledge list` 的 `--scope` 必填未标注 | `kb knowledge list` 缺 `--scope` → exit 1「required option」 | **补文档**（同时纳入 B6 中文化） |
| A12 | `README.md` CLI 段 | 未列 `kb accept` / `kb next` / `kb stats` | 三者可用 | **补 README**（少量行） |

## 3. B 类：误导性报错（11 条，含当前文案 / 新文案 / 触发方式）

| # | 触发方式 | 当前文案（实测） | 新文案 |
| --- | --- | --- | --- |
| B1 | `kb list-tasks --workspace zzzz` | 先打 `默认已收敛为未完成无主卡，全量用 --all-status`，**之后**才报「工作空间不存在…」 | 收敛提示只在工作区解析成功、即将输出列表时写 stderr；出错时不输出该行（改 `listTasks.ts`） |
| B2 | `kb release <未占用卡>` | `只有当前占用者可执行此操作`（暗示别人占用） | `未被占用，无需释放（当前状态=待规划）；如需推进请先 kb claim` |
| B3 | `kb claim <已关闭卡>` | `状态不可领取（当前=已关闭…）；无人占用，待验收卡由 owner 验收或由父代理退回待规划` | 按状态分支：待验收→原文案；已关闭/已废弃→`已关闭/已废弃的卡不能领取，请先 kb reopen <id>` |
| B4 | `kb dep ls <不存在>` / `dep add <不存在> <x>` | `任务不存在或不属于该工作区`（不说是哪个 ref、无下一步） | `任务不存在或不属于当前工作区：<ref>（用 kb list-tasks --all-status 查 id；跨区要显式授权）` |
| B5 | `kb ask-extend <不存在决策>` | exit **3** + `决策不存在：…`（文档写 1） | exit **1** + `决策不存在：<ref>（用 kb decisions 查看）` |
| B6 | `kb fail <id>`（缺 --reason）；`kb dep ls`；`kb changelog create`（缺 --title）；`kb knowledge list`（缺 --scope）；`kb show --nope`；`kb nosuchcmd` | commander 英文：`required option '--reason <text>' not specified` / `missing required argument` / `unknown option` / `unknown command`（exit 1） | 统一中文并给下一步：`缺少必填参数 --reason <text>，示例：kb fail <id> --reason "卡点"` / `缺少必填参数 <issue-id>` / `未知选项 --nope；用 kb show --help 查看可用选项` / `未知命令 nosuchcmd；用 kb --help 查看命令列表` |
| B7 | `kb close <待规划卡>` | `只有「待验收」的任务可以关闭（当前：待规划）`（无下一步） | 追加 `；请先 kb done <id> 提交验收` |
| B8 | `kb create-space probe D:\no-such-dir-xyz` | `路径不存在或不是目录: …`（半角冒号，无下一步） | `路径不存在或不是目录：…；先创建目录再重试`（全角统一） |
| B9 | `kb knowledge create`（缺必填） | `create 缺少必填项（逐项补齐后重跑）：` + 列表；英文子命令名混中文 | `知识页缺少必填项（逐项补齐后重跑）：…`，列表首项固定 `--domain` |
| B10 | `kb update <id> --status 乱值` | `status 必须是本工作区已定义的状态（可用：…）` | `状态必须是本工作区已定义的状态（可用：…）` |
| B11 | `kb decision <id>` | `unknown command '<id>'`（与 A2 同根，B6 中文化后仍不可用） | 由 A2 的实现修复消除；文档同步写 `decision show` |

严重度：高 B1/B2/B3/B5/B6；中 B4/B7/B11；低 B8/B9/B10。

## 4. 执行批次（每批一卡，提交带卡号）

### 批 1 · 文档口径回填（不改实现）
文件：`skills/using-agentboard/SKILL.md`、`skills/executing-task/SKILL.md`、`skills/ask-user/SKILL.md`、`README.md`、`Docs/api.md`
内容：A3/A4/A5/A6/A7/A10/A11/A12；A1/A2 按批 2 落地后的实际行为写（`--clear-root` 可用、`decision show` 与默认写法并存）。
验收：`grep -n "clear-root\|decision show\|--all-status" skills Docs README.md` 逐条命中且与 `kb --help` 一致；`node scripts/check-bom.mjs` 通过。

### 批 2 · CLI 实现与报错
文件：`packages/cli/src/commands/listTasks.ts`、`packages/cli/src/commands/decision.ts`、`packages/cli/src/commands/dep.ts`、`packages/cli/src/commands/close.ts`、`packages/cli/src/commands/createSpace.ts`、`packages/cli/src/index.ts`（+对应 `packages/cli/test/*.test.ts`）
内容：A1（`--clear-root` 别名）、A2（decision 默认 show）、B1、B4、B5、B6、B7、B8、B10、EXIT_CODE_HELP 退出码 3 更正。
实现要点：
- move-issue：`--root` 与 `--clear-root` 同义，互斥校验合并；`--help` 同时展示两者。
- decision：顶层命令保留子命令 `show|withdraw`，无子命令且首参可解析为 id/前缀时走 show；无法解析时输出中文未知命令提示（B6）。
- commander 错误：`main()` 已 `exitOverride()`，在捕获 CommanderError 处按 `err.code` 映射中文（`commander.unknownOption` / `unknownCommand` / `missingArgument` / `optionMissingArgument`），未命中类型保留原文。
- ask-extend：服务端 404 → 退出 1（仅参数/前缀非法保留 3）。
验收：
```
kb move-issue <测试卡> --clear-root        # exit 0，根任务
kb decision ffffffff                       # exit 1，中文「决策不存在」
kb list-tasks --workspace zzzz             # 只有一行错误，无收敛提示
kb fail <id>                               # 中文缺参提示，exit 1
kb show <id> --nope                        # 中文未知选项 + 下一步
kb ask-extend ffffffff                     # exit 1
pnpm --filter @agentboard/cli test
```

### 批 3 · 服务端文案（claim / release）
文件：`apps/server/src/services/claim.ts`（+对应单测）
内容：B2（release 未占用专用文案）、B3（claim 状态分支）。只改文案与分支，不改状态机与退出码（均 409 → CLI 2）。
验收：CLI 复测 `kb release <未占用>`、`kb claim <已关闭>`；`pnpm --filter @agentboard/server test`。

### 批 4 · 打包同源与终检
文件：`AGENTS.md`、`scripts/package-portable.mjs`、`scripts/portable/verify-rules.mjs`、`scripts/portable/README.txt`（仅当技能数量/清单变化才改；本轮仍是 8 份，预期零改动，只做核对记录）
验收：`node scripts/check-bom.mjs`；`node scripts/list-tools.mjs` 主名仍 42（本轮不动 MCP）；`pnpm package:portable --no-zip` 或包内 `verify-rules.mjs` 通过。

## 5. 明确不做
- 不改 MCP 工具集与协议（42 主名已覆盖 CLI 全部能力，对照表 `Docs/api.md` L1087-1114 实测完整）。
- 不重构错误码体系；A4 维持实现口径（1），只改文档。
- 不动他人的未提交改动：`packages/cli`、`skills`、`Docs`、`AGENTS.md`、`scripts`、`README.md`、`apps/mcp` 当前 `git status` 干净。

## 6. 风险
- B6 中文化依赖 commander 错误码稳定；未识别类型回退英文原文并附 `kb <cmd> --help` 提示，不吞错。
- A1/A2 属行为兼容扩展（新增别名/默认子命令），不破坏既有写法；单测覆盖旧写法仍可用。
- 批 2 触碰 `index.ts` 与多个命令文件，必须 `git status` 确认只 stage 本卡文件。
