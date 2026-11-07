import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialRefreshMethod, CredentialStatus, ManagedAccount, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ValidationError } from '../../errors.js';
import { managedAppSchema } from '../../services/accounts/secretVault.js';
const schema = z.object({ app_id: managedAppSchema, client_instance_id: z.string().trim().min(1).max(300), service_region: z.enum(['cn', 'global', 'unknown']), identity_hash: z.string().regex(/^[a-f0-9]{64}$/), display_name: z.string().trim().min(1).max(100), identity_hint: z.string().max(100).nullable().optional(), client_snapshot_ref: z.string().uuid().nullable().optional(), checkin_credential_ref: z.string().uuid().nullable().optional(), client_snapshot_version: z.number().int().positive().optional() }).strict();
export type CreateManagedAccountInput = z.infer<typeof schema>;
export function getManagedAccount(db: Db, id: string): ManagedAccount | null {
  const row = db.prepare('SELECT * FROM managed_account WHERE id=?').get(id) as ManagedAccount | undefined;
  return row ? { ...row, enabled: !!row.enabled } : null;
}
/** 按 (app, instance, identity_hash) 唯一索引定位账号；无则 null */
export function findManagedAccountByIdentity(db: Db, app_id: string, client_instance_id: string, identity_hash: string): ManagedAccount | null {
  const row = db.prepare('SELECT id FROM managed_account WHERE app_id=? AND client_instance_id=? AND identity_hash=?').get(app_id, client_instance_id, identity_hash) as { id: string } | undefined;
  return row ? getManagedAccount(db, row.id) : null;
}
/**
 * 按 (app_id, identity_hash) 定位账号（**忽略 client_instance_id**）。
 * 用途：跨来源识别同一账号——凭据导入（client_instance_id='imported'）与协议级加号（'protocol'）
 * 用的是同一套 identity_hash 口径（sha256(app_id + NUL + uid)），不该在库里留两条同号账号。
 */
