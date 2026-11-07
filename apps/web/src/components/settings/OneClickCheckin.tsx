/**
 * 一键签到（ACC-14 / ACC-HEADER）：按钮放在账号管理最上方标题行右端，结果在额度区下方展示。
 *
 * 服务端 `POST /api/checkin-runs` 的批次边界是 `app_id`（`checkin_batch.app_id`，409 `CHECKIN_BATCH_IN_PROGRESS`
 * 也按 app 判定），因此「一键」= 一次点击为每个可签到的平台各建一个批次，并把各批次逐账号结果聚合在同一处展示；
 * 不新增端点、不改服务端契约。
 *
 * ACC-HEADER 拆成三块以便按钮上移：`useOneClickCheckin`（状态/动作）、`OneClickCheckinButton`（标题行按钮）、
 * `OneClickCheckinResults`（结果与批次面板）；`OneClickCheckin` 保留为组合用法（等价旧 DOM 结构）。
 * 页面只保留一份状态，按钮与结果共用同一个 hook 返回值。
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ManagedAppId } from '@agentboard/shared';
import { Badge } from '../ui/Badge';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import type { AccountView } from './AccountCard';
import { CheckinBatchPanel } from './CheckinBatchPanel';
import { APP_LABEL, APP_ORDER, appLabel, checkinParticipation, reasonLabel, unavailableLabel, type AccountsAppId, type CapabilityView } from './accountCapabilities';
import { createCheckinBatch } from './checkinApi';

/** ACC-CHECKIN：一键签到跳过的账号（缺凭据/不支持签到/已停用），需在结果里逐条列出 */
export interface OneClickSkippedAccount {
  id: string;
  name: string;
  reason: string;
}

export interface OneClickOutcome {
  app: AccountsAppId;
  kind: 'created' | 'conflict' | 'error' | 'skipped';
  batchId: string | null;
  code: string | null;
  message: string | null;
  skippedAccounts: OneClickSkippedAccount[];
  /** 该平台发起时被跳过的账号总数（无论批次是否成功） */
  skippedAccountCount: number;
}

/** UNSLOP（ACC-UI-05）：批次结果只用 ink 分级 + 一处 accent（需要关注） */
const KIND_TONE: Record<OneClickOutcome['kind'], string> = {
  created: 'text-ink',
  conflict: 'text-ink-2',
  skipped: 'text-ink-3',
  error: 'bg-accent-soft font-medium text-accent',
};
const KIND_LABEL: Record<OneClickOutcome['kind'], string> = {
  created: '已发起批次',
  conflict: '已有进行中的批次',
  error: '未发起',
  skipped: '跳过',
};

export interface OneClickCheckinController {
  accounts: AccountView[];
  pending: boolean;
  runnableCount: number;
  totalAccounts: number;
  runnableLabels: string[];
  /** 因缺少签到凭据/不可签到被跳过的账号数（含无可用平台的账号） */
  skippedAccountCount: number;
  outcomes: OneClickOutcome[] | null;
  run: () => void;
}

