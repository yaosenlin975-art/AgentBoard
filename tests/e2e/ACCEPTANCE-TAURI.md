# Tauri 桌面壳验收清单（当前分支 `codex/agentboard-shared-knowledge-mcp-accounts`）

验收对象：`desktop/`（Tauri v2 壳）+ `scripts/package-portable.mjs`（便携包）+ `tauri.conf.json` 的 NSIS 打包。

依据：`desktop/src-tauri/src/main.rs`、`server_process.rs`、`tauri.conf.json`、`ui/index.html`、`scripts/package-portable.mjs`、`scripts/portable/*.cmd`、`Docs/design-2026-11-05-desktop-presentation.md` §8、`apps/server/src/index.ts`、`apps/server/src/services/serverLock.ts`。

状态口径：

| 状态 | 含义 |
|---|---|
| 可验（自动） | 有命令行/脚本可判定的客观结果，退出码即可作证据 |
| 可验（半自动） | 需脚本 + 一次人眼确认，或需 GUI 会话 |
| 仅人眼 | 必须人工操作/观察（原生对话框、托盘菜单、视觉） |
| 当前必失败 | 代码或打包配置决定其不可能达成（见 §9） |

**执行分组**（按「此刻能不能动手」分，D1/D2/D3 为当前分支的在建卡）：

| 组 | 前置 | 条目 | 条数 | 状态 |
|---|---|---|---|---|
| **A：现在能跑** | 无（只依赖源码与 Rust 工具链） | 0.1.1 锁一致性 ✅、0.1.2 探活端点 ✅、0.1.3 工具链 ✅、R1 `cargo test`（**19/19 通过**）、A-§ 静态断言集（21 条） | **5** | ✅ 已完成 |
| **B：等 D1 产物** | D1 ✅ **已就绪**（exe 12.4MB，14:52） | 1.1、1.2、1.3、1.4、1.5、1.6、2.1、2.2、2.3、2.4、2.5、3、4、5、6、7.1、7.2、7.3、7.4、7.5、8、9.4、9.6、9.9 | **24** | 可执行 |
| **C：等 D3 便携包** | D1 ✅ + D3 进行中 | 10.4 包内容自检、§12 全流程串跑、10.2 CDP 可行性、9.2 日志落点、9.10 entry 逃逸 | **5** | 部分可执行 |
| **D：安装包级** | D2 ✅ 已产出 34.23MB | 9.5 NSIS 自包含验证（方案甲已落地） | **1** | 可执行 |

合计 **35 条**（A5 + B24 + C5 + D1）。A 组已完成；B/C/D 待 D4 执行。

> R1 = 本文件 §R 的 `cargo test`。A-§ = §A 的 21 条静态断言。

---

## 0. 禁止事项（硬约束）

> 以下为**不可协商**项。D4 验收须逐条确认未被破坏；任何一条被破坏即判失败，不看其他项。

| # | 禁止 | 原因 | 自动检查 |
|---|---|---|---|
| **P1** | **禁止启用 `tauri-plugin-single-instance` 的 `semver` feature** | 启用后 Windows mutex 名带版本号，0.1.0 与 0.2.0 可各自起一个实例，绕过共享 `%APPDATA%` 与 `server.lock` 保护 → **同库双写 + 端口冲突**（SQLite WAL 会被两个进程互踩，迁移期抛 duplicate column name） | A20（静态断言） |
| **P2** | 禁止用「`%APPDATA%\AgentBoard\logs\server.log` 是否存在」判健康 | 该文件由 `appendServerLog` 在特定路径写，且 D6 前落点不固定；陈旧文件会误导。健康判据走 `/api/version` + 端口 + 看板渲染（见 §9.2） | 人工核对本清单 §9.2 |
| **P3** | 禁止引用 `%APPDATA%\AgentBoard\logs\main.log` 作为证据 | Tauri 壳不写 `main.log`（全树无写入实现）。现存那份是上一分支 Electron 壳的遗留，引用即张冠李戴 | A19（静态断言） |
| **P4** | 禁止把便携包解在仓库根下做验收 | 会触发 §9.10 的 entry 逃逸：跑仓库里的 server 而非包内副本，验收结论失真 | A21（静态断言）+ 人工解到 `$env:TEMP` |
| **P5** | **禁止用「进程树里有没有 `conhost.exe`」判「无控制台黑窗」** | 只要进程是控制台子系统，哪怕 `CREATE_NO_WINDOW` 生效也**照样有** conhost（实测：裸起 node 不带 `CREATE_NO_WINDOW` 有 conhost，带 `CREATE_NO_WINDOW` 的壳拉起的 node 也有）。真正的「黑窗」是**可见窗口**。判据应为 `conhost.MainWindowHandle == 0` 且壳自身 `MainWindowHandle != 0` | `d4-run.ps1` V7 |
| **P6** | **禁止在产物早于源码时跑验收** | 2026-11-13 实际撞过：三个产物（安装包 14:40 / release exe 14:52 / 便携包 14:53）全早于 `server_process.rs`(15:04) 与 `main.rs`(15:08)，D6/D7 修复根本没进产物 → 跑出一堆**假失败**，极易误判成代码缺陷 | `d4-run.ps1` 的 `Assert-ArtifactsFresh`（产物陈旧直接 exit 3） |
| **P7** | **禁止用「产物外层 mtime」判新鲜度，必须比内层 PE** | 2026-11-13 实际撞过：便携包 zip 外层 mtime **16:09:59** 看着是新的，包里 `agentboard-desktop.exe` 的 PE TimeDateStamp 却是 **14:52:49**（源码 release 为 16:11:22）——包里缺 D7+D10。只看外层 mtime 会放行「新包配旧壳」。所有「打包类」产物一律按「外层容器 mtime 不可信，必须验内层内容」对待 | `Assert-ArtifactsFresh` 的 `Get-PeBuildTimeFromZip` / `Get-PeBuildTimeFromNsis` |
| **P8** | **禁止用「功能测试全绿」推出「产物是新构建」** | 版本判据（V8/V9）优先于功能判据（V10/V11）。2026-11-13 实测：缺 D7+D10 的旧便携包 **能正常启动、起服务、`GET /` 200、entry 也在包内**——V10/V11 全 PASS。原因：便携包布局下 `../apps/server/dist/index.js` 本来就存在，D10 的包含性校验是「放行」而非「拒绝」；D7 是纯体验增强，不影响功能。**「能跑」和「是新构建」是两件独立的事** | `d4-run.ps1` V8（版本）+ V9（字符串）先跑，V10/V11 后跑 |

当前状态（2026-11-13 16:4x 实测）：P1 未违反（`tauri-plugin-single-instance = "2"`，无 `features`）；P2/P3 已写入判据；P4 已记为验收操作要求；P5 已修正进 `d4-run.ps1`；P6/P7/P8 均为验收脚本硬门禁。**P7 在 2026-11-13 16:2x 那次验收中实际拦下了「外层 mtime 新、内层壳旧」的便携包；P8 在 16:5x 用旧包自测时得到验证（V10/V11 对不合格包照样全绿）。**

### P8 的推论：三类判据不可互相替代

| 判据类 | 回答什么问题 | 代表项 | 能否被其他类代替 |
|---|---|---|---|
| **版本判据** | 这段代码是新的吗？ | V8（内层 PE）、V9（关键串） | **不能**。功能测试对旧构建同样通过 |
| **功能判据** | 这个功能能用吗？ | V10（起停+健康+`GET /`）、V11（点开头路径） | 不能。新构建也可能功能坏 |
| **机制判据** | 代码里有没有这道防线？ | A21/A22（静态断言） | 不能。机制存在不代表产物含它 |

危险组合：**机制判据 PASS（源码有）+ 功能判据 PASS（旧包也能跑）** → 若不跑版本判据，会得出「交付物合格」的错误结论。这正是 2026-11-13 那次差点漏掉的原因。

### P7 / P8 共同的方法论

`Get-Item zip | Select LastWriteTime` 与 `Get-FileHash zip` 是**两个都会给出「没问题」假象的操作**。后者尤其危险：它看起来在做严格校验，实际校验的是**容器的完整性**而非**内容的新旧**。任何「打包类」产物都必须解包验内层。

