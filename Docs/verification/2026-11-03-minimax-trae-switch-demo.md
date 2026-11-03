# minimax / trae 桌面登录态切换演示脚本（用户执行 + 只读核验）

- 日期：2026-11-03
- 任务：ACC-13（`65703143-0873-4ee5-8464-2be19c53513f`）。**说明**：该卡已由 server 线交付并处于「待验收」（minimax 文件级切换已实现；trae 取证结论=无法文件级切换，保持 `capture:false switch:false checkin:true reason_code=LOGIN_STATE_NOT_FILE_BASED`）。本脚本用于**真实第二账号**把 minimax 切换路径从 `unverified` 变成可复核结论，trae 只做只读观察。
- 执行分工：**客户端操作全部由用户做**（退出/登录/切回）；执行者只做只读复制、哈希与字段核验，**不启动、不停止、不改写任何客户端文件**，不读 token 原文。
- 脱敏口径：文件哈希/身份标识一律只报 **sha256 前 8 位**；不打印 token、JWT、cookie 原文；`auth.json` 只报键名与记录条数。

## 0. 只读前置（2026-11-03 16:59 现场，两客户端均未运行）

| 项 | MiniMax Code | TRAE CN |
|---|---|---|
| 进程 | 未运行（`Get-Process` 无 MiniMax/mcode） | 未运行（无 Trae 进程） |
| 安装 | `D:\Program Files\MiniMax Code\MiniMax Code.exe`，235,418,560 B | `D:\Program Files\Trae CN\Trae CN.exe`，214,715,792 B |
| 版本 | **3.1.10.203**（ProductVersion/FileVersion 同） | **3.4.14**（FileVersion 2.3.99936）——比 2026-11-03 调研时的 3.4.13 **已升级一次**，切换后需复核键结构是否仍一致 |
| 登录态主文件 | `~/.minimax/auth/prod/cn/mcode-public/auth.json`：606 B、mtime 2026-11-02 16:54、sha8 `24a7316a`、顶层键 `schemaVersion,records`、`records` **1 条** | `~/.trae-cn/trae-jwt-token`：925 B、mtime 2026-11-03 15:13、sha8 `4d24add3` |
| 状态文件 | `auth-state.json`：269 B、mtime 2026-11-02 16:54、sha8 `29f574e7`；`status=authenticated`、`storeKind=file`、`buildEnv=prod`、`region=cn`、**generation=30**、`expiresAtMs=1793613258130` | `%APPDATA%\Trae CN\User\globalStorage\state.vscdb`：1,560,576 B、sha8 `f38b224b`；`storage.json`：21,330 B、sha8 `3367feca` |
| 锁文件 | `auth.lock`：0 B、mtime 2026-10-21（**当前无活动锁**，只有历史残留的 0 字节文件） | 无对应锁文件 |
| 当前账号脱敏指纹 | `clientId` sha8 `d957b5c7`、`audience` sha8 `89f38629`、`generation=30` | 账号标识分散：`storage.json` 的 `iCubeAuthInfo://usertag`、`iCubeAuthInfo://icube-dc:578796082186762`、`iCubeAuthInfo://icube-dc:aha-0b9a…` 三条（值不读）；`~/.trae-cn/578796082186762/` 租户目录存在 |

> 复采命令（只读，执行者用）：见文末 §D。

---

## A 段：minimax 真实账号切换（脚本主体）

### A0 切换前备份（执行者做，只读复制到隔离目录）

| 备份对象 | 用途 |
|---|---|
| `~/.minimax/auth/prod/cn/mcode-public/auth.json`（整文件） | 账号 1 登录态基线；切换后比对 hash/generation |
| `~/.minimax/auth/prod/cn/mcode-public/auth-state.json`（整文件） | 状态机基线（`status`/`generation`/`expiresAtMs`/`clientId`） |
| `~/.minimax/auth/prod/cn/mcode-public/auth.lock`（若存在，记 0 字节与 mtime） | 判断切换过程是否留下锁 |
| `~/.minimax/auth/prod/cn/mcode-public/refresh/` 目录清单 | 判断刷新态是否新增/清空 |
| 当前指纹：`auth.json` sha8、`auth-state.json` sha8、`clientId` sha8、`audience` sha8、`generation`、`expiresAtMs` | 切换前后逐项对照 |

