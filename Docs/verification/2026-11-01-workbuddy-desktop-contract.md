# WorkBuddy Desktop 登录快照契约验证（ACC-01 · 以代码为准的再验证）

- 卡号：`9c1174b6`（ACC-01）
- 验证日期：2026-11-05
- 验证方式：只读静态核对 + 本机现场只读取证 + fake 环境单测。**未做任何真实切换/写回**，未读取任何凭据原文（只输出字段名、文件大小、mtime 与 `sha256(uid)` 前 8 位）。
- 历史现场记录：`Docs/evidence/workbuddy-desktop-contract-2026-11-01.md`（本页不重复其历史行号表，只给本轮结论与代码对照）。

## 0. 三档结论速览

| 档位 | 条数 | 说明 |
| --- | --- | --- |
| 已验证 | 16 | 文件路径/存在性/加密平面/身份算法/is_current 判定/退出签名/校验门禁，均有代码行号或本轮命令输出 |
| 未验证 | 5 | 真实写回是否被客户端认账、token 过期/服务端拒绝、真实回滚、busy 影响、双账号并存 |
| 无法验证 | 4 | macOS 路径与 Keychain、`$wbEncrypted` 密钥来源、客户端内部 busy 状态、服务端对旧 token 的态度 |

**一句话回答**：可以靠本机快照**可靠判定当前登录身份**（`uid → sha256(uid)`，与 `managed_account.identity_hash` 及 vault scope 同一算法），也**具备安全还原的工程结构**（锁 vault + 三元组校验 + 原子写 + 启动核验 + 回滚）；但「写回后客户端是否真的认账」**没有一次真机证据**（`account_operation` 中 switch 记录为 0）。

## 1. 契约逐条结论

### 1.1 快照来源与加密平面

| 项 | Windows | macOS |
| --- | --- | --- |
| 凭据文件 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（每用户固定路径 → 每产品单活跃实例） | **无法验证**：本机无 macOS，仓库与 Docs 无任何 macOS 路径/Keychain 记录 |
| 身份骨架 | `%USERPROFILE%\.workbuddy\storage\skeleton\account-snapshot.json` | 同上 |
| 退出签名 | `%USERPROFILE%\.workbuddy\app\window-state.json` | 同上 |
| 启动日志 | `%USERPROFILE%\.workbuddy\logs\startup\<YYYY-MM-DD>\<pid>-<HHMMSS>.{log,jsonl}` | 同上 |
| 客户端落地形态 | **明文 JSON + 敏感字段为 `{$wbEncrypted:1,envelope}` 信封（schema v2）**；envelope 是不透明字节 | 无法验证 |
| 我方存储形态 | 抓包后整体落 **Windows DPAPI（CurrentUser）** 的 `.dpapi` 文件，scope 绑定 `app_id + client_instance_id + identity_hash + purpose` | 代码对非 win32 直接 `VAULT_UNAVAILABLE` |

结论：**已验证（Windows）** / **无法验证（macOS）**。注意 `.info` 不是全文件加密：非敏感字段（含 `account.uid`、`accounts[]`）是明文，token 才是信封。

### 1.2 身份标识与 `identity_hash` 对齐

- 唯一标识：`$.account.uid`（36 字符，token 轮换不变）。
- `identity_hash = sha256(uid)`（64 位小写 hex，provider 第 105/340 行；`readWorkbuddyIdentity` 入口）。
- 对齐链路：`managed_account.identity_hash` ↔ `vault scope.identity_hash` ↔ 切换后 `readWorkbuddyIdentity().identity_hash` ↔ 插件线签到 JWT 的 `sub`。
- 本轮现场：auth 的 `uid` 长度 36，`sha256(uid)[0:8] = f5d89346`；skeleton 的 `primary.uid` 同哈希；现存账号 `600f9d7c` 的 `identity_hint = f5d89346`；插件线 token 的 `sub` 哈希同为 `f5d89346`。

结论：**已验证**（同一账号三处身份一致）。「换账号后哈希随之改变」只有历史旁证（`~/.workbuddy-key-fallback/connector-keys/` 同时存在 `f5d89346*.key` 与 `dae15da8*.key`），**未验证**于一次受控切换。