### P7 的实现口径（判据细节）

| 产物 | 判据 | 不用什么 |
|---|---|---|
| 便携包 zip | 解出 `agentboard-desktop.exe` → 读 PE `TimeDateStamp`，与 `target/release/agentboard-desktop.exe` 的 PE 比，容忍 ±2s | 不用 zip 外层 mtime；不用 zip 内条目 mtime（zip 条目时间也可能被保留旧值） |
| NSIS 安装包 | 7z 解出 `agentboard-desktop.exe` → 比 **PE TimeDateStamp + 文件大小** | **不用 sha256**：Tauri 会在 exe 里写 `_NSIS` / `_UNK` 三字节 bundle 标记，sha256 必然不同，会误判成「装了旧 exe」 |
| release exe 自身 | mtime 与 PE 都应晚于源码 | — |

**为什么 zip 条目 mtime 也不可信**：`338f667.zip` 里 `AgentBoard/app/desktop/agentboard-desktop.exe` 条目时间就是 `14:52:48`（旧壳真实值），但同目录条目 `AgentBoard/app/desktop/` 是 `16:09:54`（打包时刻）。按目录条目或外层 mtime 判都会放行。**唯一可靠的是文件内容里的 PE 头。**

---

## 0.1 先确认的四件事（最后更新：2026-11-13）

### 0.1.1 `server.lock` 一致性与 `server.lock` 存在性

**结论：反序列化兼容，路径一致，本分支 server 确实写这个文件 —— 判定通过。**

| 项 | 壳侧（`server_process.rs`） | 服务端（`apps/server/src`） | 一致 |
|---|---|---|---|
| 路径 | `config_dir()/server.lock`，`config_dir = %APPDATA%\AgentBoard`（`env::var_os("APPDATA")`） | `configDir()/server.lock`，`configDir = join(appDataDir(), 'AgentBoard')`，`appDataDir = process.env.APPDATA` | ✅ 同一路径 |
| 文件名 | `server.lock`（`server_lock_path()`） | `server.lock`（`serverLock.ts:30`） | ✅ |
| 结构 | `struct LockFile { pid: u32, #[serde(default)] port: Option<u16> }`（D6 起） | `{ pid, port, dbPath, startedAt, instanceId }`，`JSON.stringify(info, null, 2)` + `\n` | ✅ serde 忽略未知字段；缺 port 时 `default` 兜成 `None` |
| 写入者 | 只读 | 服务进程 `acquireServerLock`（`O_CREAT\|O_EXCL`）持有，`process.on('exit')` + SIGINT/SIGTERM 释放 | ✅ 壳不改写，只按 pid 匹配后删除 |
| 当前磁盘实证 | — | `%APPDATA%\AgentBoard\server.lock` 存在，内容 `{"pid":36008,"port":8787,"dbPath":"…agentboard.db","startedAt":1794549428626,"instanceId":"inst-rs8-mweke93m"}` | ✅ |

补充事实（影响判定口径）：

1. **锁只在 `main()` 路径写。** 可编程启动 `startServer()`（测试用）不写 `server.lock`——当前分支把它提前到了 `main()` 的 `acquireServerLock`（`index.ts:365`）。壳走 `node dist/index.js`，命中 `main()`，锁一定写。
2. **锁由服务进程持有，不由启动器持有。** 壳 kill 子进程后，Node 的 `process.on('exit')` 不会执行（Windows `TerminateProcess` 不可捕获），因此锁文件会以「死 pid」留在盘上，必须靠壳侧 `remove_lock_owned_by(pid)` 补删。这正是 `server_process.rs:73-74` 声明的设计，实测语义与代码一致。
3. **`remove_lock_owned_by` 的匹配口径是 pid 相等。** 壳传的是 `child.id()`（直接 spawn 的 node 进程），与服务端 `process.pid` 相同 → 能删。若服务端发生 `/api/system/restart` 自重启，新进程 pid 不同且旧进程仍可能持有锁 —— D6 已用 `decide_takeover` 补上「第二意见」终止（见 §9.4）。
4. **每工作区锁（`<workspace>/.agentboard/server.lock`）与中心锁同名但不同目录**，共用 `acquireServerLock` 实现；壳只碰 `%APPDATA%\AgentBoard\server.lock`，不会误删工作区锁。✅

### 0.1.2 探活端点

壳用 `GET /api/version`，要求 `200` + 响应体含 `"name":"agentboard-server"`（`server_process.rs:182,192`）。

- 该端点实际定义在 `apps/server/src/api/routes/systemMiscRoutes.ts:115`（设计文档 §8.2 写的 `systemRoutes.ts:132` 是**旧位置**，文档漂移，不影响实现）。
- 实测线上响应为紧凑 JSON：`{"name":"agentboard-server","version":"0.1.0","pid":36008,…}` → `text.contains("\"name\":\"agentboard-server\"")` 命中；状态行 `HTTP/1.1 200 OK` 命中 `starts_with("HTTP/1.1 200")`。✅
- 2026-11-13 15:01 真机复验（release exe，port 18890）：`{"name":"agentboard-server","version":"0.1.0","pid":33100,"instance_id":"inst-pj…` → 200。✅

### 0.1.3 工具链（2026-11-13 15:00 更新）

| 项 | 当前实测 | 影响 |
|---|---|---|
| `cargo` / `rustc` | ✅ **已就位**：`cargo 1.100.0`、`rustc 1.100.0`（`D:\tools\rust\cargo\bin`） | 可构建、可跑 `cargo test` |
| `desktop/src-tauri/target/release/agentboard-desktop.exe` | ✅ **已产出**：12,374,016 B，2026-11-13 14:52:49 | D1 产物就绪，B 组可执行 |
| `dist-package/AgentBoard/` | ✅ **已产出**（D3 进行中，脚本仍在改） | C 组部分可执行 |
| NSIS 安装包 | ✅ 34.23 MB（D2 产出） | 安装包级验收可执行 |
| WebView2 Runtime | 设计文档 §8.4 记录 `156.0.4314.58`；本轮真机启动成功即证明可用 | — |
| node | `v24.11.1` | 便携包 `runtime\node.exe` 由 `process.execPath` 复制 |

---

## 1. 窗口（自动 + 半自动）

| # | 验收项 | 步骤 | 预期 | 证据 | 状态 |
|---|---|---|---|---|---|
| 1.1 | 壳能起来、进程存活 | 双击 `<stage>\app\desktop\agentboard-desktop.exe`（或 `start.cmd`），等 10s，`Get-Process agentboard-desktop` | 进程存在，无立即退出 | `Get-Process` 输出（PID/StartTime） | 可验（自动） |
| 1.2 | 窗口标题与尺寸 | `(Get-Process agentboard-desktop).MainWindowTitle`；或用 UIAutomation 取 `BoundingRectangle` | 标题 `AgentBoard`；尺寸 1280×860（`inner_size`），最小 900×600 | PowerShell 输出 / 截图 | 可验（自动） |
| 1.3 | 启动页先出现，健康后导航到服务页 | 启动后 1s 内截图 → 服务就绪后再截图 | 第一张是启动页（`正在启动本地服务…` + 脉冲圆点），第二张是看板（有左栏/看板列） | 两张截图 + `location.href`（经 CDP，见 §10.2） | 可验（半自动） |
| 1.4 | 无原生标题栏，页面自绘标题栏生效 | 看窗口顶部 | 无系统标题栏；顶部是 `ui/index.html` 或 `WindowTitleBar` 自绘的 32px 条，含最小化/最大化/关闭三键 | 截图 | 仅人眼 |
| 1.5 | 自绘三键可用 | 点最大化→再点还原→点最小化→任务栏恢复 | 最大化/还原图标切换；最小化进任务栏 | 截图序列 | 仅人眼 |
| 1.6 | 拖拽移动窗口 | 按住标题栏空白处拖动 | 窗口跟随移动（`data-tauri-drag-region="deep"` + `core:window:allow-start-dragging`） | 录屏/两次窗口坐标 | 仅人眼 |

