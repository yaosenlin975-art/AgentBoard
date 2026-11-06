/**
 * 单个托管账号卡（ACC-08 / ACC-09 / ACC-14 / ACC-DEL-02；ACC-B2 重做为三级披露，口径：
 * `Docs/prototypes/accounts-redesign-2026-11-04/b-console.html` 的 `.acard` + DESIGN-NOTES §三）。
 * 能力来自服务端能力矩阵（由 AccountsPanel 传入），前端不维护能力副本。
 *
 * 三级披露（ACC-B2 + ACC-UI-2）：
 * - 一级（身份）：display_name（truncate，title 全文）+ identity_hint（等宽小字，截到前 8 位；空值不渲染占位）。
 *   头像已移除（纯装饰、无信息）。
 * - 二级（状态与动作）：只渲染正向芯片「客户端当前 / 签到当前 / 已停用」；动作区只留高频的 切换 → 签到，
 *   低频/危险的 停用、删除 收进 `⋯` 溢出菜单。已是当前账号、平台不支持切换或能力未知时不渲染灰切换按钮，
 *   原因由平台级说明行给出。负向信息（客户端非当前 / 客户端当前未知 / 区域未知 / 签到能力未知 / 不参与签到）
 *   一律不渲染，退到 title 或三级技术信息。
 * - 三级（技术信息）：`<details>` 默认折叠，收纳 平台能力徽标 / 区域 / 签到能力 / 实例 / 快照 / 最近签到原始枚举对照。
 *
 * ACC-DEL-02 删除是两步流：点「删除」→ 行内「确认删除」（3 秒未确认自动收回）→ `DELETE /api/managed-accounts/:id`
 * → 成功失效重拉列表。删除只清 AgentBoard 记录与本机 DPAPI 快照，不退出客户端登录，
 * 所以 `is_current=true` 不阻塞删除，仅在确认行追加警示。
 *
 * ACC-B5 删除确认增强（口径：原型 `.acard-confirm / .acard-error`）：确认行带 3 秒倒计时收缩条
 * （`.ab-countdown`，色走 --ab-del 令牌，与收回定时器同周期）；三种 409（ACCOUNT_BUSY /
 * CHECKIN_AUTHORIZATION_EXISTS / RECOVERY_REQUIRED）给删除语境的中文主文案，其余错误走 reasonLabel
 * 通用中文原因；失败裸码不进主文案，进 title 与三级「技术信息」技术码行（优先于切换/operation 码）；
 * 失败后卡片与选中态不变，删除按钮可再次操作。
 *
 * ACC-B4 切换就地确认与切换态：点「切换」→ 卡片内展开确认行（3 秒未确认自动收回，
 * 不弹全局层）；确认后进入切换中（operation 未到终态期间本卡动作按钮禁用，状态复用
 * AccountOperationStatus / operation 轮询）；成功失效重拉后 is_current 芯片转移；失败给中文原因
 * （沿用 reasonCode 中文化映射），无映射裸码只进三级「技术信息」，不进卡面。
 *
 * ACC-14 两个「当前」必须分开表达：
 * - **客户端当前**（`accounts-client-current-*`）= 桌面客户端此刻登录的账号（服务端 `is_current`，来自 capture/switch 领域）；
 * - **签到当前**（`accounts-checkin-current-*`）= 一键签到会提交的账号（app 签到能力可用 + 账号启用 + 账号签到能力非 unsupported）；
 * 两者可以不同，不合并成一个「当前」。
 *
 * 不展示 identity_hash / 快照引用 / 凭据引用 / token / 路径；标识只显示服务端给的 identity_hint（uid 哈希前 8 位）。
 */
import { useEffect, useRef, useState } from 'react';
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
  RECOVERY_ACTION_LABEL,
  RECOVERY_FAIL_LABEL,
  RECOVERY_HINT_BODY,
  RECOVERY_HINT_TITLE,
} from './accountRecovery';
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

/** 切换就地确认的窗口：3 秒内不点「确认切换」就自动收回（ACC-B4，与删除同窗口） */
const SWITCH_CONFIRM_WINDOW_MS = 3_000;

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

/** 最近签到原始枚举 → 中文化对照（ACC-B2；原始枚举与中文并列展示在技术信息里） */
const LAST_CHECKIN_STATUS_LABEL: Record<string, string> = {
  succeeded: '签到成功',
  already_done: '今日已完成',
  unknown: '结果未知',
  failed: '签到失败',
  authorized: '授权中',
};

