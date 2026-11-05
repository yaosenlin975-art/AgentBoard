# 桌面端展现方式设计（脑暴）

| 项 | 值 |
| --- | --- |
| 卡号 | `11085bb7-f033-4d5b-8a02-8c855d1d862b`【DESKTOP-PRESENT】 |
| 状态 | 已拍板：**C（Tauri）**（A 否决、B 备选）；拆分见 §8.5。本卡不写实现代码 |
| 日期 | 2026-11-05 |
| 工作区 | 任务看板 `e41eb0fb-c367-43cf-a99d-6dc5239a5694` · `D:\WorkSpaces\任务看板` |
| 改动范围 | 本文档 + 本轮建卡 DESKTOP-0/1/2/3；未动 `apps/**`、`packages/**`、`scripts/**`，未改代码、未 claim 实现卡 |

**基线说明**：下列数值与路径取自本次工作树实读结果。该工作树当前有他人未提交改动（`git status` 显示 `README.md`、`package.json` 为 `M`，`scripts/package-portable.mjs`、`scripts/portable/` 为未跟踪），因此「`package:portable` 已存在」是**工作树事实**，不等于已进 git 的既成事实。

---

## 0. 现状核对（先自己核，不照抄卡面）

| 维度 | 实读结论 | 证据 |
| --- | --- | --- |
| 前端形态 | 纯 Web 单页（React 19 + Vite 7），无桌面壳依赖；`pnpm-lock.yaml` 里唯一的 "electron" 是 `electron-to-chromium`（browserslist 的传递依赖） | `apps/web/package.json:13-33`；`package.json:9-19` 无依赖段；`pnpm-lock.yaml:1367,3508,3658` |
| 服务端 | 本地 HTTP 服务，默认端口 `8787`，可用 `AGENTBOARD_PORT` 覆盖；同时静态托管 `apps/web/dist` 并做 SPA fallback | `apps/server/src/config.ts:39`；`apps/server/src/index.ts:67,224-238,266` |
| 当前启动路径 1（仓库内） | `scripts/agentboard.vbs`：`open` 模式探活→隐藏拉起 server→用**默认浏览器**打开 `http://127.0.0.1:8787`；`autostart` 模式只隐藏拉起服务 | `scripts/agentboard.vbs:47-81`；`README.md:19,56-68` |
| 当前启动路径 2（便携包） | `start.cmd` 在前台窗口跑 server，端口默认 8787，提示「Stop: close this window or press Ctrl+C」 | `scripts/portable/start.cmd:7,15,18` |
| 桌面壳能力 | **无**原生窗口、无托盘、无原生退出/单实例控制；已有能力是注册表自启 + 桌面快捷方式（卡 `a0550248` 已关闭） | 无 electron/tauri 依赖（同上）；`README.md:56-68` |
| 单实例 | 同 DB / 同 configDir 只能有一个 server 进程，靠 `<configDir>/server.lock` 保证；多开需同时换 `APPDATA` + `AGENTBOARD_DB` + 端口 | `apps/server/src/index.ts:281-301`；`scripts/portable/README.txt:76-77` |
| 多工作区 | 同一个窗口内通过侧栏工作区切换器切换（`topbar-workspace` + `WorkspaceSidebarOverlay`），不是「一工作区一窗口」 | `apps/web/src/components/shell/SideBar.tsx:85-108` |
| 数据落点 | 中心库默认 `%APPDATA%\AgentBoard\agentboard.db`（附件在同目录 `attachments`）；工作区库 `.agentboard/agentboard.db` 只在下沉后存在，本次实测本工作区**没有**该文件 | `apps/server/src/config.ts:71-81,88-90`；`apps/server/src/db/resolver.ts:43,97,150`；`README.md:23`；`Test-Path .agentboard\agentboard.db` = False |
| 便携包 | `runtime\node.exe` + server 单文件 bundle + web 静态产物 + cli + 原生模块；规则落 `app\rules\` 并生成 `rules-manifest.json`、跑包内自检 | `scripts/package-portable.mjs:11-13,250-251,254-262,294-304` |
| 包体积现状 | 已产出的 zip `AgentBoard-win-x64-951f28d.zip` = 44,403,141 B（≈42.3 MiB）；其中 `node.exe` 本体 89,894,400 B（≈85.7 MiB，压缩后约小一半） | 本次工作树实测 |
| 本机运行时前提 | Node 24.11.1；Edge 已装（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` = True）；WebView2 Runtime 已装（`156.0.4314.58`）；Chrome 未装；`cargo` 不在 PATH | 本次实测 |
| 测试页/正式页 | 测试页固定 5174（vite dev），正式页 8787（`apps/web/dist` 旧产物） | `scripts/dev-page.mjs:23`；`using-agentboard` 的 TEST-PAGE 节 |
| 重启能力 | 已有 `POST /api/system/restart`（202 + 轮询 `/api/version`），前端有重启面板 | `apps/web/src/components/settings/RestartServerPanel.tsx:4-16` |