> 1.4/1.5 的权限前提：`capabilities/decision-notifications.json` 声明了 `core:window:allow-minimize|allow-toggle-maximize|allow-is-maximized|allow-close|allow-start-dragging`，但同一 capability 带 `"remote": { "urls": ["http://127.0.0.1:8787"] }`。该 `remote` 段是否覆盖**本地 `index.html` 启动页**，需实测确认（见 §9.6）。若不覆盖，启动页三键会静默失效。

---

## 2. 托盘（仅人眼 + 自动化探针）

| # | 验收项 | 步骤 | 预期 | 证据 | 状态 |
|---|---|---|---|---|---|
| 2.1 | 托盘图标存在 | 看系统托盘区 | 出现 AgentBoard 图标（`icons/tray.ico` 取 64×64 帧后按 DPI 缩放） | 托盘区截图 | 仅人眼 |
| 2.2 | 左键 = 显示并聚焦窗口 | 窗口隐藏时左键单击托盘图标 | 窗口出现并获焦（`show_menu_on_left_click(false)`，不弹菜单） | 截图 + `window_snapshot` | 可验（自动，用 2.5 探针） |
| 2.3 | 右键 = 菜单「显示 / 退出」 | 右键托盘图标 | 菜单只有两项：显示、退出 | 菜单截图 | 仅人眼 |
| 2.4 | 菜单「显示」等效左键 | 窗口隐藏时右键 →「显示」 | 窗口出现并获焦 | 截图 | 仅人眼 |
| 2.5 | 托盘唤醒路径可自动判定 | `agentboard-desktop.exe --probe-tray-ms 4000 --probe-out D:\tmp\tray.json` | 退出码 0；`tray.json` 含 `before/hidden/after_wake` 三段，`hidden.visible=false`、`after_wake.visible=true` 且 `focused=true` | `tray.json` + stderr `托盘探针结果已写入` | 可验（自动） |

> 2.5 是 `main.rs:310-334` 内置的验收钩子，走的是与托盘左键**完全相同**的 `wake_main_window`，不带参数时不参与运行。

---

## 3. 单实例（可验，自动）

| 字段 | 内容 |
|---|---|
| 步骤 | ① 启动第一个实例，等窗口出现；② 再启动第二个（同 exe、同环境）；③ 观察第二个进程 15s；④ 检查窗口与端口 |
| 预期 | 第二个进程立即退出（`tauri-plugin-single-instance` 在插件初始化阶段拦截，退出码 0）；不出现第二个窗口；`%APPDATA%\AgentBoard\server.lock` 的 pid 不变；8787 监听 PID 不变；第一个窗口被唤到前台 |
| 证据 | 第二个进程 `ExitCode`；两次 `Get-NetTCPConnection -LocalPort 8787 -State Listen` 的 `OwningProcess`；两次 `Get-Content %APPDATA%\AgentBoard\server.lock`；`Get-Process agentboard-desktop` 的进程数 |
| 自动化 | 见 §10.1 脚本 1（PowerShell，可直接跑） |
| 状态 | 可验（自动） |

关键点：单例插件注册在 `builder` 最前（`main.rs:340`），第二个实例不会进入 `setup`，因此**不会拉起第二个 server**。服务侧还有第二层保护（`server.lock` 拒绝同 configDir 双开，`index.ts:373-381` 打印持有者并 `exit(4)`）。

---

## 4. 关窗 = 隐藏到托盘，服务继续（仅人眼 + 自动断言）

| 字段 | 内容 |
|---|---|
| 步骤 | ① 启动并等服务就绪；② 点自绘标题栏的关闭键（X）；③ 观察进程与端口；④ 记录 `server.lock` pid |
| 预期 | 窗口消失；`agentboard-desktop.exe` 进程**仍在**；8787 仍监听（同一个 node PID）；`server.lock` 内容不变；`http://127.0.0.1:8787/api/version` 仍 200 |
| 证据 | `Get-Process` 前后对比；`api/version` 两次响应；`server.lock` 内容 |
| 自动化 | 半自动：关闭动作需人点，或改用 `--probe-tray-ms`（其内部 `window.hide()` 与关窗隐藏同语义，但**不经过** `CloseRequested` 拦截分支）。要验 `prevent_close` 分支本身仍须人点 |
| 状态 | 可验（半自动） |

---

## 5. 退出停服 + 释放 `server.lock`（可验，自动）

| 字段 | 内容 |
|---|---|
| 步骤 A（人眼主路径） | 右键托盘 →「退出」，等 ≤20s |
| 步骤 B（自动化等价路径） | `agentboard-desktop.exe --quit-after-ms 12000`（`main.rs:411-418`，走与托盘「退出」完全相同的 `shutdown` + `exit(0)`） |
| 预期 | `agentboard-desktop.exe` 与它的 `node.exe` 子进程都消失；8787 不再监听；`%APPDATA%\AgentBoard\server.lock` **被删除**；`api/version` 连接失败 |
| 证据 | 进程树前后 PID 列表；`Get-NetTCPConnection -LocalPort 8787` 空；`Test-Path server.lock` = False |
| 自动化 | 见 §10.1 脚本 2 |
| 状态 | 可验（自动；步骤 B 覆盖步骤 A 的停服语义，步骤 A 只差「点菜单」这个动作） |

判定口径（重要）：

- `stop()` 只有 8s 等进程退出、5s 等端口释放、3s 等锁删除（`server_process.rs:86,104,309`），**总预算约 16s**，脚本等待上限给 25s。
- 锁删除只在 pid 匹配或持有者已死时发生；持有者仍活着时**故意不删**（避免误删接管者的锁）。若实测残留锁且 pid 与 `api/version` 的 pid 不同，属「锁已被别的活实例接管」，不是缺陷。
- **外部实例（`child=None`）不终止、不碰锁**（`server_process.rs:78-81`）。因此「复用在跑的服务」场景下退出应用后服务仍在 —— 这是设计行为，验收时不得判为失败。

---

## 6. 端口读 `config.json`（可验，自动；含 §9.1 的口径冲突）

| 字段 | 内容 |
|---|---|
| 步骤 | ① 备份并改 `%APPDATA%\AgentBoard\config.json` 的 `port` 为 `8899`；② 确认 8899 空闲；③ **不设任何环境变量**，直接起壳 exe；④ 观察探活目标与监听端口 |
| 预期 | 壳探活 `http://127.0.0.1:8899`；spawn 的 node 绑 8899；窗口导航到 `http://127.0.0.1:8899`；`api/version` 在 8899 上 200 |
| 证据 | `Get-NetTCPConnection -LocalPort 8899`；`api/version`；`%APPDATA%\AgentBoard\server.lock` 的 `port` 字段应为 8899；窗口地址 |
| 解析口径 | `resolve_port()` 只读 `config.json` 的 `port`（整数 1..65535），非法/缺失/损坏退回 8787（`server_process.rs:37-53`）。与 `config.ts` 的 `mergeValidFields` 同口径，但**不读 `AGENTBOARD_PORT`** |
| 状态 | 可验（自动），但见 §9.1 的 `start.cmd` 冲突 |

---

## 7. 启动失败提示（可验，半自动）

| # | 场景 | 制造方式 | 预期 | 证据 | 状态 |
|---|---|---|---|---|---|
| 7.1 | 找不到服务入口 | 把 `<stage>\app\apps\server\dist` 改名 | 窗口显示启动页 + `本地服务启动失败` + 明细含「未找到服务入口 apps/server/dist/index.js（已查找：…）」；进程不崩，可拖拽/关闭 | 截图 + 错误文案 | 可验（半自动） |
| 7.2 | 端口被非看板程序占用 | 先用任意 HTTP 服务占 8787，再起壳 | 服务子进程起而 bind 失败 → 5s 重试窗口耗尽后退出 → 页面显示「服务进程启动后立即退出（exit code: 1）。入口：… 日志：…」 | 截图 + `exit code` 文案 + `.logs\server.log` 尾行 | 可验（半自动） |
| 7.3 | 端口被另一个看板实例占用 | 先起 `start-server.cmd`（或已有实例），再起壳 | 探活成功 → **复用**，不 spawn；窗口直接进看板 | `api/version` 的 pid 未变；无新 node 进程 | 可验（自动） |
| 7.4 | 健康检查超时（60s） | 用一个只接受 TCP 但不回 HTTP 的服务占 8787 | 60s 后报「等待服务健康检查超时（60 秒）。地址：… 入口：… 日志：…」 | 截图 + 耗时 | 可验（半自动） |
| 7.5 | 无白屏 | 上述任一失败场景 | 失败信息落在**本地启动页**（`window.__setShellError`），不是白屏、不是 WebView 错误页 | 截图 | 仅人眼 |

