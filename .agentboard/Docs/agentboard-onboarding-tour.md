---
id: 83d95dbe-79de-4c58-8c76-bea01d4ce8f5
slug: agentboard-onboarding-tour
title: "新手引导：遮罩挖洞与分步气泡（零依赖）"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: design
landed: landed
sources:
  - source_id: "file:apps/web/src/components/onboarding/OnboardingTour.tsx"
    source_type: file
    locator: apps/web/src/components/onboarding/OnboardingTour.tsx
    captured_at: 1794890933439
    content_hash: a2052af0efd0b4c587f9e4913f7f0f842aef1afc1794ca4496be6aa654be98cf
  - source_id: "file:apps/web/src/components/onboarding/steps.ts"
    source_type: file
    locator: apps/web/src/components/onboarding/steps.ts
    captured_at: 1794890933439
    content_hash: 2aedd7641ce318900fa4d956a0fe648d15375f1729a9f3e4d6c783bfa40c9481
  - source_id: "file:apps/web/src/components/onboarding/useOnboarding.ts"
    source_type: file
    locator: apps/web/src/components/onboarding/useOnboarding.ts
    captured_at: 1794890933439
    content_hash: a86551d8362b4403c6c89b87e28d6f9a9574b226e8f3ba1f076c003dcb5addb1
  - source_id: "file:apps/web/src/state/onboardingStore.ts"
    source_type: file
    locator: apps/web/src/state/onboardingStore.ts
    captured_at: 1794890933439
    content_hash: cbaac14f842687306c45f2508ccb397aaec5c51e104902ad9cb89a33ef67ccb8
  - source_id: "file:apps/web/src/test/onboarding.test.tsx"
    source_type: file
    locator: apps/web/src/test/onboarding.test.tsx
    captured_at: 1794890933439
    content_hash: cea0a1d5866d637a09fbd8333eb2a36eb031b580c31322de7b819fc8195dd9d3
evidence:
  - source_id: "file:apps/web/src/components/onboarding/OnboardingTour.tsx"
    locator: apps/web/src/components/onboarding/OnboardingTour.tsx
  - source_id: "file:apps/web/src/components/onboarding/steps.ts"
    locator: apps/web/src/components/onboarding/steps.ts
  - source_id: "file:apps/web/src/state/onboardingStore.ts"
    locator: apps/web/src/state/onboardingStore.ts
  - source_id: "file:apps/web/src/test/onboarding.test.tsx"
    locator: apps/web/src/test/onboarding.test.tsx
content_hash: 633a19142346e5881fbc2e54c5a74861255aad946ee6612792497980cf83b525
expires_at: null
created_at: 1794890941991
updated_at: 1794890941991
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 新手引导（G2）

## 结构

`apps/web/src/components/onboarding/`：`steps.ts`（5 步定义 + `stepTarget`）、`useOnboarding.ts`（自动启动与步骤过滤）、`OnboardingTour.tsx`（遮罩/气泡/几何）、`index.ts`（出口）。
状态在 `apps/web/src/state/onboardingStore.ts`（zustand，不持久化 store 本身）。挂载点在 `App.tsx`（`<VoiceInputProvider>` 之后）。

## 关键实现选择

- **遮罩与挖洞是同一个元素**：高亮框自身 `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)`，元素本身 `pointer-events: none`，外层 `fixed inset-0 z-[100]` 容器用 `pointer-events: auto` 吞点击。拼四块遮罩会在接缝处漏色，且四块要各自跟随目标，成本更高。
- **定位只用 `getBoundingClientRect()` + `position: fixed`**：不引入 Popper/floating-ui。气泡优先落在目标下方，放不下翻到上方，水平夹在视口内。
- **重复播放用「过滤后的下标」**：`stepIndex` 指向 `resolveVisibleSteps()` 的结果，不是 `ONBOARDING_STEPS` 的下标。第 3 步 `column-create-待规划` 只在看板视图存在，缺失时被过滤 → 计数器自然显示 `1 / 4`。
- **启动延迟 800ms** 用 `setTimeout` + cleanup 清定时器；StrictMode 双跑 effect 也只留一个定时器，且定时器触发前再查一次 `active`，避免用户已手动重播却被重置到第 1 步。
- **`ab.onboarding.v1` 只写 `'done'`**；读不到/读抛错（隐私模式）一律当已完成，宁可不打扰。

## 验证方法（坑）

- **遮罩挡点击只能用真实 `Input.dispatchMouseEvent` 验**：`element.dispatchEvent(new MouseEvent('click'))` 直接落到目标元素上，绕过命中测试，会得到「卡片被点开了」的假失败。正确做法是先 `document.elementFromPoint(x, y)` 断言命中的是遮罩容器，再发真实点击。
- **几何断言只能进真实浏览器**：jsdom 无布局引擎，`getBoundingClientRect()` 全为 0。用 CDP `Emulation.setDeviceMetricsOverride` 切视口 + `Page.captureScreenshot` 取帧。
- **高亮框外扩 4px**（`HIGHLIGHT_PAD`），比较时要把高亮框内缩回 4px 再与目标 rect 比，别直接比原始值。
- **捕获阶段 scroll 必须显式验证**：`window.addEventListener('scroll', fn, true)`，第三个参数为 `true` 或缺省 `capture: true` 才算捕获。内层滚动容器（正文、侧栏）的 scroll 不冒泡到 window，冒泡阶段监听收不到。React 侧重算走 `useLayoutEffect` + `tick` 计数，不是直接在事件里 `setState` 矩形。
- **滚动跟随的可验证条件**：先同步改 `scrollTop` 让目标元素位移，隔 ≥400ms 再量 delta，才能区分「快照没更新」与「跟随正确」。仅同步读一次会得到 0 delta 但那是没更新的假象。
- **dev 页冷启动会拖长挂载时间**：不要用固定 sleep 断言 800ms 延迟，改为轮询遮罩出现并记录 `performance.now()`；vite dev 首次编译可能让整体挂载晚于 800ms 之外。