**一句话现状**：现在是「本地 server + 浏览器页面 + 脚本拉起」，缺的是**窗口感**（独立窗口/图标/任务栏）与**桌面生命周期**（托盘、关窗语义、单实例聚焦），而不是缺一个 Web 应用。

---

## 1. 需求拆解：「桌面端的展现方式」至少有 5 个独立维度

用户原话只有一句「脑暴设计桌面端的展现方式」，下面 5 件事经常被混成一件，实际可以分开拍板。每条给出「依现状推定」的结论，并标注**待用户拍板**。

### 1.1 窗口形态：一个窗口，还是每工作区一个窗口？

- 歧义点：桌面端 = 一个窗口内切工作区，还是每个工作区独立窗口/任务栏条目分别摆放。
- 现状：单页应用 + 侧栏工作区切换器（`SideBar.tsx:85-108`），单 server 托管全部工作区。
- **依现状推定**：单窗口 + 窗口内切换（多窗口会引入「窗口↔工作区绑定」的新状态，且窗口间数据要实时同步）。
- 待用户拍板。

### 1.2 启动体验：双击之后看到什么？

- 歧义点：双击 → 默认浏览器的标签页；双击 → 无地址栏的独立应用窗口；双击 → 无控制台窗口（黑框）静默起服务。
- 现状：仓库内走 VBS（隐藏拉起 + 开默认浏览器）；便携包走 `start.cmd`（**前台黑窗**，关窗即停服）。
- **依现状推定**：双击后应是独立应用窗口、不出现控制台窗口；黑窗只保留为排障入口。
- 待用户拍板。

### 1.3 托盘与后台常驻：关窗之后服务还活不活？

- 歧义点：关窗 = 仅隐藏（服务继续跑，聊天/agent 任务不中断）还是 = 退出（服务停）；是否有托盘图标与右键菜单（打开/停止/退出）；开机自启默认开还是关。
- 现状：两条启动路径语义**不一致**——VBS 路径服务是隐藏常驻（关浏览器不影响），`start.cmd` 路径服务随窗口生死；开机自启需要用户显式执行 `kb autostart install`（`README.md:56-68`），且**便携包不支持** autostart/shortcut（`scripts/portable/README.txt:81`）。
- **依现状推定**：关窗仅隐藏、服务常驻托盘；开机自启默认**关**，由托盘菜单显式开启（沿用「不主动写注册表」的现有口径）。
- 待用户拍板。

### 1.4 多工作区：桌面端要不要比 Web 版多点什么？

- 歧义点：仅窗口内切换；还是每工作区独立窗口/独立快捷方式；还是同时并排看两个工作区。
- 现状：只有窗口内切换；`kb` 与 server 都是「一个实例服务多工作区」，server 不区分窗口。
- **依现状推定**：先保持窗口内切换，不做多窗口；多窗口涉及路由参数、窗口记忆、跨窗口状态同步，成本与收益不成比例。
- 待用户拍板。

### 1.5 与 Web 版的关系：壳，还是取代？

- 歧义点：桌面端只是 8787 上页面的另一个入口（共存），还是隐藏浏览器入口、只走桌面端。
- 现状：大量契约绑在 8787——`kb` 默认 `KB_SERVER=http://127.0.0.1:8787`（`README.md:141`）、`Docs/api.md`、测试页 5174、`agentboard.vbs` 的 `PORT` 常量（`scripts/agentboard.vbs:16`）、包内 `start.cmd:7`；agent 侧完全依赖 HTTP。
- **依现状推定**：桌面端只能是**壳**，8787 必须保留且行为不变；不能做「只允许壳访问」的收口。
- 待用户拍板。

---

## 2. 候选方案（4 个）

四个方案都建立在同一个前提上：**server 与 web 产物不动**，桌面壳只做「窗口 + 生命周期 + 入口」。差异在于壳用什么技术。

### 方案 A：轻量壳 —— 浏览器应用窗口 + 脚本托盘守护（现状加强版）

**形态**：双击桌面快捷方式 → 托盘出现图标 → 以 Edge/Chromium 的「应用窗口」模式（`--app=<url>`，无地址栏/标签页，有独立任务栏条目与图标）打开 `http://127.0.0.1:8787`；右键托盘：打开 / 停止服务 / 开机自启开关 / 退出；关窗仅隐藏。

