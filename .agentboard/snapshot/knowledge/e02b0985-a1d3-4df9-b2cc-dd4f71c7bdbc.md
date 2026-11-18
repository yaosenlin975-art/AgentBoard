---
id: e02b0985-a1d3-4df9-b2cc-dd4f71c7bdbc
slug: web-closed-status-by-kind
title: 前端关闭类判定统一走 status kind（isClosed）
scope: workspace
revision: 1
status: active
updated_at: 2026-11-09T12:22:17.650Z
---

# 前端「关闭类」判定统一走 status kind

## 结论

- 统一入口 `isClosed(status, kind?)`：`kind` 存在时只认 `done | deprecated`；`blocked` 不算关闭类。
- `kind` 缺失（字典里查不到该状态名 / 字典未加载）时按状态名「已关闭」兜底，保持改造前语义。

## 落地位置

- 详情徽标：`MetaRow.tsx` 的 `closed`。
- 依赖区圆点：`DependencySection.tsx` 的 `isItemClosed`。
- 阻塞下游清单：`BlockedDownstream.tsx` 的 `isItemClosed`。
- 树视图关闭门禁与状态下拉禁用：`IssueTreeView.tsx`（卡面原指向 `DetailPanel.tsx:259-261`，该处已只剩注释，规则实际迁到树视图）。
- `BOARD_COLUMNS` 固定四列、拖拽落点与视觉 class 均未改。

## 坑

- 组件统一从状态字典 `byName` 取 kind；字典没加载到时自动走名字兜底，不会把自定义完成态误判成未关闭。
- 新增状态字典查询会让既有测试出现未处理请求，测试 harness 的 `server.ts` 默认返回空字典，个别用例再 `server.use` 覆盖。

## 验证

- 新增 `closedStatusKind.test.tsx` 覆盖四处关闭态渲染；`workspaceStatuses.test.tsx` 覆盖 kind 优先级、blocked 非关闭、名字兜底。
- 定向 5 文件 58 用例全绿；全量 web 1425 通过 / 19 失败为存量（账号多 codex、knowledge 系列等，单跑可复现，与本次链路无关）。

