/**
 * 单个托管账号卡（ACC-08 / ACC-09 / ACC-14 / ACC-DEL-02）：展示脱敏元数据 + 切换/签到/删除。
 * 能力来自服务端能力矩阵（由 AccountsPanel 传入），前端不维护能力副本。
 *
 * ACC-DEL-02 删除是两步流：点「删除」→ 行内「确认删除」（3 秒未确认自动收回）→ `DELETE /api/managed-accounts/:id`
 * → 成功失效重拉列表；失败只给中文主文案，裸码进 title。删除只清 AgentBoard 记录与本机 DPAPI 快照，
 * 不退出客户端登录，所以 `is_current=true` 不阻塞删除，仅在确认行追加警示。
 *
 * ACC-14 两个「当前」必须分开表达：
 * - **客户端当前**（`accounts-client-current-*`）= 桌面客户端此刻登录的账号（服务端 `is_current`，来自 capture/switch 领域）；
 * - **签到当前**（`accounts-checkin-current-*`）= 一键签到会提交的账号（app 签到能力可用 + 账号启用 + 账号签到能力非 unsupported）；
 * 两者可以不同，不合并成一个「当前」。
 *
 * 不展示 identity_hash / 快照引用 / 凭据引用 / token / 路径；标识只显示服务端给的 identity_hint（uid 哈希前 8 位）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountOperation, PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
/** UNSLOP（ACC-UI-05）：本卡片内的按钮统一走令牌，chrome 只有一个强调色 */
const BTN_BASE =
  'rounded-lg border border-transparent px-2.5 py-1 text-xs font-medium ab-transition disabled:cursor-not-allowed disabled:opacity-40';
const BTN_QUIET =
  'rounded-lg border border-hairline bg-surface-card px-2.5 py-1 text-xs text-ink ab-transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40';
const BTN_DANGER =
  'rounded-lg border border-hairline bg-surface-card px-2.5 py-1 text-xs font-medium text-red-600 ab-transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400';
import { AccountOperationStatus, isTerminalState } from './AccountOperationStatus';
import {
  ACCOUNT_BUSY_REASON,
  canToggleEnabled,
  capabilityBadge,
  checkinParticipation,
  reasonCodeOf,
  reasonLabel,
  unavailableLabel,
  unavailableReason,
  type CapabilityView,
} from './accountCapabilities';

export type AccountView = PublicManagedAccount & { is_current: boolean | null };

/** 删除二次确认的窗口：3 秒内不点「确认删除」就自动收回（设计 §7） */
const DELETE_CONFIRM_WINDOW_MS = 3_000;