export function useOneClickCheckin({
  accounts,
  capabilities,
  capabilityKnown,
}: {
  accounts: AccountView[];
  capabilities: Partial<Record<ManagedAppId, CapabilityView>>;
  capabilityKnown: boolean;
}): OneClickCheckinController {
  const queryClient = useQueryClient();
  const [outcomes, setOutcomes] = useState<OneClickOutcome[] | null>(null);
  const [pending, setPending] = useState(false);
  /** `${app}:${sorted account ids}` → Idempotency-Key（同一批账号重试复用，换批换 key） */
  const idempotency = useRef<Map<string, string>>(new Map());

  const plan = APP_ORDER.map((app) => {
    const appAccounts = accounts.filter((account) => account.app_id === app && account.enabled !== false);
    const capability = capabilities[app] ?? null;
    const platformSkip = !capabilityKnown
      ? '能力矩阵读取中'
      : capability === null
        ? '能力未知'
        : !capability.checkin
          ? (unavailableLabel(capability, 'checkin') ?? reasonLabel(capability.checkin_reason_code))
          : null;
    if (platformSkip !== null) return { app, accountIds: [] as string[], skippedAccounts: [] as OneClickSkippedAccount[], skipReason: platformSkip };
    // 平台可用时再按账号判定：缺签到凭据/不支持签到的账号不提交进批次
    const evaluated = appAccounts.map((account) => ({ account, participation: checkinParticipation(account, capability) }));
    const skippedAccounts = evaluated
      .filter(({ participation }) => !participation.participates)
      .map(({ account, participation }) => ({ id: account.id, name: account.display_name, reason: participation.reason ?? '不可签到' }));
    const accountIds = evaluated.filter(({ participation }) => participation.participates).map(({ account }) => account.id);
    const onlySkipped = skippedAccounts.length === 1 ? skippedAccounts[0] : undefined;
    const skipReason = appAccounts.length === 0
      ? '该平台没有启用的账号'
      : accountIds.length === 0
        ? (onlySkipped?.reason ?? '该平台没有可签到的账号')
        : null;
    return { app, accountIds, skippedAccounts, skipReason };
  });
  const runnable = plan.filter((item) => item.skipReason === null);
  const totalAccounts = runnable.reduce((sum, item) => sum + item.accountIds.length, 0);
  const skippedAccountCount = plan.reduce((sum, item) => sum + item.skippedAccounts.length, 0);

  const run = async (): Promise<void> => {
    setPending(true);
    setOutcomes(null);
    const results: OneClickOutcome[] = [];
    for (const item of plan) {
      if (item.skipReason !== null) {
        results.push({
          app: item.app, kind: 'skipped', batchId: null, code: null, message: item.skipReason,
          skippedAccounts: item.skippedAccounts, skippedAccountCount: item.skippedAccounts.length,
        });
        continue;
      }
      const skippedMeta = { skippedAccounts: item.skippedAccounts, skippedAccountCount: item.skippedAccounts.length };
      const signature = `${item.app}:${[...item.accountIds].sort().join(',')}`;
      let key = idempotency.current.get(signature);
      if (key === undefined) {
        key = crypto.randomUUID();
        idempotency.current.set(signature, key);
      }
      try {
        const outcome = await createCheckinBatch({ app_id: item.app, account_ids: item.accountIds }, key);
        if (outcome.kind === 'created') {
          results.push({ app: item.app, kind: 'created', batchId: outcome.batch.id, code: null, message: null, ...skippedMeta });
        } else if (outcome.kind === 'conflict') {
          results.push({ app: item.app, kind: 'conflict', batchId: outcome.batchId, code: outcome.code, message: outcome.message, ...skippedMeta });
        } else {
          results.push({ app: item.app, kind: 'error', batchId: null, code: outcome.code, message: outcome.message, ...skippedMeta });
        }
      } catch (error) {
        const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'NETWORK';
        results.push({ app: item.app, kind: 'error', batchId: null, code, message: error instanceof Error ? error.message : '网络错误', ...skippedMeta });
      }
    }
    setOutcomes(results);
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
  };

  return {
    accounts,
    pending,
    runnableCount: runnable.length,
    totalAccounts,
    runnableLabels: runnable.map((item) => appLabel(item.app)),
    skippedAccountCount,
    outcomes,
    run: () => { void run(); },
  };
}

/** 标题行右端的「一键签到」按钮（`accounts-one-click-checkin` testid 保持不变；ACC-UI-TOPBAR 起在标题栏用次级样式，不抢关闭） */
export function OneClickCheckinButton({ controller, variant = 'primary' }: { controller: OneClickCheckinController; variant?: 'primary' | 'secondary' }) {
  const { pending, runnableCount, totalAccounts, skippedAccountCount, run } = controller;
  return (
    <button
      type="button"
      data-testid="accounts-one-click-checkin"
      className={variant === 'primary' ? BUTTON_PRIMARY : BUTTON_SECONDARY}
      disabled={pending || runnableCount === 0}
      title={runnableCount === 0
        ? (skippedAccountCount > 0
            ? `没有可签到的平台：${skippedAccountCount} 个账号缺少签到凭据或不可签到`
            : '没有可签到的平台：能力矩阵未就绪或全部平台签到不可用')
        : `为 ${runnableCount} 个平台共 ${totalAccounts} 个启用账号发起签到${skippedAccountCount > 0 ? `（跳过 ${skippedAccountCount} 个）` : ''}`}
      onClick={run}
    >
      {pending ? '签到中…' : '一键签到'}
    </button>
  );
}

