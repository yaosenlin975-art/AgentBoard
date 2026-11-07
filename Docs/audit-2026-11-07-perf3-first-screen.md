# PERF-3 审查报告：首屏空白与工作区切换卡顿（取证与定位）

- 任务卡：`b95530da-38a3-4fd7-93eb-ee9e9175cd4e`【PERF-3｜AUDIT】
- 工作区：任务看板 `e41eb0fb-c367-43cf-a99d-6dc5239a5694`（`D:\WorkSpaces\任务看板`）
- 取证日期：2026-11-07
- 性质：只审查、只定位、只给基线。**本报告不含任何生产代码改动**。

---

## 0. 结论摘要（先给结论，后面全部是证据）

| # | 定性 | 结论 | 量级 |
|---|---|---|---|
| R1 | B 类（数据慢） | `comment_count` 相关子查询在 `issue_comment(issue_id)` 无索引时退化为**逐行全表扫描**，单独贡献 `/api/issues` 99% 的耗时 | 663 行：8.7ms → 622.8ms（+7140%） |
| R2 | B 类（数据慢） | 首屏对 `/api/issues` 发了**两条完全相同的全量请求**（看板 1 条 + `['issues', ws, 'labels']` 1 条），每条 1.56MB | 首屏 API 3.96MB，其中 3.11MB 是重复 |
| R3 | B 类（数据慢） | 一次「写评论」触发 **2 条 WS 事件**（`comment.added` + `issue.changed`），叠加全域前缀失效，实际打出 **4 条全量请求 = 6.22MB** | 单次评论写入 → 4×1.56MB，端到端 3.5s 窗口 |
| R4 | A 类（加载态） | 看板列在 `issues` 未到时渲染 `[]` + `EmptyState「暂无任务」`，无任何加载态；切工作区时先清空再等 | 首屏空列 240ms→2172ms；切换空列 ≈230–700ms |
| R5 | A 类（加载态） | 工作区卡计数在 counts 未到时用 **0** 冒充（源码注释明确「先按 0 渲染」） | 实测闪 0 窗口 164–221ms |
| R6 | 渲染 | 663 张卡一次性渲染（8310 DOM），缓存命中切换纯渲染 281–364ms；数据层修好后渲染成为第二大头，但**当前不需要窗口化** | 见 §4 |

**已由其他卡负责、本报告不重复立项**：`issue_comment(issue_id)` 索引修复（R1 的根治手段）。
**本轮不建卡项**：gzip 压缩、statuses 批量端点、看板窗口化（均有实测数据说明暂不需要，见 §7）。

---

## 1. 取证环境与方法（可复现）

| 项 | 取值 |
|---|---|
| 库快照 | 中心库 `%APPDATA%\AgentBoard\agentboard.db`（36MB，1352 issues / 7 工作区）经 `VACUUM INTO` 生成只读快照，**不碰线上库** |
| 隔离后端 | `AGENTBOARD_PORT=8799` + `AGENTBOARD_DB=<快照>` + 独立 `APPDATA`，同库单例锁与线上实例互不影响 |
| 页面 A（产物） | `http://127.0.0.1:8799/`（`apps/web/dist`，构建于 2026-11-07 07:51） |
| 页面 B（源码） | `http://127.0.0.1:5199/`（`vite` dev，`AGENTBOARD_WEB_API_TARGET=http://127.0.0.1:8799`） |
| 浏览器 | Edge headless（Chromium），1600×1000，`Network.setCacheDisabled=true`，每轮全新 profile |
| 计时 | CDP `Network.*` + 页内 `PerformanceObserver` + 16ms 轮询 DOM 标记 |
| 采样 | 每项 3 次取中位数；SQL 每项 7 次取中位数 |

> ⚠️ 产物页落后于源码：`dist` 构建时间 07:51，而 PERF-4b 改的 `WorkspaceCard.tsx` / `WorkspaceList.tsx` 是 08:44。因此**抽屉（counts）相关数字只取页面 B（源码）**；看板/WS 相关组件（`Board.tsx` 2026-11-05、`ws.ts` 更早）早于 dist，产物页数字对它们有效。

### 1.1 冷启动地板（与查询成本分开）

| 项 | 中位数 | 说明 |
|---|---|---|
| `node -e ""` | **59ms** | 进程启动地板 |
| `kb --version` | **209ms** | 进程 + 模块加载地板（CLI 全链路的下限） |

