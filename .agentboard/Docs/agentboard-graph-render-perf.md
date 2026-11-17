---
id: 68561b50-f7e0-4f80-9f70-083284182105
slug: agentboard-graph-render-perf
title: "图谱渲染链的 memo 击穿与边去重优化"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: design
landed: landed
sources:
  - source_id: "file:apps/web/src/components/knowledge/KnowledgeGraph.tsx"
    source_type: file
    locator: apps/web/src/components/knowledge/KnowledgeGraph.tsx
    captured_at: 1794907484765
    content_hash: 4e6cc0a823888a955f115f1d86a3cc2fc324cc6a15a4452e15ff2b16095dbddf
  - source_id: "file:apps/web/src/lib/graphVisualFormulas.ts"
    source_type: file
    locator: apps/web/src/lib/graphVisualFormulas.ts
    captured_at: 1794907484765
    content_hash: f154858364a7f095f341f013ace048dc37464ebdecac36024b4f74b01b297257
  - source_id: "file:apps/web/src/lib/errorReporting.ts"
    source_type: file
    locator: apps/web/src/lib/errorReporting.ts
    captured_at: 1794907484765
    content_hash: 37e0ad5e675fc1ab3ed14a81af9b37a69f14e4728af846cb77980805539563b2
  - source_id: "file:apps/web/src/test/graphLayoutCalls.test.tsx"
    source_type: file
    locator: apps/web/src/test/graphLayoutCalls.test.tsx
    captured_at: 1794907484765
    content_hash: 036f3217d0312d8db906bce802ddae089925d20c83bc33e85d1d8d67eb421725
  - source_id: "file:apps/web/src/test/graphVisualFormulas.test.ts"
    source_type: file
    locator: apps/web/src/test/graphVisualFormulas.test.ts
    captured_at: 1794907484765
    content_hash: 60f6041dfca2515100833f48b0299f8e8458cd1a7d60ada27a2c5b57f9be7a06
evidence:
  - source_id: "file:apps/web/src/components/knowledge/KnowledgeGraph.tsx"
    locator: apps/web/src/components/knowledge/KnowledgeGraph.tsx
  - source_id: "file:apps/web/src/lib/graphVisualFormulas.ts"
    locator: apps/web/src/lib/graphVisualFormulas.ts
  - source_id: "file:apps/web/src/lib/errorReporting.ts"
    locator: apps/web/src/lib/errorReporting.ts
  - source_id: "file:apps/web/src/test/graphLayoutCalls.test.tsx"
    locator: apps/web/src/test/graphLayoutCalls.test.tsx
content_hash: df78880c560cac6eda894ea67fa12a2547bc3111f42ffd1c2e23b5089fb682f3
expires_at: null
created_at: 1794907485062
updated_at: 1794907485062
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 图谱渲染链的 memo 击穿与边去重

## 渲染链（KnowledgeGraph.tsx）

```
remote.data ──normalizeGraph──▶ raw ──memo──▶ fullGraph ──applyEdgeKinds──▶ graph
  ──searchMatches──▶ matches ──filterGraphForView──▶ viewFilter ──▶ shown
  ──useEffect([shown])──▶ buildAdjacency + layoutGraph(120 tick) + layoutClient.apply
```

`normalizeGraph` 每次调用都返回**新对象 + 新数组 + 新 Map**（`lib/knowledgeGraph.ts` 里有 `new Map()`、`[...nodes.values()].map()`、`edges.sort()`）。写在渲染体里时 `raw` 每渲染换引用，级联击穿后面全部 memo，最后 `useEffect([shown])` 无结构守卫 → **每渲染一次跑一次 120 tick 布局**。触发点：搜索框每敲一个字、缩放动画每帧（1→1.25 共 19 帧）、勾选任一 checkbox。

## 修法与实测

| 项 | 改法 | 数字 |
| --- | --- | --- |
| B1 memo 击穿 | `raw` 用 `useMemo(..., [usingFallback, fallback.data, remote.data])` | 搜索框连打 8 字符：`layoutGraph` **9 次 → 1 次** |
| B2 边去重 O(E²) | 先建 `source\0target` 的 Set 索引，反向边 O(1) 查 | 900 边 **3.7ms → 0.40ms**（9.2×）；500 边 1.25→0.26ms；结果集合完全一致 |
| B1+B2 合并 | — | 缩放 19 帧主线程计算 **365ms → 23ms** |
| B9 空定时器 | 删 `sizeWaitTimer` 与 520ms 空 setTimeout | 源码零命中 |
| B10 clipboard 未捕获 | `writeText(...).catch(() => undefined)` | 复制失败不再进 `unhandledrejection` → 不进诊断缓冲 |
| B6 unloading 不复位 | `pagehide`/`beforeunload` 置真，`pageshow` 复位 | bfcache 返回后恢复走 fetch（beacon 64KB 配额，20KB stack 约第 3 条起静默丢弃） |
| B4 指纹集合 | 上限 100 + FIFO 淘汰；**先拿 instance_id 再记指纹** | 拿不到 instance_id 时不再永久标记为「已报」 |
| B5 instance 缓存 | 空串/异常时清缓存，下次重试 | — |
| B11 readSemanticColors | **不修** | 实测省 0.1ms，远低于一帧 16.7ms |

## 关键判断：B2 不要用 `<` 替换 `localeCompare`

审查员建议用 `edge.source < edge.target` 替代 `localeCompare`（快 29.8×），但**本项目 id 含非 ASCII**：合成节点 id 是 `tag:${tag_norm}`，tag 可以是中文（`normalizeLinkTarget` 只做 NFKC + 小写，不转 ASCII）。`<` 按 UTF-16 码元比较，`localeCompare` 按 locale collation，对非 ASCII 可能给出相反结论。

所以只优化 `find` 部分（Set 索引），排序仍用 `localeCompare`。9.2× 的收益已足够。

## 验证方法（坑）

- **`vi.spyOn` 覆盖不了组件内具名导入**：`KnowledgeGraph` 从 `lib/knowledgeGraph` 具名 import `layoutGraph`，ESM live binding 下 spy 不生效。要用 `vi.mock('../lib/knowledgeGraph', ...)` + `vi.importActual` 保留其它导出。
- **`for (...; k < edges.length; k++)` 里边 `push` 会无限增长**：我在一致性测试里「给后 40% 加反向边」时写成用 `edges.length` 当上界，边遍历边 push → 无限循环 → `JavaScript heap out of memory`（4GB 堆耗尽，`Channel closed` 的误导性报错）。先固定 `const forward = edges.length`。
- **O(E²) 参照实现不能放大到 900 边进单测**：它是 O(E²)，jsdom 里跑会拖垮 worker。真值一致性用 200 边验语义，性能数字在 Node 独立基准里测。
- **B9 的「无 520ms 定时器」用两条证据**：源码 `not.toContain('sizeWaitTimer')` + 运行时 `vi.spyOn(window, 'setTimeout')` 收集 delay 断言不含 520。
- **B10 在 jsdom 里验不了 unhandledrejection 派发**：jsdom 不派发该事件（与浏览器不同）。改为断言「裸 void 的 promise 无人消费」+ 源码 `toMatch(/writeText\([^)]*\)\.catch\(/)`。
- **B11 的收益必须在真实浏览器测**：jsdom 无布局，`getComputedStyle` 恒返回默认值，测出的差值是假的。

