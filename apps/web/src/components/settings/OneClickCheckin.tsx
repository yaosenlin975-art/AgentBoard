/**
 * 一键签到（ACC-14）：顶部一个按钮，对三个平台的全部启用账号发起签到。
 *
 * 服务端 `POST /api/checkin-runs` 的批次边界是 `app_id`（`checkin_batch.app_id`，409 `CHECKIN_BATCH_IN_PROGRESS`
 * 也按 app 判定），因此「一键」= 一次点击为每个可签到的平台各建一个批次，并把各批次逐账号结果聚合在同一处展示；
 * 不新增端点、不改服务端契约。
 *
 * 后台执行时，workbuddy 批次还会带猫猫旅行结果（`CheckinBatchPanel` 读 operation.recovery_ref）。
 * 幂等：同一批账号的重试复用同一个 `Idempotency-Key`（服务端按 key 回放，不重复建批）。
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ManagedAppId } from '@agentboard/shared';
import { Badge } from '../ui/Badge';
import { BUTTON_PRIMARY } from '../ui/buttonStyles';
import type { AccountView } from './AccountCard';
import { CheckinBatchPanel } from './CheckinBatchPanel';
import { APP_LABEL, APP_ORDER, reasonLabel, unavailableLabel, type AccountsAppId, type CapabilityView } from './accountCapabilities';
import { createCheckinBatch } from './checkinApi';

export interface OneClickOutcome {
  app: AccountsAppId;
  kind: 'created' | 'conflict' | 'error' | 'skipped';
  batchId: string | null;
  code: string | null;
  message: string | null;
}

const KIND_LABEL: Record<OneClickOutcome['kind'], string> = {
  created: '已发起批次',
  conflict: '已有进行中的批次',
  error: '未发起',
  skipped: '跳过',
};

export function OneClickCheckin({
  accounts,
  capabilities,
  capabilityKnown,
}: {
  accounts: AccountView[];
  capabilities: Partial<Record<ManagedAppId, CapabilityView>>;
  capabilityKnown: boolean;
}) {
  const queryClient = useQueryClient();
  const [outcomes, setOutcomes] = useState<OneClickOutcome[] | null>(null);
  const [pending, setPending] = useState(false);
  /** `${app}:${sorted account ids}` → Idempotency-Key（同一批账号重试复用，换批换 key） */
  const idempotency = useRef<Map<string, string>>(new Map());

  const plan = APP_ORDER.map((app) => {
    const appAccounts = accounts.filter((account) => account.app_id === app && account.enabled !== false);
    const capability = capabilities[app] ?? null;
    const skipReason = !capabilityKnown
      ? '能力矩阵读取中'
      : capability === null
        ? '能力未知'
        : !capability.checkin
          ? (unavailableLabel(capability, 'checkin') ?? reasonLabel(capability.checkin_reason_code))
          : appAccounts.length === 0
            ? '该平台没有启用的账号'
            : null;
    return { app, accountIds: appAccounts.map((account) => account.id), skipReason };
  });
  const runnable = plan.filter((item) => item.skipReason === null);
  const totalAccounts = runnable.reduce((sum, item) => sum + item.accountIds.length, 0);

  const run = async (): Promise<void> => {
    setPending(true);
    setOutcomes(null);
    const results: OneClickOutcome[] = [];
    for (const item of plan) {
      if (item.skipReason !== null) {
        results.push({ app: item.app, kind: 'skipped', batchId: null, code: null, message: item.skipReason });
        continue;
      }
      const signature = `${item.app}:${[...item.accountIds].sort().join(',')}`;
      let key = idempotency.current.get(signature);
      if (key === undefined) {
        key = crypto.randomUUID();
        idempotency.current.set(signature, key);
      }
      try {
        const outcome = await createCheckinBatch({ app_id: item.app, account_ids: item.accountIds }, key);
        if (outcome.kind === 'created') {
          results.push({ app: item.app, kind: 'created', batchId: outcome.batch.id, code: null, message: null });
        } else if (outcome.kind === 'conflict') {
          results.push({ app: item.app, kind: 'conflict', batchId: outcome.batchId, code: outcome.code, message: outcome.message });
        } else {
          results.push({ app: item.app, kind: 'error', batchId: null, code: outcome.code, message: outcome.message });
        }
      } catch (error) {
        const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'NETWORK';
        results.push({ app: item.app, kind: 'error', batchId: null, code, message: error instanceof Error ? error.message : '网络错误' });
      }
    }
    setOutcomes(results);
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
  };

  const createdCount = (outcomes ?? []).filter((outcome) => outcome.kind === 'created').length;
  const conflictCount = (outcomes ?? []).filter((outcome) => outcome.kind === 'conflict').length;
  const visibleBatches = (outcomes ?? []).filter((outcome) => outcome.batchId !== null);

  return (
    <div className="mb-2 rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="accounts-one-click-checkin"
          className={BUTTON_PRIMARY}
          disabled={pending || runnable.length === 0}
          title={runnable.length === 0
            ? '没有可签到的平台：能力矩阵未就绪或全部平台签到不可用'
            : `为 ${runnable.length} 个平台共 ${totalAccounts} 个启用账号发起签到`}
          onClick={() => { void run(); }}
        >
          {pending ? '签到中…' : '一键签到'}
        </button>
        <span data-testid="accounts-one-click-plan" className="text-xs text-neutral-500 dark:text-neutral-400">
          {runnable.length === 0
            ? '当前没有可签到的平台'
            : `${runnable.length} 个平台 / ${totalAccounts} 个启用账号：${runnable.map((item) => APP_LABEL[item.app]).join('、')}`}
        </span>
      </div>

      {outcomes !== null && (
        <div data-testid="accounts-one-click-result" className="mt-2 space-y-1.5">
          <p data-testid="accounts-one-click-summary" className="text-xs text-neutral-700 dark:text-neutral-300">
            已发起 {createdCount} 个批次
            {conflictCount > 0 && `；${conflictCount} 个平台已有进行中的批次（未重复发起）`}
          </p>
          <ul className="space-y-1">
            {outcomes.map((outcome) => (
              <li key={outcome.app} data-testid={`accounts-one-click-outcome-${outcome.app}`} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-neutral-800 dark:text-neutral-200">{APP_LABEL[outcome.app]}</span>
                <Badge tone={outcome.kind === 'created' ? 'green' : outcome.kind === 'conflict' ? 'blue' : outcome.kind === 'skipped' ? 'gray' : 'red'}>
                  {KIND_LABEL[outcome.kind]}
                </Badge>
                {outcome.code !== null && <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{outcome.code}</span>}
                {outcome.message !== null && <span className="text-neutral-500 dark:text-neutral-400">{outcome.message}</span>}
                {outcome.batchId !== null && (
                  <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">批次 {outcome.batchId.slice(0, 8)}…</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {visibleBatches.map((outcome) => (
        <div key={`${outcome.app}-${outcome.batchId}`} data-testid={`accounts-one-click-batch-${outcome.app}`}>
          {outcome.batchId !== null && <CheckinBatchPanel batchId={outcome.batchId} accounts={accounts} />}
        </div>
      ))}
    </div>
  );
}
