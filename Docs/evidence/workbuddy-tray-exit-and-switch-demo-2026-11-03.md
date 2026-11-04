# WorkBuddy Desktop 托盘退出复测 + 第二账号切换闭环（用户演示脚本）

- 日期：2026-11-03
- 任务：ACC-01（`9c1174b6-c4cf-4cef-972f-fbad52189438`）
- 执行者：board-web-accounts（准备与复测）；用户执行 A/B 两段的客户端操作
- 前置记录：`Docs/verification/2026-11-01-workbuddy-desktop-contract.md`「授权观测」节（本文件只追加，不覆盖既有结论）
- 目的：把 ACC-05 的「切换路径 blocked」解除条件跑到可复验：①用户演示一次真实托盘退出 ②提供第二个授权测试账号完成 捕获→切换→回滚→核验 闭环
- 本轮约束：只读观测；不读 vault / token 原文（字符串值一律 sha256 前 8 位）；不运行签到/登录；不强杀进程；不改客户端文件；不代用户启动或关闭客户端

## 0. 本轮只读基线（2026-11-03 10:20 现场，用户操作前）

| 项 | 当前值 | 与历史记录对比 |
|---|---|---|
| 运行状态 | 运行中，8 个 `WorkBuddy` 进程；主窗口 PID 56120，标题 `WorkBuddy` | 与 11-01 一致（多进程 + 主窗口持窗） |
| 目标实例 | `D:\Program Files\WorkBuddy\WorkBuddy.exe`；ProductVersion `5.9.3.0`（FileVersion 5.9.3，Tencent Shenzhen）；mtime 2026-10-27 09:31:32Z；204,590,360 B | 未升级、未换路径 |
| client_instance_id | `9cb538c4d37df467bad26e6f00a066b3ca772c154f8b526eb4569fdb1c436752`（公式复算同 11-01） | 一致 |
| 主凭据文件 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`；9,759 B；mtime 2026-11-03 09:34:32；schema `v2-wbencrypted` | 文件变大（8,218 → 9,759 B）属启动 token 轮换，schema 未变 |
| stable UID | `$.account.uid` → sha256 前 8 位 **`f5d89346`**；`accounts[]` 长度 1 | 与 7/13、8/27、10/27、11-01 全部一致 → 未换账号 |
| 身份骨架 | `~/.workbuddy/storage/skeleton/account-snapshot.json`；326 B；mtime 09:34:34；`primary.uid` 哈希 `f5d89346` | 一致 |
| 退出签名文件 | `~/.workbuddy/ioa-im-override.json`；32 B；mtime 09:34:33（注意：位于 `.workbuddy` 根，不在 `app/`） | 路径修正：旧记录未写全路径 |
| 窗口状态 | `~/.workbuddy/app/window-state.json`；106 B；mtime 10:16:45（仍在刷新 → 客户端活跃） | — |
| 启动日志 | `~/.workbuddy/logs/startup/2026-11-03/` 2 对（`56120-093426.log/.jsonl` 为当前实例） | — |
| 时间戳备份 | auth 目录现存 `2026-05-02 / 05-06 / 08-27` 三份 `.info` 备份（今日无新增） | 与 11-01 一致 |
| UID 派生键 | `~/.workbuddy-key-fallback/connector-keys/`：`f5d89346*`、`dae15da8*` 两个前缀 | 说明本机曾用第二个账号登录过；`dae15da8` 可作账号 2 的预期锚点（非必须） |
| closeToTray 旁证 | `~/.workbuddy/app/close-to-tray-hint.json` 存在（2026-05-06） | 一致 |

只读采集命令（我复测时执行，用户可自行对照）：

```powershell
# 进程与窗口
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle
# 写盘时刻（退出签名）
Get-Item "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info",
         "$env:USERPROFILE\.workbuddy\ioa-im-override.json",
         "$env:USERPROFILE\.workbuddy\app\window-state.json" |
  Select-Object Name, Length, LastWriteTime
# 启动日志尾对
Get-ChildItem "$env:USERPROFILE\.workbuddy\logs\startup\$(Get-Date -Format yyyy-MM-dd)" -File |
  Select-Object Name, Length, LastWriteTime
