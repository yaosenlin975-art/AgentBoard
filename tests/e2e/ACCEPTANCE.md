# C5 桌面端安装包级验收清单

对应卡：`0d9a4201-034b-434a-9e07-eb745b480aef`（C5 桌面端端到端验收）。

每条验收项写明操作步骤、预期结果、证据形式、对应自动化脚本，以及当前真实状态。

状态口径：

| 状态 | 含义 |
|---|---|
| 已通过 | 有本轮实测证据（命令输出/日志/断言结果），证据可复现 |
| 部分通过 | 关键分支已验，剩余分支未验（写明缺哪条） |
| 未测 | 无执行证据，不得写成通过 |
| 阻塞 | 前置产物缺失，无法执行（写明缺什么） |

环境：Windows（Node v24.11.1，pnpm 11.18.0），Electron 45.3.1，electron-builder 26.18.0。

## 0. 执行前置

| 项 | 要求 | 校验命令（仓库根） |
|---|---|---|
| 未打包目录版 | `dist-desktop/out/win-unpacked/AgentBoard.exe` 存在 | `Test-Path dist-desktop/out/win-unpacked/AgentBoard.exe` |
| 运行时树 | `dist-desktop/runtime/{node/node.exe, bin/*.cmd, cli/<id>, apps/{server,web}}` 齐全 | `node scripts/stage-desktop.mjs --verify` |
| 安装包 | `dist-desktop/out/AgentBoard-<version>-setup.exe` 存在 | `Get-ChildItem dist-desktop/out/*.exe` |
| E2E 依赖 | `tests/e2e/node_modules/@playwright/test` 已装 | `cd tests/e2e; npx playwright --version` |
| 现网隔离 | 验收全程用独立 `--user-data-dir` + 独立 `AGENTBOARD_PORT`，不碰 `%APPDATA%\AgentBoard` | 见 `tests/e2e/lib/desktop.js` 的 `makeIsolatedEnv()` |

**隔离做法（实测有效）**：Electron 45 在 Windows 上取 `appData` 走 KnownFolder，改 `APPDATA` 环境变量**无效**（`app.getPath('appData')` 仍是 `%APPDATA%`），只有启动参数 `--user-data-dir=<tmp>` 能把 `userData` 整体挪走。因此 DB、`config.json`、`window-state.json`、`logs/` 全部落临时目录。

**必须剔除的环境变量**：本机全局有 `ELECTRON_RUN_AS_NODE=1`，它会把 `electron.exe` 变成纯 Node 进程，Playwright/双击启动都会失败（`bad option: --remote-debugging-port=0`）。所有自动化启动前须从子进程 env 中删除 `ELECTRON_RUN_AS_NODE` 与 `NODE_OPTIONS`。

---

## 1. 全新环境启动（卡面验收项 1）

> 清掉 PATH 中 node/npm 全局目录后安装 .exe，双击启动成功（不经命令行）。

| 字段 | 内容 |
|---|---|
| 步骤 1 | 把 `PATH` 压到只剩 `%SystemRoot%\System32;%SystemRoot%\System32\Wbem`，开新终端执行 `where node` 与 `where codex` |
| 预期 1 | 两条 `where` 都返回退出码 1（证明本机 Node/CLI 不可见） |
| 步骤 2 | 双击 `dist-desktop/out/AgentBoard-<version>-setup.exe`，走完 NSIS 安装（默认 `%LOCALAPPDATA%`） |
| 预期 2 | 安装完成，桌面与开始菜单出现 `AgentBoard` 快捷方式；安装过程不要求管理员权限 |
| 步骤 3 | 双击桌面快捷方式启动 |
| 预期 3 | 窗口在 15s 内出现并显示看板；不弹「缺少 node」「ENOENT」类错误框 |
| 证据 | ① `where node` / `where codex` 的退出码与空输出（终端截图或命令输出）；② 快捷方式属性截图；③ `%APPDATA%\AgentBoard\logs\main.log` 头部（含 `mode=packaged`、`runtime=packaged root=…\resources\runtime`、`nodeExe=…\runtime\node\node.exe … exists=` 行）；④ 窗口首屏截图 |
| 自动化 | `tests/e2e/scripts/verify-restricted-path.js --mode packaged`（受限 PATH + 启动 + CLI 探测一次跑完，并打印上述日志行） |
| 当前状态 | **部分通过**：受限 PATH 下未打包目录版启动、窗口加载、服务就绪、四家 CLI 全部探测成功均已实测通过；**NSIS 安装包本步未测**（产物缺失，见 §7 阻塞） |

---

## 2. 功能验收（卡面验收项 2）

> 工作区创建（含原生文件夹选择）、任务建/改/拖拽流转、评论、WS 实时更新、聊天派发一轮、打包环境 kb CLI 可用。

