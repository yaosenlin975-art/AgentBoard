---
id: f6bc096a-9014-40ab-bdd5-92b64815345b
slug: mcp-compact-workflow
title: "MCP 聚合工作包与紧凑回执"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: board
category: solved
landed: landed
sources:
  - source_id: "file:apps/mcp/src/tools/tasks.ts"
    source_type: file
    locator: apps/mcp/src/tools/tasks.ts
    captured_at: 1794975161239
    content_hash: 8c55c1c3859a8fb0700c3e45416b97a90e190952e60106e93d5531fda97d6a1c
  - source_id: "file:apps/mcp/test/tasks.test.ts"
    source_type: file
    locator: apps/mcp/test/tasks.test.ts
    captured_at: 1794975161239
    content_hash: 1af2626c67fbcb34fb41b505f0edaa7256d1cbb3dc4dba9267649d46e6e9754d
evidence:
  - source_id: "file:apps/mcp/src/tools/tasks.ts"
    locator: "apps/mcp/src/tools/tasks.ts:387-540"
  - source_id: "file:apps/mcp/test/tasks.test.ts"
    locator: "apps/mcp/test/tasks.test.ts:400-622"
content_hash: a5b9ec8bf3664dab40550597ccc969d1e7dc0b3198991ad4e82548861ed67927
expires_at: null
created_at: 1794975161469
updated_at: 1794975161469
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# MCP 聚合工作包与紧凑回执

## 结论

MCP 高频入口用 `start_task` / `finish_task` 减少读卡与收尾往返；底层仍复用 claim、changelog、done 的既有 REST 契约，不增加服务端事务。

## 已落地契约

- `start_task` 先原子 claim。冲突、依赖、决策锁沿用原 REST 安全码并以 `isError` 返回；claim 成功后的读取失败不回滚占用。
- 工作包含紧凑任务字段、12,000 字描述窗口、依赖视图、claim fence 与有限条数最近评论。
- `finish_task` 默认先写带本卡 `issue_id` 的 changelog，再调用 done；changelog 幂等键由 done 的 `request_id` 稳定派生。
- changelog 正文取 `changelog_body`，缺省取 `notes`；两者 trim 后为空时写“本轮无用户可见变更”，避免服务端 `body_md` 非空校验失败。
- `no_changelog=true` 跳过日志并映射 `changelog_ack=true`；`board_only` 与 `scope` 互斥。
- 任务列表返回紧凑投影并省略正文；任务树额外保留 `child_count`、`descendant_count`、`descendants_closed_count`。
- 写回执只保留下一步所需字段；非任务实体回执（删除、验收）保留自身结果形状。评论正文窗口保持 12,000 字和续读偏移。

## 约束

- 旧 `claim_task`、`complete_task`、`create_changelog` 与 `agentboard_*` 别名保留。
- 使用 `finish_task` 时不要再先写 changelog；使用 `complete_task` 才需要单独创建日志。
- MCP 元数据预算由 `node scripts/check-agent-context.mjs` 检查。
