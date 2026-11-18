---
id: 2fd3cf7a-3d1b-4132-b9e3-aacaece24af4
slug: web-decisions-jump-workspace-board
title: 待决策卡详情跳转：先切工作区再定位看板卡
scope: workspace
revision: 1
status: active
updated_at: 2026-11-10T01:51:27.874Z
---

# 待决策「卡详情」跳转：先切工作区，再在看板定位

## 结论（已落地）

- `panelStore.openDetail(issueId)` 只打开右侧详情浮层，且 `GET /api/issues/:id` 与工作区无关；它既不切 `appStore.workspaceId`，也不改 `navStore.view`。**只调 openDetail 的表现就是「停在原工作区、只弹详情」**。
- 待决策列表支持「所有可访问工作区」范围，条目自带 `workspace_id`。跳转必须先 `selectWorkspace(item.workspace_id)`（跨区时），再切看板并定位。
- 看板没有「按 id 选中」的现成通道：新增 navStore 瞬态 `boardFocus`（`focusIssue(id)` 设值并切 view=board；离开看板即清空），由 Board 消费：
  - 清掉会隐藏目标卡的本地筛选：搜索词、该工作区标签筛选、「仅看本次退回」；
  - 等本工作区 issues 数据就绪（排除 placeholder）后 `scrollIntoView({block:'center'})`；
  - 数据就绪后无论是否找到都清空焦点，避免下次进看板莫名滚动。
- 「选中」高亮复用既有语义：入口同时 `openDetail`，IssueCard 的 detailOpen 态就是高亮边框。
- 入口覆盖：DecisionCard 的卡号 / 标题 / ↗ / 「卡详情」、blocked_downstream 直连与间接下游行、空态最近已回答行；`onOpenIssue` 统一改为 `(issueId, issueWorkspaceId)`，下游行用决策自身 workspace_id（依赖同库）。

## 复现与验收（测试页 http://localhost:5174）

1. 待决策视图把范围切到「所有可访问工作区」，找一条工作区 chip 不是当前工作区的决策。
2. 修复前：点「卡详情」→ 只弹详情，主工作区与视图都不变。
3. 修复后：主工作区切到决策所属工作区，视图切看板，目标卡滚入视口并高亮，详情浮层为该任务。
4. 同工作区：点卡号 / 标题 → 切看板并选中该卡（不再停留待决策列表）。

## 可复用判断

- 「详情浮窗能打开」≠「跳转正确」：浮窗数据源是全局 id 查询，会掩盖工作区 / 视图没切的问题；涉及跨区列表的跳转都要显式校验 workspace 与 nav view。
- 定位类交互不要写成一次性副作用：用瞬态 focus + 消费方清空，既解决数据未就绪时滚不到，也避免残留焦点导致后续误跳。