### 1.3 可还原性

结构上具备完整闭环（provider `switchAccount` 第 257-308 行）：

`S0 preflight`（实例/版本/快照三元组）→ `S1 stop`（UIA 托盘退出 → 失败降级 WebSocket 提示手动退出 → 轮询退出签名，**绝不强杀**）→ `S2 backup`（退出后读回客户端即将覆盖的 `.info`，作为回滚依据）→ `S3 validateTarget`（解密目标快照，实例/身份/版本/角色集/sha256 五项校验）→ `S4 write`（`0o600` 临时文件 + rename 原子写）→ `S5 start`（三信号任一：启动日志对 / 127.0.0.1:18488 / 主窗口标题）→ `S5 verify`（读回 uid 必须等于目标）→ 失败则 `rollback`（写回 backup + 重启 + 核验原账号）。

- **写回能否让客户端认账**：**未验证**。`account_operation` 中 `operation='switch'` 记录数为 **0**（只有 capture：5 成功、6 失败均为 `CLIENT_NOT_RUNNING`）。
- **是否需要重启**：代码假定「必须完全退出后才可写、写后由我们拉起」，身份只在启动后由客户端读盘生效；该假定**未验证**于真机（属于契约推断，不是实测）。
- **校验失败路径**：代码内可达的有 `TARGET_INSTANCE_MISMATCH` / `TARGET_IDENTITY_MISMATCH` / `SNAPSHOT_VERSION_MISMATCH` / `TARGET_SNAPSHOT_INVALID`（sha256 或文件集不符）/ `STARTUP_TIMEOUT` / `IDENTITY_VERIFY_FAILED` / `EXIT_NOT_CONFIRMED` / `SWITCH_ROLLED_BACK` / `RECOVERY_REQUIRED`。**token 过期、服务端拒绝、设备绑定**：代码层无检测点，只能表现为「启动后 uid 不变 → `IDENTITY_VERIFY_FAILED`」，实际是否如此**未验证**。
- `canCloseSafely()` 恒返回 `{safe:false}`（第 181-183 行），且**未被切换流程调用**：busy/未保存的保护实际只依赖「请用户手动退出」这一外部约定。

结论：**未验证**（工程结构已具备，真机未跑）。

### 1.4 与代码现状对照（不照抄文档）

| 关注点 | 代码事实 | 位置 |
| --- | --- | --- |
| 读什么 | 只读 `authInfoPath` + `skeletonPath`；envelope 值不解包、不入库、不写日志 | `workbuddyDesktopProvider.ts:75-80, 138-149` |
| 写什么 | 仅 `role → 当前契约路径` 映射的两个目标；不信任快照内记录的历史路径 | 同上 `:409-415` |
| 抓取前提 | 客户端必须在运行（`pids === 0` → 409 `CLIENT_NOT_RUNNING`）；并要求签到凭据可得（否则 `CHECKIN_CREDENTIAL_UNAVAILABLE`） | `:189-236` |
| 存储 | 快照密文走 SecretVault（DPAPI + scope），引用写 `client_snapshot_ref` | `:208, 316-323`；`secretVault.ts:26-71` |
| `is_current` | 逐平台取当前身份哈希；WorkBuddy 走 `getCurrentIdentity()`；读不到 → `null`（未知），不做统一兜底 | `accountRoutes.ts:104-131, 315` |
| 能力表 | `registry.ts` 中 WorkBuddy 为 `capture/switch/checkin = true`，`reason_code = CHECKIN_READY`；但文件头注释仍写「签到 provider 未验证 → checkin 关闭」，**注释与字段值不一致** | `registry.ts:18-19, 26` |
| 并发保护 | 桌面切换/捕获按 `app_id:client_instance_id` 加客户端级锁；已有 `recovery_required` 实例时直接拒绝；写后失败默认冻结实例（`SWITCH_ROLLED_BACK` 例外） | `operationRunner.ts:28-58` |
| 版本门槛 | 硬编码 `5.9.3`，`startsWith` 判版本（本机 `5.9.3.0` 通过） | `:33, 329` |
| 退出签名 | 进程清零 + `window-state.json mtime ≥ auth 写盘`；今日真实退出：auth `06:12:50.147Z`、window-state `06:13:12.030Z`、进程 0 → 满足 | `:10, 379` |

