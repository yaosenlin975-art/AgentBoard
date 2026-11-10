# 任务清单 · kb 三边同步与报错修正

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）
每项执行前按 RULE-1 建卡并 claim；本文件只描述顺序与验收，卡号为执行时的权威来源。

## [x] T1 · 文档口径回填（依赖：无）
- 改动：`skills/using-agentboard/SKILL.md`、`skills/executing-task/SKILL.md`、`skills/ask-user/SKILL.md`、`README.md`、`Docs/api.md`
- 内容：spec §2 的 A3/A4/A5/A6/A7/A10/A11/A12；A1/A2 按 T2 实际行为描述
- 验收：
  - `kb --help` 退出码表与 `Docs/api.md` L644 表一致（3 含待决策族，4 仅 dep 边不存在）
  - `grep -n "description-stdin" skills` 不再出现 `create-issue … --description-stdin`
  - `grep -n "kb decision" skills` 均带 `show`
  - `node scripts/check-bom.mjs` exit 0
- 未随本批：`Docs/api.md`（A3/A4/A5/A11 的落点）由在飞卡 9dd37e2a 持有，已建卡 cee20cb8 并以 `blocks` 边排队，待其关闭后执行。

## [x] T2 · CLI 实现与报错修正（依赖：无；与 T1 并行时 T1 以 T2 最终行为为准）
- 改动：`packages/cli/src/commands/{listTasks,decision,dep,close,createSpace}.ts`、`packages/cli/src/index.ts`、`packages/cli/test/*`
- 内容：A1、A2、B1、B4、B5、B6、B7、B8、B10、EXIT_CODE_HELP
- 验收：spec §4 批 2 的 5 条命令探针 + `pnpm --filter @agentboard/cli test`
- 完成前证据：每条探针记录「命令 / exit / 首行文案」

## [x] T3 · 服务端 claim/release 文案（依赖：T2 完成后复测更顺，但可独立）
- 改动：`apps/server/src/services/claim.ts`、对应测试
- 内容：B2、B3
- 验收：`kb release <未占用>` → `未被占用，无需释放…`；`kb claim <已关闭>` → 含 `kb reopen`；两者 exit 2；`pnpm --filter @agentboard/server test`

## [x] T4 · 打包同源核对与终检（依赖：T1、T2、T3）
- 改动：默认零改动；若清单需变，同步 `AGENTS.md`、`scripts/package-portable.mjs`、`scripts/portable/verify-rules.mjs`、`scripts/portable/README.txt`
- 验收：
  - `node scripts/check-bom.mjs`
  - `node apps/mcp/scripts/list-tools.mjs` 主名 42（未动 MCP）
  - 便携包规则自检通过（`pnpm package:portable --no-zip` 或包内 `verify-rules.mjs`）
  - `git status` 无本卡清单外的文件被 stage

## 完成定义
- 四批全部 done，spec §2/§3 每条均有「已修/已改文档」的实测证据；
- 终检命令全绿；提交信息含完整卡号。
