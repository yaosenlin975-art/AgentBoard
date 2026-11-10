# 全仓代码审查报告（第二轮，2026-11-10）

- 工作区：任务看板 `e41eb0fb-c367-43cf-a99d-6dc5239a5694`（`D:\WorkSpaces\任务看板`）
- 审查方式：Skill `open-code-review-delegate`（宿主 agent 自行审阅，规则集不下发 LLM 端点）
- 性质：只读审查；本轮先出结论，可优化项另建卡实施（一卡一主题）
- 审查区间：`d9fdcdf..HEAD`（上一轮报告提交之后到 2026-11-10）
- 取证基线：工作树 HEAD（多会话并行改动中；他人未提交改动不计入结论）

---

## 0. 结论摘要

| 档次 | 条数 | 处置 |
|---|---|---|
| 真缺陷 | 6 | 全部建卡（CR2-*），先修 3 条影响面大的 |
| 设计债 | 3 | 只记录，不单独立卡 |
| 上轮 CR 落地复核 | 13/13 已关闭 | 2 处引入新问题（CR-2 / CR-7），见 §2 |
| 不立项 | 4 | 与既有 PERF-*、CR-* 重叠或属取舍，见 §5 |

**整体判断**：上轮 13 张 CR 卡的修复质量整体合格（labels 容错、原子写、并发池、端口读取、lint 门禁、打包软链均已落地，见 §3）。本轮新发现集中在两处：

1. **超时只解除了 UI 等待，没有释放底层连接**（CR-2 的已知取舍升级成真问题）；
2. **语音模型的就绪判定把整文件 sha256 放进了 250ms SSE tick 和每次列表请求**（上轮未覆盖区）。

另有一处**流程级影响**：`scripts/check-bom.mjs` 现在被仓库里的 QA 临时目录打红，`pnpm build` 与 `apps/web` 的 `prebuild` 会直接失败。

---

## 1. 覆盖范围与取证

### 1.1 本轮新增覆盖（上轮声明未覆盖）

| 模块 | 覆盖方式 | 结论 |
|---|---|---|
| 账号体系 `apps/server/src/services/accounts/**` | 通读 `credentialRefresh.ts`、`traeSnapshot.ts`、`traeProvider.ts`（切换段）、`credentialImport.ts`；`quotas/platformQuotaCredentials.ts` 抽样 | 凭据不落日志、刷新失败回落 recapture 的分支正确；发现 1 条路径包含缺失（§2.5） |
| 声音/SSE `api/voiceRoutes.ts` + `services/voiceModels.ts` | 通读 | 定时器清理正确；发现状态计算性能缺陷（§2.2） |
| 知识星图 `knowledge/pixiGraph.ts` + `KnowledgeGraph.tsx` | 通读销毁/尺寸/空闲帧段 + 事件监听扫描 | 销毁路径完整（`destroy` + 监听移除 + ticker 空闲停帧），**无缺陷** |

### 1.2 上轮之后的新增/变更（重点抽查）

| 区域 | 覆盖 | 结论 |
|---|---|---|
| 顶栏 / 窗口标题栏 | `components/shell/WindowTitleBar.tsx` 通读 | 拖拽区、双击最大化、tray 关闭语义正确，无监听泄漏 |
| 决策跳转 | `decisions/DecisionsView.tsx`、`state/navStore.ts` | 先写 pending 再切工作区，无竞态 |
| 附件投递 | `db/repos/attachment.ts` 状态机 + `db/migrations/attachments.ts` | `pending→sending→delivered/unknown` 带 `changes===1` 护栏，正确 |
| MCP 工具扩容 | `apps/mcp/src/tools/register.ts`、`boardViews.ts` | 新工具与 CLI 同源 `@agentboard/shared`；1 条 N+1 债（§4.1） |
| CLI OPT/ARCH | `packages/cli/src/api.ts` 超时段 | CR-3 用真实 `AbortSignal.timeout`，正确 |
| 新服务 | `browserOpener.ts`、`personaInjection.ts`、`mcpInfo.ts`、`workspaceSnapshotLag.ts` | 子进程超时/退出清理、persona 标记净化、MCP 探测缓存（60s）均正确 |

