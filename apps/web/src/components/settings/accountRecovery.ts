/**
 * 恢复（`recovery_required`）相关的界面文案（ACC-KB-B4W）。
 *
 * **单独成文件的原因**：`accountCapabilities.ts` 从 `AccountOperationStatus.tsx` 取 `isTerminalState`，
 * 而恢复文案要同时被 `AccountOperationStatus.tsx`（状态区）与 `AccountCard.tsx`（恢复入口）引用。
 * 放这里可以两边同时引用而不构成循环依赖。
 */

/** 恢复提示标题：说明「发生了什么」，而不是只说失败 */
export const RECOVERY_HINT_TITLE = '上次切换未完成，客户端可能仍是切换前的状态';

/** 恢复提示正文：说明「下一步做什么」 */
export const RECOVERY_HINT_BODY = '恢复会把客户端写回切换前的快照；恢复完成前该账号不能切换或删除。';

/** 恢复按钮文案 */
export const RECOVERY_ACTION_LABEL = '恢复客户端状态';

/** 恢复失败的中文文案（裸码只进 title） */
export const RECOVERY_FAIL_LABEL: Record<string, string> = {
  RECOVERY_NOT_REQUIRED: '该账号没有需要恢复的操作',
  RECOVERY_REQUIRED: '恢复未完成，请稍后重试',
  SNAPSHOT_MISSING: '缺少恢复依据快照，无法自动恢复',
  SNAPSHOT_WRITE_FAILED: '快照写回失败，请稍后重试',
  ACCOUNT_BUSY: '账号正忙，恢复未发起',
};
