import { randomUUID } from 'node:crypto';
import type { AddAccountProtocol, AddAccountSession, AddAccountSessionStatus, ManagedAppId } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError } from '../../errors.js';

const now = (): number => Date.now();

export interface CreateAddAccountSessionInput {
  /** 会话 id：调用方自己生成（vault scope 要用它派生 identity_hash 占位） */
  id?: string;
  app_id: ManagedAppId;
  protocol: AddAccountProtocol;
  service_region: 'cn' | 'global' | 'unknown';
  client_instance_id: string;
  authorization_url: string | null;
  user_code: string | null;
  pending_secret_hash: string;
  pending_secret_ref: string;
  expires_at: number;
}

/**
 * 新建授权会话。
 * 同一 app_id 只允许一个 pending 会话（唯一索引 add_account_session_open）：
 * 重复点「加号」会 409，避免每次点击都往 vault 里堆一份待激活凭据。
 */
export function createAddAccountSession(db: Db, input: CreateAddAccountSessionInput): AddAccountSession {
  const id = input.id ?? randomUUID();
  const ts = now();
  try {
    db.prepare(`INSERT INTO add_account_session
      (id,app_id,protocol,status,service_region,client_instance_id,authorization_url,user_code,pending_secret_hash,pending_secret_ref,created_at,updated_at,expires_at)
      VALUES(?,?,?,'pending',?,?,?,?,?,?,?,?,?)`)
      .run(id, input.app_id, input.protocol, input.service_region, input.client_instance_id, input.authorization_url, input.user_code, input.pending_secret_hash, input.pending_secret_ref, ts, ts, input.expires_at);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new ApiError(409, 'ADD_ACCOUNT_SESSION_EXISTS', '该产品已有进行中的添加账号会话');
    }
    throw error;
  }
  return getAddAccountSession(db, id)!;
}

/** 对外视图：剥离待激活凭据的 hash 与 vault 引用，任何响应只走这个函数 */
export function publicAddAccountSession(row: AddAccountSession): AddAccountSession {
  const { pending_secret_hash: _hash, pending_secret_ref: _ref, ...safe } = row as AddAccountSession & { pending_secret_hash?: string; pending_secret_ref?: string | null };
  return safe;
}

export function getAddAccountSession(db: Db, id: string): AddAccountSession | null {
  return (db.prepare('SELECT * FROM add_account_session WHERE id=?').get(id) as AddAccountSession | undefined) ?? null;
}

export function listAddAccountSessions(db: Db, appId?: ManagedAppId): AddAccountSession[] {
  const rows = appId === undefined
    ? db.prepare('SELECT * FROM add_account_session ORDER BY created_at,id').all()
    : db.prepare('SELECT * FROM add_account_session WHERE app_id=? ORDER BY created_at,id').all(appId);
  return rows as AddAccountSession[];
}

/** 该产品当前未结束的会话（pending）；没有则 null */
export function findOpenAddAccountSession(db: Db, appId: ManagedAppId): AddAccountSession | null {
  return (db.prepare("SELECT * FROM add_account_session WHERE app_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(appId) as AddAccountSession | undefined) ?? null;
}

/** 内部读取待激活凭据的 vault 引用（不对外暴露） */
export function addAccountSessionSecretRef(db: Db, id: string): { pending_secret_ref: string | null; pending_secret_hash: string } | null {
  return (db.prepare('SELECT pending_secret_ref,pending_secret_hash FROM add_account_session WHERE id=?').get(id) as { pending_secret_ref: string | null; pending_secret_hash: string } | undefined) ?? null;
}

/** 状态 CAS：只有当前状态等于 from 才更新；返回 null 表示状态已变（调用方按幂等处理） */
export function transitionAddAccountSession(
  db: Db,
  id: string,
  from: AddAccountSessionStatus,
  patch: { status: AddAccountSessionStatus; safe_error_code?: string | null; account_id?: string | null },
): AddAccountSession | null {
  const result = db.prepare('UPDATE add_account_session SET status=?,safe_error_code=?,account_id=?,updated_at=? WHERE id=? AND status=?')
    .run(patch.status, patch.safe_error_code ?? null, patch.account_id ?? null, now(), id, from);
  return result.changes === 1 ? getAddAccountSession(db, id) : null;
}