**实现路径（现有栈能不能做）**：能，且不需要任何新依赖。
- 窗口：`msedge.exe --app=http://127.0.0.1:8787 --user-data-dir=%APPDATA%\AgentBoard\edge-app`（本机 Edge 已装，实测 True）。Chrome 未装，只能以 Edge 为主、Chrome 为可选回退。
- 托盘 + 生命周期：PowerShell 5.1 + `System.Windows.Forms.NotifyIcon`（系统自带），一个常驻脚本；server 拉起/停止沿用现有 `/api/version` 探活 + 现有重启端点（`RestartServerPanel.tsx:4-16`）或直接结束自家 pid。
- 单实例/聚焦：复用 `server.lock` 的判活语义；窗口聚焦用 Edge 应用窗口的既有行为或「再次 `--app` 打开同一 user-data-dir」。
- 可选增强：给 web 加 PWA manifest（当前**没有**，`apps/web/public/` 只有 `agentboard.ico`/`agentboard.png`），用 Edge「安装为应用」获得更完整的桌面图标与独立窗口；这是唯一需要动 `apps/web/**` 的部分。

**代价**：
- 工程量：小。新增 1 个托盘脚本 + 改启动脚本/包模板，不引入依赖、不动 server。
- 维护：多一套 PowerShell/WSH 脚本要跟着端口、路径、日志目录变化走；已有同类维护面（`scripts/agentboard.vbs` 的常量必须由 `autostart install` 回写，`README.md:66`）。
- 对便携包：`runtime\node.exe` 保持不变，包体积基本不变（只多一点脚本与图标），`start.cmd` 可保留为排障前台模式。

**适用场景**：想要「像桌面软件一样有独立窗口、托盘、双击即用」，但不需要安装包/自动更新/系统级深度集成。

**风险**：依赖系统装有 Edge（精简版 Windows/Server 可能没有；本机 WebView2 与 Edge 都在）；托盘进程与 server 进程是两套生命周期，脚本写错会留下「幽灵服务」（对策：托盘只通过探活+既有 lock 判定，不做暴力 kill）；应用窗口的外观仍是浏览器渲染，不可能有原生菜单栏。

---

### 方案 B：Electron 外壳

**形态**：真正的原生窗口（`BrowserWindow` + 原生菜单 + 托盘 + 单实例锁 + 安装器/免装包），窗口加载 `http://127.0.0.1:8787`；server 仍作为子进程用包内 `node.exe` 跑。

**实现路径**：可以，但引入新构建链。新增 `apps/desktop/`（main/preload），根 `package.json` 加 `electron` + `electron-builder`；主进程 spawn 现有 `apps/server/dist/index.js`（沿用 `runtime/node.exe`），避免让 server 跑在 Electron 内置 Node 上——后者与 `better-sqlite3` 的 ABI 不匹配，需要 `electron-rebuild`（`apps/server` 依赖原生模块，`scripts/package-portable.mjs:265-292` 已为此做了 ABI 校验）。

**代价**：
- 工程量：中到大。多一个包、多一套开发/打包脚本；托盘/单实例/自动更新现成，但要重写启动编排。
- 维护：最高。Electron 版本升级节奏跟着 Chromium；原生模块 ABI、签名、自动更新服务都是长期负担。
- 对便携包：zip 从 42.3 MiB 量级升到 **100 MiB+ 量级（粗估，未实测）**；`runtime\node.exe`（85.7 MiB 未压缩）仍然需要在包内，因为 server 继续用它跑；规则文件与 `check-rules.cmd` 不受影响，但包内多一层 `app/electron/`。
- 签名/SmartScreen：Electron 产物是 exe，下载分发会触发 SmartScreen；无证书时首次运行有警告，需给出口径。

**适用场景**：需要安装包体验、自动更新、系统级集成（全局快捷键、文件关联、深链 `agentboard://`），或后续准备对外分发。

**风险**：包体积与维护成本是现状的数倍；如果最终只用到「独立窗口 + 托盘」，方案 A 已覆盖，Electron 的增量收益没有对应需求支撑。

---

### 方案 C：Tauri 外壳

**形态**：Rust 原生窗口（Windows 上就是 WebView2），体积最小的「真桌面壳」；托盘/单实例/自启有官方插件。

**实现路径**：可行但门槛最高。需要 Rust 工具链（**本机 `cargo` 不在 PATH，实测缺失**）+ 新增 `src-tauri/` + WebView2 依赖（本机已装 `156.0.4314.58`，但目标机不保证）；server 仍需包内 `node.exe` 作为 sidecar 运行。

**代价**：
- 工程量：大。Rust 侧代码量小于 Electron，但构建环境（Rust + WiX/NSIS）要新增；CI/打包脚本复杂度上升。
- 维护：中高。WebView2 运行时版本差异会带来渲染差异（前端要在这套 WebView 上回归）；Rust 侧与前端两侧都要人懂。
- 对便携包：Tauri 可执行本体小，但 `runtime\node.exe` 依旧在包内（server 是 Node 程序），**总体体积与现在接近**，并不出现「体积减半」的收益；反而多出 Rust 构建链与 WebView2 前置检查。
- 签名：同样需要；SmartScreen 同上。