/** 删除失败的中文口径；裸码不进主文案，只进 title（ACC-REASON-01） */
const DELETE_FAIL_LABEL: Record<string, string> = {
  ACCOUNT_BUSY: '账号正忙，暂时无法删除',
  CHECKIN_AUTHORIZATION_EXISTS: '该账号已有进行中的签到授权，暂时无法删除',
  RECOVERY_REQUIRED: '上次切换仍需恢复，恢复完成前不能删除',
};

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
  muted = false,
}: {
  account: AccountView;
  capability: CapabilityView | null;
  onCheckin?: () => void;
  /** 能力矩阵未就绪（加载中或失败）：删除这类写操作一并禁用，与其余写操作同口径 */
  muted?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteErrorCode, setDeleteErrorCode] = useState<string | null>(null);
  const queryClient = useQueryClient();

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

  const deleteMutation = useMutation({
    mutationFn: () => api.del<void>(`/api/managed-accounts/${account.id}`),
    onSuccess: () => {
      // 删除成功只重拉列表：行由服务端结果自然消失，不做本地乐观移除
      setDeleteConfirming(false);
      setDeleteErrorCode(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (e) => {
      setDeleteConfirming(false);
      setDeleteErrorCode(reasonCodeOf(e));
    },
  });

  useEffect(() => {
    if (!deleteConfirming || deleteMutation.isPending) return;
    const timer = setTimeout(() => setDeleteConfirming(false), DELETE_CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [deleteConfirming, deleteMutation.isPending]);

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

  // ACC-KB-A2W：能力徽标三态互斥（蓝标 / 灰标由 capabilityBadge 的 showBlue/showGray 决定，不会同时出）
  const badge = capabilityBadge(capability);
  // 启停可点判定：本卡已知的操作（切换进行中）与服务端 409 ACCOUNT_BUSY 同口径
  const toggle = canToggleEnabled(account, operation === null ? [] : [operation]);
  const [enabledError, setEnabledError] = useState<string | null>(null);
  const [enabledCode, setEnabledCode] = useState<string | null>(null);
  const toggleEnabledMutation = useMutation({
    // 服务端契约：`PATCH /api/managed-accounts/:id` body 严格为 `{enabled: boolean}`
    mutationFn: (nextEnabled: boolean) => api.patch<PublicManagedAccount>(`/api/managed-accounts/${account.id}`, { enabled: nextEnabled }),
    onSuccess: () => {
      setEnabledError(null);
      setEnabledCode(null);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (e) => {
      const code = reasonCodeOf(e);
      setEnabledCode(code);
      // 排队/进行中：与服务端 409 文案一致；其余错误给服务端 message，不静默
      setEnabledError(code === 'ACCOUNT_BUSY' ? ACCOUNT_BUSY_REASON : e instanceof Error ? e.message : '修改启用状态失败');
    },
  });

  const switchBlocked = capability?.switch !== true || account.is_current === true || frozen;
  const switchTitle = capability?.switch !== true
    ? `${unavailableLabel(capability, 'switch') ?? '切换不可用'}（${unavailableReason(capability, 'switch') ?? '能力未知'}）`
    : account.is_current === true
      ? '该账号已是客户端当前登录账号'
      : frozen
        ? '上次切换需要恢复，已冻结该账号的切换'
        : '切换到该账号作为桌面客户端登录账号';
  const checkinEnabled = capability?.checkin === true && onCheckin !== undefined;
  const participation = checkinParticipation(account, capability);

  return (
    <div data-testid={`accounts-card-${account.id}`} className="rounded-xl border border-hairline bg-surface-card px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{account.display_name}</span>
        {/* 客户端当前：桌面客户端里现在登录的是谁 */}
        <span data-testid={`accounts-client-current-${account.id}`}>
          {account.is_current === true
            ? <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">客户端当前</span>
            : account.is_current === false
              ? <span className="text-xs text-ink-2">客户端非当前</span>
              : <span className="text-xs text-ink-3">客户端当前未知</span>}
        </span>
        {/* 签到当前：一键签到会把哪些账号提交进批次（可与客户端当前不同） */}
        <span
          data-testid={`accounts-checkin-current-${account.id}`}
          title={participation.participates ? '一键签到会提交该账号' : `不参与一键签到：${participation.reason ?? '签到不可用'}`}
        >
          {participation.participates
            ? <span className="rounded-md border border-hairline px-1.5 py-0.5 text-xs text-ink">签到当前</span>
            : <span className="text-xs text-ink-3">不参与签到</span>}
        </span>
        {/* 能力徽标（ACC-KB-A2W）：蓝标与灰标互斥，只按 capabilityBadge 的两个布尔渲染 */}
        <span
          data-testid={`accounts-capability-badge-${account.id}`}
          data-state={badge.state}
          title={badge.title}
          aria-label={badge.title}
        >
          {badge.showBlue && (
            <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">{badge.label}</span>
          )}
          {badge.showGray && <span className="text-xs text-ink-3">{badge.label}</span>}
        </span>
        <span className="text-xs text-ink-3">{REGION_LABEL[account.service_region]}</span>
        <span className="text-xs text-ink-3">{CHECKIN_CAPABILITY_LABEL[account.checkin_capability]}</span>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-ink-2">
        <dt>标识</dt><dd data-testid={`accounts-hint-${account.id}`} className="truncate font-mono">{account.identity_hint ?? '未提供'}</dd>
        <dt>实例</dt><dd className="truncate">{`${account.client_instance_id ?? '未提供'}`.slice(0, 12)}…</dd>
        <dt>快照</dt><dd>v{account.client_snapshot_version}</dd>
        <dt>最近签到</dt><dd>{account.last_checkin_day ?? '—'}{account.last_checkin_status ? ` · ${account.last_checkin_status}` : ''}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`accounts-switch-${account.id}`}
          className={`${BTN_BASE} bg-accent text-accent-ink hover:opacity-90`}
          disabled={switchBlocked || switchMutation.isPending}
          title={switchTitle}
          onClick={() => { setError(null); setConfirming(true); }}
        >
          切换为客户端登录账号
        </button>
        <button
          type="button"
          data-testid={`accounts-checkin-${account.id}`}
          className={BTN_QUIET}
          disabled={!checkinEnabled}
          title={checkinEnabled ? '为该账号发起签到' : `${unavailableLabel(capability, 'checkin') ?? '签到不可用'}（${unavailableReason(capability, 'checkin') ?? '能力未知'}）`}
          onClick={() => { if (checkinEnabled) onCheckin?.(); }}
        >
          签到
        </button>
        {account.enabled === false && <span className="text-xs font-medium text-accent">已停用（只读）</span>}
        {/* ACC-KB-A2W：启用/停用插在「签到」与「删除」之间；排队/进行中由 canToggleEnabled 预判，服务端 409 另有可读提示 */}
        <button
          type="button"
          data-testid={`accounts-enabled-toggle-${account.id}`}
          className={BTN_QUIET}
          disabled={!toggle.allowed || toggleEnabledMutation.isPending}
          title={
            toggle.allowed
              ? toggle.nextEnabled
                ? '重新启用该账号（恢复参与一键签到）'
                : '停用该账号（保留记录，不再参与一键签到）'
              : toggle.reason ?? ACCOUNT_BUSY_REASON
          }
          onClick={() => { if (toggle.allowed) toggleEnabledMutation.mutate(toggle.nextEnabled); }}
        >
          {toggle.nextEnabled ? '启用' : '停用'}
        </button>
        <button
          type="button"
          data-testid={`accounts-delete-${account.id}`}
          className={BTN_QUIET}
          disabled={muted || deleteMutation.isPending}
          title={
            muted
              ? '能力矩阵未就绪，暂时不能删除账号'
              : '删除 AgentBoard 里的这条账号记录（不清除客户端登录态）'
          }
          onClick={() => { setDeleteErrorCode(null); setDeleteConfirming(true); }}
        >
          删除
        </button>
      </div>

      {/* ACC-KB-A2W：启停失败不静默——ACCOUNT_BUSY 给与服务端一致的可读文案，裸码只进 title */}
      {enabledError !== null && (
        <p
          role="alert"
          data-testid={`accounts-enabled-error-${account.id}`}
          data-code={enabledCode ?? undefined}
          title={enabledCode ?? undefined}
          className="mt-1 text-xs text-red-600 dark:text-red-400"
        >
          {enabledError}
        </p>
      )}

      {deleteConfirming && (
        <div
          data-testid={`accounts-delete-confirm-${account.id}`}
          role="group"
          aria-label="确认删除账号记录"
          className="mt-2 rounded-lg border border-hairline bg-surface-raised p-2.5 text-xs text-ink"
        >
          <p>
            确认删除「{account.display_name}」的记录？只清除 AgentBoard 保存的元数据与本机 DPAPI 快照，不会退出桌面客户端里的登录。
          </p>
          {account.is_current === true && (
            <p data-testid={`accounts-delete-current-warning-${account.id}`} className="mt-1 font-medium">
              该账号是当前客户端登录账号；删除记录不会退出客户端登录
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid={`accounts-delete-confirm-yes-${account.id}`}
              className={BTN_DANGER}
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </button>
            <button type="button" className={BTN_QUIET} onClick={() => setDeleteConfirming(false)}>取消</button>
            <span className="text-xs text-ink-3">3 秒内未确认会自动收回</span>
          </div>
        </div>
      )}

      {deleteErrorCode !== null && (
        <p role="alert" data-testid={`accounts-delete-error-${account.id}`} title={deleteErrorCode} className="mt-1 text-xs text-red-600 dark:text-red-400">
          {DELETE_FAIL_LABEL[deleteErrorCode] ?? reasonLabel(deleteErrorCode)}
        </p>
      )}

      {confirming && (
        <div data-testid="accounts-switch-confirm" role="group" aria-label="确认切换账号" className="mt-2 rounded-lg border border-hairline bg-surface-raised p-2.5 text-xs text-ink">
          <p>确认切换到「{account.display_name}」作为桌面客户端登录账号？切换会重启目标客户端，进行中的会话可能中断。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" data-testid="accounts-switch-confirm-yes" className={`${BTN_BASE} bg-accent text-accent-ink hover:opacity-90`} disabled={switchMutation.isPending} onClick={() => switchMutation.mutate()}>
              确认切换
            </button>
            <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
      )}

      {error !== null && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {operationId !== null && <AccountOperationStatus testId={`accounts-op-${account.id}`} operation={operation} />}
    </div>
  );
}
