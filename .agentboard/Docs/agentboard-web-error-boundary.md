---
id: 29e799b5-7183-4c1a-8594-126dbc44f2bb
slug: agentboard-web-error-boundary
title: "白屏止血：ErrorBoundary 分层与客户端错误缓冲"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: design
landed: landed
sources:
  - source_id: "file:apps/web/src/components/shell/AppErrorBoundary.tsx"
    source_type: file
    locator: apps/web/src/components/shell/AppErrorBoundary.tsx
    captured_at: 1794897136923
    content_hash: 8c68133605b3e3a663f3372de3332d265f681b66d7cbbe7394d004c6322afe79
  - source_id: "file:apps/web/src/components/shell/ViewErrorBoundary.tsx"
    source_type: file
    locator: apps/web/src/components/shell/ViewErrorBoundary.tsx
    captured_at: 1794897136923
    content_hash: 1d974be89d35725a311a2203d77ed908c5f8e5396c30e318b3e8b4fa7d1c7c77
  - source_id: "file:apps/web/src/lib/errorBuffer.ts"
    source_type: file
    locator: apps/web/src/lib/errorBuffer.ts
    captured_at: 1794897136923
    content_hash: a67e1f5e3d72ceb5a94f9897b3aaf6917d8f4372751412b787ab456e8f23f73e
  - source_id: "file:apps/web/src/main.tsx"
    source_type: file
    locator: apps/web/src/main.tsx
    captured_at: 1794897136923
    content_hash: 9bb656a1cb10d3c0e81e1799672b244626cae0d31a5822ea30d619a059eb6d85
  - source_id: "file:apps/web/src/test/errorBoundary.test.tsx"
    source_type: file
    locator: apps/web/src/test/errorBoundary.test.tsx
    captured_at: 1794897136923
    content_hash: 588c9e2bbb1c2f2e4727f36f066bfab806fd6636d06faec8c1f61c163da628e0
evidence:
  - source_id: "file:apps/web/src/components/shell/AppErrorBoundary.tsx"
    locator: apps/web/src/components/shell/AppErrorBoundary.tsx
  - source_id: "file:apps/web/src/components/shell/ViewErrorBoundary.tsx"
    locator: apps/web/src/components/shell/ViewErrorBoundary.tsx
  - source_id: "file:apps/web/src/lib/errorBuffer.ts"
    locator: apps/web/src/lib/errorBuffer.ts
  - source_id: "file:apps/web/src/main.tsx"
    locator: apps/web/src/main.tsx
  - source_id: "file:apps/web/src/test/errorBoundary.test.tsx"
    locator: apps/web/src/test/errorBoundary.test.tsx
content_hash: 781453fb1fc8dddbdd40e9c87a912ecdb4a0417e9828a7a81dd442ca7931b610
expires_at: null
created_at: 1794897137226
updated_at: 1794897137226
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 白屏止血：ErrorBoundary 分层与客户端错误缓冲

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 全局钩子 | `lib/errorBuffer.ts:installClientErrorHooks()`，`main.tsx` 调用 | `window.error` / `unhandledrejection` → 环形缓冲（20 条）。**不联网** |
| 顶层边界 | `main.tsx`：`StrictMode > AppErrorBoundary > QueryClientProvider` | render 期未捕获异常 → 整页兜底 UI |
| 视图边界 | `App.tsx` 各分支外包 `ViewErrorBoundary view="board\|decisions\|log\|knowledge\|chat\|guide\|experts"` | 单视图抛错只坏这一块，左栏与其它入口照常 |

`AppErrorBoundary`（`components/shell/AppErrorBoundary.tsx`）是唯一的 class 边界，接受 `fallback?: (error, reset) => ReactNode`；顶层不传 fallback（用内置白屏 UI），视图级传 `ViewErrorFallback`。这样两处只有一份边界逻辑。

## 关键约束（改这里必须保持）

- **必须包在 `QueryClientProvider` 外层**：provider 自身抛错（key 冲突、client 初始化异常）也要兜住。
- **必须包在 `StrictMode` 内层**：开发期 StrictMode 会双跑渲染，`componentDidCatch` 可能被调用两次 → 用实例字段 `reported` 去重，否则同一错误记两条、G5 的「指纹去重」失去意义。
- **兜底 UI 不能依赖业务组件/hook**：只用 `useState`/`useRef` 与项目 token 类名。白屏时 React-query、store、路由都可能已处于坏状态。
- **`reset` 必须清 `reported`**：「重试」后若同一错误再抛，需要再记一次（否则第二次异常静默丢失）。

## 验证方法（坑）

- **视图级隔离的正确验法**：把临时 throw 放在视图分支内、`ViewErrorBoundary` 之内，然后断言「`view-error-board` 出现 + `app-error-boundary` 不出现 + 左栏 8 个 `sidebar-entry-*` 仍在」。只截一张图不足以证明隔离。
- **顶层兜底的验法**：把临时 throw 移到 `ViewErrorBoundary` **之外**（例如 `VoiceInputProvider` 之前）。此时 `app-error-boundary` 出现、`sidebar` 与 `main-content` 都查不到 —— 若 left nav 还在，说明 throw 位置仍在视图边界内，验的是视图级而非顶层。
- React 开发期会把「被 boundary 捕获」的错误照常打到 `console.error`，测试输出里出现 `The above error occurred in the <X> component` 属正常，不是失败。
- **jsdom 里没法验证 `componentDidCatch` 的去重**：单测直接断言 `getClientErrors()` 里同一条错误只有一条（`kind==='react'`、`source==='react-boundary'`），不依赖 StrictMode 行为。
- **`import.meta.glob` / 动态 import 在 CDP 里会拿到另一个模块实例**：用 `await import('/src/lib/errorBuffer.ts')` 读缓冲得到 0 条，是 vite 的 URL 归一化造成的双实例，不代表钩子没挂。验「钩子挂了」用 `DOMDebugger.getEventListeners(window)` 看 `error` / `unhandledrejection` 是否在监听列表里。

## 与 G4/G5 的接缝

缓冲条目形状 `{ ts, kind: 'error'|'rejection'|'react', message, stack, source?, url }` 是上报的输入契约。G5 应消费 `getClientErrors()`，不要另建一份缓冲。