备份落点：`D:\tools\tmp\acc13\backup-<时间戳>\`（工作区外临时目录，验证结束清理），每份记录 `sha8 + 字节数 + mtime`。

### A1 用户操作步骤

1. 打开 **MiniMax Code**（当前未运行），确认已登录**账号 1**（设置/头像处看到的账号名记下来）。
2. 客户端内**退出登录**（头像菜单 → 退出/登出）。
3. **完全退出客户端**（托盘退出或窗口关闭后确认进程消失），等 10 秒。
4. 重新打开客户端，登录**账号 2**（用户提供的第二个授权账号，自行输入，不告知执行者）。
5. 等界面就绪（能进主界面、能新建任务），**保持客户端运行**。
6. 卡评论写：`A 已执行：账号2 已登录并就绪，时刻 HH:MM`。

### A2 切换后核验（执行者只读）

| # | 字段 | 采集 | 期望 |
|---|---|---|---|
| A2-1 | `auth.json` | sha8 / 字节数 / mtime | **hash 变化**（换账号必变） |
| A2-2 | `auth-state.json` → `generation` | 数值 | **≥ 31**（当前 30，切换应递增） |
| A2-3 | `auth-state.json` → `clientId` / `audience` sha8 | sha8 | **与账号 1 不同**（若不支持多账号区分，须记录实际值供判断） |
| A2-4 | `auth-state.json` → `status` | 字符串 | 仍 `authenticated`；若为 `expired`/`anonymous` 说明半写 |
| A2-5 | `expiresAtMs` | 数值 | 变为**新的未来时刻** |
| A2-6 | `auth.lock` | 是否存在 / 字节数 / mtime | 若出现**非 0 字节且 mtime 在切换期间** → 记为「锁残留」，切换后须能自行消失 |
| A2-7 | `refresh/` | 目录清单 | 记录新增/清空情况 |
| A2-8 | 实例 | `Get-Process MiniMax*` | 仍**单实例**（多实例=异常） |
| A2-9 | 客户端版本 | `ProductVersion` | 仍 3.1.10.203（被更新器改动则记录新版本） |

### A3 回滚（用户操作）

1. 客户端内退出账号 2 → 登录回**账号 1**（用客户端自身流程，**不要**由执行者回写任何快照文件）。
2. 等就绪，卡评论写：`A3 已执行：已切回账号1，时刻 HH:MM`。
3. 执行者核验：`auth.json` sha8 回到 `24a7316a` 或「不同但 `clientId` 回到 `d957b5c7`」（token 轮换会导致 file hash 不同，**身份看 clientId**）；`generation` 继续递增即可；`status=authenticated`；`auth.lock` 无残留；单实例。

### A4 失败分支（执行者记录，不代改）

| 现象 | 判定 | 后续 |
|---|---|---|
| 切换后 `status != authenticated` 或 `records` 变 0 | 登录态半写 | 记录，让用户重登；minimax `switch` 能力保持 unverified |
| `auth.lock` 存在且非 0 字节（mtime 在切换窗口） | 锁残留 | 记录；provider 的 `stop/start` 流程需要「锁检测 + 超时重试」 |
| 出现 2 个客户端进程 | 多实例 | 立即记录并停止写入类验证 |
| 客户端被更新器重启/提示升级 | 版本漂移 | 记录新版本，切回后重采键结构 |
| 账号 2 登录时报「该账号已在别处登录」 | 账号并发限制 | 记录原文（脱敏），保持 unverified |

---

## B 段：TRAE 只读观察（**不做文件级切换**）

背景：ACC-13 已取证——`~/.trae-cn/trae-jwt-token` 是主进程用 `POST {cloudide}/cloudide/api/v3/trae/GenerateTempToken` 换来的**派生临时令牌**（`writeFileSync(..., mode 384)` 写入、登出时删除、refresh 循环重写），真实登录态在加密的 cookie/leveldb 存储里，改写该文件**不会改变登录账号**；`state.vscdb` 384 个键中 0 个是 DPAPI/`enc:` 前缀的凭据。因此本段只做「观察 + 记录」，不做写入。

### B1 用户操作步骤（可选，仅用于采集账号切换时的文件变化）

1. 打开 **Trae CN**（当前未运行），确认已登录**账号 1**。
2. **完全退出客户端**（确认进程消失，等 10 秒）——SQLite 必须退出后再备份，避免 WAL 半写。
3. 执行者备份三处（只读）：
   - `%APPDATA%\Trae CN\User\globalStorage\state.vscdb`（含 `-wal`/`-shm` 若存在）
   - `%APPDATA%\Trae CN\User\globalStorage\storage.json`
   - `~/.trae-cn/trae-jwt-token`（只记字节数与 sha8）
4. 用户重新打开客户端，登录**账号 2**，等就绪后**再次完全退出**。
5. 执行者再采一次同样三处，逐项对照。
6. 卡评论写：`B 已执行：Trae 账号2 已登录并退出，时刻 HH:MM`。

### B2 观察字段（只读，值不进文档）

| # | 位置 | 字段 | 期望/说明 |
|---|---|---|---|
| B2-1 | `storage.json` | `iCubeAuthInfo://usertag` 的 sha8 + 长度 | 换账号应变化；只报哈希与长度 |
| B2-2 | `storage.json` | `iCubeAuthInfo://icube-dc:<租户/设备>` 键**集合** | 键集合变化即换租户/设备；键名可露，值不读 |
| B2-3 | `state.vscdb` | 文件 sha8、字节数、`-wal` 是否存在及大小 | 换账号会写库；`-wal` 残留说明未干净关闭 |
| B2-4 | `state.vscdb` | 用户级键里出现的数字 user id 集合（如 `2214882779084540`） | 记录集合变化（账号标识） |
| B2-5 | `~/.trae-cn/trae-jwt-token` | 字节数 + sha8 + mtime | 退出后应被删除或重写；只报这三项 |
| B2-6 | `~/.trae-cn/<数字租户目录>/` | 目录名与是否存在 | 换账号可能出现新租户目录 |
| B2-7 | 客户端版本 | `ProductVersion` | 当前 3.4.14（比调研时 3.4.13 升过级） |

