/**
 * 单个托管账号卡（ACC-08 / ACC-09）：展示脱敏元数据 + 切换/签到。
 * 能力来自服务端能力矩阵（由 AccountsPanel 传入），前端不维护能力副本。
 * 不展示 identity_hash / 快照引用 / 凭据引用 / token / 路径；标识只显示服务端给的 identity_hint（uid 哈希前 8 位）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AccountOperation, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import { AccountOperationStatus, isTerminalState } from './AccountOperationStatus';
import { APP_LABEL, reasonCodeOf, reasonLabel, unavailableLabel, unavailableReason, type CapabilityView } from './accountCapabilities';

export type AccountView = PublicManagedAccount & { is_current: boolean | null };

const REGION_LABEL: Record<AccountView['service_region'], string> = { cn: '国内', global: '国际', unknown: '区域未知' };
const CHECKIN_CAPABILITY_LABEL: Record<AccountView['checkin_capability'], string> = {
  supported: '签到可用',
  unsupported: '签到不可用',
  unknown: '签到能力未知',
};

export function AccountCard({
  account,
  capability,
  onCheckin,
}: {
  account: AccountView;
  capability: CapabilityView | null;
  onCheckin?: () => void;
}) {
  const app = account.app_id as ManagedAppId;
  const [confirming, setConfirming] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMutation = useMutation({
    mutationFn: () => api.post<{ operation_id: string; operation: AccountOperation }>(`/api/managed-accounts/${account.id}/switch`, {}),
    onSuccess: (result) => {
      setError(null);
      setConfirming(false);
      setOperationId(result.operation_id);
    },
    onError: (e) => {
      setConfirming(false);
      setError(`${reasonLabel(reasonCodeOf(e))}：${e instanceof Error ? e.message : '切换失败'}`);
      setOperationId(null);
    },
  });

  const operationQuery = useQuery({
    queryKey: ['account-operation', operationId],
    queryFn: () => api.get<AccountOperation>(`/api/account-operations/${operationId}`),
    enabled: operationId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as AccountOperation | undefined;
      if (!data) return 500;
      return isTerminalState(data.state) ? false : 500;
    },
  });

  const operation = operationQuery.data ?? null;
  const needsRecovery = operation?.state === 'recovery_required';
  useEffect(() => {
    if (needsRecovery) setFrozen(true);
  }, [needsRecovery]);

  const switchBlocked = capability?.switch !== true || account.is_current === true || frozen;
  const switchTitle = capability?.switch !== true
    ? `${APP_LABEL[app]}：${unavailableLabel(capability, 'switch') ?? '切换不可用'}（${unavailableReason(capability, 'switch') ?? '能力未知'}）`
    : account.is_current === true
      ? '该账号已是当前账号'
      : frozen
        ? '上次切换需要恢复，已冻结该账号的切换'
        : '切换到该账号';
  const checkinEnabled = capability?.checkin === true && onCheckin !== undefined;

  return (
    <div data-testid={`accounts-card-${account.id}`} className="rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{account.display_name}</span>
        <span data-testid={`accounts-current-${account.id}`}>
          {account.is_current === true
            ? <Badge tone="green">当前账号</Badge>
            : account.is_current === false
              ? <Badge tone="neutral">非当前</Badge>
              : <Badge tone="gray">当前身份未知</Badge>}
        </span>
        <Badge tone="blue">{REGION_LABEL[account.service_region]}</Badge>
        <Badge tone={account.checkin_capability === 'supported' ? 'green' : account.checkin_capability === 'unsupported' ? 'neutral' : 'gray'}>
          {CHECKIN_CAPABILITY_LABEL[account.checkin_capability]}
        </Badge>
      </div>

      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
        <dt>标识</dt><dd data-testid={`accounts-hint-${account.id}`} className="truncate font-mono">{account.identity_hint ?? '未提供'}</dd>
        <dt>实例</dt><dd className="truncate">{account.client_instance_id.slice(0, 12)}…</dd>
        <dt>快照</dt><dd>v{account.client_snapshot_version}</dd>
        <dt>最近签到</dt><dd>{account.last_checkin_day ?? '—'}{account.last_checkin_status ? ` · ${account.last_checkin_status}` : ''}</dd>
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`accounts-switch-${account.id}`}
          className={BUTTON_PRIMARY}
          disabled={switchBlocked || switchMutation.isPending}
          title={switchTitle}
          onClick={() => { setError(null); setConfirming(true); }}
        >
          切换到此账号
        </button>
        <button
          type="button"
          data-testid={`accounts-checkin-${account.id}`}
          className={BUTTON_SECONDARY}
          disabled={!checkinEnabled}
          title={checkinEnabled ? '为该账号发起签到' : `${unavailableLabel(capability, 'checkin') ?? '签到不可用'}（${unavailableReason(capability, 'checkin') ?? '能力未知'}）`}
          onClick={() => { if (checkinEnabled) onCheckin?.(); }}
        >
          签到
        </button>
        {account.enabled === false && <Badge tone="red">已停用（只读）</Badge>}
      </div>

      {confirming && (
        <div data-testid="accounts-switch-confirm" role="group" aria-label="确认切换账号" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p>确认切换到「{account.display_name}」？切换会重启目标客户端，进行中的会话可能中断。</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button type="button" data-testid="accounts-switch-confirm-yes" className={BUTTON_PRIMARY} disabled={switchMutation.isPending} onClick={() => switchMutation.mutate()}>
              确认切换
            </button>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
      )}

      {error !== null && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {operationId !== null && <AccountOperationStatus testId={`accounts-op-${account.id}`} operation={operation} />}
    </div>
  );
}