# 身份（只输出 sha256 前 8 位，不打印 uid 原文）
node D:\tools\tmp\acc01\state.cjs
```

---

## A 段：托盘退出复测（用户操作 ≤1 分钟）

### A1 用户操作步骤

1. 确认 WorkBuddy 窗口是当前可见的那个（标题 `WorkBuddy`），不做任何未保存编辑。
2. 看任务栏通知区（Win11 可能在「^」溢出区）找到 WorkBuddy 图标。
3. **右键**该图标。
4. 在菜单里点「退出 / Quit / 退出 WorkBuddy」。
5. 在卡 `9c1174b6` 评论里写一行：`A 已执行：托盘退出完成，时刻 HH:MM（本地时间）`。

- 若右键**没有**「退出」项：改从主窗口菜单（窗口右上角「…」或头像菜单）找退出项，并在评论里写明实际路径；仍无退出项 → 记为 `A 失败：无退出入口`，不要用任务管理器强杀。
- 退出后**不要**重新打开客户端，等我采完（约 1 分钟）。

### A2 退出后我立即采集的可只读证据

| # | 证据 | 采集方式 | 通过判据 |
|---|---|---|---|
| A2-1 | 进程表清空 | `Get-Process WorkBuddy` | 无任何 `WorkBuddy` 进程（=0）；有残留则记录 PID 列表 |
| A2-2 | 主凭据写盘 | `workbuddy-desktop.info` 的 `LastWriteTime` | **晚于**用户报告的退出时刻（分钟级对齐即可） |
| A2-3 | 退出签名第二次写盘 | `~/.workbuddy/ioa-im-override.json` 的 `LastWriteTime` | 与 A2-2 同刻（±10 s） |
| A2-4 | 窗口状态滞后写盘 | `~/.workbuddy/app/window-state.json` 的 `LastWriteTime` | 晚于 A2-2（历史实测滞后约 5 s） |
| A2-5 | 启动日志尾 | 当天 `logs/startup/<日期>/` 最后一对文件 | **不新增**启动日志（新增说明被重新唤起） |
| A2-6 | 身份未变 | `state.cjs` 的 `accountUid8` | 仍为 `f5d89346`（退出不应换账号） |
| A2-7 | 主进程监听端口消失 | `Get-NetTCPConnection -LocalPort 18488` | 无监听（辅助判据） |

### A3 判定

- **PASS（退出签名 supported）**：A2-1、A2-2、A2-3、A2-6 同时满足，且 A2-4 滞后关系成立。
  → 结论升级：`完全退出检测（写盘签名）` supported，`托盘退出（人工执行）` supported；provider 的 `stop() = 请求用户手动退出 + 轮询退出签名` 路径可进 ACC-05。
- **PARTIAL**：进程退出但写盘签名未变（三份文件 mtime 均未前进）→ 退出写入不可依赖，provider 只能用「进程消失 + 端口消失」判据，签名降级为辅助。
- **FAIL**：进程仍存在（尤其主窗口进程）→ 说明点的不是退出（只隐藏托盘），需按 A1 备选路径重试一次。

### A4 失败怎么看

- **窗口消失但进程还在**：典型 WM_CLOSE / 关闭到托盘；`window-state.json` 会写、`workbuddy-desktop.info` 不会写 → 记录为「只隐藏」，不算退出。
- **进程残留但主窗口没了**：记录残留 PID 与启动时刻（`Get-Process | Select Id,StartTime`），归入「未退净」，等用户处理（不代杀）。
- **写盘时刻比退出时刻早**：可能用户报的时刻晚于实际点击，按文件 mtime 与日志时间戳对齐，不臆测。
- **A2-5 出现新启动日志**：客户端被自动重启（更新器/单实例唤起），本轮退出复测作废，重做一次。

---

## B 段：第二账号闭环（用户操作 + 我核验）

前置：用户提供第二个**已授权**测试账号，并接受「登录态文件会被我只读复制到隔离目录用于比对」（不读取 token 原文）。

### B0 切换前我先做的备份（只读复制，写入隔离目录）

| 备份对象 | 目的 |
|---|---|
| `workbuddy-desktop.info`（整文件） | 账号 1 登录态基线，回滚后做哈希/身份比对 |
| `storage/skeleton/account-snapshot.json` | 身份骨架基线 |
| `~/.workbuddy/ioa-im-override.json` | 退出/切换签名基线 |
| `app/window-state.json` | 退出判据基线 |
| 当前 `uid8`（`f5d89346`）、instance id（`9cb538c4…`）、exe 版本（5.9.3.0） | 切换后逐项比对 |

备份位置：`D:\tools\tmp\acc01\backup-<时间戳>\`（工作区外，任务结束按用户要求清理），每份记录 sha256 前 8 位与 mtime。

### B1 用户操作步骤

1. 在 WorkBuddy 界面退出当前账号（账号 1）或用「切换账号」入口登录**测试账号 2**。
2. 等界面显示账号 2 就绪（能进主界面，不要求做任何业务操作）。
3. 卡评论写：`B1 已执行：已登录测试账号 2，时刻 HH:MM`。

### B2 切换后我核验的字段

| # | 字段 | 采集 | 期望 |
|---|---|---|---|
| B2-1 | `$.account.uid` 哈希 | `state.cjs` → `accountUid8` | **≠ `f5d89346`**（换账号必变；若等于 `dae15da8` 说明命中历史第二账号） |
| B2-2 | auth 目录新增时间戳备份 | `auth/` 目录列表 | 新增 `workbuddy-desktop.<TIMESTAMPZ>.info`（客户端账号变更时自建备份） |
| B2-3 | schema | `state.cjs` → `schema` | 仍 `v2-wbencrypted`（同一版本内不应回退 v1） |
| B2-4 | 身份骨架 | `skeleton.uid` 哈希 | 与 B2-1 相同（骨架与主凭据必须一致） |
| B2-5 | `accounts[]` 长度 | `state.cjs` → `accountsLen` | 记录实际值（账号 2 登录后可能 >1，属客户端多账号记录，不是产品缺陷） |
| B2-6 | instance id / exe 版本 | 公式复算 + VersionInfo | 不变（`9cb538c4…`、5.9.3.0） |
| B2-7 | 进程数 / 主窗口 | `Get-Process` | 仍是同一实例（不出现第二个安装实例） |

### B3 回滚到账号 1（用户操作）

1. 用客户端自身的「切换账号」退回**账号 1**（不使用我写入的快照文件，本轮只验证客户端自身切回是否可复现身份）。
2. 卡评论写：`B3 已执行：已切回账号 1，时刻 HH:MM`。
3. 我核验：`uid8` 回到 `f5d89346`；`skeleton.uid` 同步回落；schema 仍 v2；instance id / 版本不变；auth 目录再新增一份时间戳备份（预期）。
4. 若账号 1 需要重新输密码/扫码：这属客户端行为，记录即可（说明 token 未复用，provider 不能用文件哈希代替身份核验）。

### B4 脱敏口径（用户与我都遵守）

- 允许出现：文件**路径**、文件名（含客户端自建的时间戳备份名）、大小、mtime、schema 名称、`uid` 的 sha256 **前 8 位**、实例 id。
- 不允许出现：`auth.accessToken` / `refreshToken` / nickname / phoneNumber / mpOpenId 的明文或信封值；vault 引用；任何截图里带出账号手机号/昵称的区域（截图请打码）。
- 若需要证明「文件内容确实变了」，只报整文件 sha256 前 8 位（注意：启动轮换 token 也会变，哈希不能当身份判据）。

### B5 异常分支

| 现象 | 判定 | 后续 |
|---|---|---|
| B2-1 哈希未变 | 未真正换账号（只是刷新 token） | B 段作废，重做；记录为「切换未发生」 |
| 出现第二个安装实例进程（不同 exe 路径） | 多实例混用 | 立即停止写入类验证，回到 gate=blocked |
| 账号 2 登录后 schema 变 v1 或字段缺失 | 版本/形态不支持 | `schema 版本判定` 降级，记 unsupported 的具体字段 |
| 回滚后 uid8 不回到 `f5d89346` | 回滚不可靠 | `跨账号回滚` 保持 unverified，不解除 ACC-05 gate |
| 账号 2 无法登录（授权问题） | 环境阻塞 | 记 blocked，等用户换授权账号 |

---

## C 段：结果怎么喂回卡（用户最少要做的事）

用户只需做两件事：**执行操作** + **在卡评论写一行时刻**。其余由我采集并回填。

请贴到 `9c1174b6` 评论的最小集合：

1. `A 已执行：托盘退出完成，时刻 HH:MM`（或 `A 失败：<实际现象>`；若退出入口不在托盘右键，写明实际入口）。
2. `B1 已执行：已登录测试账号 2，时刻 HH:MM`；`B3 已执行：已切回账号 1，时刻 HH:MM`。
3. 可选：托盘右键菜单截图（打码昵称/手机号）、账号 2 的登录方式（扫码/密码/后台授权）。
4. 可选：若中途客户端弹「切换后需要重新登录」「有未保存内容」等提示，原文贴出（不含 token）。

我据此回填（写进本文件新节 + 卡评论）：

- 三份签名文件 mtime 前后对比表、进程/端口证据、启动日志尾对；
- 账号 1 / 账号 2 的 `uid8`、schema、`accounts[]` 长度、instance id、版本对照表；
- 逐字段 gate 状态更新（`完全退出检测`、`托盘退出执行`、`跨账号切换`、`回滚核验`）；
- ACC-05 是否可解除 blocked 的结论（解除 = A PASS + B 全部校验通过；任一 FAIL 保持 blocked 并写失败分支）。

---

## 本轮 gate 现状（2026-11-03 只读复核后，未解除任何一项）

| 字段 | 状态 | 说明 |
|---|---|---|
| app_id / 可执行检测 | supported | D: 5.9.3.0 唯一活跃实例，未升级 |
| client_instance_id | supported | 公式复算一致 |
| 当前身份读取 / stable UID | supported | `uid8=f5d89346`，与历史四次一致 |
| 快照字段与 schema 判定 | supported（结构） | v2 `$wbEncrypted`；文件变大属 token 轮换 |
| 启动检测（三信号） | supported | 今日 09:34 启动对 + 主窗口 + 18488（历史结论沿用） |
| 完全退出检测（写盘签名） | supported（判据）/ 待 A 段复核 | 本机 `ioa-im-override.json` 路径已修正到 `.workbuddy` 根 |
| 托盘退出执行（人工） | **unverified → 待 A 段** | 自动化已判 unverified，走「用户手动退出」路径 |
| busy/unsaved 判定 | unsupported（本机不可得） | provider 必须回退「请用户确认保存并退出」 |
| 跨账号切换 | **unverified → 待 B 段** | 当前 `accounts[]` 长度 1，本机历史第二账号键前缀 `dae15da8` |
| 跨账号回滚核验 | **unverified → 待 B 段** | 需 B3 后回落 `f5d89346` |
| 多实例共享认证位置 | unsupported（限定单活跃实例） | auth 为固定每用户路径 |

---

## A2 判据订正（2026-11-03 14:05 用户实测后，只追加）

上面 A2 表格里把 `~/.workbuddy/ioa-im-override.json` 当「退出签名」是**错的**：用户 14:05 的真实退出里，它 mtime 为 **14:05:20**（启动期写入），与退出无关。以下为订正后的可执行判据（与 `2026-11-01-workbuddy-desktop-contract.md` 的「2026-11-03 14:05 托盘退出复测」节一致）。

### A2'（订正版·按此判 PASS）

| # | 证据 | 采集方式 | 通过判据 | 实测（14:05 那次） |
|---|---|---|---|---|
| A2-1 | 进程表清空 | `Get-Process WorkBuddy` | `WorkBuddy` 进程数 = 0 | 14:12:54 采集 → **0** ✅ |
| A2-2 | 启动日志退出事件 | `~/.workbuddy/logs/startup/<日期>/<pid>-<HHMMSS>.log` 尾部 | 出现 `before-quit (… isQuitting=true, userConfirmed=true …)` 且随后 `finishQuit called (quitCleanupTimedOut=false)` | 14:05:39.408/.415 → 14:05:44.029 ✅ |
| A2-3 | 退出同刻写盘 | `~/.workbuddy/app/window-state.json` 的 mtime | 与 A2-2 的 `before-quit` **同秒**（±2s） | 14:05:39.417 ✅ |
| A2-4 | 端口消失 | `Get-NetTCPConnection -LocalPort 18488` | 无监听 | 辅助判据 |
| A2-5 | 身份未变 | `node D:\tools\tmp\acc01\state.cjs` | `accountUid8` 仍 `f5d89346`、`accountsLen=1`、schema `v2-wbencrypted`、`skeletonUid8=f5d89346` | 全部一致 ✅ |
| A2-6 | 反例排除 | 上面三个文件的 mtime | `workbuddy-desktop.info` / `ioa-im-override.json` / `account-snapshot.json` 的 mtime 落在**启动窗口**（本例 14:05:17–14:05:21），**不得**当作退出证据 | info 14:05:17.895、ioa 14:05:20.600、skeleton 14:05:21.849 ✅ |

**PASS 结论（已成立）**：A 段通过 → `完全退出检测` supported（可只读识别）、`托盘退出执行` supported（用户手动退出、无强杀）。`写入式跨账号切换 / 回滚核验` 仍 unverified，等 B 段。

**B 段待用户执行**（同上文 B1/B3）：登录第二个授权账号 → 我在卡里核验 `uid8 ≠ f5d89346`（若等于历史第二账号 `dae15da8` 则注明）→ 用户用客户端自身切回账号 1 → 我核验 `uid8` 回到 `f5d89346`、instance id `9cb538c4…` 与 exe 版本 `5.9.3.0` 不变。