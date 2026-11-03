/**
 * 账号管理面板（ACC-08 / ACC-09 / ACC-14 / ACC-UI-01）：按平台折叠分区展示托管账号与能力。
 * 能力一律以服务端能力矩阵为准。
 *
 * 结构（设计 D1/D4，`Docs/design-2026-11-03-accounts-panel-redesign.md`）：
 *   标题 → 额度区（DeepSeek 一行；opencode-go / Codex 本轮保持原样）→ 全局操作（一键签到 / 读取本机账号）
 *   → 平台分区（头部：平台名 + 三个能力图标徽标 + 「仅此平台签到」；默认第一个展开、其余折叠，不持久化）
 *
 * 能力展示（D2）：图标三态 `true → ✓`、`false → ✗`、未知 → `?`；**reason_code 只进 tooltip 与「技术信息」details**，
 * 不进徽标文本。既有 testid 映射：`accounts-capability-${app}` / `accounts-capability-source-${app}` 收进该 details（保留原名），
 * `accounts-summary-*` / `accounts-notice-*` / `accounts-empty-*` / `accounts-capture-*` 位置不变（平台体内部）。
 *
 * 行为不变：能力矩阵失败不回退本地副本；`checkin` 为 true 才可点；`POST /api/checkin-runs`（带 Idempotency-Key）；
 * `409 CHECKIN_BATCH_IN_PROGRESS` 展示已有批次并可查看。数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
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
import { QuotaCards } from './QuotaCards';
import { APP_LABEL, APP_ORDER, hasReasonLabel, isOfflineApp, reasonCodeOf, reasonLabel, reasonTechnicalCode, unavailableLabel, useAccountCapabilities, type AccountsAppId, type CapabilityView } from './accountCapabilities';
import { createCheckinBatch } from './checkinApi';

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
  /** 折叠状态：默认第一个平台展开，其余折叠；不持久化（设计 D1） */
  const [openApps, setOpenApps] = useState<Partial<Record<AccountsAppId, boolean>>>({ [APP_ORDER[0]!]: true });
  /** ACC-HEADER：一键签到按钮上移到标题行，状态与结果分离渲染 */
  const oneClick = useOneClickCheckin({ accounts, capabilities: caps.capabilities, capabilityKnown });

  return (
    <section aria-label="账号管理" className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      {/*
        ACC-HEADER：面板内不再重复「账号管理」标题（弹窗头部已有），只保留一行工具栏：
        左侧脱敏说明（小字）+ 右侧「一键签到」；窄屏（375）允许换行，不破版。
      */}
      <div data-testid="accounts-toolbar" className="mb-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
        <p data-testid="accounts-desensitize-note" className="mr-auto text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
          仅展示脱敏元数据；快照、凭据与 token 不出现在界面
        </p>
        <OneClickCheckinPlan controller={oneClick} />
        <OneClickCheckinButton controller={oneClick} />
      </div>

      <QuotaCards />

      <div data-testid="accounts-one-click-results" className="mt-2 empty:hidden">
        <OneClickCheckinResults controller={oneClick} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <LocalAccountsImport />
      </div>

      {caps.isError && (
        <p role="alert" data-testid="accounts-capabilities-error" className="mb-2 mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          能力矩阵读取失败：{caps.errorMessage ?? '未知错误'}；为避免误操作，捕获/切换/签到均已禁用
        </p>
      )}
      {caps.isPending && <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">读取能力矩阵…</p>}

      {list.isPending && <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">读取托管账号…</p>}
      {list.isError && (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error instanceof Error ? list.error.message : '读取托管账号失败'}
        </p>
      )}

      {!list.isPending && !list.isError && (
        <div className="mt-3 divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {APP_ORDER.map((app, index) => (
            <AppSection
              key={app}
              app={app}
              open={openApps[app] === true}
              onToggle={() => setOpenApps((previous) => ({ ...previous, [app]: previous[app] !== true }))}
              capability={caps.capabilities[app] ?? null}
              capabilityKnown={capabilityKnown}
              accounts={accounts.filter((account) => account.app_id === app)}
              isFirst={index === 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AppSection({
  app,
  open,
  onToggle,
  capability,
  capabilityKnown,
  accounts,
  isFirst,
}: {
  app: AccountsAppId;
  open: boolean;
  onToggle: () => void;
  capability: CapabilityView | null;
  capabilityKnown: boolean;
  accounts: PublicManagedAccount[];
  isFirst: boolean;
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

  return (
    <div data-testid={`accounts-app-${app}`} data-open={open ? 'true' : 'false'} className={isFirst ? '' : ''}>
      {/* 头部：平台名 + 三能力图标 + 主操作（仅该平台签到） */}
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

        <CapabilityBadges app={app} capability={capability} />

        {capability === null && capabilityKnown && (
          <span data-testid={`accounts-capability-unknown-${app}`} className="text-[11px] text-neutral-400 dark:text-neutral-500">能力未知</span>
        )}

        <button
          type="button"
          data-testid={`accounts-checkin-all-${app}`}
          className={`ml-auto ${BUTTON_SECONDARY}`}
          disabled={!checkinEnabled}
          title={capability?.checkin === true ? '仅为本平台启用账号发起签到批次' : unavailableLabel(capability, 'checkin') ?? '签到不可用'}
          onClick={() => checkin.mutate(enabledAccounts.map((account) => account.id))}
        >
          {capability?.checkin === true ? '仅此平台签到' : `签到不可用（${unavailableLabel(capability, 'checkin') ?? '能力未知'}）`}
        </button>
      </div>

      {/* 平台体：默认第一个展开，其余折叠（用 hidden 保持可访问性，不做高度动画） */}
      <div id={bodyId} data-testid={bodyId} hidden={!open} className="pb-3">
        {capability !== null && !usable && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
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
