import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedAccount, PublicManagedAccount } from '@agentboard/shared';
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

export function publicManagedAccount(account: ManagedAccount): PublicManagedAccount {
  const { identity_hash: _hash, client_snapshot_ref: _snapshot, checkin_credential_ref: checkinRef, ...safe } = account;
  // ACC-CHECKIN：前端据此禁用「缺凭据」账号的签到按钮；只给布尔，不给 ref
  return { ...safe, has_checkin_credential: checkinRef !== null };
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
