---
id: adb91d02-8509-47a3-81bd-2c766658d186
slug: agentboard-web-error-reporting
title: "客户端错误上报接线：指纹去重与 sendBeacon 降级"
revision: 3
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: ui
category: design
landed: landed
sources:
  - source_id: "file:apps/web/src/lib/errorReporting.ts"
    source_type: file
    locator: apps/web/src/lib/errorReporting.ts
    captured_at: 1794898216181
    content_hash: 2f9aac6b277308384840513bad6b106eed11c2f8f92660132ff4635f3128a724
  - source_id: "file:apps/web/src/lib/errorBuffer.ts"
    source_type: file
    locator: apps/web/src/lib/errorBuffer.ts
    captured_at: 1794898216181
    content_hash: 6f8b6a0a1db59631f5a63b55dfb539e627c41f3ebf9c7be34d20137dfb7f5645
  - source_id: "file:apps/web/src/main.tsx"
    source_type: file
    locator: apps/web/src/main.tsx
    captured_at: 1794898216181
    content_hash: f97b3b306a75cc49564e41d9f9ddf70995c7b6721712224806e5e79ae3f10223
  - source_id: "file:apps/web/src/components/shell/AppErrorBoundary.tsx"
    source_type: file
    locator: apps/web/src/components/shell/AppErrorBoundary.tsx
    captured_at: 1794898216181
    content_hash: 46df274413728a603d0e57910dd94a841750e90be216a16b9244e2998e60715b
  - source_id: "file:apps/web/src/test/errorReporting.test.tsx"
    source_type: file
    locator: apps/web/src/test/errorReporting.test.tsx
    captured_at: 1794898216181
    content_hash: f00db9b05a38df41dde0d1914cb7258e66a21da767d5b5f631b1a44c52f13450
  - source_id: "file:apps/server/src/api/routes/clientDiagnosticsRoutes.ts"
    source_type: file
    locator: apps/server/src/api/routes/clientDiagnosticsRoutes.ts
    captured_at: 1794898216181
    content_hash: 1bf7f3f56f3b6788e75518b66a4bc761092440271c5d2f43fe455576f0732ad7
evidence:
  - source_id: "file:apps/web/src/lib/errorReporting.ts"
    locator: apps/web/src/lib/errorReporting.ts
  - source_id: "file:apps/web/src/lib/errorBuffer.ts"
    locator: apps/web/src/lib/errorBuffer.ts
  - source_id: "file:apps/server/src/api/routes/clientDiagnosticsRoutes.ts"
    locator: "apps/server/src/api/routes/clientDiagnosticsRoutes.ts:59-73"
  - source_id: "file:apps/web/src/test/errorReporting.test.tsx"
    locator: apps/web/src/test/errorReporting.test.tsx
content_hash: 9f8fbb5398c7c6e87d2397954420611d8eabfa0f21e8876d21aae16b33f5ac50
expires_at: null
created_at: 1794898216554
updated_at: 1794900743994
created_by: kb-cli
updated_by: tester
change_note: "rename tester-rename-probe → agentboard-web-error-reporting"
---

# 客户端错误上报接线（G5）

## 链路

```
pushClientError()  ──sink──▶  reporter.handle(entry)      写环形缓冲 + 通知上报器（G3）
                                  │
                                  ├─ queueMicrotask ──▶ flush()   不在异常路径里发请求
                                  │        ├─ 指纹去重 message\0stack
                                  │        ├─ 上限 10 条/批，超出写一条「未上报」（silently）
                                  │        └─ send(payload)：卸载态 sendBeacon，其余 fetch keepalive
                                  └─ 失败静默（不重试 / 不抛 / 不回流缓冲）
                ──▶ POST /api/client-diagnostics  ──▶ <configDir>/logs/client-error.log（G4）
```

入口 `main.tsx`：`installClientErrorHooks()`（G3 记录）→ `installErrorReporting({ resolveInstanceId: fetchInstanceId, appVersion: WEB_VERSION })`（G5 上报）。

## 契约对齐（G4 `.strict()`）

- `instance_id` 来自 `GET /api/version` 的 `instance_id`，模块内缓存一次 Promise；拿不到就整批不发（否则服务端必然 400）。
- `stack` **有值才带**：`entry.stack === ''` 时 payload 里没有这个键，绝不传空串（`.strict()` 下多余字段与空串都会被拒/降级）。
- `source` / `url` / `user_agent` / `app_version` 同理，空值不带。
- 字段长度按 zod 契约预截断：message 2000 / stack 20000 / source 500 / url 2000 / ua 500 / instance_id 200。
- 不额外加 `context`、不发明契约外字段。

## 三个容易做错的点

- **指纹是 `message + '\0' + stack`**：白屏往往同一处代码反复抛同一个错。只用 message 会把「同文案不同栈」的错误合并掉（丢信息）；只用 stack 则同一错误在不同渲染路径下栈不同（重复上报）。
- **上报器状态必须是 per-reporter**：`reportedFingerprints` / `pending` / `scheduled` 早期写成模块级单例，导致两个 reporter 共用去重集合——单测里「连抛 3 次只报 1 次」直接失败（第二次 reporter 的 2 条被吃）。改成 `createErrorReporter` 闭包内实例变量。
- **「丢弃 N 条」这条本地记录不能再触发上报**：否则上报器自己产生的内容又进队列，形成自激。用 `pushClientErrorSilently`（写缓冲、不调 sink），不要临时摘 sink 再还原（那种写法依赖一个 module-level `activeSink`，重入就乱）。

## 验证方法（坑）

- **`sendBeacon` 路径不能在正常态验**：`defaultSend` 只在 `unloading` 为真时走 beacon，正常态走 `fetch`。要验 beacon 必须先 `window.dispatchEvent(new Event('pagehide'))`。jsdom 里 `navigator.sendBeacon` 不存在，需 `Object.defineProperty` 补。
- **「恰好 1 次请求」必须用严格单次加载**：CDP 脚本若先导航一次写 localStorage、再导航一次测量，两次加载各上报一次，日志里就是两行。正确做法是 `Page.addScriptToEvaluateOnNewDocument` 预置 localStorage，只导航一次。
- **8787 是旧进程（PID 47444），没有 G4 端点**（实测 POST 返回 404）。端到端验证走：`AGENTBOARD_WEB_API_TARGET=http://127.0.0.1:18998` + 临时端口 5175（`node scripts/dev-page.mjs --port 5175`），再用临时 `APPDATA` + 独立 db 起新 dist（`node apps/server/dist/index.js`），日志落 `<tempAppData>/AgentBoard/logs/client-error.log`。**不要 kill 8787。**
- `kb changelog create --issue` 的归属校验、`kb done` 的 changelog 门禁都要求日志带本卡 UUID，别只写 `--workspace`。

