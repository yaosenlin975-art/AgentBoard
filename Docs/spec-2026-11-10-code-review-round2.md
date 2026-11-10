# Spec：第二轮代码审查可优化项（2026-11-10）

工作区：任务看板（e41eb0fb-c367-43cf-a99d-6dc5239a5694）D:\WorkSpaces\任务看板

依据：`Docs/audit-2026-11-10-code-review-round2.md`（§2.1–§2.6）。
本 spec 只覆盖 6 条真缺陷；设计债按报告 §4 只记录。每项一卡、一主题，互不共文件。

---

## 决策

| 编号 | 决定 | 理由 |
|---|---|---|
| D1 | 修 Web 超时为「真中断」 | 连接池耗尽会让重试永久失效；jsdom 用 realm 回落兼容 |
| D2 | 修语音热路径 | 250ms × 全量 hash 会把主线程按住，属可观测性能缺陷 |
| D3 | 修派工模板两处文本 | 模板会批量复制给每个派工 agent，错一条即批量违规 |
| D4 | 修 TRIGGER 分流 | 调用方错误返回 500 会让 CLI/MCP 无法给出可行动提示 |
| D5 | 加快照路径校验 | 防御损坏清单导致的越界删除，成本一行 |
| D6 | check-bom 跳过 `.qa-temp` | 临时目录不该阻断 build 门禁；不动他人产物 |

不做：`routes.ts` 再拆分（CR-10 已收口）、`synchronous` 改值（CR-12 已定案不改）、MCP N+1（并入 PERF-4）、`sha256_verified` 改名（契约变更，随下个语音需求）。

---

## CR2-01 Web 请求超时真正中断底层连接

- 文件：`apps/web/src/api/client.ts`（`fetchWithTimeout`，67-84）；如需要，`apps/web/src/test/**` 的 setup。
- 改动：
  1. 每次请求 `const controller = new AbortController()`。
  2. `fetch(input, { ...init, signal: controller.signal })` 放在 try/catch 内；捕获到跨 realm 的 `TypeError`（message 含 `signal`/`AbortSignal`）时，去掉 `signal` 重试一次并记一次模块级布尔 `signalUnsupported = true`（后续请求直接不带 signal）。
  3. 超时分支先 `controller.abort()`，再 reject `ApiError(TIMEOUT_MESSAGE,'TIMEOUT',0)`；保留 `request.catch(() => {})`。
  4. 不改调用方签名，不改 `ApiError` 形状。
- 约束：620 个 web 测试必须保持全绿（realm 回落就是为此）。
- 验证：
  - `pnpm --filter @agentboard/web test` 全绿；
  - 假服务（只 accept 不回包）下 15s 后客户端报 TIMEOUT，且假服务在 16s 内收到 `close`（当前不会）。

## CR2-02 语音就绪判定去全量 sha256

- 文件：`apps/server/src/services/voiceModels.ts`（171-230）、`apps/server/src/api/voiceRoutes.ts`（仅当需要传参）。
- 改动：
  1. `statusOf` 把「下载中/校验中」早退移到 `present` 计算之前，下载态只返回 `task.bytes`。
  2. `fileReady` 增加 `(size, mtimeMs)` 缓存（模块级 Map，键 `path`，值 `{size, mtimeMs, ok}`）；size 与 mtime 均未变时直接用缓存。
  3. 有 `meta.json` 且所有文件 size 与清单一致时，直接判定齐全，不再 hash；仅 size 不符或 meta 缺失时 hash 兜底。
  4. `deleteVoiceModel` / 下载完成后失效对应缓存。
- 验证：
  - `pnpm --filter @agentboard/server test` 中 voice 相关用例全绿；
  - 放一个 200MB 假 `model.bin` 后 `GET /api/voice/models` < 50ms（改前数百 ms 级）；
  - SSE tick 不再触发 `readFileSync`（deps 注入计数断言 0）。

## CR2-03 派工模板修正

- 文件：`apps/server/src/services/dispatchTemplate.ts:25-26`。
- 改动：
  1. 第 25 行 `--reason "..."` 后补反引号。
  2. 第 26 条改为：「有可复用结论时写/更新领域知识页（`--domain` 按任务域取 accounts|knowledge|board|chat|ui|infra），无可复用结论时在 `kb done --notes` 声明原因」；删除 `--slug handoff-{{issue_id}}` 要求。
- 验证：渲染后的派工文本不含 `handoff-`；反引号成对（可加一条模板渲染单测断言 `handoff-` 不存在）。

## CR2-04 SQLite TRIGGER 错误按消息分流

- 文件：`apps/server/src/api/routes.ts:396-406`。
- 改动：`kind === 'TRIGGER'` 时按 `err.message`：
  - 含 `cycle` → 409 `{code:'DEPENDENCY_CYCLE'}`；
  - 含 `workspace mismatch` → 400 `{code:'WORKSPACE_MISMATCH'}`；
  - 含 `Knowledge history is immutable` → 500 `INTERNAL`；
  - 其他 → 500，message 带约束名不带 SQL 原文。
- 验证：错误处理单测直接构造 `{code:'SQLITE_CONSTRAINT_TRIGGER', message:'issue parent workspace mismatch'}` → 400；`'issue dependency cycle'` → 409；`'Knowledge history is immutable'` → 500。
- 影响面扫描：`grep -rn "SQLITE_CONSTRAINT" apps/server/src`（仅 routes.ts 一处映射）；现有断言在 `apps/server/src/api/*.test.ts` 的错误处理用例。

## CR2-05 快照清单路径包含校验

- 文件：`apps/server/src/services/accounts/traeSnapshot.ts:226`（解析）、`84`（拼接）。
- 改动：解析清单时对每个 `files[].path` / `entries[].path` 校验：非空、无 `..` 段、非绝对路径、无盘符与 NUL；命中即 `throw new Error('snapshot manifest contains unsafe path')`。拼接函数复用该校验。
- 验证：单测 `parseTraeSnapshotManifest({files:[{path:'../../x'}]})` 抛错；合法清单不变。

## CR2-06 check-bom 跳过 `.qa-temp`

- 文件：`scripts/check-bom.mjs:45`。
- 改动：`SKIP_DIRS` 增加 `.qa-temp`。
- 验证：`node scripts/check-bom.mjs` exit 0；`--strict` 仍按存量基线判定。

---

## 执行约束

- 每卡 `kb claim` 后再改；`kb done --scope` 只声明实际路径；提交信息带完整卡号。
- 同文件单 owner：CR2-04 动 `routes.ts`（热点文件），claim 前 `kb show` 复核无人占用并在卡上留改动声明。
- 每完成 2–3 张卡回报一次；全部完成后写知识页 + 变更日志。

## 待批准

以上 6 张卡的计划与验收口径需确认后落板并实施。
