---
id: 07c22c8e-19bf-4f4a-8aee-e6a80cd236cd
slug: agentboard-guide-two-column-scroll
title: "教程页两栏独立滚动布局（左栏固定目录）"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: design
landed: landed
sources:
  - source_id: "file:apps/web/src/components/guide/GuideView.tsx"
    source_type: file
    locator: apps/web/src/components/guide/GuideView.tsx
    captured_at: 1794889582425
    content_hash: 5905fad7da16d81b35e5e3cfd4954451a70966b01991aba86dc442607e781815
  - source_id: "file:apps/web/src/test/GuideView.test.tsx"
    source_type: file
    locator: apps/web/src/test/GuideView.test.tsx
    captured_at: 1794889582425
    content_hash: 04d40afbdaeb4c9201273004ffca38b7c53b6dc98ffe0a66c79398e8679c5990
evidence:
  - source_id: "file:apps/web/src/components/guide/GuideView.tsx"
    locator: "apps/web/src/components/guide/GuideView.tsx:112-148"
  - source_id: "file:apps/web/src/test/GuideView.test.tsx"
    locator: "apps/web/src/test/GuideView.test.tsx:55-81"
content_hash: a75e3432ead80520d1e17f020ba02bbe6959d9c12007e547460a3ff5ab08d65b
expires_at: null
created_at: 1794889590309
updated_at: 1794889590309
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

教程页（`apps/web/src/components/guide/GuideView.tsx`）两栏独立滚动的布局契约。

## 结构

- 根：`flex h-full min-h-0 flex-col lg:flex-row`，不带 `mx-auto` / `max-w-[1100px]`（两栏固定后居中会在宽屏两侧留白）
- 左栏 `<nav aria-label="教程目录">`：`shrink-0 px-4 py-3 lg:w-[240px] lg:overflow-y-auto lg:border-r lg:border-hairline lg:px-5 lg:py-6`
- 右栏正文：`min-w-0 flex-1 space-y-8 overflow-y-auto px-4 py-3 lg:max-w-[72ch] lg:px-8 lg:py-6`
- 窄屏（<1024px）目录保持 `flex overflow-x-auto` 横向 chip，`lg:flex-col` 才竖排
- 章节 `scroll-mt-4` 在有自身滚动的正文容器内依然生效（`scrollIntoView({block:'start'})` 会滚最近的滚动祖ancestor，点目录跳章后章节距容器顶 16px）

## 为什么这样能固定（关键前提）

`App.tsx` 的 `<main className="min-w-0 flex-1 overflow-auto">` 在 `flex min-h-0 flex-1` 的行内父容器里，高度由 flex 决定，因此子元素的 `h-full`（height:100%）有确定参照。若 `main` 改成高度 auto 或移除 flex 约束，`h-full` 会塌成内容高度，两栏就又回到同一个滚动容器。

`min-h-0` 不能省：flex 子项默认 `min-height:auto`，内容超长时会把容器撑开，`overflow-y-auto` 就不生效。

## 验证方法（坑）

- 「目录不跟随滚动」必须采样 `nav.getBoundingClientRect().top`：滚动正文多次（滚动过程中 + 滚动后间隔采样）全部等于同一值才算过。只截一张图不算证据。
- 900px 高视口下 12 项目录不足以产生左栏自身滚动，`nav.scrollHeight === clientHeight` 属正常；要验证左栏自滚需把视口压到 ~420px 高。
- 窄屏横向溢出的判据是 `documentElement.scrollWidth - clientWidth === 0`，不是目测。
- jsdom 没有布局引擎（所有 rect 为 0），这类断言只能进真实浏览器（CDP + `Emulation.setDeviceMetricsOverride` 切 1440×900 / 800×900）。