export function findManagedAccountByAppIdentity(db: Db, app_id: string, identity_hash: string): ManagedAccount | null {
  const row = db.prepare('SELECT id FROM managed_account WHERE app_id=? AND identity_hash=? LIMIT 1').get(app_id, identity_hash) as { id: string } | undefined;
  return row ? getManagedAccount(db, row.id) : null;
}
/** 同一身份重新捕获后替换快照引用（token 轮换会改快照字节，身份不变） */
export function attachClientSnapshot(db: Db, id: string, snapshot: { client_snapshot_ref: string; client_snapshot_version: number }): ManagedAccount {
  if (!getManagedAccount(db, id)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  db.prepare('UPDATE managed_account SET client_snapshot_ref=?, client_snapshot_version=?, updated_at=? WHERE id=?')
    .run(snapshot.client_snapshot_ref, snapshot.client_snapshot_version, Date.now(), id);
  return getManagedAccount(db, id)!;
}
/**
 * ACC-KB-A2：`enabled` 的写入路径（此前只有读取——签到授权/签到执行/前端参与判定都在用，却没有端点能改）。
 * 语义：停用 = 该账号不参与一键签到与签到授权（服务端以 ACCOUNT_DISABLED 拒绝）。
 */
export function setManagedAccountEnabled(db: Db, id: string, enabled: boolean): ManagedAccount {
  if (!getManagedAccount(db, id)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  db.prepare('UPDATE managed_account SET enabled=?, updated_at=MAX(?,updated_at+1) WHERE id=?').run(enabled ? 1 : 0, Date.now(), id);
  return getManagedAccount(db, id)!;
}

// ---------- ACC-TOKEN-2：凭据到期/失效列的判定与写入助手（设计页 §3） ----------

/** expiring 阈值：到期前 24h（minimax 生命周期 5–7h 会常态 expiring——预期信号，中性色） */
export const CREDENTIAL_EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 到期时间归一化为 epoch ms：秒级数值/字符串（<1e10，JWT exp、trae expiredAt）×1000；
 * 毫秒数值/字符串（workbuddy auth.expiresAt 明文毫秒）原样；ISO 字符串按 Date.parse；其余 null。
 */
export function parseCredentialExpiry(value: unknown): number | null {
  const toMs = (n: number): number | null => (Number.isFinite(n) && n > 0 ? (n < 10_000_000_000 ? n * 1000 : n) : null);
  if (typeof value === 'number') return toMs(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = toMs(Number(value));
    if (numeric !== null) return numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 从 JSON 形态凭据载荷（{access_token|token, refresh_token, expires_at}）里取 expires_at；裸串/解析失败 → null */
export function credentialExpiresAtFromPayload(credential: Buffer): number | null {
  const raw = credential.toString('utf8').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as { expires_at?: unknown };
    return typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at) && parsed.expires_at > 0 ? parsed.expires_at : null;
  } catch {
    return null;
  }
}

/**
 * status 判定规则（设计页 §3；GET 列表时逐行计算，不解密）：
 * 1. invalid_at 非空（成功刷新会清掉它）→ invalid；
 * 2. expires_at 非空：now >= expires_at → expired；expires_at - now <= 24h → expiring；否则 valid；
 * 3. 其余 → 落库基准值（默认 unknown）。
 */
export function deriveCredentialStatus(input: { expiresAt?: number | null; invalidAt?: number | null; stored?: CredentialStatus | null; now?: number }): CredentialStatus {
  const now = input.now ?? Date.now();
  if (input.invalidAt !== null && input.invalidAt !== undefined) return 'invalid';
  if (input.expiresAt !== null && input.expiresAt !== undefined) {
    if (now >= input.expiresAt) return 'expired';
    if (input.expiresAt - now <= CREDENTIAL_EXPIRING_WINDOW_MS) return 'expiring';
    return 'valid';
  }
  return input.stored ?? 'unknown';
}

/**
 * refresh_method = 平台静态表 ⊕ 载荷能力（设计页 §2 矩阵）：
 * minimax 载荷带 refresh_token → refresh_token（旧裸串降 recapture）；workbuddy/trae → recapture；
 * qoder/zcode → relogin；codebuddy_desktop 矩阵未覆盖 → null（端点按 relogin 口径 409 引导）。
 */
export function credentialRefreshMethodFor(appId: ManagedAppId, payloadHasRefreshToken = false): CredentialRefreshMethod | null {
  switch (appId) {
    case 'minimax': return payloadHasRefreshToken ? 'refresh_token' : 'recapture';
    case 'workbuddy_desktop':
    case 'trae': return 'recapture';
    case 'qoder_cn':
    case 'zcode': return 'relogin';
    default: return null;
  }
}

/** 捕获/导入/协议加号写入点：落到期列，status 按到期推导，清 invalid_at（新凭据即恢复） */
export function setCredentialExpiry(db: Db, accountId: string, input: { expiresAt: number | null; refreshMethod: CredentialRefreshMethod | null }): void {
  const status = deriveCredentialStatus({ expiresAt: input.expiresAt, invalidAt: null, stored: 'unknown' });
  db.prepare('UPDATE managed_account SET credential_expires_at=?, credential_status=?, credential_refresh_method=?, credential_invalid_at=NULL, updated_at=MAX(?,updated_at+1) WHERE id=?')
    .run(input.expiresAt, status, input.refreshMethod, Date.now(), accountId);
}

/** 续期成功（withRefresh / refresh-credential）：valid + 新到期时间 + 清 invalid_at；不动 refresh_method */
export function markCredentialRefreshed(db: Db, accountId: string, expiresAt: number | null, now = Date.now()): void {
  db.prepare("UPDATE managed_account SET credential_expires_at=?, credential_status='valid', credential_invalid_at=NULL, updated_at=MAX(?,updated_at+1) WHERE id=?")
    .run(expiresAt, now, accountId);
}

/** 凭据被判失效（401 / invalid_grant）：invalid + 记失效时间 */
export function markCredentialInvalid(db: Db, accountId: string, now = Date.now()): void {
  db.prepare("UPDATE managed_account SET credential_status='invalid', credential_invalid_at=?, updated_at=MAX(?,updated_at+1) WHERE id=?")
    .run(now, now, accountId);
}

export function publicManagedAccount(account: ManagedAccount, now = Date.now()): PublicManagedAccount {
  const {
    identity_hash: _hash, client_snapshot_ref: _snapshot, checkin_credential_ref: checkinRef,
    credential_status: storedStatus, credential_expires_at: expiresAt, credential_refresh_method: refreshMethod,
    credential_invalid_at: invalidAt,
    ...safe
  } = account;
  // ACC-CHECKIN：前端据此禁用「缺凭据」账号的签到按钮；只给布尔，不给 ref
  // ACC-TOKEN-2：状态读取时即时修正（落库 valid 但实际已过期的行不失真）；零解密——只读列
  return {
    ...safe,
    has_checkin_credential: checkinRef !== null,
    credential_status: deriveCredentialStatus({ expiresAt: expiresAt ?? null, invalidAt: invalidAt ?? null, stored: storedStatus ?? 'unknown', now }),
    credential_expires_at: expiresAt ?? null,
    refresh_method: refreshMethod ?? null,
  };
}
export function listManagedAccounts(db: Db): PublicManagedAccount[] {
  return (db.prepare('SELECT id FROM managed_account ORDER BY created_at,id').all() as Array<{ id: string }>).map(r => publicManagedAccount(getManagedAccount(db, r.id)!));
}
export function createManagedAccount(db: Db, input: CreateManagedAccountInput): ManagedAccount {
  const checked = schema.safeParse(input); if (!checked.success) throw new ValidationError('账号 metadata 不合法，不接受凭据原文');
  const p = checked.data; const id = randomUUID(); const now = Date.now();
  try { db.prepare(`INSERT INTO managed_account(id,app_id,client_instance_id,service_region,identity_hash,display_name,identity_hint,client_snapshot_ref,checkin_credential_ref,client_snapshot_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,p.app_id,p.client_instance_id,p.service_region,p.identity_hash,p.display_name,p.identity_hint ?? null,p.client_snapshot_ref ?? null,p.checkin_credential_ref ?? null,p.client_snapshot_version ?? 1,now,now); }
  catch (error) { if ((error as {code?:string}).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError(409, 'ACCOUNT_EXISTS', '该产品实例已有此账号'); throw error; }
  return getManagedAccount(db, id)!;
}
