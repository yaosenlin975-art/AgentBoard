/**
 * 签到批次视图（ACC-09 / ACC-14）：逐账号展示 items[].state 与错误码，取消只对 queued 项生效。
 * 数据源 GET /api/checkin-runs/:id（含 items[]）；批次未终态时轮询。
 * ACC-14：额外读 `GET /api/account-operations?batch_id=`，把 workbuddy 猫猫旅行结果
 * （`operation.recovery_ref = travel=claimed|dispatched|already_done|failed:CODE`）挂到对应账号行上。
 * 取消接口是批次级（POST /api/checkin-runs/:id/cancel）：只取消仍 queued 的项，
 * running 项服务端回传在 running[]，界面如实提示「已发出请求，无法取消」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountOperation, CheckinBatch, CheckinBatchItem, CheckinBatchStatus, PublicManagedAccount } from '@agentboard/shared';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';
import { cancelCheckinBatch, fetchBatchOperations, fetchCheckinBatch } from './checkinApi';
import { hasReasonLabel, reasonLabel, travelFromRecoveryRef, type TravelView } from './accountCapabilities';

const ITEM_LABEL: Record<CheckinBatchItem['state'], string> = {
  queued: '排队中（未发起请求）',
  running: '已发出请求',
  succeeded: '签到成功',
  already_done: '今日已完成',
  failed: '失败',
  unknown: '结果未知',
  cancelled: '已取消',
};

/** UNSLOP（ACC-UI-05）：批次条目状态只用 ink 分级 + accent 表示需要关注 */
const ITEM_TONE: Record<CheckinBatchItem['state'], string> = {
  queued: 'text-ink-3',
  running: 'text-ink-2',
  succeeded: 'text-ink',
  already_done: 'text-ink-3',
  failed: 'bg-accent-soft font-medium text-accent',
  unknown: 'text-ink-3',
  cancelled: 'text-ink-3',
};

const BATCH_LABEL: Record<CheckinBatchStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '全部成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

/** UNSLOP（ACC-UI-05）：批次状态同样只用 ink 分级 + accent */
const BATCH_TONE: Record<CheckinBatchStatus, string> = {
  queued: 'text-ink-3',
  running: 'text-ink',
  succeeded: 'text-ink-2',
  partial: 'text-ink-2',
  failed: 'bg-accent-soft font-medium text-accent',
  cancelled: 'text-ink-3',
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

  // ACC-14：批次内 operation 记录（含 workbuddy 猫猫旅行的 recovery_ref）；批次未终态时随批次一起轮询
  const operationsQuery = useQuery({
    queryKey: ['batch-operations', batchId],
    queryFn: () => fetchBatchOperations(batchId),
    refetchInterval: () => (isBatchActive(batch) ? 700 : false),
  });
  const travelByAccount = new Map<string, TravelView>();
  for (const operation of (operationsQuery.data ?? []) as AccountOperation[]) {
    if (operation.operation !== 'checkin' || operation.account_id === null) continue;
    const travel = travelFromRecoveryRef(operation.recovery_ref);
    if (travel !== null) travelByAccount.set(operation.account_id, travel);
  }

  const nameOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.display_name ?? accountId.slice(0, 8);

  const cancel = useMutation({
    mutationFn: () => cancelCheckinBatch(batchId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkin-batch', batchId] }); },
  });

  return (
    <div data-testid="checkin-batch-panel" className="mt-2 rounded-xl border border-hairline bg-surface-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink">签到批次</span>
        {batch && <span className={`rounded-md px-1.5 py-0.5 text-xs ${BATCH_TONE[batch.status]}`}>{BATCH_LABEL[batch.status]}</span>}
        <span className="font-mono text-xs tabular-nums text-ink-3" data-testid="checkin-batch-id">{batchId.slice(0, 8)}…</span>
        {batch?.profile_local_day && <span className="tabular-nums text-xs text-ink-3">本地日 {batch.profile_local_day}</span>}
        {onClose && (
          <button type="button" className="ml-auto text-xs text-ink-3 hover:text-ink hover:underline" onClick={onClose}>
            收起
          </button>
        )}
      </div>

      {batchQuery.isError && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          批次读取失败：{batchQuery.error instanceof Error ? batchQuery.error.message : '未知错误'}
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {items.map((item) => {
          const travel = travelByAccount.get(item.account_id) ?? null;
          return (
            <li key={`${item.batch_id}-${item.account_id}`} data-testid={`checkin-item-${item.account_id}`} data-state={item.state} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-ink">{nameOf(item.account_id)}</span>
              <span className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${ITEM_TONE[item.state]}`}>{ITEM_LABEL[item.state]}</span>
              {/* 失败但没有留安全错误码时也要有人话，不能只剩一个「失败」 */}
              {item.state === 'failed' && item.safe_error_code === null && (
                <span data-testid={`checkin-item-error-${item.account_id}`} className="text-red-600 dark:text-red-400">原因未记录，请重试</span>
              )}
              {item.safe_error_code !== null && (
                <span data-testid={`checkin-item-error-${item.account_id}`} className="text-red-600 dark:text-red-400">
                  {reasonLabel(item.safe_error_code)}
                  {/* 未收录的码给中性文案，同时补一个技术码，便于排障；码本身不含凭据/请求 */}
                  {!hasReasonLabel(item.safe_error_code) && <span className="ml-1 font-mono text-[11px]">{item.safe_error_code}</span>}
                </span>
              )}
              {travel !== null && (
                <span data-testid={`checkin-item-travel-${item.account_id}`} data-travel={travel.status} className="text-xs text-ink-2">
                  猫猫旅行：{travel.label}
                  {travel.code !== null && <span className="ml-1 font-mono text-[11px] text-red-600 dark:text-red-400">{travel.code}</span>}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
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