> 7.1 的错误文案在 `ensure_server` 的 `Err` 分支（`server_process.rs:216-219`），7.2/7.4 附带 `日志：<cwd>\.logs\server.log`（`log_path_display`）。`cwd = repo_root_for(entry)` = 入口上溯四级 = `<stage>\app`（便携包）——**不是** `%APPDATA%\AgentBoard\logs`，除非 `start.cmd` 已设 `AGENTBOARD_LOG`（见 §9.2）。

---

## 8. 无控制台黑窗（**当前必失败**，见 §9.3）

| 字段 | 内容 |
|---|---|
| 步骤 | 不带任何控制台启动：`Start-Process <exe> -WindowStyle Hidden` 或在资源管理器双击；用 `Get-Process <exe>` 的 `MainWindowTitle` / 附加检查是否出现 `conhost.exe` 子进程 |
| 预期 | 不出现控制台黑窗；`conhost.exe` 不是其子进程；node 子进程同样无窗口（`CREATE_NO_WINDOW`） |
| 证据 | 进程树（`Win32_Process` 按 `ParentProcessId` 聚合）里无 `conhost.exe`；截图 |
| 状态 | **当前必失败**：`main.rs` 缺少 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，release 构建产物是控制台子系统 exe，双击必弹黑窗。node 侧不受影响（`creation_flags(CREATE_NO_WINDOW)` 已设） |

---

## 9. 已知无法验证 / 可能坏掉的点

### 9.1 `start.cmd` 强制 `AGENTBOARD_PORT=8787` 与壳「读 config.json」的口径冲突 —— **已知行为 + 待定判定**

> **性质判定（lead 2026-11-13 定）**：`start.cmd` 覆盖端口是**设计取舍，不是 bug**——`scripts/portable/README.txt:87` 已写明「桌面入口固定使用 8787，会覆盖 config.json 的自定义端口；需要换端口请用前台模式」。
>
> 本项保留为「已知行为 + 实测判定」，**不改脚本**（`scripts/**` 归 devops）。要验的是失败时的可读性，不是覆盖行为本身。

**事实链**

- `scripts/portable/start.cmd` 在启动壳前执行 `set "AGENTBOARD_PORT=8787"`。
- 壳的 `resolve_port()` **只读 config.json**，不读该环境变量 → 壳探活 `config.json` 里的端口（如 8899）。
- 壳 spawn 的 node **继承** `AGENTBOARD_PORT=8787`，`loadConfig` 里环境变量覆盖 config.json（`config.ts:174`）→ 服务实际绑 8787。
- 两端口不一致 → 壳的 `waitForReady` 在 8899 上等 60s → 报「等待服务健康检查超时（60 秒）」。
- 副作用：那次启动确实会在 8787 上起一个服务进程，`ensure_server` 超时后会 `child.kill()` 它（`server_process.rs:157`），因此不留孤儿；但 60s 空转期间用户看到的是「正在启动本地服务…」。

**实测判定**（§6 步骤，③ 改成经 `start.cmd` 启动）

| 观察项 | 覆盖生效时的预期 | 记录为 |
|---|---|---|
| 壳探活目标 | `main.log` 无（壳不打日志）；看 `Get-NetTCPConnection -LocalPort 8899` 始终无监听 | 证据 |
| 服务实际端口 | 8787 有监听（服务已起来，但壳在等 8899） | 证据 |
| 用户可见结果 | 60s 后启动页显示「本地服务启动失败」+ 超时文案（含地址/入口/日志路径），进程不崩、可关窗 | 判定依据 |
| 是否留孤儿 | 超时后 8787 释放（`child.kill()` 生效） | 判定依据 |
| 耗时 | ≈60s | 体验代价 |

**建议口径（三选一，供 lead/devops 定）**

| 方案 | 做法 | 代价 | 我的倾向 |
|---|---|---|---|
| 甲（推荐） | 保留覆盖，但把 `waitForReady` 的失败文案补一句「当前端口被 `AGENTBOARD_PORT` 覆盖为 8787，`config.json` 的 port 未生效；如需自定义端口请用 `start-server.cmd <port>`」 | 改 `server_process.rs`（desktop-shell 域，D5 可顺带）；不动 `scripts/**` | ✅ 成本最低，把「看不懂的 60s 超时」变成「一句话说清」 |
| 乙 | `start.cmd` 不再设 `AGENTBOARD_PORT`，让壳与 server 都跟 `config.json` | 改 `scripts/portable/start.cmd`（devops），且与 README.txt 第六节口径相反，需同步改文档 | 口径更一致，但跨两处文档 |
| 丙 | 壳在探活前先读 `AGENTBOARD_PORT`，有则用它 | 与卡面「壳只读 config.json」口径冲突（`server_process.rs:46` 明确注释不读该变量）；要改注释与 D1 的卡面约定 | 不推荐 |

**无论选哪个，D4 验收时这一项按「已知行为」通过，只判「失败文案是否可读」与「是否留孤儿」。**

- 验证方式：按 §6 步骤做，再把 ③ 改成「经 `start.cmd` 启动」，对照两次结果即可复现。

### 9.2 日志落点（D6 后同源）与「哪些日志能当健康判据」

**D6-2 已把服务日志落点统一**：壳在 spawn node 时显式注入 `AGENTBOARD_LOG=<configDir>\logs\server.log`（`server_process.rs` 的 `.env("AGENTBOARD_LOG", server_log_path())`），`server_log_path()` = `config_dir()/logs/server.log` = `%APPDATA%\AgentBoard\logs\server.log`。

因此**两条启动路径现在同源，不再分叉**：

| 启动方式 | 服务日志落点 | 说明 |
|---|---|---|
| 经 `start.cmd` | `%APPDATA%\AgentBoard\logs\server.log` | 脚本设同名变量，与壳注入一致 |
| 直接双击 exe | `%APPDATA%\AgentBoard\logs\server.log` | D6 前会落 `<解压目录>\app\.logs\server.log`，现已统一 |
| 完全不经壳（`node dist/index.js`，无 `AGENTBOARD_LOG`） | `<cwd>\.logs\server.log` | `serverLog.ts` 的兜底，**壳不参与**，仅手工排障路径 |

**2026-11-13 15:01–15:03 真机实测（隔离 APPDATA，`--user-data-dir` 不需要，Tauri 用自己的 config 目录）**：

| 场景 | logs 目录产物 | 结论 |
|---|---|---|
| release exe，`config.json` port=18890 | 只有 `server.log`（285B，内容 = 一行 `listening http://127.0.0.1:18890 …`），**无 `main.log`** | ✅ 落点已统一到 APPDATA；❌ 无壳侧 main.log |
| 便携包 exe，`config.json` port=18891 | 只有 `server.log`（295B，同样是 `listening …` 一行），**无 `main.log`** | 同上 |

#### 判据修正（两条，均已实测）

**修正一：`server.log` 在正常启动时**会**被写，不是「只 restart 才写」。**
依据：`apps/server/src/index.ts:530` 在 `listen` 成功后**无条件**执行 `appendServerLog(listeningLine)`；实测两次正常启动都产出了 `listening …` 行。上一轮转述的「服务正常启动不写 server.log」与实测不符。

> 但这条**不影响结论**：`server.log` 仍然**不应**作为健康判据。原因是它的可信度依赖 `AGENTBOARD_LOG` 是否被正确注入（D6 前直接双击 exe 就会写错位置），且「文件存在」不等于「本次启动成功」（陈旧文件会误导）。健康判据仍以端口与 HTTP 为准。

