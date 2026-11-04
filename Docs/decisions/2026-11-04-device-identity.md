# 设备身份字段成套搬迁 —— 裁决说明
- status: proposed
- date: 2026-11-04
- card: -
- supersedes: -

- 卡：`ea7cd703` ACC-KB-B6（父卡 `2a4a8c4a`）
- 工作区：任务看板 `e41eb0fb-c367-43cf-a99d-6dc5239a5694` / `D:\WorkSpaces\任务看板`
- 状态：**等用户裁决，未实施**。本文档只承载裁决所需证据与三档代价，不含实现。
- 调研方式：只读 grep + 只读读码 + 只读知识页 `cc06032d`（common scope）。未改任何代码，未改任何卡状态。

## 0. 要裁决的冲突

| 侧 | 主张 | 出处 |
|:--|:--|:--|
| 知识 | 设备字段必须与令牌同代搬，漏搬 = 回弹（切完又回旧号）/ 权益静默变少 / 多号自我关联 | 知识页 `cc06032d` §3 |
| 代码边界 | 不触碰客户端自身登录文件 | `apps/server/src/api/accountRoutes.ts:243`、`Docs/designs/accounts/2026-11-04-accounts-unified-panel.md:99`、`Docs/designs/accounts/2026-11-01-workbuddy-accounts.md:126` |

两者只能由用户取舍。**裁决项一句话**：是否放开「不触碰客户端自身登录文件」，把客户端设备身份文件纳入 AgentBoard 的快照/写回链路；若放开，放开到哪些文件、哪些平台。

## 1. 字段现状（代码事实）

### 1.1 复核命令

```powershell
# 自有代码（排除 node_modules / dist），共 457 文件
$files = Get-ChildItem -Recurse -File -Include *.ts,*.tsx -Path apps,packages |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\dist\\' } |
  ForEach-Object { $_.FullName }
Select-String -Path $files -Pattern 'client_instance_id|clientInstanceId'      # 127 命中：server 111 / web 13 / shared 3
Select-String -Path $files -Pattern 'device_?[Ii]d|machine_?[Ii]d|installation_?[Ii]d|deviceMid|deviceNonce|login-device|keyblob|machineid'   # 0 命中
```

结论：**客户端设备身份字段在自有代码里零命中** —— 既没有读取点，也没有写入点，也没有承载字段。唯一带「设备/实例」语义的既有字段是 AgentBoard 自建的 `client_instance_id`。

### 1.2 AgentBoard 侧字段清单

| 字段 | 所在表/类型 | 写入点 | 读取点 | 跨平台共用 |
|:--|:--|:--|:--|:--|
| `client_instance_id` | `managed_account.client_instance_id` TEXT NOT NULL | `workbuddyDesktopProvider.ts:171`（`computeWorkbuddyInstanceId` :81 = `sha256(app_id + NUL + lowercase exePath)`）；`minimaxDesktopProvider.ts:170` 常量 `minimax-desktop`；`credentialImport.ts:44` 常量 | 锁域 `operationRunner.ts:24`；vault scope `secretVault.ts:10`；`checkinRunner.ts:70`；`restore.ts:30-42`；前端 `AccountCard.tsx:156` | 是（6 平台共用一列，取值规则由各 provider 自定） |
| `identity_hash` | `managed_account.identity_hash` TEXT NOT NULL（sha256 64 hex） | `workbuddyDesktopProvider.ts:99-103`（uid → sha256）；`credentialImport.ts`；`minimaxDesktopProvider.ts:172` | vault scope、`UNIQUE(app_id, client_instance_id, identity_hash)`、`managedAccount.ts:14-15` | 是 |
| `client_snapshot_ref` | `managed_account` 列（UUID → DPAPI vault） | `workbuddyDesktopProvider.ts:281`（`vaultScope`） | `loadValidatedSnapshot:349-365` | 是 |
| `client_snapshot_version` | `managed_account` 列 INTEGER DEFAULT 1 | 建表默认值（`migrations/accounts.ts:7`） | 同左 | 是（当前恒为 1） |
| 快照 `files[]` | DPAPI vault 内 JSON，`snapshotSchema:114-121`，`files` min 1 **max 10**，`role ∈ {credential, identity-skeleton}` | `workbuddyDesktopProvider.ts:197-198`（只两个 key：`auth_info`、`skeleton`） | `writeSnapshotFiles:368-374` | 否（仅 workbuddy provider 实现） |
| 快照两条硬路径 | `paths.authInfoPath` :72、`paths.skeletonPath` :73 | 同上 | `readBackup:341-347`、`writeSnapshotFiles:369-371` | 否 |
| 快照 schema 版本 | `WORKBUDDY_SNAPSHOT_SCHEMA = 'agentboard.workbuddy-desktop.snapshot/1'` :31 | — | `snapshotSchema.schema` 字面量校验 :115 | 否 |