本机地板（59 / 209）略高于父会话给出的 29 / 169，量级一致、方向一致；差异来自进程复用与磁盘热态。**本报告所有「服务端查询耗时」均为进程内测量，已剔除上述地板。**

---

## 2. 首屏四段耗时分解

定义：挂载 → 首个数据请求发出 → 首屏可用 → 稳定（无持续请求）。
首屏可用 = 第一张任务卡进入 DOM；稳定 = 卡片数连续 3 个轮询周期不变。

### 2.1 产物页（dist，3 次）

| 段 | 含义 | run1 | run2 | run3 | 中位数 |
|---|---|---|---|---|---|
| S0 | navigation → FCP | 261 | 297 | 252 | **261ms** |
| S1 | navigation → 看板骨架可见 | 240 | 273 | 225 | **240ms** |
| S2 | navigation → 首个 `/api/issues` 发出 | 227 | 260 | 213 | **227ms** |
| S3 | 请求发出 → 首个响应落地 | 829 | 1409 | 690 | **829ms** |
| S4 | 响应落地 → 首卡可见 | 1116 | 1707 | 971 | **1116ms** |
| S5 | 首卡 → 卡片数稳定（663） | 43 | 39 | 41 | **43ms** |

- 骨架（240ms）到首卡（2172ms）之间，页面是**空列**：`boardShell=240`、`firstCard=2172`。
- S4 不是纯渲染：这段时间里**第二条重复请求（1.56MB）仍在飞**，纯渲染的独立实测见 §4。

### 2.2 源码页（dev，3 次）

| 段 | 中位数 |
|---|---|
| FCP | 494–631ms（dev 模块加载，非产物口径） |
| 首个 `/api/issues` 发出 | 465–812ms |
| 首卡可见 | 2088–2862ms |
| 卡片稳定 | 2130–2910ms |

> 源码页用于验证「抽屉 / counts」这一支，不用于首屏绝对耗时口径（vite dev 的 ESM 模块加载会抬高 S0/S1）。

### 2.3 A 类与 B 类分开的证据

**A 类（加载态没渲染）**

