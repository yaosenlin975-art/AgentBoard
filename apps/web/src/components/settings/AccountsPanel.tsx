/**
 * 账号管理六行总览（ACC-PANEL-03，布局方案 C，`Docs/design-2026-11-04-accounts-unified-panel.md` §5/§6）。
 * 能力一律以服务端能力矩阵为准；数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
 *
 * 结构：工具栏（一键签到 / 读取本机账号 / 今日 n/m）→ 六行总览（三个可签到平台 + 三个仅额度来源）。
 * 排序与默认态（§5 拍板）：可签到平台在前、仅额度平台在后；组内维持 `APP_ORDER` / `QUOTA_ROW_ORDER`；默认全折叠。
 * 可签到行头部：平台名 + 「积分 未接入」灰芯片 + 签到芯片三态 + [签到]；账号管理（能力徽标 / AccountCard / 捕获 / 批次面板）收进展开层。
 * 仅额度行：嵌 C2 的 `QuotaRows`，不可展开、无账号操作。
 *
 * testid 口径（映射写进卡评论）：`accounts-app-*` / `accounts-toggle-*` / `accounts-body-*` / `accounts-count-*` /
 * `accounts-summary-*` / `accounts-empty-*` / `accounts-capture-*` / `accounts-checkin-all-*` / `accounts-notice-*` /
 * `accounts-conflict-batch-*` / `accounts-view-batch-*` / `accounts-capability-*` 全部保留；`accounts-checkin-all-*`
 * 文本由「仅此平台签到」改为「签到」；新增 `accounts-credit-<app>`（积分占位）、`accounts-checkin-chip-<app>`（签到芯片）、
 * `accounts-today-summary`（今日合计）、`accounts-overview`（六行容器）；额度侧 `quota-cards`/`quota-card-*` → `quota-rows`/`quota-row-*`。
 *
 * 行为不变：能力矩阵失败不回退本地副本、全部写操作禁用；`POST /api/checkin-runs` 带 Idempotency-Key；
 * `409 CHECKIN_BATCH_IN_PROGRESS` 展示已有批次并可查看。折叠行点 [签到] 自动展开（批次面板/通知都在展开层内）。
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import { AccountCard, type AccountView } from './AccountCard';
import { CapabilityBadges } from './CapabilityBadges';
import { CheckinBatchPanel } from './CheckinBatchPanel';
import { LocalAccountsImport } from './LocalAccountsImport';
import { OneClickCheckinButton, OneClickCheckinPlan, OneClickCheckinResults, useOneClickCheckin } from './OneClickCheckin';
import { QuotaCreditChip, QuotaRows } from './QuotaCards';
import {
  APP_LABEL,
  APP_ORDER,
  hasReasonLabel,
  isOfflineApp,
  localDayKey,
  reasonCodeOf,
  reasonLabel,
  reasonTechnicalCode,
  summarizeCheckinToday,
  unavailableLabel,
  useAccountCapabilities,
  type AccountsAppId,
  type CapabilityView,
  type CheckinChipTone,
  type CheckinTodaySummary,
} from './accountCapabilities';
import { createCheckinBatch } from './checkinApi';

/** 签到芯片三态配色（§5：绿=全完成、琥珀=部分、灰=不可用/未纳入） */
const CHIP_TONE_CLASS: Record<CheckinChipTone, string> = {
  done: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  partial: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  unavailable: 'bg-surface-raised text-ink-3',
};

/**
 * 提示条（ACC-REASON-01）：主文案=中文原因，副文案=服务端 message，
 * 未收录的码放进可展开的「技术码」，裸码不出现在主文案里。
 */
interface AppNotice {
  label: string;
  message: string | null;
  technicalCode: string | null;
}

function noticeOf(code: string | null, message: string | null): AppNotice {
  return {
    label: reasonLabel(code),
    message,
    technicalCode: code !== null && !hasReasonLabel(code) ? reasonTechnicalCode(code) : null,
  };
}

