import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountOperation } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ValidationError } from '../../errors.js';
import { managedAppSchema } from '../../services/accounts/secretVault.js';
const inputSchema = z.object({ account_id: z.string().uuid().nullable().optional(), app_id: managedAppSchema, client_instance_id: z.string().min(1).max(300), operation: z.enum(['capture','switch','checkin','restore']), batch_id: z.string().uuid().nullable().optional(), recovers_operation_id: z.string().uuid().optional() }).strict()
  .refine(v => v.operation === 'restore' ? !!v.recovers_operation_id : !v.recovers_operation_id, 'restore 必须关联被恢复操作');
export type CreateAccountOperationInput = z.infer<typeof inputSchema>;
export function getAccountOperation(db: Db, id: string): AccountOperation | null { return db.prepare('SELECT * FROM account_operation WHERE id=?').get(id) as AccountOperation | undefined ?? null; }
export function createAccountOperation(db: Db, input: CreateAccountOperationInput): AccountOperation {
  const result = inputSchema.safeParse(input); if (!result.success) throw new ValidationError('账号操作不合法'); const p = result.data;
  if (p.account_id && !db.prepare('SELECT 1 FROM managed_account WHERE id=? AND app_id=? AND client_instance_id=?').get(p.account_id,p.app_id,p.client_instance_id)) throw new ValidationError('账号与产品/实例不一致');
  if (p.recovers_operation_id) {
    const original = getAccountOperation(db,p.recovers_operation_id);
    if (!original || original.app_id !== p.app_id || original.client_instance_id !== p.client_instance_id || original.state !== 'recovery_required') throw new ValidationError('恢复目标必须是同产品实例的冻结操作');
  }
  const id = randomUUID(); db.prepare("INSERT INTO account_operation(id,batch_id,account_id,app_id,client_instance_id,operation,recovers_operation_id,state,stage,created_at) VALUES(?,?,?,?,?,?,?,'queued','preflight',?)").run(id,p.batch_id ?? null,p.account_id ?? null,p.app_id,p.client_instance_id,p.operation,p.recovers_operation_id ?? null,Date.now()); return getAccountOperation(db,id)!;
}
const transitions: Record<AccountOperation['state'], AccountOperation['state'][]> = { queued:['running','failed'], running:['succeeded','already_done','failed','unknown','recovery_required'], succeeded:[], already_done:[], failed:[], unknown:[], recovery_required:['failed'] };
export function updateAccountOperation(db: Db, id: string, patch: { state?: AccountOperation['state']; stage?: AccountOperation['stage']; safe_error_code?: string | null; recovery_ref?: string | null }): AccountOperation {
  const current = getAccountOperation(db,id); if (!current) throw new ApiError(404,'OPERATION_NOT_FOUND','账号操作不存在');
  const next = patch.state ?? current.state;
  if (next !== current.state && !transitions[current.state].includes(next)) throw new ApiError(409,'OPERATION_STATE_CONFLICT','操作状态不可回退');
  if (patch.safe_error_code && !/^[A-Z0-9_]{1,80}$/.test(patch.safe_error_code)) throw new ValidationError('错误码不合法');
  if (patch.recovery_ref && !z.string().uuid().safeParse(patch.recovery_ref).success) throw new ValidationError('恢复 reference 不合法');
  const finished = !['queued','running','recovery_required'].includes(next);
  const row = db.prepare('UPDATE account_operation SET state=?,stage=?,safe_error_code=?,recovery_ref=?,started_at=?,finished_at=? WHERE id=? AND state=?').run(next,patch.stage ?? current.stage,patch.safe_error_code === undefined ? current.safe_error_code : patch.safe_error_code,patch.recovery_ref === undefined ? current.recovery_ref : patch.recovery_ref,current.started_at ?? (next==='running' ? Date.now() : null),finished ? (current.finished_at ?? Date.now()) : null,id,current.state);
  if (!row.changes) throw new ApiError(409,'OPERATION_STATE_CONFLICT','操作已改变'); return getAccountOperation(db,id)!;
}
