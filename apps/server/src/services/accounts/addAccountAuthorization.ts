/**
 * ACC-KB-B2S：协议级「添加账号」的授权会话服务（发起 → 轮询/回调 → 落 vault → 建 managed_account）。
 *
 * 范式与 `checkinAuthorization.ts` 同构（三段式 + 状态 CAS），差别在三处：
 * 1. **没有目标账号**：加号是先授权、再建账号，所以身份来自授权响应而不是既有账号；
 * 2. **待激活凭据单独一类**：授权完成前握着的中间态（device_code / PKCE verifier / poll token）
 *    落在 vault 的 `pending_credential` purpose 里，成功即转存为 `checkin`，
 *    放弃/超时/失败即删除——**不留孤儿 vault 文件、不留半条账号**；
 * 3. **不需要客户端在跑**：全程只与平台服务端对话，账号建好后直接出现在 `GET /api/managed-accounts`。
 *
 * 身份口径：`identity_hash = sha256(app_id + NUL + uid)`，与 `credentialImport.ts` 一致，
 * 于是「导入得到的账号」与「协议加号得到的同一账号」落在同一行，不会出现两条重复账号。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AddAccountSession, ManagedAccount, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import {
  addAccountSessionSecretRef,
  createAddAccountSession,
  findOpenAddAccountSession,
  getAddAccountSession,
  publicAddAccountSession,
  transitionAddAccountSession,
} from '../../db/repos/addAccount.js';
import { findManagedAccountByAppIdentity, getManagedAccount, publicManagedAccount } from '../../db/repos/managedAccount.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { createCheckinProviders } from './httpCheckinProviders.js';
import type { AddAccountProviderSpec, AddAccountRegion, AddAccountVault } from './addAccountProtocol.js';

export interface AddAccountDeps {
  db: Db;
  vault: AddAccountVault;
  providers: Partial<Record<ManagedAppId, AddAccountProviderSpec>>;
  now?: () => number;
}

/** 有签到 provider 的平台才把 checkin_capability 标 supported（口径同 credentialImport） */
const CHECKIN_CAPABLE_APPS = new Set<string>(Object.keys(createCheckinProviders()));

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 协议加号的账号不绑具体客户端实例：用固定标记，复用时按 identity 命中既有行 */
const PROTOCOL_CLIENT_INSTANCE = 'protocol';

function scopeOfPending(appId: ManagedAppId, sessionId: string) {
  return { app_id: appId, client_instance_id: sessionId, identity_hash: sha256(sessionId), purpose: 'pending_credential' as const };
}

function scopeOfCredential(appId: ManagedAppId, clientInstanceId: string, identityHash: string) {
  return { app_id: appId, client_instance_id: clientInstanceId, identity_hash: identityHash, purpose: 'checkin' as const };
}

function requireProvider(appId: ManagedAppId, deps: AddAccountDeps): AddAccountProviderSpec {
  const provider = deps.providers[appId];
  if (!provider) throw new ApiError(409, 'PROVIDER_UNVERIFIED', '该产品暂不支持协议级添加账号', { reason_code: 'ADD_ACCOUNT_PROTOCOL_UNSUPPORTED' });
  return provider;
}

/** 删掉待激活凭据（幂等；vault 未实现 delete 时静默跳过） */
async function dropPendingSecret(deps: AddAccountDeps, appId: ManagedAppId, sessionId: string): Promise<void> {
  const row = addAccountSessionSecretRef(deps.db, sessionId);
  const ref = row?.pending_secret_ref;
  if (!ref) return;
  if (typeof deps.vault.delete === 'function') await deps.vault.delete(ref).catch(() => undefined);
}

/**
 * 清理过期未结束的会话：状态置 expired + 删掉待激活凭据。
 * 即使用户再也不回来轮询，vault 里也不会留下孤儿文件（验收②的超时分支）。
 */
export async function sweepExpiredAddAccountSessions(deps: AddAccountDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const rows = deps.db.prepare("SELECT id, app_id FROM add_account_session WHERE status='pending' AND expires_at<=?").all(now) as Array<{ id: string; app_id: ManagedAppId }>;
  for (const row of rows) {
    transitionAddAccountSession(deps.db, row.id, 'pending', { status: 'expired', safe_error_code: 'AUTHORIZATION_EXPIRED' });
    await dropPendingSecret(deps, row.app_id, row.id);
  }
  return rows.length;
}

/**
 * 发起授权：调平台拿授权地址，把待激活凭据加密落 vault（库里只留 hash 与 ref），
 * 再建一条 pending 会话。**此步不产生任何 managed_account 行**。
 */
