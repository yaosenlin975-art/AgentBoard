# ACC-GET（582a45a8）规格：本机凭据获取链路闭合

卡号：`582a45a8-c31b-43da-ac82-c96e0f2ca191`（父卡 `6549eb8d-d38b-444f-882c-3e5b5663c992`）
范围边界：只做「获取」。不做 `b5eb36e1`（签到）与 `d85bf138`（切换）。

## 1. 结论（先定方案）

| 缺口 | 方案 |
|:--|:--|
| WorkBuddy 捕获不写 `checkin_credential_ref` | 捕获流程内解析「当前账号」的签到令牌，用 `SecretVault`（DPAPI、purpose=`checkin`）落库；解析不到就**让捕获失败**（`CHECKIN_CREDENTIAL_UNAVAILABLE`），不再产生「抓到了但签不了到」的账号 |
| Trae provider 未装配 | **选 a）装配真实 provider**。本机 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` 信封可解开（知识页 `9733aae8` 已实测 4 个键通过 SHA-512 校验），因此有能力装配；能力表 `capture=true` 与真实行为一致 |
| 导入仅三平台 | 保持三平台导入（WorkBuddy/Trae/MiniMax）；Qoder/ZCode 走协议级授权添加（`addAccountProviders` 已覆盖五平台），**不新增捕获实现** |

Trae 选 a 的理由：本机确有可读且可解密的来源，方案 b 会主动降低已有能力，违背「能力与行为一致」的目标。

## 2. 现状事实（已核对）

- `apps/server/src/services/accounts/registry.ts`：`withTraeStorage()` 在 `storage.json` 存在时把 `capture` 标为 true；`qoder_cn` / `zcode` 为 false（`PROVIDER_NOT_IMPLEMENTED`）。
- `apps/server/src/index.ts:195`：默认 `desktopProviders` 只注入 `minimax`，Trae 真调落到 `requireProvider` 的 503 分支。
- `apps/server/src/services/accounts/traeProvider.ts`：只有 `captureTraeCredential`（脱敏）与 `traeStorageAvailable`，**没有** `captureCurrent` / `switchAccount`，不能直接当桌面 provider。
- `apps/server/src/services/accounts/workbuddyDesktopProvider.ts` 的 `captureCurrent` 只写 `client_snapshot_ref`，没有任何 `checkin` 字段。
- `apps/server/src/services/accounts/checkinRunner.ts:65`：账号缺 `checkin_credential_ref` 即 `CHECKIN_CREDENTIAL_MISSING`。
- `apps/server/src/services/accounts/credentialImport.ts`：导入平台枚举仅 `workbuddy|trae|minimax`；导入时用 `purpose='checkin'` 的 vault 写 token 并回填 `checkin_credential_ref`。
- WorkBuddy 桌面线令牌是 `$wbEncrypted` 信封（知识页 `9733aae8`：保护器密钥由原生模块供给，桌面线**解不开**）；插件线 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info` 的 `auth.accessToken` 是**明文 JWT**，且 `sub == 桌面 account.uid`；`apps/server/scripts/accounts/export_credentials.py` 已能按 JWT `sub` 扫描 WorkBuddy 进程内存导出 token（ACC-11）。
- `addAccountProvider.ts` 已为 `workbuddy_desktop / minimax / trae / qoder_cn / zcode` 装配协议级加号。

## 3. 设计

### 3.1 放宽桌面 provider 类型（允许「只有捕获」的 Trae）

`apps/server/src/api/accountRoutes.ts`
- 把 `type DesktopProvider = Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>` 改为：
  - `type DesktopCaptureProvider = Pick<WorkbuddyDesktopProvider, 'captureCurrent'>`
  - `type DesktopSwitchProvider = Pick<WorkbuddyDesktopProvider, 'switchAccount'>`
  - `export type DesktopProvider = Partial<DesktopCaptureProvider & DesktopSwitchProvider>`
- `AccountRouterDeps.desktopProviders?: Partial<Record<ManagedAppId, DesktopProvider>>`
- `requireProvider` 改为两个重载（`capture` → `DesktopCaptureProvider`，`switch` → `DesktopSwitchProvider`）：
  1. 先按 `registry` 能力判 409 `PROVIDER_UNVERIFIED`（保持不变）；
  2. 取注入 provider；WorkBuddy 缺省回落到 `deps.workbuddy`；
  3. 注入对象缺少对应方法 → 503 `PROVIDER_UNAVAILABLE`（能力表与行为不一致的兜底，正常不会命中）。
- `apps/server/src/index.ts` 的 `CreateAppOptions.desktopProviders` 同步改为 `DesktopProvider` 类型；装配改为：
  ```ts
  const traeProvider = new TraeDesktopProvider({ db, vault: secretVault });
  desktopProviders: {
    ...options.desktopProviders,
    minimax: options.desktopProviders?.minimax ?? minimaxProvider,
    trae: options.desktopProviders?.trae ?? traeProvider,
  }
  ```