### B3 结论预期与失败分支

- 若上述字段随账号变化但**没有单一可写文件能表达「当前账号」** → 确认 `LOGIN_STATE_NOT_FILE_BASED` 判断成立，`switch` 保持 `false`，记录证据。
- 若发现 `storage.json` 中存在**单一可整体替换**的凭据条目（例如某一条 `iCubeAuthInfo://…` 完整包含会话）→ 记录键名与长度，交 lead 决定是否开「文件级切换」实现卡（本脚本不实现）。
- 客户端退出后 `-wal` 仍存在且较大 → 说明未干净关闭，本轮数据作废重采。

---

## C 段：执行后需要贴到卡上的最小集合

用户只需贴（不要贴任何 key/token/cookie 原文）：

1. `A 已执行：账号2 已登录并就绪，时刻 HH:MM`；`A3 已执行：已切回账号1，时刻 HH:MM`。
2. `B 已执行：Trae 账号2 已登录并退出，时刻 HH:MM`（可选）。
3. 若切换过程中客户端弹了任何提示（如「需要重新登录」「账号已在别处登录」「需要更新」），把**提示原文**贴出来（不含凭据）。
4. 可选：两张客户端「账号/头像」界面截图（**把账号名/手机号打码**），用于确认确实换了账号。

执行者据此回填：A2 逐字段对照表、A3 回滚核验、B2 观察表、gate 更新（minimax `capture/switch` 是否可从 unverified 升级）。