| # | 操作步骤 | 预期结果 | 证据形式 | 状态 |
|---|---|---|---|---|
| 2.1 | 点左栏「+ 新增」→ 弹窗内点「浏览…」→ 在系统文件夹选择框里选一个已存在目录 → 点「创建」 | 原生文件夹对话框弹出（Electron `dialog.showOpenDialog`，不是网页 input）；选完路径回填输入框，名称自动填为文件夹名；创建成功后左栏出现该工作空间 | 截图（对话框 + 回填后弹窗 + 创建后左栏）；`POST /api/workspaces` 响应 JSON | 未测（需人工点原生对话框） |
| 2.2 | 在「待规划」列头点新建 → 填标题/描述 → 保存 | 卡片出现在「待规划」列；刷新后仍在 | 截图 + `GET /api/issues?workspace=<id>` 返回含该 id | 未测 |
| 2.3 | 打开卡片详情改标题/状态并保存 | 详情与卡片同步更新 | 截图 + `GET /api/issues/<id>` 字段值 | 未测 |
| 2.4 | 把卡片从「待规划」拖到「进行中」 | 卡片落到目标列；`PATCH` 成功；刷新后状态保持 | 截图（拖拽后）+ 网络面板/服务端日志中的 `PATCH /api/issues/<id>` | 未测（依赖新 UI 的 `data-testid="board-columns"` / `issue-card-<id>`；当前 `apps/web/dist` 是旧构建，选择器不一致，见 §7） |
| 2.5 | 在卡片详情发一条评论 | 评论区立即出现，`comment_count` +1 | 截图 + `GET /api/issues/<id>` 的 `comment_count` | 未测 |
| 2.6 | 另开一个客户端（浏览器 `http://127.0.0.1:<port>/`）或第二窗口改同一张卡 | 桌面端**不刷新**即更新（WS 推送）；顶栏/状态行显示「已连接 / 服务运行中」 | 双端截图 + WS 帧（DevTools → Network → WS） | **部分通过**：WS 状态「已连接」已在冒烟用例中断言通过；跨端实时同步未测 |
| 2.7 | 打开聊天面板，选一个已安装 CLI，发一轮消息 | 消息流式返回；轮次结束后会话状态离开「运行中」 | 截图 + `GET /api/sessions` | 未测（真实 CLI 计费/耗时，建议独立卡跑） |
| 2.8 | 在 `cmd` 里执行 `kb list-spaces`（打包环境，PATH 已含 `runtime\bin`） | 退出码 0，输出工作空间列表；`kb --version` 与 `runtime.json` 的 `desktopVersion` 一致 | 命令输出 + `dist-desktop/runtime/runtime.json` | 未测（打包后 PATH 注入分支已由 `verify-restricted-path.js` 间接证明 CLI 可探测，但 `kb` 子命令未逐一验） |

---

## 3. CLI 探测与内嵌回退（卡面验收项 3）

> 先探测本机，缺失才回退内嵌；受限 PATH 下四家徽标显示已安装与版本；某一家不可用时回退生效。

| 字段 | 内容 |
|---|---|
| 步骤 1 | 受限 PATH（仅 System32）下启动打包版 |
| 预期 1 | 顶栏四家徽标（CodeBuddy / Codex / OpenCode / DSH）全部为「已安装」样式（绿点），悬停 `title` 显示版本号 |
| 步骤 2 | `GET /api/clis` 取服务端探测结果 |
| 预期 2 | 四项 `installed: true` 且 `version` 非空 |
| 步骤 3 | 故意让其中一家不可用（把 `runtime\bin\<id>.cmd` 与 `runtime\cli\<id>` 临时改名），再启动 |
| 预期 3 | 该家退化：若本机 PATH 也探不到则该家显示「未安装」；其余三家不受影响；应用不崩、无白屏 |
| 证据 | ① 徽标截图（悬停显示版本）；② `/api/clis` 原始 JSON；③ `main.log` 中 `端口探测`、`runtime=` 行；④ 改名前后两次 `/api/clis` 差异 |
| 自动化 | `node tests/e2e/scripts/verify-restricted-path.js --mode packaged`（断言四项 installed + version 非空） |
| 当前状态 | **已通过（受限 PATH 侧）**。实测结果：`where node` 退出码 1、`where codex` 退出码 1；`/api/clis` 返回 codebuddy `2.81.2`、codex `codex-cli 0.130.0`、opencode `1.19.2`、dsh `0.2.2-rc.1`，四项 `installed: true`。**「某一家不可用 → 回退/退化」分支未测**（需临时改名运行时树，属破坏性操作，留到安装包定版后做） |

---

## 4. 生命周期（卡面验收项 4）

> 单实例、退出无残留 node 子进程、重装/卸载不破坏 userData。

