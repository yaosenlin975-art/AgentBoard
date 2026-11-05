/**
 * 签到批次视图（ACC-09 / ACC-14）：跨平台一键签到结果条里的逐平台批次卡片
 * （`accounts-one-click-batch-*` 内，`accounts-one-click-results` 原入口位置不变）。
 *
 * ACC-B3 收敛：状态中文对照 / 完成口径 / 取消控制 / 失败原因（中文 + 技术码折叠）统一在
 * `CheckinRunPanel.tsx`，本组件只保留平铺呈现；文案口径与右栏吸顶批次条完全一致。
 * 数据源 GET /api/checkin-runs/:id（含 items[]），批次未终态时轮询；ACC-14 猫猫旅行结果挂在
 * `GET /api/account-operations?batch_id=` 的 operation.recovery_ref 上。
 * 取消接口是批次级（POST /api/checkin-runs/:id/cancel）：只取消仍 queued 的项，running 项
 * 服务端回传在 running[]，界面如实提示「已发出请求，无法取消」；终态整块不渲染取消行（无死占位）。
 */
import type { CheckinBatchItem, PublicManagedAccount } from '@agentboard/shared';
import {
  CHECKIN_BATCH_LABEL,
  CHECKIN_BATCH_TONE,
  CHECKIN_ITEM_LABEL,
  CHECKIN_ITEM_TONE,
  CheckinCancelControls,
  CheckinItemError,
  CheckinItemTravel,
  isBatchActive,
  useCheckinBatch,
  useCheckinBatchTravel,
} from './CheckinRunPanel';

export function CheckinBatchPanel({
  batchId,
  accounts,
  onClose,
}: {
  batchId: string;
  accounts: PublicManagedAccount[];
  onClose?: () => void;
}) {
  const batchQuery = useCheckinBatch(batchId);
  const batch = batchQuery.data ?? null;
  const items = batch?.items ?? [];
  const active = isBatchActive(batch);
  const travelByAccount = useCheckinBatchTravel(batchId, active);

  const nameOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.display_name ?? accountId.slice(0, 8);

  return (
    <div data-testid="checkin-batch-panel" className="mt-2 rounded-xl border border-hairline bg-surface-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink">签到批次</span>
        {batch && (
          <span className={`rounded-md px-1.5 py-0.5 text-xs ${CHECKIN_BATCH_TONE[batch.status]}`}>
            {CHECKIN_BATCH_LABEL[batch.status]}
          </span>
        )}
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
            <li
              key={`${item.batch_id}-${item.account_id}`}
              data-testid={`checkin-item-${item.account_id}`}
              data-state={item.state}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="min-w-0 truncate text-ink">{nameOf(item.account_id)}</span>
              <span className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${CHECKIN_ITEM_TONE[item.state]}`}>
                {CHECKIN_ITEM_LABEL[item.state]}
              </span>
              {item.state === 'failed' && (
                <CheckinItemError code={item.safe_error_code} testId={`checkin-item-error-${item.account_id}`} />
              )}
              {travel !== null && (
                <CheckinItemTravel travel={travel} testId={`checkin-item-travel-${item.account_id}`} />
              )}
            </li>
          );
        })}
      </ul>

      <CheckinCancelControls batchId={batchId} items={items} active={active} testPrefix="checkin" />
    </div>
  );
}
