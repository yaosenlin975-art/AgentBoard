/**
 * ACC-QUOTA-ALL：平台额度来源的**凭据解析**（只解析，不发请求；网络在 `quotaService.fetchPlatform`）。
 *
 * 两条凭据来源：
 * - 中心库 `managed_account` 的签到凭据（vault purpose=`checkin`，scope={app_id, client_instance_id, identity_hash}）：
 *   workbuddy（app_id=`workbuddy_desktop`）/ minimax / trae / qoder_cn 走这条；
 *   聚合模式多账号时取 `updated_at` 最新的 enabled 账号；账号行模式按显式 account_id 严格读取。
 * - 本机文件 `~/.zcode/v2/credentials.json`：zcode 走这条（CLI 侧凭据，口径同 fetchDeepseek 读本地文件），
 *   键 `oauth:bigmodel:access_token`（知识 `3c21b76c` §2：`zcodejwttoken` 是错的，打 quota/limit 必 401）；
 *   值可能是 `enc:v1:<iv>.<tag>.<ciphertext>`（AES-256-GCM，key=sha256(ZCODE_CREDENTIAL_SECRET 或
 *   zcode-cli 同款 fallback 串)；算法对齐 ZCode CLI 的 createZCodeCredentialCipher），明文值原样使用。
 *   本机文件缺失时回落库内 `zcode` 账号的签到凭据。
 *
 * 隐私口径：token 原文只进返回值（调用方仅用于请求头），不落日志；detail 只写「已检测到/未检测到」
 * 与可行动指引，不含 token / identity_hash / 绝对路径。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash, createDecipheriv } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ManagedAppId, QuotaSourceId } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import type { CheckinVault } from '../accounts/checkinProvider.js';
import { parseMinimaxCredential } from '../accounts/httpCheckinProviders.js';

export interface PlatformQuotaCredentialOk {
  kind: 'ok';
  token: string;
  /** 账号显示名（仅供 detail 提示「取的是哪个账号」，不含身份散列/token） */
  accountName: string | null;
}

export interface PlatformQuotaCredentialMissing {
  kind: 'missing';
  reasonCode: string;
  detail: string;
}

export type PlatformQuotaCredential = PlatformQuotaCredentialOk | PlatformQuotaCredentialMissing;

/** 平台额度来源 → 中心库 app_id（workbuddy 额度来源的账号落在 `workbuddy_desktop` 下） */
export const QUOTA_SOURCE_APP_ID: Record<'workbuddy' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode', ManagedAppId> = {
  workbuddy: 'workbuddy_desktop',
  minimax: 'minimax',
  trae: 'trae',
  qoder_cn: 'qoder_cn',
  zcode: 'zcode',
};

/** 平台中文名（detail 文案用） */
const SOURCE_LABEL: Partial<Record<ManagedAppId, string>> = {
  workbuddy_desktop: 'WorkBuddy',
  codebuddy_desktop: 'CodeBuddy',
  minimax: 'MiniMax',
  trae: 'Trae',
  qoder_cn: 'Qoder',
  zcode: 'ZCode',
};

interface ManagedAccountRow {
  id: string;
  app_id: string;
  enabled: number;
  client_instance_id: string;
  identity_hash: string;
  display_name: string;
  checkin_credential_ref: string | null;
}

export type AccountQuotaSourceId = keyof typeof QUOTA_SOURCE_APP_ID;

/** managed_account.app_id → 唯一账号额度来源；其它平台没有账号行额度入口。 */
export function quotaSourceForAppId(appId: ManagedAppId): AccountQuotaSourceId | null {
  return (Object.keys(QUOTA_SOURCE_APP_ID) as AccountQuotaSourceId[])
    .find((source) => QUOTA_SOURCE_APP_ID[source] === appId) ?? null;
}

/** 聚合模式取最新启用账号；账号模式按 ID 读取后由调用方明确处理平台/状态/凭据。 */
function selectQuotaAccount(db: Db, appId: ManagedAppId, accountId?: string): ManagedAccountRow | null {
  const row = accountId === undefined
    ? db.prepare(
      'SELECT id, app_id, enabled, client_instance_id, identity_hash, display_name, checkin_credential_ref FROM managed_account'
      + ' WHERE app_id=? AND enabled=1 AND checkin_credential_ref IS NOT NULL'
      + ' ORDER BY updated_at DESC, created_at DESC LIMIT 1',
    ).get(appId) as ManagedAccountRow | undefined
    : db.prepare(
      'SELECT id, app_id, enabled, client_instance_id, identity_hash, display_name, checkin_credential_ref FROM managed_account WHERE id=?',
    ).get(accountId) as ManagedAccountRow | undefined;
  return row ?? null;
}

/** 从凭据字节取 token：minimax 是 JSON 载荷（ACC-FIX-3），其余平台是裸串 */
function extractToken(credential: Buffer, appId: ManagedAppId): string {
  if (appId === 'minimax') {
    const parsed = parseMinimaxCredential(credential);
    return parsed.access_token.trim();
  }
  return credential.toString('utf8').trim();
}

