import { createHash } from 'node:crypto';
import type { CheckinAuthorization, ManagedAccount, PublicManagedAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import {
  checkinAuthorizationStateRef,
  createCheckinAuthorization,
  getCheckinAuthorization,
  publicCheckinAuthorization,
  recordAccountCheckin,
  attachCheckinCredential,
  transitionCheckinAuthorization,
} from '../../db/repos/checkin.js';
import { getManagedAccount, publicManagedAccount } from '../../db/repos/managedAccount.js';
import { ApiError, NotFoundError } from '../../errors.js';
import type { CheckinProviderSpec, CheckinVault } from './checkinProvider.js';

export interface CheckinAuthorizationDeps {
  db: Db;
  vault: CheckinVault;
  provider: CheckinProviderSpec;
}

/** 本地时区日（YYYY-MM-DD）；命名与返回都只声明「本地记录」，不是官方服务日 */
export function profileLocalDay(ts: number = Date.now()): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function scopeOf(account: ManagedAccount) {
  return { app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' as const };
}

/** 授权启动：把远端 state 加密进 vault，库里只留 hash 与 ref；不返回 state/token */
export async function startCheckinAuthorization(deps: CheckinAuthorizationDeps, accountId: string): Promise<CheckinAuthorization> {
  const account = getManagedAccount(deps.db, accountId);
  if (!account) throw new NotFoundError('账号不存在');
  if (account.app_id !== deps.provider.app_id) throw new ApiError(409, 'CHECKIN_PROVIDER_MISMATCH', '该账号的产品与当前签到 provider 不一致');
  if (!account.enabled) throw new ApiError(409, 'ACCOUNT_DISABLED', '该账号已停用');
  const started = await deps.provider.startAuthorization({ account });
  const remoteStateRef = await deps.vault.protect(Buffer.from(started.remote_state, 'utf8'), scopeOf(account));
  const row = createCheckinAuthorization(deps.db, {
    account_id: account.id,
    app_id: account.app_id,
    remote_state_hash: sha256(started.remote_state),
    remote_state_ref: remoteStateRef,
    authorization_url: started.authorization_url,
    expires_at: started.expires_at,
  });
  return publicCheckinAuthorization(row);
}

/**
 * 授权轮询：只有 provider 返回 identity 且 app_id + region + sha256(uid) 与目标账号三元组全等，
 * 才把凭据加密写库并标记 authorized；任一维度不符 → 不写 vault、不绑 ref。
 */
export async function pollCheckinAuthorization(
  deps: CheckinAuthorizationDeps,
  authorizationId: string,
): Promise<{ authorization: CheckinAuthorization; account: PublicManagedAccount | null }> {
  const row = getCheckinAuthorization(deps.db, authorizationId);
  if (!row) throw new NotFoundError('签到授权不存在');
  if (row.status !== 'pending') throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该授权已不在进行中', { status: row.status });
  if (Date.now() > row.expires_at) {
    transitionCheckinAuthorization(deps.db, authorizationId, 'pending', { status: 'expired', safe_error_code: 'AUTHORIZATION_EXPIRED' });
    throw new ApiError(409, 'AUTHORIZATION_EXPIRED', '签到授权已过期，请重新授权');
  }
  const account = getManagedAccount(deps.db, row.account_id);
  if (!account) throw new NotFoundError('账号不存在');
  const stateRef = checkinAuthorizationStateRef(deps.db, authorizationId)?.remote_state_ref;
  if (!stateRef) throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该授权缺少远端状态引用');
  const remoteState = (await deps.vault.unprotect(stateRef, scopeOf(account))).toString('utf8');

  const polled = await deps.provider.pollAuthorization(remoteState);
  if (polled.status === 'pending') return { authorization: publicCheckinAuthorization(row), account: null };
  if (polled.status === 'expired') {
    const expired = transitionCheckinAuthorization(deps.db, authorizationId, 'pending', { status: 'expired', safe_error_code: 'AUTHORIZATION_EXPIRED' })
      ?? getCheckinAuthorization(deps.db, authorizationId)!;
    return { authorization: publicCheckinAuthorization(expired), account: null };
  }
  if (polled.status === 'failed') {
    const failed = transitionCheckinAuthorization(deps.db, authorizationId, 'pending', { status: 'failed', safe_error_code: polled.safe_error_code })
      ?? getCheckinAuthorization(deps.db, authorizationId)!;
    return { authorization: publicCheckinAuthorization(failed), account: null };
  }

  // authorized：三元组校验（跨产品 UID 相同也不绑定）
  const identity = polled.identity;
  const matched = identity.app_id === account.app_id
    && identity.region === account.service_region
    && sha256(identity.uid) === account.identity_hash;
  if (!matched) {
    transitionCheckinAuthorization(deps.db, authorizationId, 'pending', { status: 'failed', safe_error_code: 'CHECKIN_IDENTITY_MISMATCH' });
    throw new ApiError(409, 'CHECKIN_IDENTITY_MISMATCH', '授权返回的产品/区域/UID 与目标账号不一致，未保存凭据');
  }
  const ref = await deps.vault.protect(polled.credential, scopeOf(account));
  const bound = deps.db.transaction(() => {
    const updated = transitionCheckinAuthorization(deps.db, authorizationId, 'pending', { status: 'authorized' });
    if (!updated) throw new ApiError(409, 'AUTHORIZATION_NOT_PENDING', '该授权已不在进行中');
    const next = attachCheckinCredential(deps.db, account.id, ref);
    recordAccountCheckin(deps.db, account.id, { day: profileLocalDay(), status: 'authorized' });
    return next;
  }).immediate();
  return { authorization: publicCheckinAuthorization(getCheckinAuthorization(deps.db, authorizationId)!), account: publicManagedAccount(bound) };
}