### 3.2 Trae 捕获 provider（选 a）

`apps/server/src/services/accounts/traeProvider.ts` 内新增（不新建文件，明文不外泄）：
- 内部函数 `readTraePayload(options)`：复用现有解包逻辑，返回 `{ token, refreshToken, userId, host, expiredAt }`；`captureTraeCredential` 改为基于它输出脱敏字段（对外契约不变）。
- `function jwtSubject(token): string | null`：取 JWT payload 的 `sub`（base64url 解码；失败返回 null）。
- `export class TraeDesktopProvider`：
  - 依赖：`{ db: Db; vault: SecretVault; storagePath?: string; pepper?: Buffer }`。
  - `captureCurrent(options?: { display_name?: string }): Promise<ManagedAccount>`：
    1. `readTraePayload()` 失败 → 抛 `ApiError(409, reason_code, message)`（`TRAE_STORAGE_MISSING` / `TRAE_ENVELOPE_MISSING` / `TRAE_PEPPER_UNAVAILABLE` / `TRAE_PAYLOAD_CORRUPT` / `TRAE_TOKEN_MISSING`，均为 registry/knowledge 已有的可读码）。
    2. 稳定身份 = `jwtSubject(token) ?? payload.userId`；都缺失 → `TRAE_IDENTITY_UNAVAILABLE`。
    3. `identity_hash = sha256('trae\0' + 身份)`（**与 ACC-11 导入的 `account_key` 口径一致**，保证捕获/导入不产生同号两条）。
    4. `findManagedAccountByAppIdentity(db, 'trae', identity_hash)`：命中则复用 `client_instance_id`；否则用常量 `TRAE_CLIENT_INSTANCE = 'trae-desktop'` 新建。
    5. `vault.protect(Buffer.from(token), { app_id: 'trae', client_instance_id, identity_hash, purpose: 'checkin' })` → `ref`。
    6. 写库：
       - 已有账号：`attachCheckinCredential(db, id, ref)`，并更新 `display_name`（若传了 `display_name`）；旧 `checkin_credential_ref` 不同则 `vault.delete(old)`。
       - 新账号：`createManagedAccount(..., checkin_credential_ref: ref)` 后再 `attachCheckinCredential` 把 `checkin_capability` 置 `supported`。
    7. 审计：用 `runAccountOperation(db, { app_id:'trae', client_instance_id, operation:'capture' }, async () => 'succeeded')` 包住（与 WorkBuddy 一致，失败落固定 safe 码；不写 token）。
  - `getCurrentIdentity` 不实现（`is_current` 属 ACC-SWITCH 范围）。
  - 不实现 `switchAccount`（registry 对 Trae `switch=false`，路由先 409）。

### 3.3 WorkBuddy 捕获回填签到凭据

新增 `apps/server/src/services/accounts/workbuddyCheckinSource.ts`：
- `export interface WorkbuddyCheckinTokenSource { find(identity: ClientIdentity): Promise<string | null> }`
- `export function createWorkbuddyCheckinTokenSource(options?: { pluginInfoPath?: string; runExport?: ExportRunner }): WorkbuddyCheckinTokenSource`
  - 默认插件线路径：`join(process.env.LOCALAPPDATA ?? '', 'CodeBuddyExtension','Data','Public','auth','Tencent-Cloud.coding-copilot.info')`。
  - 顺序：
    1. 读插件线 JSON 的 `auth.accessToken`；若是字符串且 JWT `sub` 的 `sha256 === identity.identity_hash` → 返回 token。
    2. 否则调用导出脚本（`ExportRunner`，默认复用 `credentialImport.ts` 里抽出的 `createDefaultExportRunner`）`platform='workbuddy'`；`parseExportOutput` 后取 `sha256(account_key) === identity.identity_hash` 的那条 `token`。
    3. 都失败不可用（文件缺失/无匹配/脚本失败）→ 返回 `null`（**不抛错、不影响既有捕获错误语义**）。
  - 不在日志/响应中出现 token；解析失败静默。

`credentialImport.ts`：把私有 `defaultRunner` 改名为 `export function createDefaultExportRunner(options)`（行为不变），供上面复用。