**修正二：Tauri 壳不写 `main.log`，「看 main.log」这条证据链不成立。**
- 全树检索 `desktop/src-tauri/**`（排除 `target`、`bundle-stage`）：`main.log` 仅出现在 `server_process.rs:383` 的**注释**里，无任何写入实现（无 `fs::write` / `File::create` / `OpenOptions` 指向该文件，`eprintln!` 只走 stderr）。
- `Cargo.toml` 未声明 `tauri-plugin-log`；`Cargo.lock` 中无该 crate。
- 实测两次启动后 `logs\` 下均无 `main.log`。

> 现存的那份 `%APPDATA%\AgentBoard\logs\main.log`（891B，含 `==== 启动 mode=dev`、`端口探测：agentboard`、`复用已在运行的 AgentBoard 服务`）是**上一分支 Electron 壳**写的遗留文件，不是当前 Tauri 壳产出。拿它当 D4 证据会张冠李戴。

**D4 应采用的健康判据（不依赖日志）**

| 序 | 判据 | 命令 |
|---|---|---|
| 1 | `GET http://127.0.0.1:<port>/api/version` → 200 且 `name=agentboard-server` | `Invoke-WebRequest ... \| Select -Expand Content` |
| 2 | 该响应的 `pid` 与端口监听者 PID 一致 | `Get-NetTCPConnection -LocalPort <port> -State Listen` |
| 3 | 窗口内看板可用（工作区/任务渲染） | 截图 / UIAutomation / CDP |
| 4 | `%APPDATA%\AgentBoard\server.lock` 的 `pid` 与上面一致 | `Get-Content ... \| ConvertFrom-Json` |

需要日志证据时的**可用**来源：`%APPDATA%\AgentBoard\logs\server.log`（D6 后位置确定、由服务端 `appendServerLog` 写）。**不要**引用 `main.log`。

### 9.3 无控制台黑窗 —— **D5 已修**

### 9.3 无控制台黑窗 —— **D5 已修**

2026-11-13 14:29 的 D5 提交在 `main.rs:14` 加入：

```rust
// release 用窗口子系统：不带此项时 exe 是 console 子系统，双击会先弹一个控制台黑窗。
// debug 保留控制台，排障时 stdout/stderr 可见。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

release 产物（`target/release/agentboard-desktop.exe`，12,374,016 B，14:52:49）已带该属性。**该项从「当前必失败」转为可验**：验法是 `dumpbin /headers <exe> | findstr subsystem` 或启动后确认无 `conhost.exe` 子进程（`Get-CimInstance Win32_Process` 按 `ParentProcessId` 聚合）。

### 9.4 服务自重启后壳失去子进程句柄 → 托盘「退出」不停服 —— **D6 已修**

- 原缺陷：`POST /api/system/restart` 会 `spawnDetached` 新 node 进程并让旧进程退出（`index.ts:451`）；壳只持有最初 spawn 的 `Child`，旧进程退出后句柄成死句柄，`stop()` kill 无效、`remove_lock_owned_by(旧pid)` 因新 pid 存活而不删锁。
- D6 修复：`LockFile` 增加 `#[serde(default)] port: Option<u16>`，`stop()` 里新增「第二意见」判定 `decide_takeover(lock, child_pid, self.port, is_pid_alive)` —— 当「锁 pid ≠ 子进程 pid」且「锁里 port == 本壳端口」且「该 pid 存活」时，按锁里的 pid 再终止一次，并以「实际终止的 pid」为准删锁。
- 新增 5 个单测覆盖该判定：`takeover_detected_when_lock_pid_differs_and_alive`、`no_takeover_when_lock_pid_is_own_child`、`no_takeover_when_lock_holder_is_dead`、`no_takeover_for_other_port`、`no_takeover_when_lock_missing_or_port_absent`（`cargo test` 19 passed 已含）。
- 现状：**代码已修、单测通过；端到端（真触发 restart 再托盘退出）未验** —— 留给 D4。

### 9.5 NSIS 安装包 —— **D2 已实现方案甲（`bundle.resources` 已补）**

> **处置口径（lead 2026-11-13 定）**：本项不在 D4 判定，由 D2 卡（`4a80650c-6fbd-4f89-b8ed-f7f5d1eb1cd3`）定向，二选一：补 `bundle.resources` 让安装包自包含，或明确 NSIS 仅作壳、分发走便携包。

**D2 实际选择：方案甲。** `tauri.conf.json` 现已含：

```json
"bundle": {
  "resources": {
    "bundle-stage/apps/server": "apps/server",
    "bundle-stage/apps/web/dist": "apps/web/dist",
    "bundle-stage/runtime/node.exe": "runtime/node.exe"
  }
}
```

`desktop/src-tauri/bundle-stage/` 已产出 `apps/server/{dist,node_modules,package.json}`、`apps/web/dist`、`runtime/node.exe`、`runtime-manifest.json`。安装包 34.23 MB（lead 通报）。

**D4 需验（安装包级）**：
1. 装到 `%LOCALAPPDATA%\AgentBoard` 后，`resources/` 下存在 `apps/server/dist/index.js`、`apps/web/dist/index.html`、`runtime/node.exe`；
2. 双击快捷方式启动 → 看板可用（说明 `resolve_server_entry` / `resolve_node` 在安装布局下命中）；
3. 卸载后 `%APPDATA%\AgentBoard`（数据）保留。

**待实测风险（A21 已抓到的同源问题）**：`bundle.resources` 的 target 是相对 **exe 目录** 还是 **resources 目录**，决定安装后能否命中。见 §9.10。

### 9.6 capability 的 `remote` 是否覆盖本地启动页

`capabilities/decision-notifications.json` 同时写了 `windows: ["main"]` 与 `remote.urls: ["http://127.0.0.1:8787"]`。远程看板页需要它（自绘标题栏、系统通知）；但**本地 `index.html` 启动页的三键**是否也被该 capability 覆盖，需实测（§1.5）。若未被覆盖，启动页的关闭/最小化会静默无效（`invoke` 被拒）。

### 9.7 构建与打包前置

| 缺什么 | 后果 | 解法 |
|---|---|---|
| `cargo` / `rustc` | 壳无法构建；`package:portable` 的 `ensureDesktopExe()` 直接 fail | 装 Rust（MSVC toolchain），且 `cl`/`link` 需在 PATH（VS 2022 Developer Shell） |
| `desktop/src-tauri/target/release/agentboard-desktop.exe` | 便携包打不出来（脚本注释明确：无产物且非 `--skip-build` 才尝试 cargo 构建，`--skip-build` 时直接 fail） | 先构建 |
| NSIS 下载（`tauri build` 首次） | 与 Electron 那次同类风险：需从 GitHub 拉 `nsis` 工具链，本机对 `140.82.112.3:443` 曾 ETIMEDOUT | 配镜像/代理，或先只出 `--no-bundle`（便携包不依赖 NSIS） |
| `dist-package/` | 无包可验 | `node scripts/package-portable.mjs`（会连带 `pnpm -r build`） |

### 9.11 ⚠️ 验收脚本自身踩过的坑（写测试的人必读）

这三条都在 2026-11-13 的 D4 执行中实际踩过，都会**制造假结论**，与产品缺陷混在一起极难分离。

#### 坑 1：PowerShell 哈希表按「类型 + 值」查找，`[uint32]5 ≠ [int]5`

`Get-CimInstance Win32_Process` 的 `ProcessId` / `ParentProcessId` 是 **UInt32**，而 `Queue.Enqueue(5)` 里存的是 **Int32**。PowerShell 的 `@{}` 用「相等 + 哈希」，两者不相等，于是：

```powershell
$byParent = @{}
foreach ($p in $all) { $byParent[$p.ParentProcessId] += $p }   # 键是 UInt32
$queue.Enqueue([int]$RootPid)                                   # 值是 Int32
if ($byParent.ContainsKey($cur)) { ... }                        # 永远 false
```

**后果**：进程树只返回根节点，子进程全丢。第一版 V1 因此误报 `nodeChild=0` → FAIL，而实际上服务明明起来了。

**修法**：建键与查键都显式 `[int]` 归一。

```powershell
$key = [int]$p.ParentProcessId          # 建键时 cast
if ($byParent.ContainsKey([int]$cur))   # 查键时同样 cast
```

同类风险：Python 里 `numpy.uint32(5) == 5` 为 True 但 `hash()` 在部分版本/容器里不一致，凡是「CIM/WMI 数值当字典键」都要先归一。