**适用场景**：确定要长期做跨平台（macOS/Linux）、或对安装包体积极度敏感，且团队愿意承担 Rust 构建链。

**风险**：本项目是 Windows 单机为主（`scripts/portable/README.txt:82`「仅支持 Windows x64」），Tauri 的核心卖点（小体积、跨平台）在这里都被「server 必须带 Node」抵消。

---

### 方案 D：WebView2 自建壳（最小原生宿主）

**形态**：自写一个小的原生宿主 exe（C# WinForms/WPF + WebView2，或 C++ + WebView2 SDK），加载 `http://127.0.0.1:8787`，自带托盘、单实例、关窗隐藏。

**实现路径**：可行（本机 WebView2 Runtime 已装），但需要 .NET 或 C++ 工具链与自写壳代码；.NET 若走 self-contained，体积 +60 MiB 量级（粗估）；走 framework-dependent 则违背「免装」承诺。

**代价**：
- 工程量：中。壳本身代码不大，但托盘/单实例/生命周期/更新全要自己写，没有 Electron 那样的现成生态。
- 维护：自研代码无上游生态兜底；WebView2 SDK 与 .NET 版本要跟着升级。
- 对便携包：`runtime\node.exe` 不变；额外增加自建 exe（+ 可能的 .NET 运行时），包体积增量介于 A 与 B 之间。

**适用场景**：明确拒绝引入 Chromium（Electron）也拒绝 Rust（Tauri），同时愿意维护一小段自研原生代码。

**风险**：三个「自己写」的系统能力（托盘、单实例、崩溃恢复）都是 bug 温床；与方案 A 相比，收益只是「不依赖系统 Edge 的 app 模式」，而本机 WebView2 与 Edge 均已存在。

---

### 方案对比（最小表）

| | A 轻量壳 | B Electron | C Tauri | D WebView2 自建 |
| --- | --- | --- | --- | --- |
| 新依赖 | 无 | electron + builder | Rust + tauri | .NET/C++ + WebView2 SDK |
| 窗口来源 | Edge 应用窗口 | Chromium 内置 | WebView2 | WebView2 |
| 包体积增量（粗估） | ≈0 | +100 MiB 量级 | 接近 0（server 仍带 Node） | +60 MiB 量级 |
| 托盘/单实例 | 自写脚本 | 现成 | 插件 | 全自写 |
| 自动更新 | 无 | 有现成方案 | 有现成方案 | 无 |
| 构建链变化 | 无 | 新增 desktop 包 | 新增 Rust 链 | 新增原生工程 |
| 对便携包规则文件 | 不变 | 不变 | 不变 | 不变 |
| 主要风险 | 依赖系统 Edge | 体积/维护/ABI | Rust 环境/WebView2 | 自研稳定性 |

---

## 3. 每个方案对现有约束的影响

逐条对照五条硬约束。

### 3.1 便携包 `pnpm package:portable`

- A：`scripts/package-portable.mjs` 只需多复制一个「桌面启动器目录」（或把托盘脚本放进 `scripts/portable/`），末段的包内自检 `verify-rules.mjs`、`check-rules.cmd` 不受影响（`package-portable.mjs:297-304`）。**改动最小**。
- B：需要新增桌面壳产物与 electron-builder 配置，打包入口要么包一层，要么并列第二条入口；`dirtyFiles()` 的过滤正则（`package-portable.mjs:218-228`）要加 `apps/desktop`。
- C：同 B，另加 Rust 构建步骤；「未装 Node 也能跑」的前提不变（server 仍用包内 node.exe）。
- D：同 B，另加 .NET/C++ 编译产物。

### 3.2 `runtime\node.exe`

- 四个方案里，**server 都继续用包内 `node.exe`**（A/B/C/D 都建议不把 server 塞进壳进程），因为 `better-sqlite3` 是按 Node 24 编译的原生模块，`package-portable.mjs:284-292` 已做 ABI 校验。B 的「Electron 内置 Node」路径会破坏这条，除非引入 `electron-rebuild`。

### 3.3 规则随包携带（`app\rules\` + `check-rules.cmd`）

- 四方案均不改变规则清单与自检口径（`package-portable.mjs:38-43,162-191,294-304`）。唯一要注意的是：若壳改变了「包内相对路径」结构，`verify-rules.mjs` 与 `kb.cmd` 里的相对路径要跟着验（A 不涉及）。

### 3.4 数据落点（中心库 vs 工作区 `.agentboard/agentboard.db`）

