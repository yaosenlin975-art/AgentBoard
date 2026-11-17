---
id: 9cb6a157-b9b9-488a-8a04-a5688a3617a1
slug: cli-ref-resolution-and-epipe
title: "CLI 引用解析与输出健壮性口径"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: infra
category: design
landed: landed
sources:
  - source_id: "file:packages/cli/src/io.ts"
    source_type: file
    locator: packages/cli/src/io.ts
    captured_at: 1794913024912
    content_hash: d508e7f380ef10de561f778fd914d3cc0ae24752bb3bf2dcc07978cff9c206b7
  - source_id: "file:packages/cli/src/commands/knowledge.ts"
    source_type: file
    locator: packages/cli/src/commands/knowledge.ts
    captured_at: 1794913024912
    content_hash: 3de3c6ce2afa7bc148c36ff196297ceac5efc8d6fb26fd01127a8379863ab7d6
  - source_id: "file:packages/cli/src/commands/changelog.ts"
    source_type: file
    locator: packages/cli/src/commands/changelog.ts
    captured_at: 1794913024912
    content_hash: 670aed38eba81b757ae9f6f5d448e6deaa9d5b82b2432c15ddc183c2eb5252ee
  - source_id: "file:packages/cli/src/workspace.ts"
    source_type: file
    locator: packages/cli/src/workspace.ts
    captured_at: 1794913024912
    content_hash: 5dbcc68a1a5ec1ed0162412b385878d919e9628cea2558393b00442f489f66d5
evidence:
  - source_id: "file:packages/cli/src/commands/knowledge.ts"
    locator: "packages/cli/src/commands/knowledge.ts:455-500"
  - source_id: "file:packages/cli/src/io.ts"
    locator: "packages/cli/src/io.ts:72-130"
  - source_id: "file:packages/cli/src/commands/changelog.ts"
    locator: "cmd:kb changelog delete 2ae38cc3 --expected-revision 1"
  - source_id: "file:packages/cli/src/workspace.ts"
    locator: "cmd:cmd /c kb list-spaces pipe node exit0"
content_hash: e8a611c0c37b67100e2e20b476ade2ab098f500321d18f53bbbd5f105c228c5f
expires_at: null
created_at: 1794913025097
updated_at: 1794913025097
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# CLI 引用解析与输出健壮性口径

## 为什么统一成一套

P5 之前 `kb knowledge` 一族对「id 前缀」有三套行为：`show` / `resolve` 认，`action` 认（文档没写），`revise` / `rename` 不认（直接 404「知识页不存在」）。同一个字符串在不同子命令下结论不同，用户只能靠背。`changelog` 一族更彻底：只认完整 36 位 UUID。加上 `show` 在**显式给 `--scope`** 时同样不认前缀（这一点原报告也没发现），共四处口径分裂。

## 解析口径（唯一）

引用（`<page-id>` / `<changelog-id>`）合法形态三种：完整 UUID、≥8 位纯十六进制前缀、slug（仅知识页）。

- **前缀**：先解析成完整 id 再发请求。解析失败分两种文案，不能混：
  - 位数不足 → 「请给 ≥8 位（当前 N 位）唯一前缀或完整 UUID」
  - 位数够但零命中 → 「该前缀没有任何命中（页可能已改名/删除，用 kb knowledge list 核对）」
  - 多命中 → **exit 2** 并列候选，不发任何写请求
- **slug 未命中**：保留「知识页不存在」原文案——那句是准确的，改成「无法解析」反而更模糊。
- **完整 UUID + 显式 `--scope`**：不发 resolve（省一次往返），保持旧路径。
- `--scope` 省略时一律走 `/api/knowledge/resolve`（`scope=both`），显式给出时只有「看起来像前缀」的引用才 resolve。

`changelog` 没有服务端 resolve 端点，用 `GET /changelog?limit=100` 拉一页本地前缀过滤；这是有意的取舍——变更日志是低频对象，不为它加端点。前缀 ≥8 位是硬门槛（`MIN_CHANGELOG_PREFIX = 8`，与 `MIN_ISSUE_PREFIX` / `KNOWLEDGE_SHORT_ID_LEN` 对齐）。

## 输出健壮性：EPIPE 就是正常结束

`kb … | head -3`、`kb … | node -e "process.exit(0)"`：下游整体退出后，上游任何写 stdout 都会拿 EPIPE。这是**异步 `'error'` 事件**，不是 `write()` 的同步 throw，所以两件事都要做：在 `process.stdout/stderr` 上挂一次性 `'error'` 监听（只吞 EPIPE，其它写错误照抛），写入再包 try/catch 兜同步抛出。捕获后标记 broken，之后所有写入变 no-op，进程以 0 退出。

修前实测 `kb list-spaces | node -e "process.exit(0)"` 会打 EPIPE 栈 + `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，看起来像 CLI 崩了。修后同样的管道：exit 0、零输出、零栈。

推论要写进使用纪律：**这类被截断的管道，退出码不承载业务结果**。要判成败就落盘再读，或改用 `--json` 自己截。

## 两条校验的可预测性

`--status 待验收`：判定是「有 `-d` 且描述非空」，**不查关键词**，`--allow-empty` 不豁免。行为本轮没变（校验本来就在 `skipFaceCheck` 之前跑），变的是文案——旧文案说「必须同时填写验收标准」，让人以为在查「验收」二字，于是写了别的正文却被拒、或写了「验收标准：」空骨架却通过。

`create-issue` 位置参数：第 1 个位置参数命中工作区时建到那个工作区（OPT-02 既定行为，不改）。缺陷是**匹配时完全静默**、不匹配时反而有提示，用户看不出发生了什么。现在命中时也打一行 stderr，报事实（解析成哪个工作区 + 怎么把它当标题）。要在当前工作区建「标题等于某工作区名」的卡，用 `--workspace <当前工作区>` 显式指定，标题就落回第 1 个位置参数。