---

## 2. 真缺陷

### 2.1 [中] Web 请求超时只解除等待，不中断底层连接（CR-2 的遗留）

- **证据**：`apps/web/src/api/client.ts:67-84`

```
67: * 用竞速而非把 AbortSignal 传给 fetch：超时到点即解除 loading 是目标；底层连接交给浏览器/网关回收。
70:   const request = fetch(input, init);
73:   request.catch(() => {});
75:   return await Promise.race([ request, timeoutReject ]);
```

- **触发条件**：服务进程存活但不响应（长事务/大查询按住事件循环）。
- **后果**：超时后 `useQuery` 已进错误态，但那条 `fetch` 仍占着连接。浏览器对同源 HTTP/1.1 只给 6 条连接，连续几次超时后连接池被占满——**用户点「重试」也拿不到连接**，表现为「一直 loading 且重试无效」；`request.catch(() => {})` 还把真实失败吞掉，无从归因。
- **为何上轮没改**：`knowledge:a99b3eb7`（AbortSignal 在 jsdom 跨 realm 报 TypeError，曾打挂 620 个 web 测试）。所以修法必须带 realm 回落，不能直接塞 `signal`。
- **建议**：`AbortController` + 超时分支 `controller.abort()`；`fetch` 调用处 try/catch 捕获跨 realm `TypeError` 后以无 signal 重试一次（浏览器走 abort，jsdom 走回落）。测试补一条「超时后底层请求被取消」。
- **复跑证据**：起一个只 `accept` 不回包的假 HTTP 服务 → 页面 15s 进错误态后，假服务侧应立即收到 `close`（当前要等 60s+ 或进程退出）。

### 2.2 [中] 语音模型就绪判定在 SSE 每 250ms 全量重算 sha256

- **证据**：`apps/server/src/api/voiceRoutes.ts:40`（`sseIntervalMs ?? 250`）、`:71-86`（tick 调 `voiceModelProgress`）；`apps/server/src/services/voiceModels.ts:171-181`（`fileReady` 用 `readFileSync` 整文件 hash）、`:190`（`present` 在下载态早退之前计算）。

```
voiceModels.ts:176:  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
voiceModels.ts:190:  const present = files.filter((file) => fileReady(dir, file, weakVerify))...
voiceModels.ts:205:  if (task !== undefined && (task.state === 'downloading' || task.state === 'verifying')) {
```

- **触发条件**：模型已部分/全部落盘后打开语音页，或正在下载。
- **后果**：每个 tick（4 次/秒）把已存在的模型文件整块读进内存再 hash；200–400MB 模型 = 每秒数百 MB 读盘 + 主线程 CPU（better-sqlite3 与 hash 都在主线程），直接把整个看板拖慢。`GET /api/voice/models` 每次请求同样对每个模型全量 hash。
- **建议**：① 把下载/校验态早退提到 `present` 之前（下载中只回报 `task.bytes`）；② 非下载态用 `(size, mtimeMs)` 缓存判定，只有缓存未命中或 size 不符时才 hash；③ 已有 `meta.json` 且 size 全对时直接信任，不必再 hash。
- **复跑证据**：`docs` 目录放一个 200MB 假 `model.bin`，`GET /api/voice/models` 当前数百 ms 级；改后应 < 50ms。

### 2.3 [中] 派工模板与知识库口径冲突，且反引号未闭合

- **证据**：`apps/server/src/services/dispatchTemplate.ts:25-26`

```
25: 4. 全部完成后执行 `kb done {{issue_id}}`；无法完成执行 `kb fail {{issue_id}} --reason "..."。
26: 5. 完成前必须写一条知识页（`kb knowledge create --slug handoff-{{issue_id}} ...
```