### 4.1 单实例

| 字段 | 内容 |
|---|---|
| 步骤 | 启动第一个实例并等窗口出现 → 同一 `--user-data-dir` 再启动第二个 → 观察 30s |
| 预期 | 第二个实例自行退出（退出码 0），不新增监听进程、不新增服务子进程；第一个实例窗口被聚焦、`/api/workspaces` 仍 200；`main.log` 里 `==== 启动` 只有 1 条 |
| 证据 | 第二个进程退出码与 stderr；两次 `Get-NetTCPConnection -LocalPort <port>` 的 OwningProcess；`main.log` 中 `==== 启动` 行数 |
| 自动化 | `node tests/e2e/scripts/verify-single-instance.js --mode packaged` |
| 状态 | **已通过**（实测：第二实例 exit 0；监听 PID 全程唯一；`serverChildren` 数量恒为 1；主进程启动记录 1 条） |

### 4.2 退出无残留

| 字段 | 内容 |
|---|---|
| 步骤 | 启动 → 记录 Electron 主进程 PID → 取该 PID 的**进程树** → 关窗退出 → 轮询 20s |
| 预期 | 进程树内所有 PID（含 `node.exe` 服务子进程）全部消失；端口不再监听 |
| 证据 | 关闭前后的 PID 列表与存活判定输出；`Get-NetTCPConnection -LocalPort <port>` 空结果 |
| 判定口径 | **按进程树，不按进程名**。本机常驻其他 `node.exe`（如看板服务 PID 18716），按名字判会误报残留 |
| 自动化 | `node tests/e2e/scripts/check-residual-processes.js --mode packaged` |
| 状态 | **已通过**（实测：7 个 PID 全部退出，`allGone: true`，`survivors: []`，`portReleased: true`；现网 18716 未被波及） |

### 4.3 重装/卸载保留数据