/** 计划摘要（`accounts-one-click-plan`） */
export function OneClickCheckinPlan({ controller }: { controller: OneClickCheckinController }) {
  const { runnableCount, totalAccounts, runnableLabels, skippedAccountCount } = controller;
  return (
    <span data-testid="accounts-one-click-plan" className="tabular-nums text-xs text-ink-3">
      {runnableCount === 0
        ? '当前没有可签到的平台'
        : `${runnableCount} 个平台 / ${totalAccounts} 个可签到账号：${runnableLabels.join('、')}`}
      {skippedAccountCount > 0 && `；跳过 ${skippedAccountCount} 个账号（缺少签到凭据或不可签到）`}
    </span>
  );
}

/** 逐平台结果与批次面板（`accounts-one-click-*` testid 全部保持不变） */
export function OneClickCheckinResults({ controller }: { controller: OneClickCheckinController }) {
  const { outcomes, accounts } = controller;
  if (outcomes === null) return null;
  const createdCount = outcomes.filter((outcome) => outcome.kind === 'created').length;
  const conflictCount = outcomes.filter((outcome) => outcome.kind === 'conflict').length;
  const visibleBatches = outcomes.filter((outcome) => outcome.batchId !== null);
  return (
    <div data-testid="accounts-one-click-result" className="space-y-2">
      <p data-testid="accounts-one-click-summary" className="text-xs text-ink-2">
        已发起 {createdCount} 个批次
        {conflictCount > 0 && `；${conflictCount} 个平台已有进行中的批次（未重复发起）`}
      </p>
      <ul className="space-y-1.5">
        {outcomes.map((outcome) => (
          <li key={outcome.app} data-testid={`accounts-one-click-outcome-${outcome.app}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 truncate text-ink">{appLabel(outcome.app)}</span>
            {/* 单色相状态：created=ink / conflict=ink-2 / skipped=ink-3 / error=accent（只是需要关注，不是另一种色相） */}
            <span className={`rounded-md px-1.5 py-0.5 text-xs ${KIND_TONE[outcome.kind]}`}>{KIND_LABEL[outcome.kind]}</span>
            {outcome.code !== null && <span className="font-mono text-xs text-ink-3">{outcome.code}</span>}
            {outcome.message !== null && <span className="text-ink-3">{outcome.message}</span>}
            {outcome.skippedAccounts.length > 0 && (
              <span data-testid={`accounts-one-click-skipped-${outcome.app}`} className="text-ink-3">
                跳过 {outcome.skippedAccounts.length} 个账号：{outcome.skippedAccounts.map(item => `${item.name}（${item.reason}）`).join('、')}
              </span>
            )}
            {outcome.batchId !== null && (
              <span className="font-mono text-xs tabular-nums text-ink-3">批次 {outcome.batchId.slice(0, 8)}…</span>
            )}
          </li>
        ))}
      </ul>
      {visibleBatches.map((outcome) => (
        <div key={`${outcome.app}-${outcome.batchId}`} data-testid={`accounts-one-click-batch-${outcome.app}`}>
          {outcome.batchId !== null && <CheckinBatchPanel batchId={outcome.batchId} accounts={accounts} />}
        </div>
      ))}
    </div>
  );
}

/** 组合用法（等价 ACC-14 的旧 DOM 结构）：按钮 + 计划 + 结果放在一个带边框的块里 */
export function OneClickCheckin(props: {
  accounts: AccountView[];
  capabilities: Partial<Record<ManagedAppId, CapabilityView>>;
  capabilityKnown: boolean;
}) {
  const controller = useOneClickCheckin(props);
  return (
    <div className="mb-3 rounded-2xl border border-hairline bg-surface-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <OneClickCheckinButton controller={controller} />
        <OneClickCheckinPlan controller={controller} />
      </div>
      <div className="mt-2">
        <OneClickCheckinResults controller={controller} />
      </div>
    </div>
  );
}
