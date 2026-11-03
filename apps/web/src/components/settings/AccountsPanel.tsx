/**
 * 账号管理面板（ACC-08 / ACC-09 / ACC-14）：按平台分区展示托管账号与能力；能力一律以服务端能力矩阵为准。
 * - 能力矩阵 `GET /api/managed-account-capabilities`：失败时不回退本地副本，全部写操作禁用并显示错误态。
 * - ACC-14 顶部两个入口：「一键签到」（`OneClickCheckin`，三平台全部启用账号）、「读取本机账号」（`LocalAccountsImport`，ACC-11 导入端点）。
 * - ACC-14 平台范围：只展示 WorkBuddy / MiniMax / Trae；CodeBuddy Desktop 已下线，栏位移除且历史账号在界面过滤（接口与库内数据不变）。
 * - 签到：`checkin` 为 true 才可点；发起 `POST /api/checkin-runs`（带 Idempotency-Key），批次视图见 CheckinBatchPanel。
 * - `409 CHECKIN_BATCH_IN_PROGRESS`：展示已有批次 id 并可查看该批次。
 * 数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import { AccountCard, type AccountView } from './AccountCard';
import { CheckinBatchPanel } from './CheckinBatchPanel';
import { LocalAccountsImport } from './LocalAccountsImport';
import { OneClickCheckin } from './OneClickCheckin';
import { APP_LABEL, APP_ORDER, SOURCE_LABEL, capabilityReasonCode, hasReasonLabel, isOfflineApp, reasonCodeOf, reasonLabel, reasonTechnicalCode, unavailableLabel, useAccountCapabilities, type AccountsAppId, type CapabilityView } from './accountCapabilities';
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

  return (
    <section aria-label="账号管理" className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">账号管理</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">仅展示脱敏元数据；快照、凭据与 token 不出现在界面</p>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <OneClickCheckin accounts={accounts} capabilities={caps.capabilities} capabilityKnown={capabilityKnown} />
        <LocalAccountsImport />
      </div>

      {caps.isError && (
        <p role="alert" data-testid="accounts-capabilities-error" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          能力矩阵读取失败：{caps.errorMessage ?? '未知错误'}；为避免误操作，捕获/切换/签到均已禁用
        </p>
      )}
      {caps.isPending && <p className="text-sm text-neutral-500 dark:text-neutral-400">读取能力矩阵…</p>}

      {list.isPending && <p className="text-sm text-neutral-500 dark:text-neutral-400">读取托管账号…</p>}
      {list.isError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error instanceof Error ? list.error.message : '读取托管账号失败'}
        </p>
      )}

      {!list.isPending && !list.isError && (
        <div className="space-y-3">
          {APP_ORDER.map((app) => (
            <AppSection
              key={app}
              app={app}
              capability={caps.capabilities[app] ?? null}
              capabilityKnown={capabilityKnown}
              accounts={accounts.filter((account) => account.app_id === app)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AppSection({
  app,
  capability,
  capabilityKnown,
  accounts,
}: {
  app: AccountsAppId;
  capability: CapabilityView | null;
  capabilityKnown: boolean;
  accounts: PublicManagedAccount[];
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
  const checkinEnabled = capability?.checkin === true && accounts.length > 0 && !checkin.isPending;
  const enabledAccounts = accounts.filter((account) => account.enabled !== false);

  return (
    <div
      data-testid={`accounts-app-${app}`}
      className={`rounded-lg border p-2.5 ${usable ? 'border-neutral-200 dark:border-neutral-800' : 'border-dashed border-neutral-300 dark:border-neutral-700'}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{APP_LABEL[app]}</h4>
        <Badge tone="gray">{accounts.length} 个账号</Badge>
        {capability === null ? (
          <Badge tone="gray">{capabilityKnown ? '能力未知' : '读取中'}</Badge>
        ) : (
          <>
            <Badge tone={capability.switch ? 'green' : 'neutral'}>
              {capability.switch ? '切换可用' : unavailableLabel(capability, 'switch') ?? '切换不可用'}
            </Badge>
            <span data-testid={`accounts-capability-${app}`} className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              捕获 {capability.capture ? 'OK' : capabilityReasonCode(capability, 'capture')} · 切换 {capability.switch ? 'OK' : capabilityReasonCode(capability, 'switch')} · 签到 {capability.checkin ? 'OK' : capabilityReasonCode(capability, 'checkin')}
            </span>
            <span data-testid={`accounts-capability-source-${app}`} className="text-[11px] text-neutral-400 dark:text-neutral-500">
              来源：{SOURCE_LABEL[capability.source]}
            </span>
          </>
        )}
      </div>

      {capability !== null && !usable && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          该客户端目标未确认：捕获/切换能力未验证，只读展示已有记录。
        </p>
      )}

      {accounts.length === 0 ? (
        <p data-testid={`accounts-empty-${app}`} className="mt-2 rounded-md border border-dashed border-neutral-300 px-3 py-3 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          尚无{APP_LABEL[app]}账号{usable ? '' : '；该客户端能力未验证，暂不可捕获'}。点「读取本机账号」或「捕获当前账号」后列出。
        </p>
      ) : (
        <>
          <p data-testid={`accounts-summary-${app}`} className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            共 {accounts.length} 个账号，其中 {enabledAccounts.length} 个启用并参与一键签到
          </p>
          <div className="mt-2 space-y-2">
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
        <button
          type="button"
          data-testid={`accounts-checkin-all-${app}`}
          className={BUTTON_SECONDARY}
          disabled={!checkinEnabled}
          title={capability?.checkin === true ? '为本平台启用账号发起签到批次' : unavailableLabel(capability, 'checkin') ?? '签到不可用'}
          onClick={() => checkin.mutate(enabledAccounts.map((account) => account.id))}
        >
          {capability?.checkin === true ? '本平台批量签到' : `签到不可用（${unavailableLabel(capability, 'checkin') ?? '能力未知'}）`}
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
  );
}