#### 坑 2：`conhost.exe` 存在 ≠ 有控制台黑窗

见禁止事项 **P5**。空口说无凭，这里是实测对照：

| 场景 | conhost 子进程 | conhost `MainWindowHandle` |
|---|---|---|
| 裸起 node（不带 `CREATE_NO_WINDOW`） | 有 | **0**（无窗口） |
| 壳（`CREATE_NO_WINDOW`）拉起的 node | 有 | **0**（无窗口） |
| 壳 release exe 自身（PE subsystem=2） | — | 不适用 |

**正确判据**（已写进 `d4-run.ps1` V7）：

```powershell
$cons = Get-AbProcessTree -RootPid $shell.Id | Where-Object { $_.Name -eq 'conhost.exe' }
$visible = @($cons | Where-Object { (Get-Process -Id $_.ProcessId).MainWindowHandle -ne 0 })
$ok = ($visible.Count -eq 0) -and ((Get-Process -Id $shell.Id).MainWindowHandle -ne 0)
```

辅以 PE subsystem 静态判定（`subsystem == 2` 即 GUI 子系统）。

#### 坑 3：产物早于源码 → 一堆假失败

见禁止事项 **P6** 与 §9.12。核心是**跑验收前先断言产物比 src 新**，而不是跑完再去解释为什么全红。

### 9.12 产物新鲜度门禁（`d4-run.ps1` 开头）

```powershell
pwsh -NoProfile -File .\tests\desktop\d4-run.ps1           # 陈旧则 exit 3，不跑用例
pwsh -NoProfile -File .\tests\desktop\d4-run.ps1 -SkipFreshnessGate   # 显式跳过
```

判据：取 `desktop/src-tauri/{src,Cargo.toml,capabilities}` 与 `apps/{server,web}/src` 下最新的 `.rs/.toml/.json` 修改时间作为 `srcNewest`；三份产物（release exe、NSIS 安装包、便携包 zip）的 mtime 都必须 ≥ `srcNewest`，否则判定陈旧。

2026-11-13 15:3x 实测输出：

```
源码最新：main.rs @ 2026-11-13 15:08:40
  产物 release exe  @ 2026-11-13 14:52:49
  产物 NSIS 安装包     @ 2026-11-13 14:40:06
  产物 便携包 zip      @ 2026-11-13 14:53:10

== 产物陈旧，拒绝验收 ==
  release exe（14:52:49 < 源码 15:08:40）
  NSIS 安装包（14:40:06 < 源码 15:08:40）
  便携包 zip（14:53:10 < 源码 15:08:40）
```

退出码 3，不产生任何用例结果 —— 这正是设计意图：**宁可不给结论，也不给假结论**。

重打后应看到「✔ 产物新鲜度通过」，此时再跑 V1–V9。

> 与构建侧同源：`scripts/desktop/build-all.mjs` 的 `assertDistFresh()` 是同一思路（抓「改了 `apps/server/src` 忘了 build」），两者一个管构建入口、一个管验收入口。

### 9.8 便携包自身的自检依赖网络无、但依赖 `tar.exe`

`package-portable.mjs:397` 用 `tar -a -c -f` 打 zip。Windows 10 1803+ 自带 `tar.exe`；若 PATH 被裁剪或系统过旧，末步失败（前面的 stage 已完成，可用 `--no-zip` 先验内容）。

### 9.9 entry 与 node 同源判据（D4 新增，替代「必须用自己的 server」）

**判据口径**：不断言「必须用包内 server」，而是断言**启动时 `entry`（`apps/server/dist/index.js`）与 `node` 落在同一个根下**——即壳不出现「用包内 node 跑包外 server」或反之的错配。

理由：`resolve_server_entry` 与 `resolve_node` 是两套独立候选列表，理论上存在各自命中不同层级的组合；实测两种真实布局均同源，错配需人为构造。

| 布局 | `exe_dir` | entry 命中 | node 命中 | 同源 |
|---|---|---|---|---|
| dev（`target/release`） | `desktop/src-tauri/target/release` | `../../../../apps/server/dist/index.js` → 仓库根 | `runtime/node.exe`（同级，stage 产出） | ✅ |
| 便携包（`app/desktop`） | `dist-package/AgentBoard/app/desktop` | `../apps/server/dist/index.js` **（预期）** | `../../runtime/node.exe` → `stage/runtime` | ⚠️ 实测 entry 先命中第 0 候选，见 §9.10 |

**验证方式（D4 执行）**：启动后取子进程命令行（`Get-CimInstance Win32_Process` 过滤 `index.js`），检查：

```powershell
$cmd = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'index\.js' }).CommandLine
# 从命令行切出 node 路径与 entry 路径，各自上溯到「包根」，断言两者相等
```

或直接跑 `node tests/desktop/static-asserts.mjs` 的 **A21**（离线判定，见 §A）。

### 9.10 ⚠️ A21 实测发现：便携包 entry 会逃逸到包外（需 D3/devops 确认）

**现象**：`resolve_server_entry` 的第 0 个候选是 `exe_dir/../../../../apps/server/dist/index.js`（为 dev 布局 `target/release` 上溯四级到仓库根而设）。便携包布局下 `exe_dir = <stage>/app/desktop`，上溯四级正好**逃出 stage**：

```
<stage>/app/desktop/../../../../apps/server/dist/index.js
    = <stage 的父目录>/apps/server/dist/index.js
```

**2026-11-13 15:03 真机实测（`dist-package/AgentBoard`）**：子进程实际命令行为

```
"...\dist-package\AgentBoard\app\desktop\../../runtime/node.exe"
 "D:\Workspaces\AgentBoard\dist-package\AgentBoard\app\desktop\../../../../apps/server/dist/index.js"
```

即 **node 来自包内（`dist-package/AgentBoard/runtime/node.exe`），entry 却解析到包外的 `D:\Workspaces\AgentBoard\apps\server\dist\index.js`** —— 正是「entry 与 node 不同源」。

**触发条件（已实测枚举）**：

| 包解压位置 | entry[0] 是否存在 | 结果 |
|---|---|---|
| 仓库根下（`D:\Workspaces\AgentBoard\dist-package\AgentBoard`） | ✅ 存在（撞到仓库自身） | **逃逸**：跑仓库里的 server |
| 仓库内 `.tmp` 子目录 | ❌ 不存在 | 正常回退到 entry[1]，命中包内 |
| 用户典型位置（`D:\AgentBoard\AgentBoard`） | ❌ 不存在 | 正常回退到 entry[1]，命中包内 |

**影响判定**：
- 对**终端用户**（解压到仓库外任意位置）：不触发，行为正确。
- 对**在仓库内做验收**（D3/D4 当场跑 `dist-package`）：**会误判** —— 看起来「服务起来了、看板可用」，实际跑的是仓库里的 server，而非包内副本。验收结论会失真。
- 这也解释了为什么「两种真实布局实测都同源」的观察在本机不成立：本机的便携包恰好解在仓库根下。

**建议**（不改代码，交 D3/devops 定）：
1. 验收时把便携包解到**仓库外**临时目录（如 `$env:TEMP\agentboard-accept\AgentBoard`）再跑，避免实测污染；
2. 或由 D3 决定是否给 entry 候选加「必须落在 stage 内」的约束（`resolve_server_entry` 属 desktop-shell 域，需 D5/D7 配合）。

D4 执行时按「解到仓库外」的方式验收；§9.9 的同源断言用 A21 跑（A21 已把此逃逸判为 FAIL）。

---

## 10. 自动化骨架（建议实现位置 `scripts/desktop/` 或 `tests/desktop/`）

### 10.1 PowerShell 可自动判定的三条

**脚本 1：单实例（§3）**

```powershell
$exe = '<stage>\app\desktop\agentboard-desktop.exe'
$p1 = Start-Process $exe -PassThru
Start-Sleep -Seconds 12
$lock1 = Get-Content "$env:APPDATA\AgentBoard\server.lock" -Raw | ConvertFrom-Json
$listen1 = (Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue).OwningProcess
$p2 = Start-Process $exe -PassThru
$p2.WaitForExit(15000) | Out-Null
$lock2 = Get-Content "$env:APPDATA\AgentBoard\server.lock" -Raw | ConvertFrom-Json
$listen2 = (Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue).OwningProcess
$count = (Get-Process agentboard-desktop -EA SilentlyContinue).Count
# 断言：$p2.HasExited -and $lock1.pid -eq $lock2.pid -and $listen1 -eq $listen2 -and $count -eq 1
```

