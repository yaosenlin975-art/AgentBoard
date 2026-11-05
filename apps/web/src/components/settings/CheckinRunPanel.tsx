/**
 * ACC-B3：单平台签到批次的右栏呈现（收敛 `PlatformRow` 的批次视图）。
 * 结构形态取 `Docs/prototypes/accounts-redesign-2026-11-04/b-console.html` 的 `.runPanel`，样式沿用 `--ab-*` 令牌：
 * - 吸顶批次条：批次短号 + 状态 + 进度（done/total，unknown 加 ?）+ 收起/展开；
 * - 账号级状态列表：display_name + 排队中 / 执行中 / 签到成功 / 今日已完成 / 结果未知（? 角标）/ 签到失败 / 已取消；
 * - 终态（succeeded / partial / failed / cancelled）：不渲染取消按钮，也不渲染「没有可取消的排队项」占位行；
 *   失败原因给中文主文案，技术码收进折叠层。
 *
 * sticky 依附点（读 DrawerPanel 层级确认）：`drawer-body`（`overflow-auto`）是右栏唯一滚动容器；
 * `accounts-detail` 与 `PlatformRow` 根节点都没有 overflow，`sticky top-0` 相对 drawer-body 生效；
 * `-mx-3 px-3` 抵消 drawer-body 的 `p-3`，吸顶时左右不留透缝。
 *
 * 完成口径（父卡硬规则，批次进度与平台指标同口径）：
 * succeeded / already_done 计入 done；unknown 计入 total 不计入 done 且带 ?；failed 落回未签到；
 * authorized 不是批次条目状态，只在平台今日指标（`summarizeCheckinToday`）里不计入完成。
 *
 * 跨平台一键签到（OneClickCheckin → CheckinBatchPanel）复用本文件的状态对照 / 进度口径 / 取消控制 / 失败原因渲染。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountOperation,
  CheckinBatch,
  CheckinBatchItem,
  CheckinBatchStatus,
  PublicManagedAccount,
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
const ITEM_DOT: Record<CheckinBatchItem['state'], string> = {
  queued: 'bg-ink-3/50',
  running: 'bg-ink',
  succeeded: 'bg-ink-2',
  already_done: 'bg-ink-2/60',
  failed: 'bg-accent',
  unknown: 'bg-ink-3',
  cancelled: 'bg-ink-3/50',
};

/** 批次是否仍在执行（有 queued/running 条目且未结束）；终态 = false */
export function isBatchActive(batch: CheckinBatch | null | undefined): boolean {
  if (!batch) return false;
  if (batch.finished_at !== null) return false;
  return (batch.items ?? []).some((item) => item.state === 'queued' || item.state === 'running');
}

export interface CheckinBatchProgress {
  /** 计入完成：succeeded + already_done */
  done: number;
  /** 结果未知：计入 total 不计入 done（展示加 ? 角标） */
  unknown: number;
  total: number;
}

/** 批次进度口径（父卡硬规则）：succeeded / already_done 计入 done；unknown 计入 total 不计入 done */
export function checkinBatchProgress(items: CheckinBatchItem[]): CheckinBatchProgress {
  return {
    done: items.filter((item) => item.state === 'succeeded' || item.state === 'already_done').length,
    unknown: items.filter((item) => item.state === 'unknown').length,
    total: items.length,
  };
}

