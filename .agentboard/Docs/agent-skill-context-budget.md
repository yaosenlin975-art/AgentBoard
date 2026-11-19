---
id: 2939e0f9-21cf-447c-a029-5fed2dacc4f0
slug: agent-skill-context-budget
title: "AgentBoard 技能入口与上下文预算门禁"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: knowledge
category: solved
landed: landed
sources:
  - source_id: "file:scripts/check-agent-context.mjs"
    source_type: file
    locator: scripts/check-agent-context.mjs
    captured_at: 1794972324622
    content_hash: 7dbdd00c9b4c013cfe6959cfe7c1ac503400388fccf9a3f337be0ee5a3b984a2
evidence:
  - source_id: "file:scripts/check-agent-context.mjs"
    locator: scripts/check-agent-context.mjs
content_hash: 9e28712ad090ba304976fd39cb23156179759e8a7e2cacaf24fc3391aef5b5e1
expires_at: null
created_at: 1794972324775
updated_at: 1794972324775
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# AgentBoard 技能入口与上下文预算门禁

## 结论

技能启动成本按入口文件控制。高频 gates 和最小命令留在 `SKILL.md`，完整参数、Git、知识页与故障细节放同目录 `references/`，入口只给一跳路由。

## 已落地口径

- 8 个技能入口都必须 <= 12,000 chars，任一 reference <= 20,000 chars。
- `using-agentboard` 相对 37,409 chars 基线下降 >= 60%；`using-agentboard + executing-task` 合计下降 >= 50%。
- `scripts/check-agent-context.mjs` 启动真实 MCP stdio，读取 tools/list，并检查 JSON <= 140,000 bytes。
- 跨技能参考用 `../<skill>/references/<file>.md`；校验器以 SKILL.md 所在目录解析相对路径。
- `--self-test` 同时覆盖超限入口识别和跨技能引用解析。
- `scripts/portable/verify-rules.mjs` 复制后再次校验 SKILL.md 中引用的 references 是否存在。

## 当前结果

- 8 个入口合计 47,434 chars，原基线 105,328 chars。
- `using-agentboard` 4,015 chars。
- `using-agentboard + executing-task` 6,394 chars，原基线 49,483 chars。
- MCP tools/list 119,781 bytes，未进入本卡压缩。

复算：`node scripts/check-agent-context.mjs`
