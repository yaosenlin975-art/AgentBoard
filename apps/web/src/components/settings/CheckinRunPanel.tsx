/**
 * 签到批次共享层（ACC-B3；ACC-UI-PRUNE 起单平台吸顶批次条 `CheckinRunPanel` 已随单平台签到入口删除，
 * 本文件只保留跨平台一键签到结果条（OneClickCheckin → CheckinBatchPanel）复用的共享件）：
 * - 状态/条目中文对照与配色（CHECKIN_BATCH_LABEL / CHECKIN_BATCH_TONE / CHECKIN_ITEM_LABEL / CHECKIN_ITEM_TONE）；
 * - 批次查询与旅行结果轮询（useCheckinBatch / useCheckinBatchTravel / useCancelCheckinBatch / isBatchActive）；
 * - 失败原因与取消控制（CheckinItemError / CheckinItemTravel / CheckinCancelControls）。
 * - 终态（succeeded / partial / failed / cancelled）不渲染取消按钮，也不渲染「没有可取消的排队项」占位行；
 *   失败原因给中文主文案，技术码收进折叠层。
 *
 * 完成口径（父卡硬规则）：succeeded / already_done 计入 done；unknown 计入 total 不计入 done；
 * failed 落回未签到；authorized 不是批次条目状态，只在平台今日指标（`summarizeCheckinToday`）里不计入完成。
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountOperation,
  CheckinBatch,
  CheckinBatchItem,
  CheckinBatchStatus,
} from '@agentboard/shared';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';
import { cancelCheckinBatch, fetchBatchOperations, fetchCheckinBatch } from './checkinApi';
import { reasonLabel, travelFromRecoveryRef, type TravelView } from './accountCapabilities';

/** 批次状态中文（终态三种：全部成功 / 部分成功 / 失败；另有排队中 / 进行中 / 已取消） */
export const CHECKIN_BATCH_LABEL: Record<CheckinBatchStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '全部成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

/** UNSLOP（ACC-UI-05）：批次状态只用 ink 分级 + accent（需要关注），不引入新色相 */
export const CHECKIN_BATCH_TONE: Record<CheckinBatchStatus, string> = {
  queued: 'text-ink-3',
  running: 'text-ink',
  succeeded: 'text-ink-2',
  partial: 'text-ink-2',
  failed: 'bg-accent-soft font-medium text-accent',
  cancelled: 'text-ink-3',
};

/** 账号级状态中文对照（与 AccountCard 最近签到的 ACC-B2 映射同口径；排队中/执行中为批次专有中间态） */
export const CHECKIN_ITEM_LABEL: Record<CheckinBatchItem['state'], string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '签到成功',
  already_done: '今日已完成',
  failed: '签到失败',
  unknown: '结果未知',
  cancelled: '已取消',
};

/** UNSLOP（ACC-UI-05）：条目状态同样只用 ink 分级 + accent */
export const CHECKIN_ITEM_TONE: Record<CheckinBatchItem['state'], string> = {
  queued: 'text-ink-3',
  running: 'text-ink-2',
  succeeded: 'text-ink',
  already_done: 'text-ink-3',
  failed: 'bg-accent-soft font-medium text-accent',
  unknown: 'text-ink-3',
  cancelled: 'text-ink-3',
};

/** 状态点（单色相：ink 分级表达进度深浅，accent 只给失败） */

/** 批次是否仍在执行（有 queued/running 条目且未结束）；终态 = false */
export function isBatchActive(batch: CheckinBatch | null | undefined): boolean {
  if (!batch) return false;
  if (batch.finished_at !== null) return false;
  return (batch.items ?? []).some((item) => item.state === 'queued' || item.state === 'running');
}

/** 批次查询（未终态时 700ms 轮询）；查询键与一键签到共用，react-query 自动去重 */
export function useCheckinBatch(batchId: string) {
  const queryClient = useQueryClient();
  const batchQuery = useQuery({
    queryKey: ['checkin-batch', batchId],
    queryFn: () => fetchCheckinBatch(batchId),
    refetchInterval: (query) => (isBatchActive(query.state.data as CheckinBatch | undefined) ? 700 : false),
  });

  useEffect(() => {
    if (batchQuery.data?.finished_at == null) return;
    // A quota query with no cached data can be joined by invalidateQueries while its first request is pending.
    // Cancel it first so the post-batch read starts fresh and a late old snapshot cannot replace it.
    void queryClient.cancelQueries({ queryKey: ['managed-account-quotas'] }).then(() => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['managed-accounts'] }),
      queryClient.invalidateQueries({ queryKey: ['managed-account-quotas'] }),
    ]));
  }, [batchId, batchQuery.data?.finished_at, queryClient]);

  return batchQuery;
}