/** 批次查询（未终态时 700ms 轮询）；查询键与一键签到共用，react-query 自动去重 */
export function useCheckinBatch(batchId: string) {
  return useQuery({
    queryKey: ['checkin-batch', batchId],
    queryFn: () => fetchCheckinBatch(batchId),
    refetchInterval: (query) => (isBatchActive(query.state.data as CheckinBatch | undefined) ? 700 : false),
  });
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

/**
 * 单平台批次吸顶呈现。`batchId` 变化时由调用方换 `key` 重挂（收起态随新批次重置为展开）。
 * 取消只对 queued 生效；running 项如实提示已发出请求、无法取消。
 */
export function CheckinRunPanel({
  batchId,
  accounts,
}: {
  batchId: string;
  accounts: PublicManagedAccount[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const batchQuery = useCheckinBatch(batchId);
  const batch = batchQuery.data ?? null;
  const items = batch?.items ?? [];
  const progress = checkinBatchProgress(items);
  const active = isBatchActive(batch);
  const travelByAccount = useCheckinBatchTravel(batchId, active);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const nameOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.display_name ?? accountId.slice(0, 8);

  return (
    <section data-testid="checkin-run-panel" data-active={active ? 'true' : 'false'} aria-label="签到批次" className="mb-1">
      {/* 吸顶批次条：依附 drawer-body 滚动容器（层级见文件头注释）；实底 + backdrop 防正文透出 */}
      <div
        data-testid="checkin-run-bar"
        className="sticky top-0 z-10 -mx-3 border-b border-hairline bg-surface-card/95 px-3 py-1.5 backdrop-blur"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span aria-hidden="true" className={`inline-block size-1.5 rounded-full ${active ? 'bg-accent motion-safe:animate-pulse' : 'bg-ink-3'}`} />
          <span className="font-medium text-ink">签到批次</span>
          {batch !== null && (
            <span data-testid="checkin-run-status" className={`rounded-md px-1.5 py-0.5 ${CHECKIN_BATCH_TONE[batch.status]}`}>
              {CHECKIN_BATCH_LABEL[batch.status]}
            </span>
          )}
          <span data-testid="checkin-run-id" className="font-mono text-xs tabular-nums text-ink-3">{batchId.slice(0, 8)}…</span>
          <span
            data-testid="checkin-run-progress"
            data-done={progress.done}
            data-total={progress.total}
            data-unknown={progress.unknown}
            title="succeeded/already_done 计入完成；unknown 标 ? 不计入"
            className="ml-auto font-semibold text-xs tabular-nums text-ink-2"
          >
            {progress.done}/{progress.total}{progress.unknown > 0 ? '?' : ''}
          </span>
          <button
            type="button"
            data-testid="checkin-run-toggle"
            aria-expanded={!collapsed}
            className="text-xs text-ink-3 hover:text-ink hover:underline"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
        {/* 进度条：done/total 百分比（unknown 留空档，与计数口径一致） */}
        <span data-testid="checkin-run-progressbar" className="mt-1 block h-0.5 overflow-hidden rounded-sm bg-surface-raised">
          <span
            className="block h-full bg-accent duration-300 transition-[width] motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </span>
      </div>

      {batchQuery.isError && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          批次读取失败：{batchQuery.error instanceof Error ? batchQuery.error.message : '未知错误'}
        </p>
      )}

      {!collapsed && (
        <div data-testid="checkin-run-body" className="mt-2">
          <ul data-testid="checkin-run-items" className="space-y-1.5">
            {items.map((item) => {
              const travel = travelByAccount.get(item.account_id) ?? null;
              return (
                <li
                  key={`${item.batch_id}-${item.account_id}`}
                  data-testid={`checkin-run-item-${item.account_id}`}
                  data-state={item.state}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${ITEM_DOT[item.state]}`} />
                  <span className="min-w-0 truncate text-ink">{nameOf(item.account_id)}</span>
                  <span className={`rounded-md px-1.5 py-0.5 tabular-nums ${CHECKIN_ITEM_TONE[item.state]}`}>
                    {CHECKIN_ITEM_LABEL[item.state]}
                    {item.state === 'unknown' && (
                      <span
                        data-testid={`checkin-run-item-unknown-${item.account_id}`}
                        title="结果未知，未自动重发；计入总数不计入完成"
                        className="ml-0.5 font-semibold"
                      >
                        ?
                      </span>
                    )}
                  </span>
                  {item.state === 'failed' && (
                    <CheckinItemError code={item.safe_error_code} testId={`checkin-run-item-error-${item.account_id}`} />
                  )}
                  {travel !== null && (
                    <CheckinItemTravel travel={travel} testId={`checkin-run-item-travel-${item.account_id}`} />
                  )}
                </li>
              );
            })}
          </ul>
          {/* 终态口径说明（原型 .b-run-note） */}
          {batch !== null && !active && (
            <p data-testid="checkin-run-note" className="mt-2 text-[11px] text-ink-3">
              成功与今日已完成计入完成；结果未知标 ? 不计入；失败落回未签到；授权中不算完成。
            </p>
          )}
          <CheckinCancelControls batchId={batchId} items={items} active={active} testPrefix="checkin-run" />
        </div>
      )}
    </section>
  );
}