- **后果**：
  1. 每个被派工的 agent 都被要求建 `handoff-<uuid>` 页，而 `using-agentboard` 明确「禁用 `handoff-<issue-uuid>` 命名」「进度与完成情况不进知识库」——模板在批量教违规，产出的页会被 kb-curator 反复清理。
  2. 第 25 行 `--reason "..."` 后的反引号缺失，代码段一直悬空到模板结尾，渲染后第 26 条整段变成代码块。
- **建议**：第 25 行补反引号；第 26 条改成「有可复用结论 → 写/更新领域知识页（`--domain` 按任务域）；无可复用结论 → 在 `kb done --notes` 声明原因」，去掉 `handoff-{{issue_id}}` slug 要求。

### 2.4 [低] CR-7 的 `SQLITE_CONSTRAINT_TRIGGER` 例外建立在不成立的前提上

- **证据**：`apps/server/src/api/routes.ts:396-406` 注释称触发器是「如附件事务回滚保护」；但 `apps/server/src/db/migrations/attachments.ts:39-66` 的触发器只有 `INSERT/DELETE`，**没有任何 `RAISE(ABORT)`**。真正会 `RAISE(ABORT)` 的是：
  - `db/migrations/issueDependency.ts:35,56`（跨库依赖、依赖环）
  - `db/migrations/taskHierarchy.ts:17,23,34`（跨库父卡、父子环）
  - `db/migrations/knowledge.ts:28-29`（知识历史不可变）
- **后果**：前三类是**调用方可触发的参数错误**（并发下绕过应用层预检即可命中），现在统一落 500 `INTERNAL`，CLI/MCP 退出码塌成 1，用户看到「内部错误」而不是「跨工作区父卡非法 / 依赖成环」。只有知识历史不可变才应保持 500。
- **建议**：按 `err.message` 分流：`cycle` → 409 `DEPENDENCY_CYCLE`；`workspace mismatch` → 400 `WORKSPACE_MISMATCH`；`Knowledge history is immutable` → 500；其余 TRIGGER → 500 并记约束名。
- **复跑证据**：`UPDATE issue SET parent_id=<另一工作区的卡>` 直连 SQL 触发 `issue parent workspace mismatch`，当前返回 500；改后应 400 且 body 含 `code`。

### 2.5 [低] 快照清单路径未做包含校验

- **证据**：`apps/server/src/services/accounts/traeSnapshot.ts:84`（`join(dataDir, ...relPath.split('/'))`）、`:226`（`parseTraeSnapshotManifest` 只校验结构）、`:250-255`（`restoreTraeSnapshot` 对清单内路径直接 `fs.remove`）。
- **定性**：清单来自加密 vault、由本机生成，外网不可注入，**不是当前可利用漏洞**；但清单损坏或被改写时，`../` 可让删除动作逃出 `dataDir`（删用户任意文件）。
- **建议**：解析时拒绝含 `..`、绝对路径、盘符或 NUL 的 entry（一条 `assertSafeRelativePath`），命中即整份清单判无效。

### 2.6 [低] `check-bom` 门禁被仓库内 QA 临时目录打红

- **证据**：`node scripts/check-bom.mjs` → `发现 1 个新增带 UTF-8 BOM 的文件 .qa-temp/topbar-kb-old.md (EF BB BF)`，exit 1；`scripts/check-bom.mjs:45-46` 的 `SKIP_DIRS` 不含 `.qa-temp`。
- **后果**：`pnpm build`（根 `prebuild`）与 `apps/web` 的 `prebuild` 直接失败；`.qa-temp/` 里是别人正在写的截图，不能删也不能改。
- **建议**：`SKIP_DIRS` 加 `.qa-temp`（临时目录不应进门禁）；是否清理该目录由拥有者决定，本卡不动。

---

## 3. 上轮 13 张 CR 卡落地复核