**脚本 2：退出停服 + 删锁（§5）**

```powershell
$exe = '<stage>\app\desktop\agentboard-desktop.exe'
$p = Start-Process $exe -ArgumentList '--quit-after-ms','12000' -PassThru
Start-Sleep -Seconds 8
$pidServer = (Get-Content "$env:APPDATA\AgentBoard\server.lock" -Raw | ConvertFrom-Json).pid
# 关闭后最多等 25s（代码预算 16s）
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $procGone = -not (Get-Process -Id $p.Id -EA SilentlyContinue)
  $nodeGone = -not (Get-Process -Id $pidServer -EA SilentlyContinue)
  $portFree = -not (Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue)
  $lockGone = -not (Test-Path "$env:APPDATA\AgentBoard\server.lock")
  if ($procGone -and $nodeGone -and $portFree -and $lockGone) { 'PASS'; break }
  Start-Sleep -Milliseconds 500
}
```

**脚本 3：托盘唤醒（§2.5）**

```powershell
$exe = '<stage>\app\desktop\agentboard-desktop.exe'
$out = Join-Path $env:TEMP 'tray-probe.json'
Start-Process $exe -ArgumentList '--probe-tray-ms','6000','--probe-out',$out -Wait
$r = Get-Content $out -Raw | ConvertFrom-Json
# 断言：-not $r.before.visible 或 $r.before.visible；$r.hidden.visible -eq $false；$r.after_wake.visible -eq $true
```

### 10.2 WebView2 走 CDP（可选，需实测）

壳 window 加载的是 `http://127.0.0.1:8787`（远程 URL）与本地 `index.html`。若要让 Playwright 直接断言 DOM：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process '<stage>\app\desktop\agentboard-desktop.exe'
# 另开：chromium.connectOverCDP('http://127.0.0.1:9222')
```

该路径**未实测**（需先有 exe）。若生效，§1.3、§4、§7 的 DOM 断言可全自动化；不生效则退回 UIAutomation + 截图。

### 10.3 单元测试（无需 GUI，只需 cargo）→ 见 §R

### 10.4 便携包内容自检（不需要 Rust，只要有现成 exe 与 node）

```powershell
node scripts/package-portable.mjs --skip-build --no-zip
# 断言：dist-package\AgentBoard\app\desktop\agentboard-desktop.exe 存在
#      dist-package\AgentBoard\runtime\node.exe 存在
#      dist-package\AgentBoard\app\apps\server\dist\index.js 存在
#      dist-package\AgentBoard\app\apps\web\dist\index.html 存在
#      runtime\node.exe app\verify-rules.mjs 退出码 0（8 个技能 + kb --help）
```

---

## R. `cargo test` 执行记录（A 组，唯一可离线跑的壳测试）

**命令**

```powershell
$env:RUSTUP_HOME='D:\tools\rust\rustup'; $env:CARGO_HOME='D:\tools\rust\cargo'
& 'D:\tools\rust\cargo\bin\cargo.exe' test --manifest-path desktop/src-tauri/Cargo.toml
```

**工具链实测**：`cargo 1.100.0 (3acc79c0c 2026-11-05)`、`rustc 1.100.0 (0ef1bc386 2026-11-09)`，位于 `D:\tools\rust\cargo\bin`。

### R.1 第一次尝试（14:06–14:15）：被 D1 的 package cache 锁阻塞，未跑成

| 时刻 | 观察 |
|---|---|
| 14:06:21 | 启动 `cargo test`，唯一输出 `Blocking waiting for file lock on package cache` |
| 14:06–14:10 | `D:\tools\rust\cargo\registry` 中 `.crate` 数从 0 涨到 257（D1 在下载依赖） |
| 14:10:40–14:12:23 | 仍在下 `.crate`（`tauri-2.12.5.crate`、`regex-syntax-0.8.11.crate` 等），`desktop/src-tauri/target/` 始终未创建 |
| 14:15:01 | 按指示停手；`Get-CimInstance Win32_Process` 确认只剩 devops 的 `cargo build --bins --features tauri/custom-protocol --release`（PID 37696），我的进程已退出 |

阻塞根因：`cargo test` 与 D1 的 `cargo build` 共享 `$CARGO_HOME` 下的 **package cache 锁**；D1 首次下载 257+ crate 期间 test 无法进入编译。

### R.2 第二次尝试（14:19）：**8 passed / 0 failed，退出码 0**

D1 的下载阶段结束、`desktop/src-tauri/target/{release,debug}` 已建立后续跑：

```
running 8 tests
test server_process::tests::illegal_port_falls_back_to_default ... ok
test server_process::tests::valid_port_is_parsed ... ok
test server_process::tests::missing_file_or_field_falls_back_to_default ... ok
test tests::destroyed_window_recreates_instead_of_show ... ok
test tests::hidden_window_shows_unminimizes_and_focuses ... ok
test tests::minimized_window_does_not_call_show ... ok
test tests::visible_window_only_refocuses ... ok
test tests::quitting_aborts_for_every_phase ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

耗时 0.3s（编译已由 D1 的构建缓存覆盖），日志 `.logs/qa-cargo-test-desktop.log`。

**用例数口径**：源文件里是 `main.rs` 5 个 + `server_process.rs` 3 个 = **8 个**，实测也是 8。lead 转述的「11 个」与源码不符，以实测 8 为准。

| 模块 | 用例 | 覆盖 |
|---|---|---|
| `main.rs:446-487` | `hidden_window_shows_unminimizes_and_focuses` / `minimized_window_does_not_call_show` / `visible_window_only_refocuses` / `destroyed_window_recreates_instead_of_show` / `quitting_aborts_for_every_phase` | `wake_steps` 的四态 + quitting 短路 |
| `server_process.rs:374-397` | `valid_port_is_parsed` / `missing_file_or_field_falls_back_to_default` / `illegal_port_falls_back_to_default` | §6 的端口解析口径（0/-1/65536/字符串/浮点 全部退默认） |

**结论：A 组的 R1 项通过（8/8）。** 这锁住了 §2.5 托盘唤醒与 §6 端口解析两块逻辑，且不需要 GUI/WebView2。

### R.3 第三次（15:04，D5/D6 之后）：**19 passed / 0 failed，退出码 0**

D5（`windows_subsystem`）与 D6（日志路径 + 端口对齐 + takeover 判定）合入后新增 11 个用例：

| 模块 | 新增用例 | 覆盖 |
|---|---|---|
| `server_process.rs` | `takeover_detected_when_lock_pid_differs_and_alive` | §9.4：restart 后锁 pid ≠ 子进程 pid 且存活 → 应接管终止 |
| | `no_takeover_when_lock_pid_is_own_child` | 锁 pid == 自己的子进程 → 不重复终止 |
| | `no_takeover_when_lock_holder_is_dead` | 持有者已死 → 交给 remove_lock_owned_by |
| | `no_takeover_for_other_port` | 锁里 port ≠ 本壳端口 → 不误杀别的实例 |
| | `no_takeover_when_lock_missing_or_port_absent` | 锁缺失/无 port 字段 → 保守不终止（`serde(default)` 路径） |
| | `child_port_env_equals_shell_port` | §9.1：注入子进程的 `AGENTBOARD_PORT` 恒等于壳端口 |
| | `ambient_port_mismatch_flags_conflicting_value` | 外部 `AGENTBOARD_PORT` 与壳端口不一致时，错误文案点明「已被对齐」 |
| | `ambient_port_mismatch_ignores_same_value` | 值相同 → 不加噪音 |
| | `ambient_port_mismatch_ignores_unset_or_garbage` | 未设/非法 → 忽略 |
| | `server_log_path_is_under_appdata_not_install_root` | §9.2：日志路径必须以 `AgentBoard/logs/server.log` 结尾，且不含 `/.logs/` |
| | `log_path_display_matches_server_log_path` | 错误文案里的日志路径与实际落点一致 |

