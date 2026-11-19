---
id: 544d510b-af17-4990-98dd-4a13b5c8656b
slug: agentboard-cli-input-safety-and-build-gate
title: "CLI 输入安全与构建门禁"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: infra
category: solved
landed: landed
sources:
  - source_id: "file:packages/cli/src/commands/createIssue.ts"
    source_type: file
    locator: packages/cli/src/commands/createIssue.ts
    captured_at: 1794903140881
    content_hash: d425c7b4b298563dddbb6d19afbc081941fd7107f5a2616baa168df594a8411c
  - source_id: "file:packages/cli/src/render.ts"
    source_type: file
    locator: packages/cli/src/render.ts
    captured_at: 1794903140881
    content_hash: e190372bfdde6d7de327f833e355bb43efc9ba50c3e3d3e5edd86e1d57a1f23e
  - source_id: "file:scripts/verify/dist-syntax.mjs"
    source_type: file
    locator: scripts/verify/dist-syntax.mjs
    captured_at: 1794903140881
    content_hash: 959b80ef4d3764a8f749d222cf28ec242546a54266d7c9d0971642ef326e77b7
evidence:
  - source_id: "file:packages/cli/src/commands/createIssue.ts"
    locator: "packages/cli/src/commands/createIssue.ts:104-119"
  - source_id: "file:packages/cli/src/render.ts"
    locator: "packages/cli/src/render.ts:10-27"
  - source_id: "file:scripts/verify/dist-syntax.mjs"
    locator: "scripts/verify/dist-syntax.mjs:90-116"
  - source_id: "file:packages/cli/src/commands/createIssue.ts"
    locator: "cmd:kb create-issue AgentBoard 'a \"q\" title' -d x"
content_hash: 0b9dbbc52fd9f7b229ed17555739a681864d88c2a647bd9f3b06893f2a82f874
expires_at: null
created_at: 1794903157645
updated_at: 1794903157645
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# CLI 输入安全与构建门禁

## 通道决定防护：引号检查只对 argv 有效

`kb create-issue` 有两个标题通道，防护强度必须不同：

| 通道 | 是否经 PowerShell 分词 | 引号检查 |
| --- | --- | --- |
| `<title>` 位置参数 | 是（`"` `&` `|` `\` 会吞掉后续参数并静默 exit 0，CLI-01） | 保留：拒绝 `" ' “ ” ‘ ’` 与 `-` 开头 |
| `--title-stdin` | 否（管道进 stdin，字节原样到达） | 不检查，只留 200 字上限 |

判据是**「这个风险通道存在吗」**，不是「这个字符危险吗」。对 stdin 通道复用它，等于把报错文案指定的逃生口一起堵死：`assertIssueTitle(title)` 在 P3 之前不分通道，两条路径都拒引号，用户被指向一个同样失败的分支。

实现形状：`assertIssueTitle(title, channel: 'argv' | 'stdin')`，长度检查在两通道共有，引号与选项样式检查在 `channel === 'argv'` 之后提前 return。`create-issue` 调用处按 `args.titleStdin === true` 选通道。

`update --title` 走 argv 但历史上从未加引号检查（服务端 `schemas.ts` 只 trim + 1..200），现为「能写引号」的既定行为；改它属于另一张卡的取舍，不要因为读到这里就顺手统一。

## 正则字面量的语义 tsc 不校验

`/[\"'“”‘’]/u` 编译通过（TS 不校验正则语义），Node 加载模块时抛 `SyntaxError: Invalid regular expression: ... Invalid escape`——带 `u` 标志时字符类里的 `\'` 是非法转义（`\"` 合法）。CLI 入口 import 全部 command 模块，任一模块语法失败 = `kb` 全命令不可用，`kb --version` 也崩。

字符类里的 `'` 不需要转义，正确写法是 `/["'“”‘’]/u`。

2026-11-17 全仓阻断就是这么来的：src 改完、dist 编译通过、三个 agent 的 `kb` 同时失效。

## 构建门禁：node --check 才抓得住这类错误

`tsc` 放行、`node` 崩，中间缺一道 V8 解析。两道门禁（`scripts/verify/`）：

- `dist-syntax.mjs [目录…]`：逐文件 `node --check`，零依赖；`--all-dist` 扫全部 `packages/*/dist` 与 `apps/*/dist`。逐文件收集**所有**失败再统一退出，不只在第一个失败处停。
- `cli-modules-smoke.mjs`：真实 `import()` 每个编译产物，抓 `node --check` 抓不到的 import 期失败（ESM 解析、循环依赖、顶层副作用）。

判定：往 dist 塞一个含 `/[\"'“”‘’]/u` 的探针文件，`node --check` 直接 exit 1 并打印文件与源码行；`tsc` 对同一文件放行。这就是「只有门禁抓得到」的证据。

## 表格单元格必须单行化

标题可含换行（`--title-stdin` 管道喂多行），控制字符进表格会把一行切成两行、列宽算错。`render.ts` 的 `singleLine()` 把 `\u0000-\u001f\u007f` 折叠成一个空格，`table()` 与 `issueLines()`、`show`、`create-issue` 回执共用。

`table()` 是全部表格唯一出口（list-tasks / dep ls / list-spaces / next / status / accounts），改这里即全覆盖；不要在各命令里另做转义。

## 验证套路

- 通道行为：`'a "q" title' | kb create-issue <ws> --title-stdin -d '…'` 必须 exit 0，且 `kb show <id> --json` 的 `title` 含原样引号；`kb create-issue <ws> 'a "q" title' -d '…'` 必须 exit 1 且文案里的命令可照抄成功。
- 表格完整性：换行标题建卡后 `kb list-tasks --all-status` 命中该卡的行数必须为 1（不是 2）。
- 产物可加载性：`pnpm --filter @agentboard/cli build` 后跑 `scripts/verify/dist-syntax.mjs` 与 `cli-modules-smoke.mjs`，两者 exit 0 才算编译产物可用。