`workbuddyDesktopProvider.ts`：
- `WorkbuddyProviderDeps` 新增 `checkinTokenSource?: WorkbuddyCheckinTokenSource`；构造函数缺省 `createWorkbuddyCheckinTokenSource()`。
- `captureCurrent` 在身份复核（现有 `after` 校验）通过后：
  1. `const token = await this.checkinTokenSource.find(identity).catch(() => null)`；
  2. `token === null` → 清理已写 snapshot（`vault.delete(ref)`）并抛 `ApiError(409, 'CHECKIN_CREDENTIAL_UNAVAILABLE', '未能从本机获取签到凭据，请改用授权添加或导入本机凭据')`；
  3. 有 token → `checkinRef = vault.protect(token, { app_id:'workbuddy_desktop', client_instance_id: pre.instanceId, identity_hash, purpose:'checkin' })`；
  4. 已有账号：`attachClientSnapshot` + `attachCheckinCredential`；删除旧的 `client_snapshot_ref` / `checkin_credential_ref`（不同才删）。
  5. 新账号：`createManagedAccount({ ..., client_snapshot_ref, checkin_credential_ref: checkinRef })` + `attachCheckinCredential`（置 `supported`）。
  6. 任一步骤写库失败 → 删除新生成的 `ref` / `checkinRef` 后再抛出（避免孤儿密文）。
- `operationRunner.ts` 的 `SAFE_ERROR_CODES` 增加 `CHECKIN_CREDENTIAL_UNAVAILABLE`、`TRAE_STORAGE_MISSING`、`TRAE_ENVELOPE_MISSING`、`TRAE_PEPPER_UNAVAILABLE`、`TRAE_PAYLOAD_CORRUPT`、`TRAE_TOKEN_MISSING`、`TRAE_IDENTITY_UNAVAILABLE`（固定码，不含明文）。

### 3.4 导入 / 能力表一致性

- 不改 `importCredentialsSchema` 的三平台白名单（与知识页「三平台可捕获」一致）。
- 不改 registry：`qoder_cn` / `zcode` 仍 `capture=false` 且原因码 `PROVIDER_NOT_IMPLEMENTED`；Trae `capture=true`（本机有 storage 时）。
- 前端 `accountCapabilities.ts` 不改（选 a 后 Trae 仍可用；Qoder/ZCode 已有「需授权添加」文案）。

## 4. 改动文件清单

| 文件 | 改动 |
|:--|:--|
| `apps/server/src/api/accountRoutes.ts` | provider 类型放宽 + `requireProvider` 重载 |
| `apps/server/src/index.ts` | `desktopProviders` 类型与 Trae 装配 |
| `apps/server/src/services/accounts/traeProvider.ts` | `readTraePayload` / `jwtSubject` / `TraeDesktopProvider` |
| `apps/server/src/services/accounts/workbuddyCheckinSource.ts` | **新建**：插件线 + 导出脚本双来源 |
| `apps/server/src/services/accounts/credentialImport.ts` | `defaultRunner` → 导出 `createDefaultExportRunner` |
| `apps/server/src/services/accounts/workbuddyDesktopProvider.ts` | 捕获回填签到凭据 |
| `apps/server/src/services/accounts/operationRunner.ts` | safe 错误码补充 |
| `apps/server/test/fakeWorkbuddy.ts` | `provider()` 注入 fake `checkinTokenSource` |
| `apps/server/test/workbuddyDesktopProvider.test.ts` | vault 文件数/签到凭据断言 + 缺 token 失败用例 |
| `apps/server/test/traeProvider.test.ts` 或 `traeCapture.test.ts` | Trae 捕获落库/幂等/不落明文用例 |
| `apps/server/test/accountApi.test.ts` | Trae capture-current 200、能力与行为一致 |
| `apps/server/test/accountPlatforms.test.ts` | 导入平台矩阵与能力表一致性 |

## 5. 验收与命令

1. `pnpm --filter @agentboard/server test -- --run test/workbuddyDesktopProvider.test.ts test/traeCapture.test.ts test/accountApi.test.ts test/accountPlatforms.test.ts test/checkinRunner.test.ts`
2. `pnpm --filter @agentboard/web build`
3. `pnpm -r test`（全量；失败逐条标注是否既有基线）
4. 断言：
   - 捕获成功 → `checkin_credential_ref` 非空，且用账号自身 scope（`app_id/client_instance_id/identity_hash/purpose=checkin`）能 `unprotect` 出 token；
   - `managed_account` / `account_operation` / 响应 JSON 不含 token 明文；
   - Trae：本机有 storage → `capture-current` 200；无 storage → registry `capture=false`，路由 409（不再 503）；
   - 导入三平台；Qoder/ZCode `capture=false` + 加号 provider 存在。

## 6. 不做 / 未验证

- 不实现 Qoder/ZCode 捕获；不实现 Trae 切换；不改 `routes.ts`、`packages/cli/**`、knowledge。
- 真机 WorkBuddy 签到（真实 token 调线上接口）**未验**；真机 Trae `capture-current` 写库**未验**（仅单测 + 本机文件探测）。
- 不新增任何启动/定时扫描（ACC-11 维持）。