| 证据 | 位置 | 实测 |
|---|---|---|
| 看板把 pending 当空集合 | [Board.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/board/Board.tsx#L92-L96)、[Board.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/board/Board.tsx#L130-L140) `issues ?? []`，全程未读 `isLoading` | 骨架 240ms 可见，卡片 2172ms 才出现，中间 **0 卡 + 「暂无任务」** |
| 列空态 = 真空态 | [Column.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/board/Column.tsx#L133-L135) `issues.length === 0 → EmptyState` | 加载中与「真的没有任务」**视觉不可区分** |
| 切工作区先清空 | 新 `queryKey` 无 `placeholderData`，`data` 为 `undefined` | 采样：`57ms:0 83ms:0 … 290ms:0`，之后才跳到 290 张；出现空白列 = **true** |
| 工作区卡计数用 0 冒充 | [WorkspaceCard.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/workspace/WorkspaceCard.tsx#L121-L134)，注释原文「加载中（undefined）先按 0 渲染」 | `statFirstText="0"`，非零出现于抽屉打开后 **164 / 180 / 221ms** |

**B 类（数据真慢 / 真查不到）**

| 证据 | 实测 |
|---|---|
| `/api/issues` 全量 663 行（HTTP） | 中位 **684ms**，响应 **1,555,766 B**，无 `content-encoding`（未压缩） |
| 同请求 SQL（进程内，7 次中位） | **622.83ms**；去掉 `comment_count` 后 **8.79ms** |
| 首屏同时存在 2 条相同请求 | `t=227 d=829` 与 `t=228 d=1566`，两条 body 均 1,555,766 B |
| counts 端点（PERF-4b）是否可用 | **可用**：1 次请求、**956 B**、4.4ms、27 行 |

> 结论：**「计数恒显示 0」在 PERF-4b 之后已不是 B 类缺陷**（counts 端点正常且极快），残留的只是 A 类的 164–221ms 闪 0。用户截图里的持续全 0 对应的是 07:51 的旧产物（每卡一次全量），不是当前源码。

---

## 3. 计数与列表的取数行为

### 3.1 当前源码的取数集合（首屏 + 抽屉）

| 场景 | 请求 | 字节 | 耗时（隔离实例） |
|---|---|---|---|
| 首屏 `/api/issues?workspace=任务看板` | 1 | 1,555,766 | 684ms |
| 首屏 `['issues', ws, 'labels']`（**只为收集标签**） | 1 | 1,555,766 | ~600ms |
| 首屏 `/api/workspaces/:id/statuses` | 1 | 907 | 0.3ms |
| 抽屉打开：`/api/issues/counts?workspace_ids=<7>` | 1 | **956** | **4.4ms** |
| 抽屉打开：每个工作区卡自己的 `/api/workspaces/:id/statuses` | **6–7** | 907/条 ≈ 6.4KB | 7ms 并发 |
| 切工作区（未缓存） | 7 | ≈0.6MB | 770ms 墙钟 |

- **没有 N+1 全量列表了**（PERF-4b 生效）。
- 仍存在的两处重复取数：
  1. `useWorkspaceLabels` 用独立 key `['issues', ws, 'labels']` 拉一份**完整 issue 列表**只为抽标签（[workspaceLabels.ts](file:///D:/WorkSpaces/任务看板/apps/web/src/lib/workspaceLabels.ts#L18-L54)），与看板 key 不同 → 不去重，全量查询跑两遍。
  2. 每个工作区卡各拉一次状态字典（N 次，但单次 907B / 0.3ms，**不建议立项**）。
- 顺带观察：`WorkspaceCard` 的回落 query 与 `Board` **共用** `['issues', workspace.id]` 且 queryFn 不同（[WorkspaceCard.tsx](file:///D:/WorkSpaces/任务看板/apps/web/src/components/workspace/WorkspaceCard.tsx#L104-L109)）。当前两者 URL 一致所以行为等价，但「后注册的 queryFn 覆盖先注册的」会让归属难以判断（CDP initiator 栈实际指向 `WorkspaceCard`）。属隐患，不单独立项。

### 3.2 一次用户操作 → 多少 key 失效 → 实际打几次请求

服务端写评论会**连发两条事件**（[routes.ts](file:///D:/WorkSpaces/任务看板/apps/server/src/api/routes.ts#L1370-L1376)）：

| 事件 | 失效前缀 | 命中 key | 实际请求（实测） |
|---|---|---|---|
| `comment.added` | `['issues']` 全域 | `['issues',ws]`、`['issues',ws,'labels']`、`['issues','counts',visibleIds]` | 2 条全量 + 1 条 counts |
| `issue.changed` | `['issues',ws]` | `['issues',ws]`、`['issues',ws,'labels']` | 2 条全量 |
| **合计（写一条评论）** | 2 条事件 / 3 个 key | | **4 条全量 = 6,223,064 B + 1 条 counts** |

实测（源码页，抽屉打开）：

```
issues?workspace=e41eb0fb… d=503ms  b=1555766
issues?workspace=e41eb0fb… d=1082ms b=1555766
issues?workspace=e41eb0fb… d=1529ms b=1555766
issues?workspace=e41eb0fb… d=1934ms b=1555766
counts                     d=…      b=956
```

- 只改状态（单条 `issue.changed`）：**2 条全量 = 3,111,532 B**。
- 评论与状态两条事件对看板是**重复失效**：`comment.added` 用全域前缀已覆盖 `issue.changed` 的目标范围，且把 labels / counts 一起拖下水。

---

## 4. 数据慢 vs 渲染慢

| 指标 | 数值 | 口径 |
|---|---|---|
| 663 卡渲染（缓存命中切回，无网络） | **281 / 364ms**（2 次） | 产物页，纯 React 渲染 |
| 663 卡渲染（dev 源，无网络） | 579ms | 源码页 |
| 首屏 firstCard − 首个响应落地 | 971–1707ms | 含重复请求在飞 + 渲染 |
| DOM 节点 | **8310**，卡片 DOM **663** | 产物页实测 |
| longtask | n=2–3，合计 161–316ms，最长 133–160ms | 产物页 |
| 单次全量查询 SQL | 622.83ms | 进程内 |

**判断**：当前 663 卡规模下，**数据层成本（2×~600ms，且写操作放大到 4×）远大于渲染成本（~0.3s）**。按卡均成本约 0.42–0.55ms/卡外推：
- 到 1500 卡 ≈ 0.6–0.8s，开始可感；
- 到 2500 卡 ≈ 1.0–1.4s，必须处理。

**因此本卡结论：现阶段不建窗口化卡**（收益小于复杂度），先在报告与后续卡里给出 1500 卡阈值；超过阈值再立项。

---

## 5. SQL 耗时与 `EXPLAIN QUERY PLAN`

### 5.1 端点级（进程内 better-sqlite3，只读快照，7 次中位）

| 查询 | 中位数 | 行数 |
|---|---|---|
| `/api/issues` 全量（任务看板 663） | **622.83ms** | 663 |
| `/api/issues` 全量（Framework 290） | 267.33ms | 290 |
| `/api/issues` 仅看板所需 19 列（663） | **5.21ms** | 663 |
| `/api/issues/counts`（7 工作区） | **1.54ms** | 27 |
| `/api/workspaces` | 0.02ms | 7 |
| `/api/workspaces/:id/statuses` | 0.01ms | 5 |

响应体：FULL **1,613,942 B**（原始行）/ 线上 **1,555,766 B**；LEAN 19 列 **334,358 B**；counts **2,270 B**（单区 164 B）。

### 5.2 逐项裁剪（同一 FULL 查询，663 行）

| 变体 | 中位数 | 相对基线 |
|---|---|---|
| `i.*`（无 ORDER BY） | 8.71ms | 基线 |
| `+ ORDER BY` | 8.79ms | +1% |
| **`+ comment_count`** | **795.14ms** | **+9028%** |
| `+ dep join` | 9.29ms | +7% |
| `+ dep_violation`（递归 EXISTS） | 7.58ms | −13% |
| `+ decision ×4` | 8.36ms | −4% |
| `+ children ×2` | 6.99ms | −20% |

（单行成本受页缓存影响有 ±10% 抖动；`comment_count` 一项占满全部成本，与 §5.1 的 622.83 vs 5.21 互相印证。）

### 5.3 `EXPLAIN QUERY PLAN` 关键行

```
SEARCH i USING INDEX issue_parent_order (workspace_id=?)     ← 工作区定位走索引，正常
CORRELATED SCALAR SUBQUERY 1
  SCAN c                                                     ← ★ comment_count 全表扫描
SEARCH d USING INDEX ux_decision_active (issue_id=?)          ← 决策投影正常
SEARCH v USING INDEX sqlite_autoindex_issue_dependency_1 (blocked_issue_id=?)  ← 依赖正常
SEARCH c USING COVERING INDEX idx_issue_parent (parent_issue_id=?)             ← 子卡进度正常
USE TEMP B-TREE FOR ORDER BY                                  ← 排序 0.08ms，可忽略
```

- **唯一缺索引的全表扫描是 `issue_comment` 的 `issue_id`**（`SCAN c`）。其余相关子查询都命中索引。
- `issue_comment` 只有主键 / `(issue_id, id)` 之外的形态缺失，导致 663 × 4665 行 ≈ **309 万行访问/请求**。
- LEAN 计划同样没有 `SCAN c`，与 5.21ms 吻合。

> 该索引修复已由其他卡承担，本报告只作为根因引用，不复述修复方案。

---

## 6. 验收量化表（同库快照 / 同环境 / 3 次中位数）

| 项 | 改前基线 | 采集方式 |
|---|---|---|
| FCP | **261ms** | 产物页 ×3 |
| 看板骨架可见 | **240ms** | 产物页 ×3 |
| 首屏可用（首卡入 DOM） | **2172ms** | 产物页 ×3 |
| 首屏稳定（663 卡） | **2215ms** | 产物页 ×3 |
| 切换响应（未缓存，663→290） | **770ms**，其中空列 ≈230–700ms | 产物页 ×3 |
| 切换响应（缓存命中） | **281 / 364ms**，0 请求 | 产物页 ×2 |
| 首屏请求数（抽屉未开） | **8**（issues×2、statuses、sessions、decisions×2、workspaces 等） | 产物页 |
| 首屏 API 字节（抽屉未开） | **≈3.2MB**，其中 1.56MB 为重复 | 产物页 |
| 抽屉请求数 / 字节 | **8**（counts 1 + statuses 6–7）/ **≈7.4KB** | 源码页 |
| 一次写评论引发请求 | **4 条全量 + 1 counts = 6.22MB** | 源码页 |
| 一次改状态引发请求 | **2 条全量 = 3.11MB** | 产物页 |
| `/api/issues` SQL | **622.83ms**（7 次中位） | 进程内 |
| `/api/issues` 响应体 | **1,555,766 B**（无压缩） | HTTP |
| `/api/issues/counts` | **1.54ms / 956 B** | 进程内 + HTTP |

复算路径见 §8。

---

## 7. 后续卡拆分（只建卡，不实现）

| 卡 | 任务 id | 范围 | 依据 |
|---|---|---|---|
| PERF-6 | `cf75a266-0b30-4ac0-b01e-162a00f974fe` | 去掉 `['issues', ws, 'labels']` 对全量列表的重复请求（改轻量标签端点或从看板数据派生） | §3.1：首屏 3.11MB 中有 1.56MB 是纯重复；S4 的 1116ms 与该请求在飞窗口重叠 |
| PERF-8 | `a21b8549-d1de-4f72-8cee-f4cef39f5568` | WS 失效收敛：`comment.added` 不再全域失效 `['issues']`；与 `issue.changed` 合并去重；counts 独立 key | §3.2：一次评论 = 4×全量 + 1 counts |
| PERF-9 | `751c2729-80eb-4c13-b5a5-a8c7133dc141` | A 类加载态：看板列加载骨架（不得用 `[]`+「暂无任务」）、计数占位（不得用 0）、切工作区保留上一屏到新数据到达 | §2.3：空列 240→2172ms；切换空列 230–700ms；闪 0 164–221ms |

编号说明：PERF-5（`c98392ac`，`issue_comment(issue_id)` 索引）与 PERF-7（`e5b8eb90`，已废弃）已被占用，故新卡取 PERF-6 / PERF-8 / PERF-9。

**明确不立项（附实测依据）**：
- **看板窗口化**：663 卡纯渲染 281–364ms，阈值定在 1500 卡，未到。
- **statuses 批量端点**：7 次 × 907B × 0.3ms，收益 < 5ms。
- **gzip**：可把 1.56MB 压到 ~150KB，但索引修复后该请求会降到 ~10ms 量级，届时再评估更划算；现在立项会与索引卡抢同一段链路。
- **`issue_comment(issue_id)` 索引**：根因已由【PERF-5】`c98392ac-22f8-4e08-b638-f2bec6f532f6` 单独立项修复，本报告只引用该结论（§5 R1），不重复立项、不在本卡改 schema。

---

## 8. 复算命令

```powershell
# 数据规模
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.APPDATA+'\\AgentBoard\\agentboard.db',{readOnly:true});console.log(d.prepare('select count(*) n from issue').get(), d.prepare('select count(*) n from workspace').get(), d.prepare('select count(*) n from issue_comment').get())"

# SQL 与 EXPLAIN（脚本落在 %TEMP%\perf3-audit\sqlbench.mjs，7 次中位）
node "$env:TEMP\perf3-audit\sqlbench.mjs"

# 端点耗时/字节（隔离实例 8799）
node "$env:TEMP\perf3-audit\httpbench.mjs"

# 首屏四段（Edge headless + CDP，3 次）
node "$env:TEMP\perf3-audit\cdp.mjs"

# 切换 + WS 风暴
node "$env:TEMP\perf3-audit\cdp3.mjs" "http://127.0.0.1:5199/"
```

> 脚本与原始输出都在 `%TEMP%\perf3-audit\`（不进仓库）。隔离实例启动方式：`APPDATA=<临时目录> AGENTBOARD_DB=<VACUUM INTO 快照> AGENTBOARD_PORT=8799 node apps/server/dist/index.js`。

---

## 9. 未验证 / 口径差异

- 产物页 `dist` 落后于 PERF-4b 源码，抽屉相关结论只用源码页数字；**未重建 dist**（本卡不改代码，重建属收尾动作）。
- 「元素级渲染耗时」未用 React Profiler 单独采样，只给了「缓存命中切换 281–364ms」与「响应落地→首卡 971–1707ms」两个端到端口径；S4 中渲染与重复请求的**归因比例**未做 A/B 拆分（无基线对照，按卡面要求不臆断）。
- 父会话测得的 `comment_count` 增量（1139–1278ms）高于本报告的 795ms，方向一致；差异来自驱动/页缓存/是否含传输，本报告已按「进程内、只读快照、7 次中位」固定口径。
- 采样机为开发机（Edge headless、无 GPU），移动端/低配机未覆盖。