### 1.3 客户端设备字段（知识 `cc06032d` §3，非代码事实）

| 平台 | 设备字段 | 代码现状 |
|:--|:--|:--|
| WorkBuddy | `security/<uuid>/`、`login-device-nonce`(32B)、`.workbuddy\device-id`、`device-id.machine`、`keyblob` | provider 已实现（capture/switch/checkin 全开），但快照只搬 `auth_info` + `skeleton` 两文件，**设备字段全部漏搬** |
| Trae CN | `machineid`、`telemetry.machineId`/`devDeviceId`/`sqmId`、`aha/`、`Local State`、`Network/`、`state.vscdb-wal/-shm`（成对） | 未实现（`registry.ts:29` capture=false，`LOGIN_STATE_NOT_FILE_BASED`） |
| Qoder CN | `auth.machine-id`、`.qoder-cn\.auth\machine_id`、`main.sqlite.local_device_identity.device_id`、明文 `authenticationContext` | 未实现（`registry.ts:32`，`PROVIDER_NOT_IMPLEMENTED`） |
| ZCode | `deviceMid`（`telemetry-state.json`，请求头 `X-Device-Mid`）、`providerFamilyDomain` | 未实现（`registry.ts:33`，`PROVIDER_NOT_IMPLEMENTED`） |
| MiniMax | 无独立设备 id（`business-telemetry.identity.json` 仅埋点） | 已实现（capture=true），无需搬设备字段 |

## 2. 为什么是「成套」而不是加一列

1. **漏搬即回弹**：WorkBuddy 校验链路是 `client_instance_id` + `identity_hash` + `version.product` + role 完整性 + sha256（`loadValidatedSnapshot:354-362`）。设备字段不在其中，所以「换完又被判回旧号」不会被现有校验拦住 —— 校验全绿但结果错。
2. **写回是整文件覆盖，不做字段合并**：`writeSnapshotFiles:373` 对两条硬路径 `atomicWrite`。知识 `cc06032d` §2 WorkBuddy 行要求「重写 info 时**合并** `allAccounts`」—— 现有实现与知识要求直接冲突，这一点即使不放开边界也需要单独裁决。
3. **容量约束**：`files` max 10，WorkBuddy 设备字段里 `security/<uuid>/` 是**目录**，`content_base64` 只能装单文件 ⇒ 必须二选一：目录归档（tar）或按文件枚举并把上限提高。不解决容量就装不进去。
4. **老快照没有设备字段**：现有 `client_snapshot_ref` 指向的密文全是 `/1` schema，不含设备段。加字段后老快照一律缺设备身份 ⇒ 不回填就等于「新账号能搬、老账号照旧回弹」。
5. **跨库/离线一致性**：设备身份是**本机**属性。快照跨机恢复（DPAPI 绑当前用户 + 当前机）时设备字段与本机不符，写入会把客户端判成「换了设备」。这条决定是否需要「跨机禁用设备段」。

## 3. 三档方案

### A 最小：只加字段与 schema 段，不回填老快照

- 内容：`managed_account` 加 `device_identity_ref TEXT NULL`；快照 schema `/1` → `/2` 增 `device` 段；`loadValidatedSnapshot` 双 schema 分支；`files` max 10 → 20。
- 改动文件数：**6–8**（`migrations/deviceIdentity.ts`、`workbuddyDesktopProvider.ts`、`repos/managedAccount.ts`、`shared/src/types.ts`、`accountRoutes.ts`、2 个测试）
- 迁移可逆：**是**（`ALTER TABLE ADD/DROP COLUMN`，本机 SQLite 3.53.2 支持 DROP COLUMN，实测 `sqlite_version()=3.53.2`）
- 遗留不一致：老快照仍缺设备段 ⇒ 老账号继续回弹；同一功能新老账号行为不同，排障时症状混叠（回弹 vs 未搬）
- 需用户提供：无（但要接受「老账号不回弹问题不解决」）