export async function startAddAccountAuthorization(
  deps: AddAccountDeps,
  input: { app_id: ManagedAppId; region?: AddAccountRegion },
): Promise<AddAccountSession> {
  const provider = requireProvider(input.app_id, deps);
  await sweepExpiredAddAccountSessions(deps);
  if (findOpenAddAccountSession(deps.db, input.app_id)) {
    throw new ApiError(409, 'ADD_ACCOUNT_SESSION_EXISTS', '该产品已有进行中的添加账号会话，请先完成或取消');
  }
  const region: AddAccountRegion = input.region ?? 'cn';
  const started = await provider.startAuthorization({ region });
  const sessionId = randomUUID();
  const pendingScope = scopeOfPending(input.app_id, sessionId);
  const ref = await deps.vault.protect(started.pending_secret, pendingScope);
  try {
    const row = createAddAccountSession(deps.db, {
      id: sessionId,
      app_id: input.app_id,
      protocol: provider.protocol,
      service_region: region,
      client_instance_id: PROTOCOL_CLIENT_INSTANCE,
      authorization_url: started.authorization_url,
      user_code: started.user_code,
      pending_secret_hash: sha256(started.pending_secret.toString('utf8')),
      pending_secret_ref: ref,
      expires_at: started.expires_at,
    });
    return publicAddAccountSession(row);
  } catch (error) {
    // 建行失败（如并发同 app 重复发起）→ 立刻删掉刚写的密文，不留孤儿
    if (typeof deps.vault.delete === 'function') await deps.vault.delete(ref).catch(() => undefined);
    throw error;
  }
}
/** 建号 / 更新号：同一 app + 同一 uid 命中既有行就更新，不产生重复账号 */
function upsertAccount(deps: AddAccountDeps, appId: ManagedAppId, identityHash: string, displayName: string, credentialRef: string, existing: ManagedAccount | null, region: 'cn' | 'global' | 'unknown'): { account: ManagedAccount; previousRef: string | null } {
  const capability = CHECKIN_CAPABLE_APPS.has(appId) ? 'supported' : 'unsupported';
  const timestamp = deps.now?.() ?? Date.now();
  if (existing) {
    deps.db.prepare('UPDATE managed_account SET display_name=?,checkin_credential_ref=?,checkin_capability=?,updated_at=MAX(?,updated_at+1) WHERE id=?')
      .run(displayName, credentialRef, capability, timestamp, existing.id);
    return { account: getManagedAccount(deps.db, existing.id)!, previousRef: existing.checkin_credential_ref };
  }
  const id = randomUUID();
  deps.db.prepare(`INSERT INTO managed_account
    (id,app_id,client_instance_id,service_region,identity_hash,display_name,identity_hint,client_snapshot_ref,checkin_credential_ref,client_snapshot_version,checkin_capability,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, appId, PROTOCOL_CLIENT_INSTANCE, region, identityHash, displayName, null, null, credentialRef, 1, capability, timestamp, timestamp);
  return { account: getManagedAccount(deps.db, id)!, previousRef: null };
}

/**
 * 轮询授权结果：
 * - pending → 原样返回，**不写 vault、不建账号**；
 * - authorized → 凭据加密落 vault（purpose=checkin）→ 建/更新 managed_account → 会话置 authorized；
 * - failed / expired → 会话置终态并**删掉待激活凭据**（不留孤儿）。
 */
export async function pollAddAccountAuthorization(
  deps: AddAccountDeps,
  sessionId: string,
): Promise<{ session: AddAccountSession; account: PublicManagedAccount | null }> {
  const row = getAddAccountSession(deps.db, sessionId);
  if (!row) throw new NotFoundError('添加账号会话不存在');
  if (row.status !== 'pending') {
    throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该添加账号会话已不在进行中', { status: row.status });
  }
  const now = deps.now?.() ?? Date.now();
  if (now > row.expires_at) {
    transitionAddAccountSession(deps.db, sessionId, 'pending', { status: 'expired', safe_error_code: 'AUTHORIZATION_EXPIRED' });
    await dropPendingSecret(deps, row.app_id, sessionId);
    throw new ApiError(409, 'AUTHORIZATION_EXPIRED', '添加账号会话已过期，请重新发起');
  }
  const provider = requireProvider(row.app_id, deps);
  const secretRef = addAccountSessionSecretRef(deps.db, sessionId);
  if (!secretRef?.pending_secret_ref) throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该添加账号会话缺少待激活凭据');
  const pendingSecret = await deps.vault.unprotect(secretRef.pending_secret_ref, scopeOfPending(row.app_id, sessionId));
  if (sha256(pendingSecret.toString('utf8')) !== secretRef.pending_secret_hash) {
    throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '待激活凭据与会话不匹配');
  }

  const polled = await provider.pollAuthorization(pendingSecret);
  if (polled.status === 'pending') return { session: publicAddAccountSession(row), account: null };
  if (polled.status === 'failed') {
    const failed = transitionAddAccountSession(deps.db, sessionId, 'pending', { status: 'failed', safe_error_code: polled.safe_error_code })
      ?? getAddAccountSession(deps.db, sessionId)!;
    await dropPendingSecret(deps, row.app_id, sessionId);
    await provider.dispose?.(pendingSecret).catch(() => undefined);
    return { session: publicAddAccountSession(failed), account: null };
  }
  if (polled.status === 'expired') {
    const expired = transitionAddAccountSession(deps.db, sessionId, 'pending', { status: 'expired', safe_error_code: 'AUTHORIZATION_EXPIRED' })
      ?? getAddAccountSession(deps.db, sessionId)!;
    await dropPendingSecret(deps, row.app_id, sessionId);
    await provider.dispose?.(pendingSecret).catch(() => undefined);
    return { session: publicAddAccountSession(expired), account: null };
  }

  // authorized：先把凭据按最终 scope 加密落 vault，再在事务里建号 + 置终态
  const identityHash = sha256(`${row.app_id}\u0000${polled.uid}`);
  const displayName = (polled.display_name ?? '').trim() || polled.uid.slice(0, 12);
  // 跨来源识别同一账号：导入得到的行（client_instance_id='imported'）与协议加号命中同一 identity_hash
  const existing = findManagedAccountByAppIdentity(deps.db, row.app_id, identityHash);
  const clientInstanceId = existing?.client_instance_id ?? PROTOCOL_CLIENT_INSTANCE;
  const scope = scopeOfCredential(row.app_id, clientInstanceId, identityHash);
  const credentialRef = await deps.vault.protect(polled.credential, scope);
  try {
    const result = deps.db.transaction(() => {
      const upserted = upsertAccount(deps, row.app_id, identityHash, displayName, credentialRef, existing, row.service_region);
      const updated = transitionAddAccountSession(deps.db, sessionId, 'pending', { status: 'authorized', account_id: upserted.account.id });
      if (!updated) throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该添加账号会话已不在进行中');
      return upserted;
    }).immediate();
    // 旧密文引用作废即删（事务外做文件操作）
    if (result.previousRef && result.previousRef !== credentialRef && typeof deps.vault.delete === 'function') {
      await deps.vault.delete(result.previousRef).catch(() => undefined);
    }
    // 成功后再删待激活凭据：中途失败时它还在，可重试
    await dropPendingSecret(deps, row.app_id, sessionId);
    await provider.dispose?.(pendingSecret).catch(() => undefined);
    return { session: publicAddAccountSession(getAddAccountSession(deps.db, sessionId)!), account: publicManagedAccount(result.account) };
  } catch (error) {
    // 建号失败：把刚落库的凭据删掉，避免留下没人引用的 vault 文件
    if (typeof deps.vault.delete === 'function') await deps.vault.delete(credentialRef).catch(() => undefined);
    throw error;
  }
}

/** 放弃授权：会话置 cancelled，待激活凭据删除，不建账号 */
export async function cancelAddAccountAuthorization(deps: AddAccountDeps, sessionId: string): Promise<AddAccountSession> {
  const row = getAddAccountSession(deps.db, sessionId);
  if (!row) throw new NotFoundError('添加账号会话不存在');
  if (row.status !== 'pending') return publicAddAccountSession(row);
  // 先取出待激活凭据（provider 要用它释放本地回调监听），再删密文
  const provider = deps.providers[row.app_id];
  const secretRef = addAccountSessionSecretRef(deps.db, sessionId);
  let pendingSecret: Buffer | null = null;
  if (provider?.dispose && secretRef?.pending_secret_ref) {
    pendingSecret = await deps.vault.unprotect(secretRef.pending_secret_ref, scopeOfPending(row.app_id, sessionId)).catch(() => null);
  }
  const cancelled = transitionAddAccountSession(deps.db, sessionId, 'pending', { status: 'cancelled', safe_error_code: 'AUTHORIZATION_CANCELLED' })
    ?? getAddAccountSession(deps.db, sessionId)!;
  await dropPendingSecret(deps, row.app_id, sessionId);
  if (provider?.dispose && pendingSecret) await provider.dispose(pendingSecret).catch(() => undefined);
  return publicAddAccountSession(cancelled);
}
