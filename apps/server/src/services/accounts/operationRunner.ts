import type { AccountOperation } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { createAccountOperation, getAccountOperation, updateAccountOperation, type CreateAccountOperationInput } from '../../db/repos/accountOperation.js';
import { ApiError } from '../../errors.js';
import { withAccountLock, tryWithAccountLock } from './locks.js';
function mayHaveWrittenClient(op: AccountOperation): boolean { return ['switch','restore'].includes(op.operation) && ['write','start','verify','rollback'].includes(op.stage); }
/** 可落库的安全错误码（固定大写码，不含凭证或原始异常文本）；SWITCH_ROLLED_BACK 表示已独立核验恢复原账号 */
const SAFE_ERROR_CODES = new Set(['RECOVERY_REQUIRED','OPERATION_UNKNOWN','VAULT_READ_FAILED','VAULT_UNAVAILABLE','SWITCH_ROLLED_BACK',
  'CLIENT_INSTANCE_NOT_FOUND','CLIENT_VERSION_UNSUPPORTED','CLIENT_SCHEMA_UNSUPPORTED','CLIENT_NOT_RUNNING','IDENTITY_UNAVAILABLE','IDENTITY_CHANGED',
  'SNAPSHOT_MISSING','SNAPSHOT_FILE_MISSING','SNAPSHOT_VERSION_MISMATCH','TARGET_SNAPSHOT_INVALID','TARGET_INSTANCE_MISMATCH','TARGET_IDENTITY_MISMATCH',
  'ACCOUNT_NOT_FOUND','ACCOUNT_EXISTS','EXIT_NOT_CONFIRMED','SNAPSHOT_WRITE_FAILED',
  // ACC-07 签到：固定码，不含账号/响应原文
  'ACCOUNT_BUSY','CHECKIN_FAILED','CHECKIN_RATE_LIMITED','CHECKIN_CREDENTIAL_MISSING',
  // ACC-13 minimax 桌面切换：固定码，不含 token/路径原文
  'CLIENT_PATH_MISSING','CLIENT_STATE_UNREADABLE','CLIENT_NOT_LOGGED_IN','TARGET_CREDENTIAL_MISSING','SWITCH_WRITE_FAILED','CLIENT_STOP_UNAVAILABLE','CLIENT_START_UNAVAILABLE','ACCOUNT_APP_MISMATCH',
  // ACC-KB-A3 restore 解冻：RESTORED 记在被解冻的原操作上（正常收尾码），RECOVERY_NOT_REQUIRED 由 restore 端点抛出
  'RESTORED','RECOVERY_NOT_REQUIRED']);
export interface AccountOperationHooks { onOperationCreated?: (id: string) => void }
/** tryLock：同账号已被占用时立即失败（ACCOUNT_BUSY），不排队——批量签到逐账号独立结果用 */
export interface AccountOperationOptions { tryLock?: boolean }
export async function runAccountOperation(db: Db, input: CreateAccountOperationInput, run: (operation: AccountOperation) => Promise<'succeeded' | 'already_done' | 'unknown'>, hooks: AccountOperationHooks = {}, options: AccountOperationOptions = {}): Promise<AccountOperation> {
  const key = input.operation === 'checkin' ? input.account_id ?? input.client_instance_id : `${input.app_id}:${input.client_instance_id}`;
  const scope = input.operation === 'checkin' ? 'account' : 'client';
  const body = async (): Promise<AccountOperation> => {
    if (input.operation !== 'restore' && db.prepare("SELECT 1 FROM account_operation WHERE app_id=? AND client_instance_id=? AND state='recovery_required' LIMIT 1").get(input.app_id,input.client_instance_id)) throw new ApiError(409,'RECOVERY_REQUIRED','该客户端实例需要先恢复');
    const operation = createAccountOperation(db,input);
    if (hooks.onOperationCreated) hooks.onOperationCreated(operation.id);
    const running = updateAccountOperation(db,operation.id,{ state:'running' });
    try {
      const state = await run(running);
      if (input.operation === 'restore' && state === 'succeeded') return db.transaction(() => {
        const original = getAccountOperation(db,running.recovers_operation_id!);
        if (!original || original.state !== 'recovery_required' || original.app_id !== input.app_id || original.client_instance_id !== input.client_instance_id) throw new ApiError(409,'RECOVERY_REQUIRED','恢复目标已改变');
        // Registered restore callback may succeed only after independently verifying the original identity.
        const completed = updateAccountOperation(db,operation.id,{ state });
        updateAccountOperation(db,original.id,{ state:'failed',safe_error_code:'RESTORED' });
        return completed;
      }).immediate();
      return updateAccountOperation(db,operation.id,{ state });
    }
    catch (error) {
      const code = error instanceof ApiError && SAFE_ERROR_CODES.has(error.code) ? error.code : 'ACCOUNT_OPERATION_FAILED';
      const persisted = getAccountOperation(db,operation.id) ?? running;
      // 写后失败默认冻结实例；SWITCH_ROLLED_BACK 例外——回滚已独立核验恢复原账号，按 failed 收尾
      return updateAccountOperation(db,operation.id,{ state:code==='RECOVERY_REQUIRED' || (mayHaveWrittenClient(persisted) && code!=='SWITCH_ROLLED_BACK') ? 'recovery_required' : code==='OPERATION_UNKNOWN' ? 'unknown' : 'failed',safe_error_code:code });
    }
  };
  if (!options.tryLock) return withAccountLock(scope, key, body);
  const result = await tryWithAccountLock(scope, key, body);
  if (result === null) throw new ApiError(409, 'ACCOUNT_BUSY', '该账号有进行中的账号操作');
  return result;
}
export function recoverAccountOperations(db: Db): void {
  db.transaction(() => {
    const pending = db.prepare("SELECT * FROM account_operation WHERE state IN ('queued','running')").all() as AccountOperation[];
    for (const op of pending) {
      const clientWrite = op.state === 'running' && mayHaveWrittenClient(op);
      const state = clientWrite ? 'recovery_required' : op.state === 'running' && op.operation === 'checkin' ? 'unknown' : 'failed';
      updateAccountOperation(db,op.id,{ state,safe_error_code:'INTERRUPTED' });
      if (state === 'unknown' && op.account_id) db.prepare("UPDATE managed_account SET last_checkin_status='unknown',updated_at=MAX(?,updated_at+1) WHERE id=?").run(Date.now(),op.account_id);
    }
  })();
}