| 字段 | 内容 |
|---|---|
| 步骤 | 建 1 个工作空间 + 2 张卡 → 卸载（控制面板或安装目录 Uninstall）→ 检查 `%APPDATA%\AgentBoard\` → 重装并启动 |
| 预期 | 卸载后 `agentboard.db`、`config.json` 仍在（`electron-builder.yml` 的 `deleteAppDataOnUninstall: false`）；重装后工作空间与卡片仍在 |
| 证据 | 卸载前后 `Get-ChildItem %APPDATA%\AgentBoard` 对比；重装后首屏截图 |
| 状态 | **未测**（需真实安装包；当前无 NSIS 产物） |

---

## 5. 稳定性（卡面验收项 5）

### 5.1 连续启动关闭 3 次

| 字段 | 内容 |
|---|---|
| 步骤 | 连续 3 轮「启动 → 断言窗口与 WS → 正常退出」，每轮换独立 `--user-data-dir` 与端口 |
| 预期 | 3 轮全绿；每轮 `main.log` 无 `[error]` 行；无残留进程 |
| 证据 | 每轮断言输出 + 三轮 `main.log` |
| 自动化 | `npx playwright test specs/desktop-smoke.spec.js`（含 2 轮稳定性用例）；3 轮版在 C5 执行时把循环上限改 3 |
| 状态 | **部分通过**（dev 模式 2 轮已通过；打包版连续 3 轮未跑） |

### 5.2 8787 被占用

| 字段 | 内容 |
|---|---|
| 步骤 A（逻辑层） | 直接调 `apps/desktop/src/bootstrap.js` 的 `ensureServer`，分别对着①在跑的 AgentBoard ②返回 JSON 对象的假 HTTP 服务 |
| 预期 A | ①`kind=reused` ②`kind=foreign`（判定文案：`GET /api/workspaces 返回 JSON 但不是数组`） |
| 步骤 B（应用层·复用） | 完整启动桌面端指向在跑的 AgentBoard |
| 预期 B | `main.log` 出现「复用已在运行的 AgentBoard 服务，不启动子进程」；**无**「已启动服务子进程」行；进程树无 `node.exe` 子进程；窗口正常创建 |
| 步骤 C（应用层·外来占用） | 起假 HTTP 服务占独立端口，完整启动桌面端指向该端口 |
| 预期 C | `main.log` 出现「端口 N 被其它程序占用」；弹原生 `dialog.showMessageBoxSync`（进程被对话框阻塞仍存活）；**不创建** BrowserWindow；用户点「退出」后进程正常退出、不崩 |
| 证据 | 三段的日志行 + 进程存活判定 + `Get-NetTCPConnection` |
| 自动化 | `node tests/e2e/scripts/verify-port-conflict.js --mode packaged` |
| 状态 | **已通过**（实测：A1 `reused`「已有 AgentBoard 实例（工作空间 4 个）」；A2 `foreign`；B `reuseLogLine: true`、`spawnedLine: null`、`nodeChildren: []`、窗口已创建；C `occupiedLogLine: true`、`windowCreated: false`、进程存活于对话框） |

---

## 6. 数据持久化（卡面验收项 6）

> 数据库落 userData，重启后任务仍在。

| 字段 | 内容 |
|---|---|
| 步骤 | 启动 → 建工作空间 + 建卡 → 记录 `GET /api/issues?workspace=<id>` → 退出 → 用**同一** `--user-data-dir` 重启 → 再取同一接口 |
| 预期 | 两次返回的卡片 id/标题/状态一致；`agentboard.db` 位于 `<user-data-dir>\agentboard.db`（不是 `%APPDATA%\AgentBoard`） |
| 证据 | 两次接口 JSON 对比；`Get-ChildItem <user-data-dir>` 显示 `agentboard.db`、`config.json`；`main.log` 的 `userData=` 行 |
| 状态 | **未测**（冒烟用例只验证了**空库**走空态、`userData` 落在临时目录；「写入 → 重启 → 仍在」的往返未跑） |

---

## 7. 当前阻塞与未测原因

| 阻塞 | 事实 | 影响 |
|---|---|---|
| 无 NSIS 安装包 | 上一轮 `build:desktop` 在 nsis 阶段 `connect ETIMEDOUT 140.82.112.3:443`（连 GitHub 下载 nsis 工具链）失败，只产出 `win-unpacked` | §1 步骤 2–3、§4.3 无法执行 |
| `apps/desktop` 源码与 `dist-desktop/runtime` 运行时树从磁盘消失 | 2026-11-13 13:42:45 工作区被切到 `codex/agentboard-shared-knowledge-mcp-shared...` 分支（HEAD=3af3d8d），原内容被 `git stash` 收走（`stash@{0}` = 5cd2bad）。`dist-desktop/runtime/{node,bin}` 已空、`win-unpacked/AgentBoard.exe` 与 `app.asar` 丢失 | 本清单所有自动化脚本当前**不可执行**；恢复 `apps/desktop` + 重跑 `stage-desktop.mjs` 后可原样复用 |
| `apps/web/dist` 与 `apps/web/src` 代次不一致 | 当前磁盘上的 `dist` 是 13:29 构建的旧 TopBar 版；本分支 `src` 已是 `shell/SideBar` + `shell/TopBar` 新结构（`主导航`、`sidebar-entry-*`、`board-search` 等 testid 只在 src 里，dist 中没有） | §2.4 等依赖 UI 选择器的项需先重新构建 `apps/web/dist` 再断言；`specs/desktop-smoke.spec.js` 现有断言针对旧 UI，重新构建后需同步更新选择器 |
| 真实 CLI 派发需计费/授权 | 四家 CLI 均已安装，但发一轮消息会真实消耗额度 | §2.7 建议单独安排一次执行，不与其余项混跑 |

---

## 8. 一键执行顺序（产物齐备后）

```powershell
# 仓库根
cd D:\Workspaces\AgentBoard

# 1) 前置校验
Test-Path dist-desktop/out/win-unpacked/AgentBoard.exe
Test-Path dist-desktop/out/AgentBoard-0.1.0-setup.exe

# 2) E2E 依赖
cd tests/e2e
npm install --no-audit --no-fund      # 首次

# 3) 冒烟（dev 模式，2 用例）
npx playwright test specs/desktop-smoke.spec.js --reporter=list

# 4) 四个辅助脚本（打包产物）
node scripts/verify-restricted-path.js --mode packaged
node scripts/check-residual-processes.js --mode packaged
node scripts/verify-single-instance.js --mode packaged
node scripts/verify-port-conflict.js --mode packaged

# 5) 服务端基线（与桌面端改动无关的回归闸门）
cd ..\..
corepack pnpm --filter @agentboard/server test
```

所有脚本退出码 0 = 通过，1 = 断言失败，2 = 脚本自身异常。失败时脚本打印具体步骤 JSON，不吞错。

---

## 9. 证据归档约定

| 证据类型 | 落盘位置 |
|---|---|
| Playwright 失败产物 | `tests/e2e/.artifacts/<用例名>/`（trace.zip、test-failed-1.png、error-context.md） |
| 脚本输出 | 重定向到 `.logs/qa-<脚本名>-<时间戳>.log` |
| 主进程日志 | `<user-data-dir>/logs/main.log` |
| 服务子进程日志 | `<user-data-dir>/logs/server-YYYYMMDD.log` |
| 界面截图 | 人工验收时存 `.qa-temp/`，命名 `<验收项号>-<动作>.png` |
| 卡面记录 | 按项目规则用 `kb comment <C5-id> --stdin` 写测试标题/步骤/预期/实际状态；未测项写「未测」与原因 |