/** 技术信息里的「最近签到」：日期 + 原始枚举（中文对照），未签到时不虚构状态 */
function lastCheckinLabel(account: AccountView): string {
  if (account.last_checkin_day === null && account.last_checkin_status === null) return '未签到';
  const status = account.last_checkin_status;
  if (status === null) return account.last_checkin_day ?? '未签到';
  return `${account.last_checkin_day ?? '—'} · ${status}（${LAST_CHECKIN_STATUS_LABEL[status] ?? status}）`;
}

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
  /** ACC-B4：切换失败的原始原因码；主文案走中文映射，裸码只进 title 与三级技术信息 */
  const [switchErrorCode, setSwitchErrorCode] = useState<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteErrorCode, setDeleteErrorCode] = useState<string | null>(null);
  const [restoreErrorCode, setRestoreErrorCode] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /**
   * ACC-KB-B4W：恢复入口（`POST /api/managed-accounts/:id/restore`）。
   * recovery_required 不再只是「失败」——服务端会把客户端写回切换前的快照再解冻。
   */
  const restoreMutation = useMutation({
    mutationFn: () => api.post<{ operation_id: string; operation: AccountOperation; replayed: boolean }>(`/api/managed-accounts/${account.id}/restore`, {}),
    onSuccess: () => {
      setRestoreErrorCode(null);
      setFrozen(false);
      setOperationId(null);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (e) => { setRestoreErrorCode(reasonCodeOf(e)); },
  });

  const switchMutation = useMutation({
    mutationFn: () => api.post<{ operation_id: string; operation: AccountOperation }>(`/api/managed-accounts/${account.id}/switch`, {}),
    onSuccess: (result) => {
      setError(null);
      setSwitchErrorCode(null);
      setConfirming(false);
      setOperationId(result.operation_id);
    },
    onError: (e) => {
      // ACC-B4：回到未切换态 + 中文原因（沿用 reasonCode 映射）；裸码不进卡面，只进 title 与三级技术信息
      setConfirming(false);
      const code = reasonCodeOf(e);
      setSwitchErrorCode(code);
      setError(code === null ? '切换失败' : reasonLabel(code));
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

  // ACC-B4：切换就地确认 3 秒未确认自动收回（与删除确认同窗口）；确认请求在途时不收回
  useEffect(() => {
    if (!confirming || switchMutation.isPending) return;
    const timer = setTimeout(() => setConfirming(false), SWITCH_CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [confirming, switchMutation.isPending]);

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

  // ACC-SWITCH：切换进入终态后刷新账号列表，让 is_current 芯片与真实登录态一致（成功的切过去 / 回滚的切回来）
  const operationState = operation?.state ?? null;
  useEffect(() => {
    if (operationState === null || !isTerminalState(operationState)) return;
    void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
  }, [operationState, queryClient]);

  /**
   * ACC-B4 切换态：确认请求在途（operationId 还没发下来）或 operation 未到终态都算「切换中」。
   * 期间本卡动作按钮统一禁用，防止重复发起；进行中状态由 AccountOperationStatus 呈现。
   */
  const switching = switchMutation.isPending
    || (operationId !== null && (operation === null || !isTerminalState(operation.state)));
  /** 三级技术信息里的失败原因码：删除请求失败码优先（最近的用户动作），其次切换失败码与 operation 的安全错误码 */
  const techErrorCode = deleteErrorCode ?? switchErrorCode ?? operation?.safe_error_code ?? null;

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
  // ACC-SWITCH：不能切的平台必须给出可见原因 + 出路，不能只留一个禁用按钮
  const switchTitle = switching
    ? '切换进行中，等待当前操作完成后才能再次切换'
    : capability?.switch !== true
      ? `该平台暂不支持切换：${unavailableLabel(capability, 'switch') ?? '切换不可用'}（${unavailableReason(capability, 'switch') ?? '能力未知'}），需手动在客户端切换`
      : account.is_current === true
        ? '该账号已是客户端当前登录账号'
        : frozen
          ? '上次切换需要恢复，已冻结该账号的切换'
          : '切换到该账号作为桌面客户端登录账号';
  const participation = checkinParticipation(account, capability);
  // ACC-CHECKIN：缺签到凭据 / 平台能力不可用 / 账号停用时按钮直接禁用，原因进 title
  const checkinEnabled = participation.participates && onCheckin !== undefined;
  const checkinTitle = checkinEnabled
    ? '为该账号发起签到'
    : (participation.reason ?? `${unavailableLabel(capability, 'checkin') ?? '签到不可用'}（${unavailableReason(capability, 'checkin') ?? '能力未知'}）`);

  // ACC-UI-2 一级：identity_hint 恒为前 8 位（服务端超长也截断）；空值不渲染占位
  const hint = (account.identity_hint ?? '').slice(0, 8);
  // ACC-B2 二级：客户端当前非正向态不渲染，负向信息退到 title
  const clientCurrentTitle =
    account.is_current === false
      ? '客户端非当前'
      : account.is_current === null
        ? '客户端当前未知'
        : undefined;
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const closeMenu = () => menuRef.current?.removeAttribute('open');

  return (
    <article
      data-testid={`accounts-card-${account.id}`}
      className={`px-1 py-2.5 ${account.enabled === false ? 'opacity-60' : ''}`}
    >
      {/* 一级 + 二级：身份与正向芯片 | 动作区（切换 → 签到 → ⋯ 菜单） */}
      <div data-testid={`accounts-card-face-${account.id}`} className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-ink" title={account.display_name}>
              {account.display_name}
            </span>
            {/* 客户端当前：正向才出芯片；非当前/未知退到 title（ACC-B2 负向不渲染） */}
            <span data-testid={`accounts-client-current-${account.id}`} title={clientCurrentTitle}>
              {account.is_current === true && (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">客户端当前</span>
              )}
            </span>
            {/* 签到当前：正向才出芯片；不参与原因退到 title（可与客户端当前不同） */}
            <span
              data-testid={`accounts-checkin-current-${account.id}`}
              title={participation.participates ? '一键签到会提交该账号' : `不参与一键签到：${participation.reason ?? '签到不可用'}`}
            >
              {participation.participates && (
                <span className="rounded-md border border-hairline px-1.5 py-0.5 text-xs text-ink">签到当前</span>
              )}
            </span>
            {account.enabled === false && (
              <span className="rounded-md bg-surface-raised px-1.5 py-0.5 text-xs font-medium text-ink-2">已停用</span>
            )}
          </div>
          {/* ACC-UI-2：空 identity_hint 不再渲染「未提供」占位（无信息量）；有值才出等宽小字 */}
          {hint !== '' && (
            <p data-testid={`accounts-hint-${account.id}`} className="mt-0.5 truncate font-mono text-[11px] tracking-wide text-ink-3">
              {hint}
            </p>
          )}
        </div>

        <div className="flex flex-none items-center gap-1.5">
          {/* ACC-UI-2：已是当前账号 / 平台不支持切换时不渲染灰按钮，原因交给芯片与平台级说明行 */}
          {capability?.switch === true && account.is_current !== true && (
            <button
              type="button"
              data-testid={`accounts-switch-${account.id}`}
              className={`${BTN_BASE} bg-accent text-accent-ink hover:opacity-90`}
              disabled={switchBlocked || switching}
              title={switchTitle}
              onClick={() => { setError(null); setSwitchErrorCode(null); setConfirming(true); }}
            >
              切换
            </button>
          )}
          <button
            type="button"
            data-testid={`accounts-checkin-${account.id}`}
            className={BTN_QUIET}
            disabled={!checkinEnabled || switching}
            title={checkinTitle}
            onClick={() => { if (checkinEnabled) onCheckin?.(); }}
          >
            签到
          </button>
          {/* ACC-UI-2：低频/危险操作（停用、删除）收进 ⋯ 菜单，主行只留高频动作 */}
          <details ref={menuRef} data-testid={`accounts-more-${account.id}`} className="relative">
            <summary
              aria-label="更多操作"
              title="更多操作（停用 / 删除）"
              className="flex size-7 cursor-pointer select-none items-center justify-center rounded-lg border border-hairline bg-surface-card text-ink-2 ab-transition hover:bg-surface-raised [&::-webkit-details-marker]:hidden"
            >
              ⋯
            </summary>
            <div
              role="menu"
              aria-label="账号更多操作"
              className="absolute right-0 top-full z-10 mt-1 w-32 rounded-lg border border-hairline bg-surface-card p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                data-testid={`accounts-enabled-toggle-${account.id}`}
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink ab-transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!toggle.allowed || toggleEnabledMutation.isPending || switching}
                title={
                  toggle.allowed
                    ? toggle.nextEnabled
                      ? '重新启用该账号（恢复参与一键签到）'
                      : '停用该账号（保留记录，不再参与一键签到）'
                    : toggle.reason ?? ACCOUNT_BUSY_REASON
                }
                onClick={() => {
                  closeMenu();
                  if (toggle.allowed) toggleEnabledMutation.mutate(toggle.nextEnabled);
                }}
              >
                {toggle.nextEnabled ? '启用' : '停用'}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`accounts-delete-${account.id}`}
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-red-600 ab-transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                disabled={muted || deleteMutation.isPending || switching}
                title={
                  muted
                    ? '能力矩阵未就绪，暂时不能删除账号'
                    : '删除 AgentBoard 里的这条账号记录（不清除客户端登录态）'
                }
                onClick={() => {
                  closeMenu();
                  setDeleteErrorCode(null);
                  setDeleteConfirming(true);
                }}
              >
                删除
              </button>
            </div>
          </details>
        </div>
      </div>

      {/* 三级：技术信息（ACC-B2，默认折叠）——平台能力 / 区域 / 签到能力 / 实例 / 快照 / 最近签到原始枚举对照 */}
      <details data-testid={`accounts-tech-${account.id}`} className="mt-2 text-[11px] text-ink-3">
        <summary className="cursor-pointer select-none ab-transition hover:text-ink-2">技术信息</summary>
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt>平台能力</dt>
          <dd>
            {/* ACC-KB-A2W：能力徽标三态互斥（蓝标 / 灰标由 capabilityBadge 的 showBlue/showGray 决定，不会同时出） */}
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
          </dd>
          <dt>区域</dt><dd>{REGION_LABEL[account.service_region]}</dd>
          <dt>签到能力</dt><dd>{CHECKIN_CAPABILITY_LABEL[account.checkin_capability]}</dd>
          <dt>实例</dt><dd className="break-all font-mono">{account.client_instance_id}</dd>
          <dt>快照</dt><dd>v{account.client_snapshot_version}</dd>
          <dt>最近签到</dt><dd>{lastCheckinLabel(account)}</dd>
          {/* ACC-B4：切换失败的原始原因码（含无映射裸码）只进三级技术信息，不进卡面 */}
          {techErrorCode !== null && (
            <>
              <dt>技术码</dt>
              <dd data-testid={`accounts-tech-code-${account.id}`} className="break-all font-mono" title={techErrorCode}>{techErrorCode}</dd>
            </>
          )}
        </dl>
      </details>

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
            {/* ACC-B5：3 秒倒计时收缩条（.ab-countdown，与上方收回定时器同周期；纯装饰，aria-hidden） */}
            <span aria-hidden="true" data-testid={`accounts-delete-countdown-${account.id}`} className="ml-auto ab-countdown" />
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
          <p>确认切换到「{account.display_name}」作为桌面客户端登录账号？切换后客户端将以该账号登录，目标客户端会重启，进行中的会话可能中断。</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" data-testid="accounts-switch-confirm-yes" className={`${BTN_BASE} bg-accent text-accent-ink hover:opacity-90`} disabled={switchMutation.isPending} onClick={() => switchMutation.mutate()}>
              {switchMutation.isPending ? '切换中…' : '确认切换'}
            </button>
            <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>取消</button>
            <span className="text-xs text-ink-3">3 秒内未确认会自动收回</span>
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid={`accounts-switch-error-${account.id}`}
          data-code={switchErrorCode ?? undefined}
          title={switchErrorCode ?? undefined}
          className="mt-1 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {/* ACC-KB-B4W：recovery_required 给出可操作的下一步（指向 restore），而不是只显示失败 */}
      {needsRecovery && (
        <div
          data-testid={`accounts-recovery-${account.id}`}
          role="group"
          aria-label="恢复客户端状态"
          className="mt-2 rounded-lg border border-hairline bg-surface-raised p-2.5 text-xs text-ink"
        >
          <p className="font-medium">{RECOVERY_HINT_TITLE}</p>
          <p className="mt-1 text-ink-2">{RECOVERY_HINT_BODY}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid={`accounts-recovery-action-${account.id}`}
              className={BTN_BASE}
              disabled={restoreMutation.isPending}
              title="让服务端把客户端写回切换前的快照并解冻该账号"
              onClick={() => { setRestoreErrorCode(null); restoreMutation.mutate(); }}
            >
              {restoreMutation.isPending ? '恢复中…' : RECOVERY_ACTION_LABEL}
            </button>
          </div>
          {restoreErrorCode !== null && (
            <p
              role="alert"
              data-testid={`accounts-recovery-error-${account.id}`}
              title={restoreErrorCode}
              className="mt-1 text-red-600 dark:text-red-400"
            >
              {RECOVERY_FAIL_LABEL[restoreErrorCode] ?? reasonLabel(restoreErrorCode)}
            </p>
          )}
        </div>
      )}

      {operationId !== null && (
        <AccountOperationStatus
          testId={`accounts-op-${account.id}`}
          operation={operation}
          safeErrorLabel={operation?.safe_error_code ? reasonLabel(operation.safe_error_code) : null}
        />
      )}
    </article>
  );
}