- 四方案都不应改变数据落点：默认仍是 `%APPDATA%\AgentBoard\agentboard.db`（`config.ts:79-81`），工作区库仍由 STORE 线（`.agentboard/agentboard.db`，`resolver.ts:43`）决定——本工作区当前还没有该文件。
- 壳不得把「数据目录」搬到包旁边：那会同时违反现有单例口径（`README.txt:76-77`）与 `start.cmd:12` 打印的 DB 路径约定；真要做「绿色版」必须单独成卡并处理迁移（见 Q6）。

### 3.5 Windows 单机为主

- A 依赖系统 Edge（本机实测已装）；D 依赖 WebView2 Runtime（本机实测已装）；B 与 C 自带/依赖 WebView2，但都引入 exe 与签名/SmartScreen 话题。
- 目前包只承诺 Windows x64（`scripts/portable/README.txt:82`），四方案都不破坏这条；只有 C 打开了跨平台的可能性。

### 3.6 单实例与「多开」口径

- A：沿用 `server.lock` + `/api/version` 探活（`index.ts:281-301`）；多窗口只是多个 Edge 应用窗口指向同一 server，**不需要**放开 server 单例。
- B/C/D：壳可以自己实现单实例（Electron/Tauri 有现成 API，D 要自写），但 server 仍是单例，多开数据仍要换 `APPDATA`+`AGENTBOARD_DB`+端口。

---

## 4. 结论与理由

### 结论（2026-11-05 用户拍板）：推荐 C（Tauri）

- **用户否决 A 的原话**：「我实在不想启动桌面端时又启动一个浏览器」。A 的 `msedge --app` 本质仍是另起一个 Edge 进程/浏览器窗口（任务栏图标归 Edge、任务管理器里是 `msedge.exe` 及其子进程），不满足「窗口必须属于这个应用本身」。
- **拍板结果**：C（Tauri）；B（Electron）降为「不愿引 Rust 时的退路」；A 作废；D（WebView2 自建）不采用（等于自己重写 Tauri 的壳层）。
- **不变口径**：关窗 = 隐藏到托盘、服务由壳托管持续运行；mac 必须覆盖（后置，见 DESKTOP-3）；不得出现独立的浏览器客户端窗口。
- 详细复核见 §7；Tauri 落地路径与 Windows/mac 差异见 §8。

### ~~历史推荐：方案 A（轻量壳：Edge 应用窗口 + 脚本托盘守护）~~（已作废，仅留档）

理由（每条对应上面实读事实）：

1. **要补的缺口正好是 A 的强项**。现状缺的是独立窗口、托盘、双击即用（第 1 节），不是缺 Web 应用；A 用现有 Edge 的 app 模式与系统自带的 PowerShell 托盘，零新依赖。
2. **不碰 server 与 web 契约**。8787、`kb` 默认地址、测试页 5174、VBS 端口常量全部不变（`README.md:141`、`scripts/agentboard.vbs:16`、`scripts/dev-page.mjs:23`），风险面最小。
3. **便携包几乎不增重**。B 会把 zip 从 42.3 MiB 推到 100 MiB+ 量级（粗估），且 `runtime\node.exe` 仍要保留；C 的「小体积」被 Node sidecar 抵掉；A 的增量是脚本与图标级别。
4. **已有资产可复用**。自动启停/自启/快捷方式的语义已存在（`README.md:56-68`，卡 `a0550248`），A 只是把它们收进一个托盘菜单，不重造。
5. **失败可回退**。A 的所有改动落在 `scripts/**` 与包模板，删掉即回到现在的「浏览器打开」体验；B/C/D 一旦落地就是长期维护承诺。

**什么时候该换成 B/C**：出现下面任一需求时——对外分发需要安装器/自动更新、需要 `agentboard://` 深链或文件关联、需要 macOS/Linux。那是方案 B 或 C 的领域，届时再单独立项，不要为了「桌面感」提前付出这部分代价。

### ~~A 口径的第一张实现卡建议~~（已作废；现行拆分见 §8.5）

- **DESKTOP-1｜启动器与窗口（最小可验证）**
  新增 `scripts/desktop/` 下的托盘脚本（PowerShell + NotifyIcon：打开 / 停止服务 / 开机自启开关 / 退出）与「应用窗口」启动逻辑（Edge `--app`，Edge 缺失时回退默认浏览器并提示）；复用 `/api/version` 探活与 `server.lock` 判活，不新增 server 端点，不改 `apps/**`。
  验收：① 双击无控制台窗口；② 独立窗口无地址栏、有任务栏图标；③ 关窗后服务仍在、托盘可重新打开；④ 二次双击只聚焦不重起；⑤ 托盘「停止」后探活失败、图标状态正确；⑥ 「退出」不留孤儿进程。
