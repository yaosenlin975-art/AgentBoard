# WorkBuddy Desktop 契约核查

- 日期：2026-11-01
- 任务：ACC-01（9c1174b6-c4cf-4cef-972f-fbad52189438）
- 结论：安装实例已识别；登录身份、快照和恢复 gate=unverified；ACC-05 不得启用真实切换。
- 范围：只读已安装程序版本、进程名称/路径及既有参考源码；未读取 auth/vault/账号文件，未运行客户端、关闭进程或签到。

## 实例

| 产品 | 已观察可执行文件 | ProductVersion | client_instance_id（提案） |
|---|---|---|---|
| WorkBuddy | `C:/Users/31633/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe` | 4.22.5.0 | `f6b140a4d1008e3078b1997f3b965d764d588ee2664da78affde96717e82e131` |
| WorkBuddy | `D:/Program Files/WorkBuddy/WorkBuddy.exe` | 5.9.3.0 | `9cb538c4d37df467bad26e6f00a066b3ca772c154f8b526eb4569fdb1c436752` |

版本取自各 exe 的 VersionInfo；进程名称查询未返回 WorkBuddy/CodeBuddy 进程。该观察不能证明未来窗口无未保存工作。实例 ID 定义为 SHA-256(`app_id + NUL + canonicalExePath.toLowerCase()`)，实施时先 realpath，再计算；版本单独验证，不纳入稳定实例 ID。多实例不得按进程名混用。

## 契约 gate

| 字段 | 状态 | 依据与执行条件 |
|---|---|---|
| app_id / executable detection | supported（只读检测） | 上表 ProductName=WorkBuddy；仅支持显式选定实例 |
| 当前稳定 UID | unverified | 参考 `D:/WorkSpaces/LLM 看板/desktop/auth.mjs:10-38` 从 `account.uid` 读取；未核验这两个安装版本的真实登录态 |
| 快照字段/格式 | unverified | 同文件解析 `auth.accessToken` 或 `$wbEncrypted/envelope`；`desktop/settings.mjs:107-124`、`desktop/platform.mjs:23-35` 指向平台认证目录。仅为参考实现路径，不视为当前客户端契约 |
| 独立实例认证数据 | unverified | 参考默认 auth 路径不包含安装实例，不能证明两个安装可独立切换；禁止按默认路径直接写入 |
| 捕获与加密 | unverified | `desktop/store.mjs:166-300` 有保存快照流程；本次未读取任何登录资料 |
| 正常退出 / 忙闲态 | unverified | `desktop/controller.mjs:95-166` 有完整路径比对的进程检测；未证明窗口忙闲与未保存状态。检测不可靠时先由用户保存并退出 |
| 原子替换 / 回滚 | unverified | `desktop/store.mjs:396-468` 有身份检查、停止、写入与失败恢复流程；未在目标版本执行 |
| 恢复后独立身份核验 | unverified | 未使用两个授权测试账号运行正向/反向切换，禁止报告切换成功 |

## 契约测试矩阵

| 用例 | 必须结果 | 本轮 |
|---|---|---|
| snapshotIdentityMustMatchProductInstanceAndUid | app/instance/UID 任一不符，不写入 | 未实现 provider；未运行 |
| unknownActivityStateBlocksClose | 忙闲未知、未保存未知，拒绝自动关闭/写入 | 未实现 provider；未运行 |
| rollbackMustVerifyOriginalIdentity | 恢复原文件后必须核对原 UID；不一致保持 recovery_required | 未实现 provider；未运行 |
| 多版本共享认证位置 | 未证实映射前实例不可切换 | 已据静态缺口设 gate=unverified |

`workbuddyProvider.test.ts` 尚不存在；本卡不创建空壳测试，不宣称对应命令通过。

## 解除阻塞条件

- 选定目标安装实例与版本，提供两个已授权的测试账号场景。
- 明确允许对测试登录态做受限捕获、加密保存及原账号恢复验证；不输出令牌原文。
- 客户端空闲且已保存内容，正常退出/启动和身份探测可复现。
- 每个版本分别证明快照范围及独立 UID 还原；只给通过门禁的版本启用 provider。