**结论：R1 全绿（19/19）。** 这 11 个新用例正好覆盖了本轮三条验收事实里的两条（日志落点、端口对齐）加 §9.4 的修复。

**重跑时机**：D7（壳收尾四项）合入后再跑一次；`wake_steps` 若新增状态需同步加用例。

---

## A. A 组静态断言集（不需要任何构建产物，现在就能跑）

已落地为可执行脚本 **`tests/desktop/static-asserts.mjs`**（纯 Node，零依赖，只读源码/配置，不构建、不启动、不依赖 GUI）。它是 D5/D2 改完代码后的最小防回归闸门。

```powershell
node tests/desktop/static-asserts.mjs          # 人读
node tests/desktop/static-asserts.mjs --json   # 机器读
```

退出码 0 = 无硬失败；1 = 有 `FAIL`；2 = 脚本异常。

**`expect: 'absent'` 型断言**（A5/A6/A19）记录的是「缺口」：缺口仍在时打印 `EXPECTED-GAP`，修好后打印 `GAP-FIXED`。这类不计入失败数——否则改对了反而会让脚本「失败」。

**2026-11-13 15:05 实测（D5/D6/D2 之后）：21 条，通过 17，失败 1（A21），缺口仍在 1（A19），缺口已修 2（A5/A6），退出码 1。**

| # | 断言 | 依据 | 实测 |
|---|---|---|---|
| A1 | 壳与服务端的 `server.lock` 路径口径一致 | `server_process.rs` / `serverLock.ts:31` | ✅ PASS |
| A2 | `LockFile{pid:u32, #[serde(default)] port:Option<u16>}` 可由服务端锁反序列化 | `server_process.rs` | ✅ PASS（D6 后已更新断言） |
| A3 | `/api/version` 自报 `name=agentboard-server` 且壳探针字符串匹配 | `systemMiscRoutes.ts:115` | ✅ PASS |
| A4 | 壳的 `resolve_port` 只读 config.json、不读 `AGENTBOARD_PORT` | `server_process.rs:46-53` | ✅ PASS |
| A5 | `bundle.resources` 存在 | `tauri.conf.json` | **GAP-FIXED**（D2 方案甲） |
| A6 | 有 `windows_subsystem` 属性 | `main.rs:14` | **GAP-FIXED**（D5） |
| A7 | node 子进程带 `CREATE_NO_WINDOW` | `server_process.rs` | ✅ PASS |
| A8 | 单例插件注册早于 `.setup(` | `main.rs` | ✅ PASS |
| A9 | 关窗 `CloseRequested` + `prevent_close` + `hide` | `main.rs` | ✅ PASS |
| A10 | 停服预算 8s/5s/3s | `server_process.rs` | ✅ PASS |
| A11 | 三个验收钩子参数存在 | `main.rs` | ✅ PASS |
| A12 | capability 的 5 条 window 权限齐全 | `capabilities/decision-notifications.json` | ✅ PASS |
| A13 | `frontendDist=./ui`、`app.windows=[]` | `tauri.conf.json` | ✅ PASS |
| A14 | 便携包把壳放 `app/desktop/` | `package-portable.mjs:370` | ✅ PASS |
| A15 | `start.cmd` 覆盖 `AGENTBOARD_PORT=8787` | `scripts/portable/start.cmd` | ✅ PASS |
| A16 | D6-2：壳注入 `AGENTBOARD_LOG` → `<configDir>\logs\server.log`，不再落安装根 `.logs` | `server_process.rs` | ✅ PASS |
| A17 | D6：壳把自身端口注入子进程，消除 `start.cmd` 口径冲突 | `server_process.rs` | ✅ PASS |
| A18 | D6：`stop()` 有 `decide_takeover` 第二意见判定 | `server_process.rs` | ✅ PASS |
| A19 | 壳不写 `main.log`（缺口：无壳侧文件日志） | `desktop/src-tauri/src/**` + `Cargo.toml` | **gap**（见 §9.2 修正二） |
| A20 | **P1 禁止项**：`single-instance` 未启用 `semver` feature | `Cargo.toml` | ✅ PASS |
| A21 | D4 判据：便携包下 entry 与 node 都落在包根内 | `server_process.rs` + `dist-package/` | ❌ **FAIL**（见 §9.10：entry 逃逸到仓库） |

**A21 失败是真问题，不是断言写错**：`dist-package/AgentBoard/app/desktop` 下 entry 的第 0 候选 `../../../../apps/server/dist/index.js` 解析到 `D:\Workspaces\AgentBoard\apps\server\dist\index.js`（包外），而 node 命中包内 `dist-package/AgentBoard/runtime/node.exe` —— 真机启动后子进程命令行已证实。详见 §9.10。

---

## 11. 自动化 vs 人眼分布

| 类别 | 条目 |
|---|---|
| 可验（自动，退出码/JSON 判定） | 1.1、1.2、2.5、3、5、6、7.3、10.3（→§R）、10.4 |
| 可验（半自动：脚本 + 一次人眼/需 GUI 会话） | 1.3、4、7.1、7.2、7.4 |
| 仅人眼 | 1.4、1.5、1.6、2.1、2.3、2.4、7.5 |
| 当前必失败（需先改代码/配置） | 8（缺 `windows_subsystem`，D5 修）、9.5（NSIS 无 resources，D2 定向） |
| 未测（依赖构建产物） | 9.4（重启后停服，D5 修）、9.6（capability 覆盖） |

约 **10 条全自动 / 5 条半自动 / 7 条仅人眼**，另有 **15 条静态断言**（现在即可跑，零依赖）。把 §9.3 与 §9.5 修掉后，全自动项可覆盖「进程、端口、锁、单例、停服、端口读取、复用」这七个最容易回归的面；托盘菜单点击、自绘三键、失败页观感三项长期只能人眼。

---

## 12. 一键执行顺序（产物齐备后）

> 分组见文件头「执行分组」表：A 组现在就能跑，B 组等 D1，C 组等 D1+D3，D 组等 D2。

```powershell
# 仓库根
cd D:\Workspaces\AgentBoard

# ---- A 组：现在能跑 ----
$env:RUSTUP_HOME='D:\tools\rust\rustup'; $env:CARGO_HOME='D:\tools\rust\cargo'
& 'D:\tools\rust\cargo\bin\cargo.exe' test --manifest-path desktop/src-tauri/Cargo.toml
# 预期 8 passed（见 §R）；若被 D1 的 package cache 锁阻塞 >3min，停下上报

node tests/desktop/static-asserts.mjs                # 建议落地：§A 的 15 条静态断言
cargo --version; rustc --version                     # 工具链核查

# ---- B 组：等 D1 的 agentboard-desktop.exe ----
Test-Path desktop\src-tauri\target\release\agentboard-desktop.exe
# §1–§8 各项；其中三条可全自动（§10.1 脚本 1/2/3）

# ---- C 组：等 D3 的便携包 ----
node scripts/package-portable.mjs
dist-package\AgentBoard\runtime\node.exe dist-package\AgentBoard\app\verify-rules.mjs
# §10.4 包内容自检 + §12 全流程串跑 + §10.2 CDP 可行性

# ---- D 组：等 D2 定向 NSIS ----
# 按 D2 选定的方案甲/乙执行对应验收

# 服务端回归（桌面壳不改 API，但契约零变更是验收前提）
corepack pnpm --filter @agentboard/server test
```

---

## 13. 证据归档约定

| 证据类型 | 落盘位置 |
|---|---|
| 脚本输出 | `.logs/desktop-verify-<项号>-<时间戳>.log` |
| 托盘探针 JSON | `--probe-out` 指定路径（建议 `.logs/tray-probe-<时间戳>.json`） |
| 主进程/服务日志 | `%APPDATA%\AgentBoard\logs\server.log`（经 `start.cmd`）或 `<stage>\app\.logs\server.log`（直接起 exe） |
| 单例锁证据 | `%APPDATA%\AgentBoard\server.lock` 前后两份内容 |
| 进程/端口快照 | `Get-CimInstance Win32_Process` 过滤 `agentboard-desktop|node` + `Get-NetTCPConnection` |
| 界面截图 | `.qa-temp/tauri-<项号>-<动作>.png` |