export function AccountsPanel() {
  const list = useQuery({
    queryKey: ['managed-accounts'],
    queryFn: () => api.get<AccountView[]>('/api/managed-accounts'),
  });
  const caps = useAccountCapabilities();
  // ACC-14：已下线平台（CodeBuddy Desktop）的历史账号不在界面出现；其余平台全部账号都列出（同平台多账号）
  const accounts: AccountView[] = (list.data ?? []).filter((account) => !isOfflineApp(account.app_id));
  const capabilityKnown = !caps.isPending && !caps.isError;
  /** 默认全折叠（§5 拍板）：展开是低频账号管理动作，不抢首屏。会话内状态，不持久化 */
  const [openApps, setOpenApps] = useState<Partial<Record<AccountsAppId, boolean>>>({});
  /** ACC-HEADER：一键签到按钮在工具栏，状态与结果分离渲染 */
  const oneClick = useOneClickCheckin({ accounts, capabilities: caps.capabilities, capabilityKnown });

  const today = localDayKey(Date.now());
  const accountsByApp = APP_ORDER.map((app) => accounts.filter((account) => account.app_id === app));
  const summaries = APP_ORDER.map((app, index) => summarizeCheckinToday(accountsByApp[index]!, caps.capabilities[app] ?? null, today));
  const todayTotal = summaries.reduce((sum, item) => sum + item.total, 0);
  const todayDone = summaries.reduce((sum, item) => sum + item.done, 0);

  const setAppOpen = (app: AccountsAppId, open: boolean) => setOpenApps((previous) => ({ ...previous, [app]: open }));

  return (
    <section aria-label="账号管理" className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      {/* 工具栏（§5）：脱敏说明靠左，一键签到 / 读取本机账号 / 今日 n/m 靠右；窄屏换行不破版 */}
      <div data-testid="accounts-toolbar" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <p data-testid="accounts-desensitize-note" className="mr-auto text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
          仅展示脱敏元数据；快照、凭据与 token 不出现在界面
        </p>
        <OneClickCheckinPlan controller={oneClick} />
        <OneClickCheckinButton controller={oneClick} />
        <LocalAccountsImport />
        <span
          data-testid="accounts-today-summary"
          title="今日已完成/可参与账号（本地记录，非平台官方当日状态）"
          className="shrink-0 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400"
        >
          今日 {todayDone}/{todayTotal}
        </span>
      </div>

      <div data-testid="accounts-one-click-results" className="mb-2 empty:hidden">
        <OneClickCheckinResults controller={oneClick} />
      </div>

      {caps.isError && (
        <p role="alert" data-testid="accounts-capabilities-error" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          能力矩阵读取失败：{caps.errorMessage ?? '未知错误'}；为避免误操作，捕获/切换/签到均已禁用
        </p>
      )}
      {caps.isPending && <p data-testid="accounts-capabilities-loading" className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">读取能力矩阵…</p>}

      {list.isPending && <p data-testid="accounts-list-loading" className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">读取托管账号…</p>}
      {list.isError && (
        <p role="alert" data-testid="accounts-list-error" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error instanceof Error ? list.error.message : '读取托管账号失败'}
        </p>
      )}

      {!list.isPending && !list.isError && (
        <div data-testid="accounts-overview" className="divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {APP_ORDER.map((app, index) => (
            <PlatformRow
              key={app}
              app={app}
              open={openApps[app] === true}
              onToggle={() => setAppOpen(app, openApps[app] !== true)}
              onOpen={() => setAppOpen(app, true)}
              capability={caps.capabilities[app] ?? null}
              capabilityKnown={capabilityKnown}
              accounts={accountsByApp[index]!}
              summary={summaries[index]!}
              today={today}
            />
          ))}
          {/* 后三行：仅额度来源，不可展开、无账号操作 */}
          <div className="py-1"><QuotaRows /></div>
        </div>
      )}
    </section>
  );
}