### B 中：加字段 + 一次性回填 + 校验（推荐）

- 内容：A 的全部 + 回填任务：对每条有 `client_snapshot_ref` 的账号，解密 `/1` 快照 → 读当前客户端设备字段 → 写**新 ref**（`/2`），旧 ref 保留不覆盖 → 回读校验 sha256。
- 回填失败处理：不阻断、不回滚，写 `device_identity_status='pending'`；该账号后续切换返回固定码 `DEVICE_IDENTITY_PENDING`（而非静默继续）；写一条 `capture` 操作提示用户重新捕获该账号。
- 改动文件数：**10–14**（A 的 6–8 + `services/accounts/deviceIdentityBackfill.ts`、回填单测、`docs/api.md` 错误码表、前端 `CapabilityBadges.tsx` 状态展示）
- 迁移可逆：**字段可逆；数据不可逆** —— 必须靠「新 ref 不覆盖旧 ref」保证可回滚。若覆盖旧密文，`/1` 快照永久丢失。
- 需用户提供：**允许读取的具体路径清单**（WorkBuddy 5 项是否全开；`security/<uuid>/` 是否允许整目录归档）；跨机恢复时是否禁用设备段

### C 大：重设计设备身份模型

- 内容：新增 `device_identity(platform, device_key, value_encrypted, captured_at, source_path)` 表；快照只存 `device_identity` 引用集合；各 provider 声明自己的设备字段清单（Trae 15 条 / ZCode 4 级 / Qoder 4 项统一承载）。
- 改动文件数：**20–28**（新表 + 迁移 + `registry.ts` 能力声明扩展 + workbuddy 改造 + 未来 4 个 provider 适配点 + 测试）
- 迁移可逆：表可删，但已捕获的设备身份需先导出；执行前必须备份 vault
- 收益：一次解决 5 平台差异，避免每平台改一次快照 schema；`files` max 上限问题被绕开
- 代价：trae / zcode / qoder_cn 三个 provider 目前**全未实现**（`registry.ts:32-33`），为未落地平台预付建模成本
- 需用户提供：设备身份是否按平台隔离（决定加密 scope）、是否支持跨机迁移、是否允许目录归档

## 4. 推荐

**推荐 B，但前置条件是先裁决边界本身。**

理由：

1. A 保留回弹症状 —— WorkBuddy 是唯一已全开的平台（`registry.ts:25`），回弹正是它的实际故障，A 等于「有字段、没效果」。
2. C 在 3/6 平台 provider 未实现时先建通用模型，属于为未落地平台预付成本；等 trae/zcode/qoder_cn 落地后再抽象，字段清单才稳定。
3. B 的增量最小且失败可标记可重试（`pending` + 固定错误码），不产生「静默半成功」；SQLite 3.53.2 的 `DROP COLUMN` 让字段级回滚可行，「新 ref 不覆盖旧 ref」让数据级回滚可行。

**但无论选哪档，闸门是同一个**：`accountRoutes.ts:243` / `design-2026-11-04:99` / `design-2026-11-01:126` 三条「不触碰客户端自身登录文件」的边界条款必须先由用户裁决。不放开，本卡无可执行形态。

## 5. 未验证项

- 回填脚本未实现、未运行；`/1` → `/2` 转换的字段覆盖度未实测。
- WorkBuddy `security/<uuid>/` 目录的真实文件数与总体积未测 ⇒ `files` 上限 10 是否必须提高、提高多少未定。
- 跨机恢复场景（DPAPI 绑用户+本机）下设备段的实际客户端反应未实测。
- 知识 `cc06032d` 的字段清单来自既往调研，本次未逐条复验客户端文件是否存在（只读边界内未读客户端数据目录）。
- 卡面写 `accountRoutes.ts:214` 为边界注释，实测边界在 `:243`（`:214` 是 restore 端点注释）—— 行号勘误。