结论：**已验证**（代码行为与本轮现场一致；分布见 §2）。

## 2. 证据表

| # | 结论 | 依据 |
| --- | --- | --- |
| E1 | Windows 两条快照路径固定且本轮存在 | `workbuddyDesktopProvider.ts:75-80`；现场：`.info` 9919B @ 2026-11-05 14:12:50、skeleton 存在 |
| E2 | 敏感字段是 `$wbEncrypted` v2 信封，非全文件加密 | 代码注释 `:9`、schema `:111-116`；现场 `auth.accessToken` 为对象且 `$wbEncrypted=1`（**未读取 envelope 内容**） |
| E3 | 我方快照落地为 DPAPI 密文，scope 四元组强绑定 | `.dpapi` 路径与 `scopeSchema` 见 `secretVault.ts:26-71` |
| E4 | 身份算法 `sha256(uid)`，并作为 vault scope | `:105, 340, 316-318` |
| E5 | 现场三处身份一致（f5d89346） | auth uid 长 36、skeleton uid、账号 `identity_hint`、插件 JWT `sub` 的 sha256 前 8 位同为 `f5d89346` |
| E6 | `is_current` 逐平台比对、读不到为 null | `accountRoutes.ts:104-131, 315`；现场唯一账号 `is_current=true`（客户端已退出但 `.info` 可读） |
| E7 | 退出签名判定成立（今日真实验证） | 今日启动日志对 `2026-11-05\16476-141237.log` 含 `before-quit userConfirmed=true`、`finishQuit`；auth/window-state 时间满足 `:10` 口径 |
| E8 | 抓取要求客户端运行；6 次真实失败均 `CLIENT_NOT_RUNNING` | `:196`；`account_operation`：failed×6（11-02 21:51 → 11-03 08:04），succeeded×5（11-03 10:25 → 11-05 17:04） |
| E9 | 真实切换零执行 | `account_operation` 中 `operation='switch'` 计数 0 |
| E10 | fake 环境契约用例全通过（12/12） | `apps/server/test/workbuddyDesktopProvider.test.ts` 实跑 |
| E11 | 版本门槛 5.9.3.x 且本机通过 | `:33, 329`；ProductVersion `5.9.3.0` |
| E12 | 写盘为 0600 临时文件 + rename 原子替换 | `:409-415` + `atomicWrite` |
| E13 | 目标快照五项校验（实例/身份/版本/角色集/sha256） | `:394-403` |
| E14 | 启动就绪三信号均已实现，今日启动目录结构符合信号① | `:532-552`；现场 `logs/startup/2026-11-05/16476-141237.{log,jsonl}` |
| E15 | 签到凭据来自插件线**明文 JWT**（非桌面信封），导出脚本存在 | 现场 `Tencent-Cloud.coding-copilot.info` 4452B，token 为 plaintext string；`apps/server/scripts/accounts/export_credentials.py` 存在 |
| E16 | 同一实例的捕获/切换串行化，且有 recovery_required 门禁 | `operationRunner.ts:28-58`（client 级锁、`ACCOUNT_BUSY`、写后失败冻结） |

未验证：U1 写回被客户端认账（E9）、U2 token 过期/服务端拒绝（无检测点、无真机）、U3 真实 rollback、U4 busy/未保存影响（`canCloseSafely` 恒 false 且未接入）、U5 双账号并存（每用户单 `.info`，仅单实例假设成立）。

无法验证：V1 macOS 路径/Keychain（无设备、无文档）、V2 `$wbEncrypted` 密钥来源与跨机可用性、V3 客户端内部 busy 状态、V4 服务端对旧 refresh token 的态度。

## 3. 风险清单（按「最可能坏在哪一步」排序）