function PlatformRow({
  app,
  open,
  onToggle,
  onOpen,
  capability,
  capabilityKnown,
  accounts,
  summary,
  today,
}: {
  app: AccountsAppId;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  capability: CapabilityView | null;
  capabilityKnown: boolean;
  accounts: PublicManagedAccount[];
  summary: CheckinTodaySummary;
  today: string;
}) {
  const queryClient = useQueryClient();
  const [batchId, setBatchId] = useState<string | null>(null);
  const [conflictBatchId, setConflictBatchId] = useState<string | null>(null);
  const [notice, setNotice] = useState<AppNotice | null>(null);
  /** 同一批账号重试时复用同一个 Idempotency-Key（服务端按 key 回放，不会重复建批） */
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  const capture = useMutation({
    mutationFn: () => api.post<{ account: PublicManagedAccount }>(`/api/managed-accounts/${app}/capture-current`, {}),
    onSuccess: () => {
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (e) => setNotice(noticeOf(reasonCodeOf(e), e instanceof Error ? e.message : '捕获失败')),
  });

  const checkin = useMutation({
    mutationFn: async (accountIds: string[]) => {
      const signature = `${app}:${[...accountIds].sort().join(',')}`;
      if (idempotencyRef.current === null || idempotencyRef.current.signature !== signature) {
        idempotencyRef.current = { signature, key: crypto.randomUUID() };
      }
      return createCheckinBatch({ app_id: app, account_ids: accountIds }, idempotencyRef.current.key);
    },
    onSuccess: (outcome) => {
      if (outcome.kind === 'created') {
        setNotice(null);
        setConflictBatchId(null);
        setBatchId(outcome.batch.id);
        return;
      }
      if (outcome.kind === 'conflict') {
        setConflictBatchId(outcome.batchId);
        setNotice(noticeOf(outcome.code, outcome.message));
        return;
      }
      setNotice(noticeOf(outcome.code, outcome.message));
    },
  });

  const usable = capability ? capability.capture || capability.switch : false;
  const enabledAccounts = accounts.filter((account) => account.enabled !== false);
  const checkinEnabled = capability?.checkin === true && enabledAccounts.length > 0 && !checkin.isPending;
  const bodyId = `accounts-body-${app}`;

  /** 折叠行点 [签到] 自动展开（§6 拍板）：批次面板、通知、冲突「查看该批次」都在展开层内 */
  const startCheckin = () => {
    onOpen();
    checkin.mutate(enabledAccounts.map((account) => account.id));
  };

  return (
    <div data-testid={`accounts-app-${app}`} data-open={open ? 'true' : 'false'}>
      {/* 行头部：平台名 + 积分占位芯片 + 签到芯片 + [签到] */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
        <button
          type="button"
          data-testid={`accounts-toggle-${app}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-neutral-900 hover:text-neutral-700 dark:text-neutral-100 dark:hover:text-neutral-300"
        >
          <span aria-hidden="true" className={`inline-block w-3 text-center text-neutral-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>▸</span>
          <span className="truncate">{APP_LABEL[app]}</span>
          <span data-testid={`accounts-count-${app}`} className="text-[11px] font-normal text-neutral-400 dark:text-neutral-500">{accounts.length} 个</span>
        </button>

        <QuotaCreditChip testId={`accounts-credit-${app}`} />

        <span
          data-testid={`accounts-checkin-chip-${app}`}
          data-tone={summary.chip.tone}
          title={summary.chip.title}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${CHIP_TONE_CLASS[summary.chip.tone]}`}
        >
          {summary.chip.text}
        </span>

        {capability === null && capabilityKnown && (
          <span data-testid={`accounts-capability-unknown-${app}`} className="text-[11px] text-neutral-400 dark:text-neutral-500">能力未知</span>
        )}

        <button
          type="button"
          data-testid={`accounts-checkin-all-${app}`}
          className={`ml-auto ${BUTTON_SECONDARY}`}
          disabled={!checkinEnabled}
          title={capability?.checkin === true ? '为本平台启用账号发起签到批次' : unavailableLabel(capability, 'checkin') ?? '签到不可用'}
          onClick={startCheckin}
        >
          {capability?.checkin === true ? '签到' : `签到不可用（${unavailableLabel(capability, 'checkin') ?? '能力未知'}）`}
        </button>
      </div>

      {/* 展开层：账号管理（默认折叠；用 hidden 保持可访问性，不做高度动画） */}
      <div id={bodyId} data-testid={bodyId} hidden={!open} className="pb-3">
        <CapabilityBadges app={app} capability={capability} />

        {capability !== null && !usable && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            该客户端目标未确认：捕获/切换能力未验证，只读展示已有记录。
          </p>
        )}

        {accounts.length === 0 ? (
          <p data-testid={`accounts-empty-${app}`} className="mt-1 rounded-md border border-dashed border-neutral-300 px-3 py-3 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            尚无{APP_LABEL[app]}账号{usable ? '' : '；该客户端能力未验证，暂不可捕获'}。点「读取本机账号」或「捕获当前账号」后列出。
          </p>
        ) : (
          <>
            <p data-testid={`accounts-summary-${app}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
              共 {accounts.length} 个账号，其中 {enabledAccounts.length} 个启用并参与一键签到
              <span className="ml-1">· 今日已完成 {summary.done}/{summary.total}（本地记录，{today}）</span>
            </p>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account as AccountView}
                  capability={capability}
                  onCheckin={checkinEnabled ? () => checkin.mutate([account.id]) : undefined}
                />
              ))}
            </div>
          </>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`accounts-capture-${app}`}
            className={capability?.capture ? BUTTON_PRIMARY : BUTTON_SECONDARY}
            disabled={capability?.capture !== true || capture.isPending}
            title={capability?.capture ? '从当前客户端读取并保存账号快照' : unavailableLabel(capability, 'capture') ?? '捕获不可用'}
            onClick={() => capture.mutate()}
          >
            {capability?.capture ? '捕获当前账号' : `捕获不可用（${unavailableLabel(capability, 'capture') ?? '能力未知'}）`}
          </button>
        </div>

        {notice !== null && (
          <div role="alert" data-testid={`accounts-notice-${app}`} className="mt-1 text-xs text-red-600 dark:text-red-400">
            <p data-testid={`accounts-notice-reason-${app}`}>
              {notice.label}
              {notice.message !== null && notice.message !== notice.label && (
                <span className="ml-1 text-neutral-600 dark:text-neutral-400">{notice.message}</span>
              )}
            </p>
            {notice.technicalCode !== null && (
              <details data-testid={`accounts-notice-code-${app}`} className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                <summary className="cursor-pointer select-none">技术码</summary>
                <code className="font-mono">{notice.technicalCode}</code>
              </details>
            )}
          </div>
        )}

        {conflictBatchId !== null && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span data-testid={`accounts-conflict-batch-${app}`} className="text-neutral-600 dark:text-neutral-400">
              <span className="mr-1 font-mono text-[11px]">CHECKIN_BATCH_IN_PROGRESS</span>
              进行中的批次 id：<span className="font-mono">{conflictBatchId}</span>
            </span>
            <button type="button" data-testid={`accounts-view-batch-${app}`} className={BUTTON_SECONDARY} onClick={() => setBatchId(conflictBatchId)}>
              查看该批次
            </button>
          </div>
        )}

        {batchId !== null && <CheckinBatchPanel batchId={batchId} accounts={accounts} onClose={() => setBatchId(null)} />}
      </div>
    </div>
  );
}
