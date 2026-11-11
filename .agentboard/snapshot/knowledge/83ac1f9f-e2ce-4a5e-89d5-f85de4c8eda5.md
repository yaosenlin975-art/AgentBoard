---
id: 83ac1f9f-e2ce-4a5e-89d5-f85de4c8eda5
slug: desktop-shell-appearance-follow
title: 桌面壳深浅色跟随系统：启动页跨源约束与主题口径（E3）
scope: workspace
revision: 1
status: active
updated_at: 2026-11-11T15:50:40.451Z
---

# 桌面壳深浅色跟随系统（启动页跨源约束与主题口径）

## 现状事实（改前核实，勿重复排查）

- 主站页面（apps/web `src/theme.ts`）本就跟随系统：缺省主题 `system`，`initTheme` 注册 matchMedia change 监听实时跟随（免重启）；显式 light/dark 落 localStorage 且系统切换不覆盖。
- wry 0.57（Tauri 2.12）mac 侧不强制 NSAppearance、`drawsBackground` 关闭（窗口背景透出、随外观）→ WKWebView 的 `prefers-color-scheme` 默认跟随系统 effectiveAppearance，壳侧无需额外代码。

## 真正缺口：壳本地启动页（desktop/src-tauri/ui/index.html）跨源

启动页与主站不同源（tauri 资产源 ≠ `127.0.0.1` 服务源），读不到主站 localStorage 的主题选择——只能跟随系统 `prefers-color-scheme`，不能复刻用户显式主题。落地：`:root` 补 `color-scheme: light dark`（同时让 WKWebView under-page 背景随外观，消除深色白闪）+ `@media (prefers-color-scheme: dark)` 覆盖同值暖黑令牌（与 apps/web `.dark` 逐值一致）。启动瞬间随系统、主站加载后回到用户主题（显式选择优先，口径见卡 104300b2 评论）。

## 验证方法（无 mac）

- 启动页双态像素验证：`msedge --headless --force-dark-mode --screenshot`（Chromium 系 flag，WebView2/WKWebView 同语义）对 file:// 截图，PIL 采样页面背景/winbar/卡片像素对比令牌值。
- 主站口径回归：`apps/web/src/test/themeFollowSystem.test.ts`（可控 matchMedia mock + setDark 触发 change），断言 system 跟随、显式不覆盖、免重启跟随。
- mac 真机截图（系统切换 3s 内窗口+页面同步）仍需人工。