| 卡 | 落地证据 | 结论 |
|---|---|---|
| CR-1 启动锁 | `apps/server/src/index.ts:343` `acquireServerLock` 已前移到 `openDb` 之前 | 已修 |
| CR-2 Web 超时 | `apps/web/src/api/client.ts:67-84` `Promise.race` | **部分修**，见 §2.1 |
| CR-3 CLI 超时 | `packages/cli/src/api.ts:69,200` `AbortSignal.timeout(15_000)` | 已修 |
| CR-4 批量状态 | `apps/web/src/components/board/Board.tsx:25,68,254` `mapWithConcurrency`（上限 6） | 已修 |
| CR-5 labels 容错 | `apps/server/src/db/repos/issue.ts:190,204` `tryParseLabels` / `parseLabelsOrEmpty` | 已修 |
| CR-6 桌面端口 | `desktop/src-tauri/src/server_process.rs:25` `resolve_port()` 读 `config.json` | 已修 |
| CR-7 SQLite 错误码 | `apps/server/src/api/routes.ts:400-409`，含 TRIGGER 例外 | **部分修**，见 §2.4 |
| CR-8 config 原子写 | `apps/server/src/config.ts:220` `renameSync` | 已修 |
| CR-9 端点注册表 | `apps/web/src/api/**` 收敛 | 已修 |
| CR-10 routes 拆分 | `api/routes.ts` 已降到 406 行，域模块分文件装配 | 已修（未引入新问题） |
| CR-11 lint 门禁 | `package.json:11` `lint`、`eslint.config.mjs:25` | 已修 |
| CR-12 synchronous | 评估结论「不改」，知识页 `knowledge:56983afc` | 已定案（卡 notes 为空，结论在知识页） |
| CR-13 打包软链 | `scripts/package-portable.mjs:129` `lstatSync` | 已修 |

---

## 4. 设计债（不单独立卡）

1. **MCP `next_tasks` 的 N+1**：`apps/mcp/src/tools/boardViews.ts:50-55` 对每个候选各发一次 `/issues/:id/dependencies`，100 个候选就是 100 个并发请求。与 `kb next` 同口径、结果正确；等 PERF-4 的分页/批量端点落地时一并收敛，不另立项。
2. **`sha256_verified` 名不符实**：`apps/server/src/services/voiceModels.ts:203` 表示「文件齐全」，不是「校验通过」。字段是对外契约，改名要跟 CLI/MCP/前端一起动；先记录，随下个语音相关需求修正。
3. **下载任务 Map 只增不减**：`voiceModels.ts` 的 `tasks` / `lastTask` 在重试时被覆盖但不清理旧对象；单机低频，内存占用可忽略。

---

## 5. 不立项（与既有卡重叠或属明确取舍）

| 现象 | 处置 |
|---|---|
| `dependency_violation` 逐行递归 CTE | 并回 PERF-4 验收，不重复立卡 |
| 首屏重复 `/api/issues`、WS 全域失效、空态计数 | PERF-6 / PERF-8 / PERF-9 |
| Web 固定以 `user` 身份写入 | PERM-2 的显式取舍，已在 `Docs/api.md` 记录 |
| `tools` 别名保留 `__agb_` 前缀工具名 | 已有删除计划卡 `f78d7465` |
| 账号 zcode 回落密钥可预测 | 已有记录（本地混淆定位），无新增利用面 |

---

## 6. 本轮可优化清单（对应建卡）

| 卡 | 主题 | 文件 | 优先级 |
|---|---|---|---|
| CR2-01 | Web 超时真正中断底层连接（realm-safe） | `apps/web/src/api/client.ts` + 测试 | 中 |
| CR2-02 | 语音就绪判定去全量 sha256（SSE 热路径） | `services/voiceModels.ts`、`api/voiceRoutes.ts` | 中 |
| CR2-03 | 派工模板修正（反引号 + 知识页口径） | `services/dispatchTemplate.ts` | 中 |
| CR2-04 | SQLite TRIGGER 错误按消息分流 | `api/routes.ts` | 低 |
| CR2-05 | 快照清单路径包含校验 | `services/accounts/traeSnapshot.ts` | 低 |
| CR2-06 | `check-bom` 跳过 `.qa-temp` | `scripts/check-bom.mjs` | 低 |