---

## D 段：复采命令（执行者用，只读）

```powershell
# 进程与版本
Get-Process | Where-Object { $_.ProcessName -match 'MiniMax|Trae|mcode' } | Select-Object Id,ProcessName
(Get-Item 'D:\Program Files\MiniMax Code\MiniMax Code.exe').VersionInfo | Select-Object ProductVersion,FileVersion
(Get-Item 'D:\Program Files\Trae CN\Trae CN.exe').VersionInfo | Select-Object ProductVersion,FileVersion

# minimax 登录态（只看字节数/mtime/哈希，不打印内容）
$mm = "$env:USERPROFILE\.minimax\auth\prod\cn\mcode-public"
Get-ChildItem $mm | Select-Object Name,Length,LastWriteTime
Get-FileHash "$mm\auth.json" -Algorithm SHA256 | ForEach-Object { $_.Hash.Substring(0,8) }

# trae 三处
Get-Item "$env:USERPROFILE\.trae-cn\trae-jwt-token","$env:APPDATA\Trae CN\User\globalStorage\state.vscdb","$env:APPDATA\Trae CN\User\globalStorage\storage.json" |
  Select-Object Name,Length,LastWriteTime
```

> 执行者全程不 `Start-Process` / 不 `Stop-Process` 客户端；备份用只读复制；不修改 `.minimax` / `.trae-cn` / `Trae CN` 下任何文件。

---

## E 段：领取后现场变化（2026-11-03 17:03 复采，**基线已变，按此节执行**）

| 项 | 16:59 基线（§0） | 17:03 现状 | 说明 |
|---|---|---|---|
| MiniMax Code 进程 | 未运行 | **运行中（7 个 `MiniMax Code` 进程）** | 用户已启动客户端 |
| `auth.json` | 606 B / sha8 `24a7316a` / mtime 11-02 16:54 | 606 B / sha8 `0eeb4c15` / mtime **11-03 17:01:45** | 文件已被客户端重写 |
| `auth-state.json` | `status=authenticated`、`generation=30` | **`status=logout_pending`、`generation=32`** | 状态机处于过渡态（登出进行中），`clientId` sha8 仍 `d957b5c7`、`records=1` |
| `auth.lock` | 0 B（mtime 10-21） | 0 B（mtime 10-21） | 无活动锁 |
| TRAE CN | 3.4.14 | 3.4.14 | 未变；`trae-jwt-token` sha8 `4d24add3` / `state.vscdb` `f38b224b` / `storage.json` `3367feca` 均未变 |

### E1 由此追加的硬规则

1. **`status=logout_pending` 是过渡态**：不作为任何判定依据，也不在这时复制 `auth.json`（可能半写）。
2. **只在两个稳定窗口做备份与核验**：
   - 窗口 1 = 用户说「账号 2 已登录并就绪」且 `status=authenticated`；
   - 窗口 2 = 用户说「已切回账号 1」且 `status=authenticated`。
3. 基线改用「**回滚后**的账号 1 状态」作为长期基线；§0 的 `24a7316a / generation=30` 仅作历史参考。
4. 客户端运行期间不复制 SQLite/`auth.json`（minimax 是纯 JSON 但会被写；TRAE 是 SQLite，运行中复制可能得到半写库）。

### E2 判据调整（替换 A2 的对应行）

| 字段 | 判定 |
|---|---|
| `auth-state.json → status` | 必须为 `authenticated`；`logout_pending`/`login_pending`/`expired` 一律判「未稳定」，不采信 |
| `auth-state.json → generation` | 单调递增即可（30 → 32 → …），只作为「发生过状态迁移」的证据，不作为账号区分依据 |
| `auth.json → clientId` sha8 | 仍为 `d957b5c7` 时**不能**证明换过账号；换账号后应变化（若不变，则 minimax 可能用同一 clientId 多账号，需记录并在 gate 里降级） |