1. **捕获 S0：客户端未运行即失败**。`pids === 0 → 409 CLIENT_NOT_RUNNING`；本机已有 6 次真实失败，用户看到的就是「捕获当前账号失败」。UI 若不提示「先打开客户端」，会被误判为功能坏掉。
2. **现有唯一账号缺签到凭据**：`600f9d7c` 的 `checkin_credential_ref` 为空、`checkin_capability = unknown`。签到按钮会禁用、一键签到会跳过；而回填只能靠「客户端运行时重新捕获」（捕获现在强制要求签到凭据可得）。
3. **能力表超前于证据**：`registry.ts` 已把 `switch/checkin` 标 true，但真实 switch 为 0 次；同文件注释还写着「签到 provider 未验证 → checkin 关闭」，读者会得到相反结论。第一个实际坏点是 `S1 stop`：UIA 托盘菜单可能定位不到 → 降级为手动退出提示并等待 120s → 超时 `EXIT_NOT_CONFIRMED`（本次不写任何客户端数据）。
4. **S5 核验失败后的回滚风险**：`IDENTITY_VERIFY_FAILED` 会触发 backup 写回 + 重启 + 核验；若 backup 本身已在退出后被客户端重写、或重启仍失败，落到 `RECOVERY_REQUIRED`，该实例被冻结等待人工恢复。这是「切换失败但状态可读」与「实例不可用」的分界线。
5. **版本/路径硬编码**：仅认 `5.9.3.*`，且 exe 固定 `D:\Program Files\WorkBuddy\WorkBuddy.exe`；客户端升级或非默认安装即 `CLIENT_VERSION_UNSUPPORTED` / 路径不存在。
6. **`canCloseSafely` 是死接口**：表面上有 busy/未保存保护，实际切换流程从未调用；用户若带着未保存会话切换，上下文丢失不可预防。
7. **单实例假设**：auth 路径按用户唯一，同机多开/多账号并存不受支持。并发不是漏洞（`operationRunner` 已按 `app_id:client_instance_id` 加锁并串行），但代价是第二个操作会被排队或 `ACCOUNT_BUSY` 拒绝，用户会感觉「点了没反应」。
8. **签到凭据平面是明文 JWT**：与桌面信封不同，任何回填逻辑都必须走 vault，不得落日志/界面；回填卡需明确禁止打印。

## 4. 给实现卡的输入

1. **捕获体验/前置卡**：客户端未运行时明确引导「先启动 WorkBuddy」（不自动拉起），或提供可选 `ensureClientRunning`；错误码已有 `CLIENT_NOT_RUNNING`，缺的是 UI 引导与重试入口。
2. **签到凭据回填卡（最高优先）**：为已存在账号 `600f9d7c` 提供回填路径（重捕获复用或独立 backfill），成功后写 `checkin_credential_ref` 并把 `checkin_capability` 置 `true`；前置条件=客户端运行 + 插件线 token 可得；凭据只入 vault。
3. **真实切换验收卡（需用户授权 + 第二账号）**：`capture(B) → switch(B) → verify → 故意失败一次看 rollback`，逐阶段落 `account_operation` 证据；未完成前不应把 `switch:true` 当既成事实对外承诺。
4. **决策卡：`canCloseSafely` 接入或删除**；若保留，需定义「busy 不可判定」时的产品口径（当前等于强制用户手动退出）。
5. **版本/路径放宽卡**：版本白名单 + exe 路径探测（注册表/开始菜单），避免升级即不可用。
6. **macOS 支持**：设备/环境阻塞，单独立卡并标 blocked；本页只记「无证据，不可假设与 Windows 同构」。

补充说明：卡面提到的 `workbuddyProvider.test.ts` 实际文件名为 `workbuddyDesktopProvider.test.ts`（12 例），属命名漂移，不影响验收。

## 5. 复现命令（本轮实际执行）

```powershell
# 1) provider 契约用例（fake 环境，不触碰真实客户端）
pnpm --filter @agentboard/server test -- workbuddyDesktopProvider.test.ts   # 12 passed

# 2) 现场元数据（只输出存在性/大小/mtime/字段名/uid 哈希前 8 位）
node "$env:TEMP\acc01-state.cjs"

# 3) 操作记录分布（只读中心库）
node "$env:TEMP\acc01-ops3.cjs"   # switch=0；capture succeeded=5, failed=6(CLIENT_NOT_RUNNING)

# 4) 客户端进程数
(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count   # 0
```

> 本轮未执行：真实写回、真实切换、真实回滚、客户端启动/退出操作。以上均标注「需用户授权后验证」。