/** 批次内 operation 记录（ACC-14：workbuddy 猫猫旅行结果挂在 recovery_ref）；未终态时随批次一起轮询 */
export function useCheckinBatchTravel(batchId: string, active: boolean): Map<string, TravelView> {
  const operationsQuery = useQuery({
    queryKey: ['batch-operations', batchId],
    queryFn: () => fetchBatchOperations(batchId),
    refetchInterval: () => (active ? 700 : false),
  });
  const travelByAccount = new Map<string, TravelView>();
  for (const operation of (operationsQuery.data ?? []) as AccountOperation[]) {
    if (operation.operation !== 'checkin' || operation.account_id === null) continue;
    const travel = travelFromRecoveryRef(operation.recovery_ref);
    if (travel !== null) travelByAccount.set(operation.account_id, travel);
  }
  return travelByAccount;
}

export function useCancelCheckinBatch(batchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelCheckinBatch(batchId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkin-batch', batchId] }); },
  });
}

/**
 * 条目失败原因：中文主文案（已知码给原因，未收录码给中性文案），原始码收进「技术码」折叠层，
 * 主文案位置不出现裸码。无安全码给兜底文案（不留一个光秃秃的「失败」）。
 */
export function CheckinItemError({ code, testId }: { code: string | null; testId: string }) {
  if (code === null) {
    return <span data-testid={testId} className="text-red-600 dark:text-red-400">原因未记录，请重试</span>;
  }
  return (
    <span data-testid={testId} className="inline-flex flex-wrap items-center gap-x-1 text-red-600 dark:text-red-400">
      {reasonLabel(code)}
      <details data-testid={`${testId}-code`} className="text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
        <summary className="cursor-pointer select-none">技术码</summary>
        <code className="font-mono">{code}</code>
      </details>
    </span>
  );
}

/** 猫猫旅行结果行（ACC-14）：已领取 / 已派出 / 今日已完成 / 失败（带安全码） */
export function CheckinItemTravel({ travel, testId }: { travel: TravelView; testId: string }) {
  return (
    <span data-testid={testId} data-travel={travel.status} className="text-xs text-ink-2">
      猫猫旅行：{travel.label}
      {travel.code !== null && <span className="ml-1 font-mono text-[11px] text-red-600 dark:text-red-400">{travel.code}</span>}
    </span>
  );
}

/**
 * 取消控制（批次级 POST /api/checkin-runs/:id/cancel，只取消仍 queued 的项）。
 * 仅在批次执行中渲染；终态整块不渲染（无取消按钮、无「没有可取消的排队项」死占位行）。
 */
export function CheckinCancelControls({
  batchId,
  items,
  active,
  testPrefix = 'checkin',
}: {
  batchId: string;
  items: CheckinBatchItem[];
  active: boolean;
  testPrefix?: string;
}) {
  const cancel = useCancelCheckinBatch(batchId);
  if (!active) return null;
  const queuedCount = items.filter((item) => item.state === 'queued').length;
  const runningCount = items.filter((item) => item.state === 'running').length;
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          data-testid={`${testPrefix}-cancel`}
          className={BUTTON_SECONDARY}
          disabled={queuedCount === 0 || cancel.isPending}
          title={queuedCount === 0 ? '没有处于排队中（尚未发出请求）的账号可取消' : `取消 ${queuedCount} 个排队项`}
          onClick={() => cancel.mutate()}
        >
          取消排队项
        </button>
        {(queuedCount > 0 || runningCount > 0) && (
          <span data-testid={`${testPrefix}-cancel-hint`} className="text-neutral-500 dark:text-neutral-400">
            {queuedCount > 0
              ? `可取消 ${queuedCount} 项${runningCount > 0 ? `；另有 ${runningCount} 项已发出请求` : ''}`
              : `有 ${runningCount} 个账号已发出请求，无法取消`}
          </span>
        )}
      </div>
      {cancel.data && (
        <p data-testid={`${testPrefix}-cancel-result`} className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          已取消 {cancel.data.cancelled.length} 项{cancel.data.running.length > 0 ? `；${cancel.data.running.length} 项已发出请求，未取消` : ''}
        </p>
      )}
      {cancel.isError && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          取消失败：{reasonLabel((cancel.error as { code?: string } | null)?.code ?? null)}
        </p>
      )}
    </>
  );
}