---

# 2026-11-01 授权观测（真实现场）

- 执行者：kb-cli；用户授权范围：版本/实例/身份稳定性/正常退出与恢复的真实观测，测试账号场景取当前本机登录态。
- 本节结论覆盖上方 codex 静态核查的 gate 状态。
- 方法：只读命令（Get-Item/Get-Process/Get-NetTCPConnection/Get-FileHash/reg query）+ 授权流内的启动/优雅关闭观测。所有疑似凭证文件的值未读原文，仅记录路径、大小、键结构，字符串值一律输出 sha256 前 8 位。观测/复现脚本：`C:\Users\31633\AppData\Local\Temp\acc01-obs\`（`scan-structure.cjs` 为脱敏结构扫描器，`hashes.cjs` 为实例 ID 复算，`launch.ps1`/`graceful-close.ps1`/`tray-*.ps1` 为授权流观测）。
- 违规检查：未读任何 token/cookie/vault 原文；未运行签到；未触发登录动作；未使用 taskkill /F 或任何强杀；未修改任何客户端文件（观测启动的客户端实例由本卡启动并保持运行，见 §4）。

## 1. 安装实例表

| 项 | 实例 A（排除） | 实例 B（当前活跃） |
|---|---|---|
| 可执行路径 | `C:\Users\31633\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe` | `D:\Program Files\WorkBuddy\WorkBuddy.exe` |
| ProductVersion | 4.22.5.0（FileVersion 4.22.5，Company=Tencent Technology） | 5.9.3.0（FileVersion 5.9.3，Company=Tencent Technology (Shenzhen) Company Limited） |
| 版本来源 | exe VersionInfo（Get-Item .VersionInfo）；exe mtime 2026-05-05，223,077,424 B | exe VersionInfo；exe mtime 2026-10-27，204,590,360 B |
| 注册表 | 无卸载项（HKLM/HKCU Uninstall 均无） | HKCU\...\Uninstall\BFD312E9-1019-4F57-9F44-F86246833B50：DisplayName=WorkBuddy 5.9.3，UninstallString 指向 D: |
| 数据目录 | `%APPDATA%\WorkBuddy`（Electron userData，最后活动 2026-04-29）+ `%LOCALAPPDATA%\WorkBuddyExtension`（VSCode 形态，最后活动 2026-04-28）；无活跃 auth | `~/.workbuddy`（数据根：workbuddy.db、logs/、storage/、app/）+ `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`（auth 根） |
| 是否正在运行 | 否 | 观测开始前否；本卡启动观测后保持运行（窗口可见） |
| client_instance_id | `f6b140a4d1008e3078b1997f3b965d764d588ee2664da78affde96717e82e131` | `9cb538c4d37df467bad26e6f00a066b3ca772c154f8b526eb4569fdb1c436752` |

- client_instance_id 定义（已复算，与 codex 记录一致）：`SHA-256("workbuddy_desktop" + NUL + canonicalExePath.toLowerCase())`。稳定性证据：两路径本次复算逐字节复现既有 ID；版本号不参与 ID，升级不改 ID。
- 实例 B 绑定证据：今日启动日志 `~/.workbuddy/logs/startup/2026-11-01/` 含 `"appVersion":"5.9.3"`；`~/.workbuddy/app/renderer-version.json` 内容哈希 = SHA-256("5.9.3") 前 8 位（ac5f0ffa）。实例 A 数据树 4 月后无任何活动，判定为陈旧残留，ACC-05 范围排除。
- 命名陷阱：auth 根目录名为 `CodeBuddyExtension`（客户端基于 CodeBuddy IDE 壳），但其中文件为 `workbuddy-desktop.info`、目录内有 `CodeBuddyIDE` 子结构，属 WorkBuddy Desktop 产品数据，勿与 CodeBuddy 产品混淆。
- 多实例认证位置：auth 路径为固定每用户路径（不含安装实例段）。当前仅一个活跃安装可支持；同产品装第二份 5.9.x 会共享同一 auth 文件，切换范围限定「每产品一个活跃安装实例」。

## 2. 当前身份字段（supported）

主凭据文件 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（8,218 B，JSON）：

| 键路径 | 结构 | 脱敏值（sha256_8） |
|---|---|---|
| `$.account.uid` | string len=36 | `f5d89346` |
| `$.account.nickname` / `$.account.phoneNumber` / `$.account.mpOpenId` | `{$wbEncrypted:1, envelope:string}` 加密信封 | envelope `c23828ef`/`fe4ef84f`/`de568660` |
| `$.auth.accessToken` / `$.auth.refreshToken` | `{$wbEncrypted:1, envelope:string}`（len 2500/1408） | `0f8e9b48`/`e222ab22` |
| `$.accounts[]`、`$.allAccounts[]` | 与 `$.account` 同构的账号数组（len=1，uid 相同） | `f5d89346` |

客户端自维护身份骨架 `~/.workbuddy/storage/skeleton/account-snapshot.json`（326 B，非密钥）：`{primary:{version,uid,nickname,type,editionType,isPro,isAdmin,oneidAccountId,enableArdotDesign,showDefaultPermission,savedAt}}`，`uid` 哈希同为 `f5d89346`。

**stable UID 结论：存在，且跨重启稳定（supported）。** 证据链（均以 sha256_8 比对，未读原值）：
1. `~/.workbuddy-key-fallback/connector-keys/f5d89346485dd3e33a993e81bb9f05b4.key` 文件名前 8 位 = uid 哈希（2026-07-13，客户端以 UID 派生本机键文件名）。
2. 2026-08-27 的 auth 备份 `workbuddy-desktop.2026-08-27T12-49-03-117Z.info`：uid `f5d89346`。
3. 2026-10-27 `workbuddy-desktop.info.5d63bdd69323e571.observation.json`：`identity.userId` `f5d89346`。
4. 本次现场（2026-11-01）：用户真实退出（21:01）→ 本卡启动（21:18）→ WM_CLOSE 隐藏托盘（21:19）→ 二次唤起（21:26），`.info` 三处 uid 与 account-snapshot uid 全程 `f5d89346` 不变。
5. 反例锚点：2026-05-02 备份 uid=`cacb9fd3`（当时登录的另一账号）——UID 随账号切换改变，身份核验必须解析 `account.uid`，不能以文件哈希代替。

## 3. 快照字段 / 版本（supported，结构层面）

构成「登录态」的最小集合（只列路径与结构，值未读）：

| 文件 | 角色 | 写盘时机（实测） |
|---|---|---|
| `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` | 主凭据：auth（accessToken/refreshToken 加密信封 + 过期时间）+ account/profile | 启动时重写（token 轮换）；真实退出时写 |
| `~/.workbuddy/storage/skeleton/account-snapshot.json` | 身份骨架（uid/类型/版本标记） | 启动时重写 savedAt |
| `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.<TIMESTAMPZ>.info` | 客户端自身的带时间戳多账号备份（2026-05-02、05-06、08-27 三份现存） | 客户端账号变更时 |

schema 版本判据：v1（≤4.22.x 时代，2026-08 备份仍如此）`auth.accessToken` 为明文字符串、nickname/phoneNumber 明文、含 `wechatOpenId`；v2（5.9.3 现行）敏感字段统一 `{$wbEncrypted:1, envelope}`，新增 `isAdmin/isCreator/mpOpenId/loginChannels/logOutEnable/allAccounts`。**文件哈希在启动后必变（token 轮换），只能做完整性比对，不能做身份比对。**

snapshot schema 草案：

```jsonc
{
  "schema": "agentboard.workbuddy-desktop.snapshot/1",
  "app_id": "workbuddy_desktop",
  "client_instance_id": "9cb538c4...",          // sha256(app_id+NUL+lowercase exe)
  "identity": { "uid_sha256_8": "f5d89346", "account_type": "<type字段的sha256_8>" },
  "version": { "product": "5.9.3", "schema": "v2-wbencrypted", "captured_at": 0 },
  "files": [                                     // 相对根：见上表；值为整文件字节
    { "path": "%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info", "role": "credential", "sha256": "<capture 时>" },
    { "path": "~/.workbuddy/storage/skeleton/account-snapshot.json", "role": "identity-skeleton", "sha256": "<capture 时>" }
  ]
}
```

快照文件本体存 DPAPI vault；数据库与日志只存 `uid_sha256_8`、别名与引用。

## 4. 正常退出 / 启动检测

- 进程与窗口：进程名 `WorkBuddy`（多进程 5–7 个）；主进程持可见窗口，标题 `WorkBuddy`。就绪判定（启动后约 4 秒内全部出现）：① 主窗口 HWND+标题；② `~/.workbuddy/logs/startup/YYYY-MM-DD/<pid>-<HHMMSS>.{log,jsonl}` 对（≤2 秒落盘，文件名含主进程 PID 与启动时刻）；③ 主进程监听 `127.0.0.1:18488`（helper 监听 54694/54695）。
- **WM_CLOSE ≠ 退出**：`CloseMainWindow()` 后窗口销毁（MainWindowHandle=0）但 7 个进程全部存活，且不产生任何写盘。客户端为关闭到托盘行为（旁证：`~/.workbuddy/app/close-to-tray-hint.json` 存在）。
- **真实退出签名**（用户 21:01 手动退出实测）：`workbuddy-desktop.info` 与 `ioa-im-override.json` 同刻写盘（13:01:29Z）→ `app/window-state.json` 滞后 5 秒（13:01:34Z）。据此「完全退出」可用只读判据识别：窗口不存在 + `window-state.json` mtime 晚于 auth 写盘 + 进程数为 0。
- busy/unsaved 状态：无法从文件/进程证据判定 → unverified；provider 侧必须走「无法确认即要求用户手动保存并退出」路径。
- 托盘退出自动化：UIA 可枚举到溢出区托盘图标 `[ WorkBuddy]` 并右键，但未产生任何可定位的菜单窗口（Win11 XAML 宿主或该图标无右键菜单）→ **优雅退出自动化 unverified**。参考实现 `controller.mjs` 的 Windows 停止路径用 `taskkill /T /F`（强杀），违反本卡约束，provider 实现不得照抄。
- 单实例语义：客户端运行中再次 Start-Process 不产生新实例，唤起原窗口（同 PID/HWND），伴生一个短命启动日志对（如 54020-212602）。
- 本次观测遗留状态：WorkBuddy（D: 5.9.3）由本卡启动，现窗口可见保持运行；hide-to-tray 试验后已重新唤起窗口。未做强制关闭。
- workbuddy.db（SQLite）运行中被进程独占锁定，无法只读哈希；客户端停止后可读（退出前实测 221,184 B）。

## 5. 恢复 / 身份证明

- 跨「真实退出 → 重启」身份不变：supported（§2 证据链 4，本卡启动前后 uid 一致）。
- 账号切换 / 回滚后身份核验（rollbackMustVerifyOriginalIdentity 的现场证明）：unverified——当前仅有单账号登录态，未执行写入式切换。
- 快照可还原性（用捕获的 .info 恢复到另一账号再恢复回来）：unverified，需第二授权账号。

## 6. 逐字段 gate 表（本节覆盖前表）

| 字段 | 状态 | 证据与复现 |
|---|---|---|
| app_id / 可执行检测 | supported | §1 表；复现：`Get-Item <exe>).VersionInfo` + `reg query HKCU\...\Uninstall\BFD312E9-1019-4F57-9F44-F86246833B50` |
| client_instance_id | supported | §1 定义与复算；复现：`node hashes.cjs` |
| 当前身份读取（getCurrentIdentity） | supported | §2；复现：`node scan-structure.cjs <auth.info> <account-snapshot.json>`，uid_sha256_8=f5d89346 |
| stable UID（跨重启） | supported | §2 证据链 1–4 |
| 快照字段/结构（captureSnapshot 只读面） | supported（结构） | §3 文件清单与 schema 草案；未执行写入式捕获恢复 |
| schema 版本判定 | supported | §3 v1/v2 判据（明文 token vs $wbEncrypted 信封） |
| 启动检测 | supported | §4 就绪三信号 |
| 完全退出检测 | supported（判据）/ unverified（自动化执行） | §4 真实退出签名；托盘退出菜单自动化未达 |
| closeToTray 识别 | supported | §4 WM_CLOSE 行为 |
| busy/unsaved 判定 | unsupported（本机证据不可得） | §4；provider 须回退为「用户手动确认」 |
| 优雅退出执行（provider 侧 stop()） | unverified | 托盘菜单自动化失败；需用户手动退出或授权替代方案 |
| 跨账号切换/回滚恢复 | unverified | §5；需第二授权账号 |
| C: 4.22.5.0 实例 | unsupported（陈旧，排除） | 无卸载项、数据树 2026-04 后无活动、auth 形态为旧 schema |
| 多安装共享认证位置 | unsupported（限定单活跃安装） | auth 为固定每用户路径，无实例段 |

## 7. 契约测试矩阵（断言描述，本卡不实现）

| 用例 | 断言 | 测试数据形状 | 状态 |
|---|---|---|---|
| snapshotIdentityMustMatchProductInstanceAndUid | validateSnapshot(snapshot) 返回的 identity 三元组必须与目标 (app_id, client_instance_id, uid_sha256_8) 完全一致；任一不符拒绝写入并返回固定错误码 | snapshot JSON（§3 草案）：app_id="workbuddy_desktop"、instance=9cb538c4…、uid_sha256_8 与现场 `.info` 解析结果比对；负例：instance=f6b140a4…（陈旧实例）、uid_sha256_8=cacb9fd3（历史账号） | 断言成立所需输入均已由现场证据定义；用例未运行（provider 未实现） |
| unknownActivityStateBlocksClose | canCloseSafely() 在以下任一情况返回 {safe:false}：进程存在但窗口不可见（closeToTray）、`window-state.json` mtime 未晚于 auth 写盘、无 `logs/startup` 就绪记录 | 现场观测进程表（7 进程、MainWindowHandle=0）为 busy 样本；退出后空进程表为 safe 样本 | 判定输入已定义；用例未运行 |
| rollbackMustVerifyOriginalIdentity | 回滚写入备份后必须重新解析 `.info` 的 uid 并与回滚前记录的 uid_sha256_8 比对；不一致置 recovery_required 并冻结该实例写入 | 备份快照（§3 files[]）+ 回滚前 uid_sha256_8 + 回滚后实测解析值；负例：恢复文件为 cacb9fd3 账号的 v1 schema 旧文件 | 断言成立所需输入已定义；用例未运行 |

补充断言（来自现场新证据）：snapshot 文件哈希不得作为身份判据（启动 token 轮换必变哈希）；provider 不得实现 taskkill /F 强杀（参考 controller.mjs Windows 路径违规）。

## 8. ACC-05 gate 结论

- **进入 ACC-05 范围（目标实例 = D: 5.9.3.0，client_instance_id=9cb538c4…）**：身份读取、stable UID、快照结构/schema 版本、启动检测、完全退出判据、closeToTray 识别。这些字段 supported，可开始 provider 实现（只读面先行）。
- **保持阻塞的字段**：①优雅退出自动化执行（unverified）；②跨账号捕获→切换→回滚→身份核验（unverified，需第二授权测试账号）；③busy/unsaved 判定（unsupported，走用户确认路径）。
- **结论：provider 可进入实现但不满足「真实切换验收」前置；ACC-05 的切换/恢复路径保持 blocked。**
- 解除条件：
  1. 用户手动演示一次托盘退出（托盘图标右键 → 退出），复测「真实退出签名 + 全进程清零」判据与启动后身份不变；或用户明确授权 provider 采用「请求用户手动退出 + 轮询退出签名」的 stop() 方案（禁止强杀）。
  2. 提供第二授权测试账号，完成一次受限捕获→写入→启动→身份核验→回滚→原身份核验闭环；全程不输出令牌原文。
  3. 实现时限定：仅支持单活跃安装实例（5.9.3+，schema v2）；检测到 v1 schema（明文 token）或 C: 陈旧实例即返回 unsupported。
