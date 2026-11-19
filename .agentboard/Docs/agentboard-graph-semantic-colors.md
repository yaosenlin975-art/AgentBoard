---
id: ff242c3c-5195-4fbe-af9b-b288e054533b
slug: agentboard-graph-semantic-colors
title: "星图语义色键集与测试耦合"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: solved
landed: landed
sources:
  - source_id: "file:apps/web/src/test/graphVisualFormulas.test.ts"
    source_type: file
    locator: apps/web/src/test/graphVisualFormulas.test.ts
    captured_at: 1794908304088
    content_hash: 2579a163585e1f474dfd4ccc7f97e27a1cad59be13b3ffe5af4bcc98076712ba
  - source_id: "file:apps/web/src/lib/graphVisualFormulas.ts"
    source_type: file
    locator: apps/web/src/lib/graphVisualFormulas.ts
    captured_at: 1794908304088
    content_hash: 99791c9ba3d0a3fbd676a0dd5ba01ebd3b2042f3cfc92fe0dfe3f867e92a53ff
evidence:
  - source_id: "file:apps/web/src/test/graphVisualFormulas.test.ts"
    locator: apps/web/src/test/graphVisualFormulas.test.ts
  - source_id: "file:apps/web/src/lib/graphVisualFormulas.ts"
    locator: "apps/web/src/lib/graphVisualFormulas.ts:176-197"
content_hash: fa0207b161335e3cb20a2af0544470565bb7285641c93d5e4cefc2c54fe15c7c
expires_at: null
created_at: 1794908304274
updated_at: 1794908304274
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 语义色键集与测试的耦合

## 事实

`GRAPH_SEMANTIC_CLASSES`（`apps/web/src/lib/graphVisualFormulas.ts`）是星图语义色的唯一键集，当前 **12 个**：
`fill / fillFocused / fillTag / fillUnresolved / fillAttachment / arrow / circle / line / lineEmbed / text / fillHighlight / lineHighlight`。

P2-03 加第 12 个 `lineEmbed`（`color-line-embed`）时只改了实现，测试与三处注释仍写 11 → 存量失败 `expected 12 to be 11`。

## CSS 侧已核实（S2 的前提）

- `.graph-view.color-line-embed { color: var(--kb-graph-line-embed); }` 在 `apps/web/src/index.css:427`
- 变量亮色 `--kb-graph-line-embed: #d97706`（:368）、暗色 `#fbbf24`（:387）
- 12 个 `.graph-view.color-*` 规则齐全

**结论：加第 12 个色是对的，问题在测试与注释。**

## 修法（防再次脱节）

测试不再写死数字，改为从常量派生：

```ts
expect(Object.keys(colors).sort()).toEqual([...Object.keys(GRAPH_SEMANTIC_CLASSES)].sort());
expect(expectedKeys.length).toBeGreaterThanOrEqual(12);   // 只保留下限，防误删
```

另加一条守卫测试直接读 `index.css` 源码：断言**每个 class 名都有对应 CSS 规则**、且 `--kb-graph-line-embed` 至少出现两次（亮/暗两套）。这样「实现加了颜色但 CSS 没定义」会立即红，而不是等到跑浏览器才发现取色为空。

## 教训

**键集用手写的数字断言，必然与实现脱节。** 数量断言只在「防止误删」时才有价值，用 `>=` 下限；覆盖性断言用集合相等（从常量派生），不要写 `toBe(11)`。

同理，注释里写死数量（「读 11 个语义色」）会在每次扩展时变成谎言——改成分情况说明来源（「键集见 GRAPH_SEMANTIC_CLASSES」）。