- **DESKTOP-2｜便携包接线**
  `scripts/portable/` 增加桌面启动入口（`start.cmd` 保留为前台排障），更新 `README.txt` 的启动与停止说明；`pnpm package:portable --no-zip` 冒烟 + `check-rules.cmd` 通过。
- **DESKTOP-3（可选）｜PWA manifest**
  仅当拍板要「安装为应用」的图标/标题体验时才做：`apps/web/public/manifest.webmanifest` + `index.html` 引用，走测试页 5174 验证、`dist 未重建（测试页已验证）` 口径。这是唯一会动 `apps/web/**` 的卡，必须与前两张串行。

> 三张卡的文件集互不相交（`scripts/desktop/**`、`scripts/portable/**`、`apps/web/public/**`），可按 `executing-task` 的规则并行或串行排布；实际建卡前需再核一次占用。

---

## 5. 待用户拍板的问题（6 条，每条 A/B + 代价）

> 前 6 条对应卡面的 6 个待澄清问题；每条已给「依现状推定」的建议答案，但只有用户点头才作数。

**Q1 窗口形态：一个窗口内切工作区，还是每工作区独立窗口？**
- A（建议，依现状推定）：单窗口 + 窗口内切换。代价：与现状一致，无新增状态。
- B：每工作区独立窗口/任务栏条目。代价：需要「窗口↔工作区」绑定（路由参数/窗口记忆）与跨窗口实时同步，前端要新机制；server 单例可不动。

**Q2 关闭窗口 = 隐藏还是退出？**
- A（建议，依现状推定）：关窗仅隐藏，server 常驻托盘，后台聊天/agent 任务不中断。代价：需要托盘与「真正退出」入口，用户要知道服务还在跑。
- B：关窗即停服。代价：后台任务被切断，下次启动要重新拉起（VBS 路径已是隐藏常驻，B 会与它语义冲突）。

**Q3 托盘与开机自启：默认常驻托盘 + 自启关，还是无托盘 + 自启开？**
- A（建议，依现状推定）：托盘常驻、开机自启默认关，由托盘菜单显式开启（沿用 `kb autostart install` 的「用户主动安装」口径）。代价：多一个常驻脚本进程。
- B：默认开机自启、无托盘。代价：未经同意写 `HKCU\Run`，卸载残留风险；且便携包目前明确不支持 autostart（`README.txt:81`），要先补。

**Q4 与 Web 版关系：共存还是取代？**
- A（建议，依现状推定）：共存——8787 保留，浏览器随时能开，`kb`/agent 契约不变。代价：无。
- B：只留桌面端入口（隐藏浏览器路径）。代价：`kb` 默认 `KB_SERVER`、`Docs/api.md`、测试页 5174、VBS 端口常量全部要重新定义，且 agent 侧工作流被破坏。

**Q5 技术轴：轻量壳（A）还是重量级壳（B/C/D）？——已拍板，不再是待决项**
- 结论：C（Tauri）。A 被用户否决（会另起 Edge 进程/浏览器图标）；B 作为「不愿引 Rust」时的退路保留；D 不采用。
- 代价：新增 Rust 工具链（本机 `rustc`/`cargo` 实测缺失，见 DESKTOP-0），Windows 上后台会有 `msedgewebview2.exe` 子进程；换来窗口归属应用、无浏览器客户端窗口。

