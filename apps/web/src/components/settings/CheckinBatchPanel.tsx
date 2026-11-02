/**
 * 签到批次视图（ACC-09）：逐账号展示 items[].state 与错误码，取消只对 queued 项生效。
 * 数据源 GET /api/checkin-runs/:id（含 items[]）；批次未终态时轮询。
 * 取消接口是批次级（POST /api/checkin-runs/:id/cancel）：只取消仍 queued 的项，
 * running 项服务端回传在 running[]，界面如实提示「已发出请求，无法取消」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckinBatch, CheckinBatchItem, CheckinBatchStatus, PublicManagedAccount } from '@agentboard/shared';
import { Badge, type BadgeTone } from '../ui/Badge';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';
import { cancelCheckinBatch, fetchCheckinBatch } from './checkinApi';
import { reasonLabel } from './accountCapabilities';

const ITEM_LABEL: Record<CheckinBatchItem['state'], string> = {
  queued: '排队中（未发起请求）',
  running: '已发出请求',
  succeeded: '签到成功',
  already_done: '今日已完成',
  failed: '失败',
  unknown: '结果未知',
  cancelled: '已取消',
};

const ITEM_TONE: Record<CheckinBatchItem['state'], BadgeTone> = {
  queued: 'neutral',
  running: 'blue',
  succeeded: 'green',
  already_done: 'green',
  failed: 'red',
  unknown: 'gray',
  cancelled: 'gray',
};

const BATCH_LABEL: Record<CheckinBatchStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '全部成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

const BATCH_TONE: Record<CheckinBatchStatus, BadgeTone> = {
  queued: 'neutral',
  running: 'blue',
  succeeded: 'green',
  partial: 'blue',
  failed: 'red',
  cancelled: 'gray',
};

const ACTIVE_STATES: CheckinBatchItem['state'][] = ['queued', 'running'];

export function isBatchActive(batch: CheckinBatch | null | undefined): boolean {
  if (!batch) return false;
  if (batch.finished_at !== null) return false;
  return (batch.items ?? []).some((item) => ACTIVE_STATES.includes(item.state));
}

export function CheckinBatchPanel({
  batchId,
  accounts,
  onClose,
}: {
  batchId: string;
  accounts: PublicManagedAccount[];
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const batchQuery = useQuery({
    queryKey: ['checkin-batch', batchId],
    queryFn: () => fetchCheckinBatch(batchId),
    refetchInterval: (query) => (isBatchActive(query.state.data as CheckinBatch | undefined) ? 700 : false),
  });
  const batch = batchQuery.data ?? null;
  const items = batch?.items ?? [];
  const queuedCount = items.filter((item) => item.state === 'queued').length;
  const runningCount = items.filter((item) => item.state === 'running').length;

  const nameOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.display_name ?? accountId.slice(0, 8);

  const cancel = useMutation({
    mutationFn: () => cancelCheckinBatch(batchId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkin-batch', batchId] }); },
  });

  return (
    <div data-testid="checkin-batch-panel" className="mt-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-neutral-900 dark:text-neutral-100">签到批次</span>
        {batch && <Badge tone={BATCH_TONE[batch.status]}>{BATCH_LABEL[batch.status]}</Badge>}
        <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400" data-testid="checkin-batch-id">{batchId.slice(0, 8)}…</span>
        {batch?.profile_local_day && <span className="text-neutral-500 dark:text-neutral-400">本地日 {batch.profile_local_day}</span>}
        {onClose && (
          <button type="button" className="ml-auto text-xs text-neutral-500 hover:underline dark:text-neutral-400" onClick={onClose}>
            收起
          </button>
        )}
      </div>

      {batchQuery.isError && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          批次读取失败：{batchQuery.error instanceof Error ? batchQuery.error.message : '未知错误'}
        </p>
      )}

      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={`${item.batch_id}-${item.account_id}`} data-testid={`checkin-item-${item.account_id}`} data-state={item.state} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="min-w-0 truncate text-neutral-800 dark:text-neutral-200">{nameOf(item.account_id)}</span>
            <Badge tone={ITEM_TONE[item.state]}>{ITEM_LABEL[item.state]}</Badge>
            {item.safe_error_code !== null && (
              <span data-testid={`checkin-item-error-${item.account_id}`} className="text-red-600 dark:text-red-400">
                {reasonLabel(item.safe_error_code)}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          data-testid="checkin-cancel"
          className={BUTTON_SECONDARY}
          disabled={queuedCount === 0 || cancel.isPending}
          title={queuedCount === 0 ? '没有处于排队中（尚未发出请求）的账号可取消' : `取消 ${queuedCount} 个排队项`}
          onClick={() => cancel.mutate()}
        >
          取消排队项
        </button>
        <span data-testid="checkin-cancel-hint" className="text-neutral-500 dark:text-neutral-400">
          {queuedCount === 0
            ? runningCount > 0 ? `有 ${runningCount} 个账号已发出请求，无法取消` : '没有可取消的排队项'
            : `可取消 ${queuedCount} 项${runningCount > 0 ? `；另有 ${runningCount} 项已发出请求` : ''}`}
        </span>
      </div>

      {cancel.data && (
        <p data-testid="checkin-cancel-result" className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          已取消 {cancel.data.cancelled.length} 项{cancel.data.running.length > 0 ? `；${cancel.data.running.length} 项已发出请求，未取消` : ''}
        </p>
      )}
      {cancel.isError && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          取消失败：{reasonLabel((cancel.error as { code?: string } | null)?.code ?? null)}
        </p>
      )}
    </div>
  );
}
