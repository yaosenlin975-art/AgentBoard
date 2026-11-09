import type { CheckinBatch, CheckinBatchItemState, ManagedAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import {
  getCheckinBatch,
  getCheckinBatchItem,
  listCheckinBatchItems,
  recordAccountCheckin,
  updateCheckinBatch,
  updateCheckinBatchItem,
} from '../../db/repos/checkin.js';
import { credentialExpiresAtFromPayload, getManagedAccount, markCredentialInvalid, markCredentialRefreshed } from '../../db/repos/managedAccount.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { runAccountOperation } from './operationRunner.js';
import type { CheckinProviderSpec, CheckinVault } from './checkinProvider.js';
import { profileLocalDay } from './checkinAuthorization.js';

export interface CheckinRunnerDeps {
  db: Db;
  vault: CheckinVault;
  provider: CheckinProviderSpec;
}

const SUCCESS_STATES: ReadonlySet<CheckinBatchItemState> = new Set(['succeeded', 'already_done']);

function finalStatus(states: CheckinBatchItemState[]): CheckinBatch['status'] {
  if (states.length > 0 && states.every(state => state === 'cancelled')) return 'cancelled';
  const succeeded = states.filter(state => SUCCESS_STATES.has(state)).length;
  const pendingLike = states.filter(state => state === 'queued' || state === 'running').length;
  if (succeeded === 0 && pendingLike === 0) return 'failed';
  if (succeeded === states.length) return 'succeeded';
  return 'partial';
}

/** 逐账号串行执行一个批次：不并发、每项各自结果、取消的排队项直接跳过。返回批次最终状态。 */
export async function runCheckinBatch(deps: CheckinRunnerDeps, batchId: string): Promise<CheckinBatch> {
  const batch = getCheckinBatch(deps.db, batchId);
  if (!batch) throw new NotFoundError('签到批次不存在');
  const day = batch.profile_local_day ?? profileLocalDay();
  updateCheckinBatch(deps.db, batchId, { status: 'running' });
  for (const queuedItem of listCheckinBatchItems(deps.db, batchId)) {
    // 每取一项前重读状态：已被取消的排队项不发请求、不建操作记录
    const fresh = getCheckinBatchItem(deps.db, batchId, queuedItem.account_id);
    if (!fresh || fresh.state !== 'queued') continue;
    updateCheckinBatchItem(deps.db, batchId, fresh.account_id, { state: 'running' });
    await runItem(deps, batchId, day, fresh.account_id);
  }
  const states = listCheckinBatchItems(deps.db, batchId).map(item => item.state);
  return updateCheckinBatch(deps.db, batchId, { status: finalStatus(states), finished_at: Date.now() });
}

async function setItem(db: Db, batchId: string, accountId: string, state: CheckinBatchItemState, code: string | null, operationId?: string | null): Promise<void> {
  updateCheckinBatchItem(db, batchId, accountId, { state, safe_error_code: code, ...(operationId === undefined ? {} : { operation_id: operationId }) });
}

function failItem(db: Db, batchId: string, accountId: string, code: string): void {
  setItem(db, batchId, accountId, 'failed', code);
}

async function runItem(deps: CheckinRunnerDeps, batchId: string, day: string, accountId: string): Promise<void> {
  const account = getManagedAccount(deps.db, accountId);
  if (!account) return failItem(deps.db, batchId, accountId, 'ACCOUNT_NOT_FOUND');
  if (!account.enabled) return failItem(deps.db, batchId, accountId, 'ACCOUNT_DISABLED');
  if (account.app_id !== deps.provider.app_id) return failItem(deps.db, batchId, accountId, 'CHECKIN_PROVIDER_MISMATCH');
  // 无独立签到凭据的账号不发请求（不从 Desktop 快照推断）
  if (!account.checkin_credential_ref) return failItem(deps.db, batchId, accountId, 'CHECKIN_CREDENTIAL_MISSING');
  // Trae 的历史 succeeded 可能来自未核验的 2xx；同日记录仍需查询来源状态
  if (deps.provider.app_id !== 'trae' && account.last_checkin_day === day && account.last_checkin_status === 'succeeded') {
    return setItem(deps.db, batchId, accountId, 'already_done', 'LOCAL_RECORD');
  }
  const scope = { app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' as const };
  let credential: Buffer;
  let credentialRef = account.checkin_credential_ref;
  try {
    credential = await deps.vault.unprotect(credentialRef, scope);
  } catch {
    return failItem(deps.db, batchId, accountId, 'VAULT_READ_FAILED');
  }
  /**
   * ACC-FIX-3：凭据失效时用 refresh_token 续期一次，写回 vault 并更新账号引用后重试当前动作。
   * 只重试一次；无 refresh_token / 续期失败 / 写回失败都不重试，维持 CHECKIN_CREDENTIAL_INVALID。
   */
  const withRefresh = async <T>(action: (current: Buffer) => Promise<T>): Promise<T> => {
    try {
      return await action(credential);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CHECKIN_CREDENTIAL_INVALID' || deps.provider.refreshCredential === undefined) throw error;
      const refreshed = await deps.provider.refreshCredential(credential).catch(() => null);
      if (refreshed === null) {
        // ACC-TOKEN-2：续期失败——凭据判失效，落 invalid_at 供列表显示「凭据已失效」
        markCredentialInvalid(deps.db, account.id);
        throw error;
      }
      let newRef: string;
      try {
        newRef = await deps.vault.protect(refreshed, scope);
        deps.db.prepare('UPDATE managed_account SET checkin_credential_ref=?, updated_at=? WHERE id=?').run(newRef, Date.now(), account.id);
      } catch {
        throw error;
      }
      if (deps.vault.delete !== undefined) {
        try { await deps.vault.delete(credentialRef); } catch { /* 旧凭据清理失败不影响本次签到 */ }
      }
      credential = refreshed;
      credentialRef = newRef;
      // ACC-TOKEN-2：续期成功——落新到期时间 + valid + 清 invalid_at（到期时间从 JSON 载荷 expires_at 取）
      markCredentialRefreshed(deps.db, account.id, credentialExpiresAtFromPayload(refreshed));
      return action(credential);
    }
  };
  try {
    const operation = await runAccountOperation(
      deps.db,
      { account_id: account.id, app_id: account.app_id, client_instance_id: account.client_instance_id, operation: 'checkin', batch_id: batchId },
      async () => {
        const status = await withRefresh(current => deps.provider.queryStatus(current));
        if (status === 'already_done') return 'already_done';
        const submitted = await withRefresh(current => deps.provider.submitCheckin(current));
        if (submitted === 'succeeded') return 'succeeded';
        if (submitted === 'already_done') return 'already_done';
        if (submitted === 'rate_limited') throw new ApiError(429, 'CHECKIN_RATE_LIMITED', '签到被限流');
        if (submitted === 'unknown') throw new ApiError(409, 'OPERATION_UNKNOWN', '签到结果未知，不会自动重发');
        throw new ApiError(409, 'CHECKIN_FAILED', '签到失败');
      },
      { onOperationCreated: (id: string) => { updateCheckinBatchItem(deps.db, batchId, accountId, { state: 'running', operation_id: id }); } },
      { tryLock: true },
    );
    const state: CheckinBatchItemState = operation.state === 'succeeded' || operation.state === 'already_done' || operation.state === 'unknown' ? operation.state : 'failed';
    // ACC-12：签到成功/已签到时执行附加活动（workbuddy 猫猫旅行）；失败不改签到结果，只写进 operation.recovery_ref
    if ((state === 'succeeded' || state === 'already_done') && deps.provider.afterCheckin) {
      let note = 'travel=failed';
      try {
        const activity = await deps.provider.afterCheckin(credential);
        if (activity) {
          note = activity.status === 'failed'
            ? `travel=failed:${activity.safe_error_code ?? 'TRAVEL_FAILED'}`
            : `travel=${activity.status}`;
        }
      } catch (error) {
        note = `travel=failed:${error instanceof ApiError ? error.code : 'TRAVEL_FAILED'}`;
      }
      deps.db.prepare('UPDATE account_operation SET recovery_ref=? WHERE id=?').run(note, operation.id);
    }
    await setItem(deps.db, batchId, accountId, state, operation.safe_error_code, operation.id);
    if (state === 'succeeded' || state === 'already_done') recordAccountCheckin(deps.db, accountId, { day, status: state });
    if (state === 'unknown') recordAccountCheckin(deps.db, accountId, { day, status: 'unknown' });
  } catch (error) {
    // ACC-TOKEN-2：收尾 CHECKIN_CREDENTIAL_INVALID（含续期后重试仍 401）——凭据判失效，落 invalid_at
    if (error instanceof ApiError && error.code === 'CHECKIN_CREDENTIAL_INVALID') markCredentialInvalid(deps.db, accountId);
    const code = error instanceof ApiError
      ? (['ACCOUNT_BUSY', 'RECOVERY_REQUIRED', 'CHECKIN_RATE_LIMITED', 'CHECKIN_FAILED', 'CHECKIN_CREDENTIAL_INVALID', 'OPERATION_UNKNOWN', 'VAULT_READ_FAILED'].includes(error.code) ? error.code : 'CHECKIN_FAILED')
      : 'CHECKIN_FAILED';
    await setItem(deps.db, batchId, accountId, code === 'OPERATION_UNKNOWN' ? 'unknown' : 'failed', code);
  }
}

/** 路由用：不等待执行完成，批次状态经 GET /api/checkin-runs/:id 轮询 */
export function startCheckinBatchInBackground(deps: CheckinRunnerDeps, batchId: string): void {
  void runCheckinBatch(deps, batchId).catch(() => {
    // 执行器内部已把逐账号结果落库；批级异常保留 running 由下次启动 recoverAccountOperations 收敛
  });
}