**Q6 数据落点与便携包：继续中心库，还是做「绿色版」数据随包？**
- A（建议，依现状推定）：继续 `%APPDATA%\AgentBoard\`，包不携带数据（`config.ts:79-81`、`README.txt:20-27`）。代价：卸载要手动删数据目录；换机器要手动拷。
- B：数据默认放包旁。代价：与现有默认路径/文档/单例口径冲突，必须新卡做迁移与备份，且与 `start.cmd:12` 打印的路径文案冲突。

---

## 6. 本卡明确不做的事

- 不写任何实现代码；`apps/**`、`packages/**`、`scripts/**` 一字未改。
- 本轮只建卡（DESKTOP-0/1/2/3 已建，见 §8.5），不 claim 实现卡，卡内不写代码。
- 不替已关闭卡 `a0550248`（开机自启/桌面快捷方式）改口径，也不与它抢 `scripts/agentboard.vbs`。
- 不在本文档里讨论与 DSH 桌面壳 `net.fetch cookie 401` 相关的第三方产品问题。
- 未更新 `Docs/INDEX.md`（卡面要求「只写这一个文件」）；索引登记留到实现阶段随卡补，或由用户指定单独提交。

---

## 7. 追加（2026-11-05）：A 被否决、B/C 复核与最终拍板 C

### 7.1 否决记录

> 用户原话：「我实在不想启动桌面端时又启动一个浏览器」。

A 的 `msedge --app=...` 虽然去掉了地址栏与标签页，本质上仍是**另起一个 Edge 进程/浏览器窗口**：任务栏图标归 Edge，任务管理器里是 `msedge.exe` 及其子进程。这与「窗口必须属于这个应用本身」冲突，因此 **A 作废**。

- 上一轮按 A 口径写的 3 张卡（Edge app 窗口 + PowerShell 托盘 / 便携包接线 / PWA manifest）已全部删除（未 claim、无评论、无子卡），避免与新卡重码混淆。
- 不变口径：关窗 = 隐藏到托盘、服务由壳托管持续运行；mac 必须覆盖（后置）；不得出现独立浏览器客户端窗口。

### 7.2 B 与 C 在「用户看不到浏览器」维度的真实差异

| 维度 | B Electron | C Tauri（Windows） |
| --- | --- | --- |
| 任务管理器进程 | 应用 exe 的多进程（主/GPU/渲染/工具进程都以应用 exe 名出现）；**不会出现 `msedge.exe` / `msedgewebview2.exe`** | 宿主是应用 exe，但 WebView2 会拉起 `msedgewebview2.exe` 子进程（挂在应用名下，后台可见） |
| 窗口与任务栏归属 | 归应用，图标是应用图标 | 归应用，图标是应用图标 |
| 是否需装 WebView2 | 不需要（自带 Chromium） | Windows 需要 WebView2 Runtime（Win10 1803+/Win11 通常随 Edge 预装；LTSC/Server/精简版可能缺，需 bootstrapper 联网装或自带固定版运行时） |
| mac 侧渲染 | 自带 Chromium（每架构一份，需 macOS 构建） | 系统 WKWebView（无需安装运行时） |
| 工具链 | 纯 JS/Node（pnpm + electron-builder） | Rust + cargo（本机实测缺失）+ MSVC（VS 2022 Community 已装但不在 PATH）+ WebView2 |
| 包体积增量（粗估） | +100 MiB 量级（zip） | 壳本体 ~10 MiB 量级；若自带固定版 WebView2 再 +100 MiB 量级 |
| 每平台构建 | 一份 JS 代码，Windows/mac 两个目标；mac 需 macOS 机器或 mac CI | 同左，另加 Rust 原生构建矩阵与条件编译 |

**关键差异**：Tauri 省掉 Chromium 体积，但在 Windows 上**必然**出现 `msedgewebview2.exe` 后台进程——这是 WebView2 的实现方式，不是配置能消除的。用户否决 A 的理由是「又启动一个浏览器」，因此要把「后台子进程」与「浏览器客户端窗口」区分清楚：C 满足的正是「没有浏览器窗口、窗口与图标归应用」。

### 7.3 继续用包内 `node.exe` 跑 server 时的体积合计（粗估）

- 基线：便携 zip 42.3 MiB（含 `node.exe` 85.7 MiB 未压缩）。
- B：`node.exe` + Chromium → zip **140 MiB 量级**。
- C：`node.exe` + Tauri 小壳（WebView2 用系统）→ zip **45–50 MiB 量级**。
- 两方案都必须保留 `runtime\node.exe`：server 是 Node 程序，`better-sqlite3` 按 Node 24 编译（`scripts/package-portable.mjs:284-292` 的 ABI 校验）。**把 server 塞进壳进程会引入 ABI/重编译问题**，所以 §8 的进程模型是「壳 + 独立 node 进程」。
- mac 侧另算：C 的小壳 + 一份 darwin 版 node（~80 MiB 量级）。

### 7.4 只有 A 能做到、B/C 做不到的能力（供取舍参考）

1. **零新增依赖、零新增构建链**（当前根 `package.json` 无 electron/tauri）。
2. **包体积与构建时间基本不增**。
3. **不产出未签名 exe，无 SmartScreen 首次运行告警**。
4. **渲染引擎随系统 Edge 升级，免维护 Chromium/WebView2 版本**。
5. **不额外占一份浏览器内核的磁盘/安装依赖**（注意 Edge `--app` 仍会新起一组进程，内存不是零成本）。

放弃 A 换来的是：窗口与任务栏归属本应用、进程列表里没有 `msedge.exe`（C 仍有后台 `msedgewebview2.exe`）。

### 7.5 最终拍板：C（Tauri）；B 降为备选

**结论**：采用 C（Tauri）。代价是新增 Rust 工具链（本机 `rustc`/`cargo` 缺失，需用户批准安装）、Windows 后台存在 `msedgewebview2.exe`；换来壳体积小、mac 用系统 WKWebView、窗口归属应用。

依据三条：
1. 用户明确否决「另起浏览器」，B/C 都能满足「没有浏览器窗口」，C 的壳体积与 mac 运行时依赖（WKWebView 免安装）更省。
2. mac 是硬要求：C 在 mac 上无需下载/安装任何渲染运行时，B 则每架构要带一份 Chromium。
3. 体积与构建产物更贴近现有「便携 zip 40 MiB 量级」：C 的增量是壳本体，B 是 +100 MiB 量级。

**B 的退路条件**：若用户不愿在本机引入 Rust/MSVC 构建链，则改用 B（Electron）——纯 JS、无 Rust，但包体积 +100 MiB 量级，且需处理 `better-sqlite3` 的 Electron ABI（本设计仍建议 server 走包内 `node.exe` 独立进程，从而避开该问题）。

---

## 8. Tauri 落地路径

### 8.1 壳的职责边界

壳只做四件事：**窗口、托盘、单例、进程生命周期**。

- 不读写业务数据、不直连 SQLite、不代理 API 请求、不改端口。
- 窗口加载现有 `http://127.0.0.1:8787`（同源，无自定义协议、无 CORS 变更、无请求注入）。
- mac 只在接口/配置处预留，实现留到 DESKTOP-3。

### 8.2 进程模型（关键取舍）

```
Tauri 壳 exe
  └─ spawn: runtime\node.exe apps\server\dist\index.js   （独立进程，监听 127.0.0.1:8787）
       └─ better-sqlite3（按 Node 24 编译，与现在同一 ABI）
壳窗口（WebView2 / WKWebView）→ GET http://127.0.0.1:8787
```

- server 不走壳内置运行时：因此 **`better-sqlite3` 不涉及 Electron/Tauri ABI 问题**，`package-portable.mjs:284-292` 的 ABI 校验继续有效。
- 单例判定沿用现有两件套：`GET /api/version`（`name=agentboard-server`，见 `apps/server/src/api/systemRoutes.ts:132,152-154`）+ `<configDir>/server.lock`（`apps/server/src/index.ts:281-301`）。
- 关窗只隐藏；退出时等 server 自行退出并确认 `server.lock` 释放，不暴力 kill。

### 8.3 API 契约零变更

- 不改 `apps/server/**` 与 `docs/api.md` 的任何路径/字段/状态码；`kb` 的默认 `KB_SERVER`、测试页 5174、正式页 8787 全部不变。
- 壳只作为「又一个访问 8787 的客户端」，浏览器仍然可以同时访问同一实例（共存口径，见 Q4）。

### 8.4 Windows 与 mac 的差异

| 项 | Windows | macOS |
| --- | --- | --- |
| 渲染 | WebView2 Runtime（系统组件；本机实测 156.0.4314.58） | WKWebView（系统自带，无安装项） |
| 缺失运行时 | LTSC/Server/精简版可能没有，需 bootstrapper 或自带固定版 | 不存在该问题 |
| 托盘 | Tauri 官方托盘 API | 同一套 API（菜单栏图标），无需平台私有实现 |
| node 二进制 | `runtime\node.exe`（现有，85.7 MiB） | 单独 darwin 版 node（含对应架构）与 darwin 版原生模块 |
| 构建机 | Windows + MSVC（VS 2022 Community 已装，`cl`/`link` 需 Developer Command Prompt 或 PATH 配置） | macOS + Xcode Command Line Tools；签名/公证需 Apple 证书 |
| 产物 | `.exe`（可 zip 免装分发） | `.app` / `.dmg`（外部分发需 notarization） |

### 8.5 落地顺序（已建卡，本轮未 claim）

| 顺序 | 卡 | 短码/全长 | 前置 | 产出 |
| --- | --- | --- | --- | --- |
| 0 | DESKTOP-0 工具链与环境核查 | `e9d90ea0-b1dc-469b-8f96-7fef5b5d8ff4` | 无 | 只读环境报告（rustc/cargo/MSVC/WebView2/node） |
| 1 | DESKTOP-1 Tauri 壳骨架 | `5000a03f-7951-4a3e-9023-65897c7cfb41` | DESKTOP-0 | `desktop/**` + `scripts/desktop/**`：窗口/托盘/单例/隐藏/优雅停服 |
| 2 | DESKTOP-2 Windows 便携包接线 | `37dfa496-53d7-4ddd-84f6-ac636c448620` | DESKTOP-1 | 壳接入 `pnpm package:portable`，既有脚本行为不变 |
| 3 | DESKTOP-3 macOS 支持 | `f42b6f18-f9e0-468a-a891-ff8cc68cddb8` | DESKTOP-2 | WKWebView 壳 + 跨平台托盘 + 各平台 node 二进制 |

依赖边已用 `kb dep ls` 复核（0→1→2→3 串联）。本机当前实测：`rustc`/`cargo` 缺失，`cl`/`link` 不在 PATH，VS 2022 Community 的 VC 工具已装，WebView2 `156.0.4314.58`，node `v24.11.1`。
