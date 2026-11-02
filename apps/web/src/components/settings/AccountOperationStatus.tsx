/**
 * 账号操作状态（ACC-08）：把 AccountOperation 的 state/stage/safe_error_code 翻成可读文案。
 * 只展示脱敏字段；recovery_required 视为「需要恢复」并冻结后续切换。
 */
import type { AccountOperation } from '@agentboard/shared';
import { Badge, type BadgeTone } from '../ui/Badge';

const STATE_LABEL: Record<AccountOperation['state'], string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '切换成功',
  already_done: '已是最新状态',
  failed: '失败',
  unknown: '结果未知',
  recovery_required: '需要恢复',
};

const STATE_TONE: Record<AccountOperation['state'], BadgeTone> = {
  queued: 'neutral',
  running: 'blue',
  succeeded: 'green',
  already_done: 'green',
  failed: 'red',
  unknown: 'neutral',
  recovery_required: 'red',
};

const STAGE_LABEL: Record<AccountOperation['stage'], string> = {
  preflight: '预检',
  stop: '停止客户端',
  snapshot: '保存快照',
  validate_target: '校验目标账号',
  write: '写入配置',
  start: '启动客户端',
  verify: '校验结果',
  rollback: '回滚',
};

/** 终态：不再轮询 */
export function isTerminalState(state: AccountOperation['state']): boolean {
  return state === 'succeeded' || state === 'already_done' || state === 'failed' || state === 'unknown' || state === 'recovery_required';
}

export function AccountOperationStatus({ operation, testId }: { operation: AccountOperation | null; testId: string }) {
  if (operation === null) return null;
  const frozen = operation.state === 'recovery_required';
  return (
    <div data-testid={testId} data-state={operation.state} className="mt-2 rounded-md border border-neutral-200 px-2 py-1.5 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={STATE_TONE[operation.state]}>{STATE_LABEL[operation.state]}</Badge>
        <span>阶段：{STAGE_LABEL[operation.stage]}</span>
        {operation.safe_error_code !== null && <span className="text-red-600 dark:text-red-400">错误码：{operation.safe_error_code}</span>}
      </div>
      {frozen && (
        <p className="mt-1 text-amber-700 dark:text-amber-300">
          切换中断，需要人工恢复；恢复引用：{operation.recovery_ref ?? '（未提供）'}
        </p>
      )}
    </div>
  );
}
