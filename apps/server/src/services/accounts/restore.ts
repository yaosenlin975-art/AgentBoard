/**
 * ACC-KB-A3：`recovery_required` 的人工解冻通道（restore 端点）。
 *
 * 背景：`account_operation.operation` 枚举与状态机早有 `restore`，`operationRunner` 也实现了它的收尾
 * （把被恢复的原操作改 `failed` 并记 `safe_error_code='RESTORED'`），但**没有任何端点能发起它**。
 * 结果：写后失败被冻结的实例永久停在 `recovery_required`——`operationRunner` 的写类门禁恒 409，
 * `delete` 也被 `RECOVERY_REQUIRED` 挡住，等于死锁。
 *
 * 本模块只做「发起 + 幂等」，恢复动作本身的边界（是否真的写回客户端快照）由 run 回调决定：
 * 当前 provider 没有对外暴露 restore 能力（快照内容归另一张卡），因此这里按「人工确认已恢复/放弃恢复」
 * 语义把原操作收尾为 failed(RESTORED)，从而解除门禁；真正的快照写回接入后只需替换 run 回调。
 */
import type { AccountOperation } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { getAccountOperation } from '../../db/repos/accountOperation.js';
import { getManagedAccount } from '../../db/repos/managedAccount.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { runAccountOperation } from './operationRunner.js';

export interface RestoreResult {
  /** 本次（或此前已完成的）restore 操作 */
  operation: AccountOperation;
  /** 被解冻的原操作 id */
  recovered_operation_id: string;
  /** true = 幂等重放：之前已经解冻过，本次没有新建任何 operation 行 */
  replayed: boolean;
}

/** 该实例当前冻结的操作（最新的 recovery_required） */
function pendingRecovery(db: Db, app_id: string, client_instance_id: string): AccountOperation | null {
  return (db.prepare(`SELECT * FROM account_operation
    WHERE app_id=? AND client_instance_id=? AND state='recovery_required'
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(app_id, client_instance_id) as AccountOperation | undefined) ?? null;
}

/** 已完成的 restore（原操作已被标 failed / RESTORED）——用于幂等重放 */
function completedRestore(db: Db, app_id: string, client_instance_id: string): AccountOperation | null {
  return (db.prepare(`SELECT r.* FROM account_operation r
    JOIN account_operation o ON o.id = r.recovers_operation_id
    WHERE r.app_id=? AND r.client_instance_id=? AND r.operation='restore' AND r.state='succeeded'
      AND o.state='failed' AND o.safe_error_code='RESTORED'
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1`).get(app_id, client_instance_id) as AccountOperation | undefined) ?? null;
}

/**
 * 发起解冻。幂等：已解冻过的实例再调一次返回原 restore 操作（`replayed: true`），不新建行、
 * 不会把已恢复的实例二次置为 failed。
 */
export async function startAccountRestore(db: Db, accountId: string): Promise<RestoreResult> {
  const account = getManagedAccount(db, accountId);
  if (!account) throw new NotFoundError('账号不存在');

  const frozen = pendingRecovery(db, account.app_id, account.client_instance_id);
  if (!frozen) {
    const done = completedRestore(db, account.app_id, account.client_instance_id);
    if (done) return { operation: done, recovered_operation_id: done.recovers_operation_id!, replayed: true };
    throw new ApiError(409, 'RECOVERY_NOT_REQUIRED', '该账号所在客户端实例没有需要解冻的操作');
  }

  const operation = await runAccountOperation(
    db,
    {
      account_id: account.id,
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      operation: 'restore',
      recovers_operation_id: frozen.id,
    },
    // 人工解冻：无 provider 级快照写回能力时，确认后直接把原操作收尾为 failed(RESTORED)（由 runner 执行）
    async () => 'succeeded',
  );
  return { operation: getAccountOperation(db, operation.id)!, recovered_operation_id: frozen.id, replayed: false };
}
