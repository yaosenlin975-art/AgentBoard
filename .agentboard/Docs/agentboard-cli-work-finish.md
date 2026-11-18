---
id: 1030adae-b45d-4ed2-b5e3-75b4badafc18
slug: agentboard-cli-work-finish
title: "CLI 聚合工作包与短收尾入口"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: board
category: solved
landed: landed
sources:
  - source_id: "file:packages/cli/src/commands/work.ts"
    source_type: file
    locator: packages/cli/src/commands/work.ts
    captured_at: 1794972961063
    content_hash: 3c383021a7d319203740ca98a3901b2172445a80be98fd9f064f5f6cd7564e0c
evidence:
  - source_id: "file:packages/cli/src/commands/work.ts"
    locator: packages/cli/src/commands/work.ts
content_hash: 6540b2260effc9f9e8f60358c497a844e754815781124aa0831f4b504b71b7d0
expires_at: null
created_at: 1794972961227
updated_at: 1794972961227
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# CLI 聚合工作包与短收尾入口

## 结论

`kb work` 复用原子 `claim`，再读取卡面与依赖，返回适合执行的工作包；`kb finish` 直接复用 `done` 的 close-record 路径，不建立第二套收尾逻辑。

## 契约

- `work` 只在 claim 成功后输出 `进行中`，claim 冲突、依赖、决策锁沿用原退出码。
- `work --json` 输出单个 JSON 文档，包含 issue、description、blockers、blocked。
- `finish` 默认等价 `done --close-record`。
- `finish --no-changelog` 等价 `done --no-changelog`。
- `--json` 的既有 `claim/show/done` 字段保持兼容。
- 不新增 REST、状态机或数据库迁移。

## 验证

- `pnpm --filter @agentboard/cli test`：41 个测试文件，552 条用例通过。
- `pnpm --filter @agentboard/cli build`：通过。
- `kb work --help`、`kb finish --help`：可执行。

复算：`pnpm --config.verify-deps-before-run=false --filter @agentboard/cli test`