/** vault 解析签到凭据；vault 未装配 / 无账号 / 解不开 / token 空 → 各自精确的 missing 结果 */
async function resolveVaultCredential(
  db: Db,
  vault: Pick<CheckinVault, 'unprotect'> | undefined,
  appId: ManagedAppId,
  noAccountDetail: string,
  accountId?: string,
): Promise<PlatformQuotaCredential> {
  if (!vault && accountId === undefined) {
    return { kind: 'missing', reasonCode: 'VAULT_UNAVAILABLE', detail: '凭据保护未装配（vault 不可用），无法读取额度凭据' };
  }
  const account = selectQuotaAccount(db, appId, accountId);
  if (!account) {
    return { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: accountId === undefined ? noAccountDetail : '账号不存在，无法读取该账号额度' };
  }
  if (account.app_id !== appId) {
    return { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '该账号的平台与额度来源不匹配' };
  }
  if (!account.enabled) {
    return { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '账号已停用，无法读取额度' };
  }
  if (!account.checkin_credential_ref) {
    return { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '该账号未导入额度凭据，请重新导入凭据' };
  }
  if (!vault) {
    return { kind: 'missing', reasonCode: 'VAULT_UNAVAILABLE', detail: '凭据保护未装配（vault 不可用），无法读取额度凭据' };
  }
  let credential: Buffer;
  try {
    credential = await vault.unprotect(account.checkin_credential_ref, {
      app_id: appId,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
  } catch {
    return {
      kind: 'missing',
      reasonCode: 'CREDENTIAL_UNAVAILABLE',
      detail: `${SOURCE_LABEL[appId] ?? appId} 账号的签到凭据不可读取（DPAPI 解密失败），请在账号管理重新导入凭据`,
    };
  }
  const token = extractToken(credential, appId);
  if (token === '') {
    return {
      kind: 'missing',
      reasonCode: 'CREDENTIAL_UNAVAILABLE',
      detail: `${SOURCE_LABEL[appId] ?? appId} 账号的签到凭据为空，请在账号管理重新导入凭据`,
    };
  }
  return { kind: 'ok', token, accountName: account.display_name };
}

/**
 * ZCode CLI 的凭据加密（对齐 ZCode CLI 的 createZCodeCredentialCipher）：
 * `enc:v1:<iv b64url>.<authTag b64url>.<ciphertext b64url>`，AES-256-GCM（IV 12B / tag 16B），
 * key = sha256(ZCODE_CREDENTIAL_SECRET ?? `zcode-credential-fallback:<platform>:<homedir>:<username>`)。
 * 解密失败（如设置了 ZCODE_CREDENTIAL_SECRET 但与写凭据时不一致）返回 null，不抛错。
 */
export function decryptZcodeCredentialValue(value: string, env: Record<string, string | undefined>): string | null {
  if (!value.startsWith('enc:v1:')) return value;
  const parts = value.slice('enc:v1:'.length).split('.');
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, dataPart] = parts;
  let secret = env.ZCODE_CREDENTIAL_SECRET?.trim() ?? '';
  if (secret === '') {
    let username = 'unknown';
    try { username = userInfo().username; } catch { /* 非 POSIX 主平台兜底；Windows 恒有值 */ }
    secret = `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), Buffer.from(ivPart!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 顶层 `oauth:bigmodel:access_token`（加密或明文）；文件/键缺失或解不开 → null */
export function readZcodeOauthToken(homeDir: string, env: Record<string, string | undefined>): string | null {
  const file = join(homeDir, '.zcode', 'v2', 'credentials.json');
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const raw = record['oauth:bigmodel:access_token'];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const token = decryptZcodeCredentialValue(raw, env);
    return token !== null && token.trim() !== '' ? token.trim() : null;
  } catch {
    return null;
  }
}

export interface ResolvePlatformQuotaCredentialInput {
  db: Db;
  /** 生产为 SecretVault（routes.ts 注入的 CheckinVault 视图）；缺省按「vault 未装配」处理 */
  vault?: Pick<CheckinVault, 'unprotect'>;
  /** CLI 侧凭据根目录（zcode）；缺省 os.homedir() */
  homeDir?: string;
  /** ZCODE_CREDENTIAL_SECRET 等 env（测试注入）；缺省 process.env */
  env?: Record<string, string | undefined>;
  source: QuotaSourceId;
  /** 显式按托管账号选择凭据；传入时禁用聚合选择与 ZCode 本机 token 回退。 */
  accountId?: string;
}

/** 各平台缺账号时的可行动指引（不含绝对路径；`~` 相对路径沿用既有 detail 风格） */
const NO_ACCOUNT_DETAIL: Record<'workbuddy' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode', string> = {
  workbuddy: '未检测到 WorkBuddy 账号签到凭据（请在账号管理为 WorkBuddy 导入并激活凭据后重试）',
  minimax: '未检测到 MiniMax 账号签到凭据（请在账号管理为 MiniMax 导入并激活凭据后重试）',
  trae: '未检测到 Trae 账号签到凭据（请在账号管理为 Trae 导入并激活凭据后重试）',
  qoder_cn: '未检测到 Qoder 账号凭据（请在账号管理为 Qoder 导入桌面端 dt- 凭据后重试）',
  zcode: '未检测到 ZCode 登录凭据（~/.zcode/v2/credentials.json），请在本机登录 ZCode 后重试，或在账号管理导入凭据',
};

/** 解析某额度来源的凭据；结果只含 token + 显示名，绝不抛错（失败都落成 missing） */
export async function resolvePlatformQuotaCredential(input: ResolvePlatformQuotaCredentialInput): Promise<PlatformQuotaCredential> {
  const { db, source } = input;
  if (source === 'deepseek' || source === 'opencode_go' || source === 'codex') {
    return { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: `${source} 不是平台额度来源` };
  }
  if (source === 'zcode' && input.accountId === undefined) {
    const local = readZcodeOauthToken(input.homeDir ?? homedir(), input.env ?? process.env);
    if (local !== null) return { kind: 'ok', token: local, accountName: null };
  }
  const appId = QUOTA_SOURCE_APP_ID[source];
  return resolveVaultCredential(db, input.vault, appId, NO_ACCOUNT_DETAIL[source], input.accountId);
}
