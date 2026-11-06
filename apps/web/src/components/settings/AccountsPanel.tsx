/**
 * 账号管理六行总览（ACC-PANEL-03，布局方案 C，`Docs/design-2026-11-04-accounts-unified-panel.md` §5/§6）。
 * 能力一律以服务端能力矩阵为准；数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
 *
 * 结构：工具栏（一键签到 / 读取本机账号 / 今日 n/m）→ 六行总览（三个可签到平台 + 三个仅额度来源）。
 * 排序与默认态（§5 拍板）：可签到平台在前、仅额度平台在后；组内维持 `APP_ORDER` / `QUOTA_ROW_ORDER`；默认全折叠。
 * 可签到行头部：平台名 + 「积分 未接入」灰芯片 + 签到芯片三态 + [签到]；账号管理（能力徽标 / AccountCard / 捕获）收进展开层。
 * ACC-B3：单平台批次改由右栏工作区顶部的 `CheckinRunPanel` 吸顶呈现（进度 done/total + 账号级状态列表，终态无取消行）。
 * 仅额度行：嵌 C2 的 `QuotaRows`，不可展开、无账号操作。
 *
 * testid 口径（映射写进卡评论）：`accounts-app-*` / `accounts-toggle-*` / `accounts-body-*` / `accounts-count-*` /
 * `accounts-summary-*` / `accounts-empty-*` / `accounts-capture-*` / `accounts-checkin-all-*` / `accounts-notice-*` /
 * `accounts-conflict-batch-*` / `accounts-view-batch-*` / `accounts-capability-*` 全部保留；`accounts-checkin-all-*`
 * 文本由「仅此平台签到」改为「签到」；新增 `accounts-credit-<app>`（积分占位）、`accounts-checkin-chip-<app>`（签到芯片）、
 * `accounts-today-summary`（今日合计）、`accounts-overview`（六行容器）；额度侧 `quota-cards`/`quota-card-*` → `quota-rows`/`quota-row-*`。
 *
 * 行为不变：能力矩阵失败不回退本地副本、全部写操作禁用；`POST /api/checkin-runs` 带 Idempotency-Key；
 * `409 CHECKIN_BATCH_IN_PROGRESS` 展示已有批次并可查看（该批次同样进右栏吸顶批次条）。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QUOTA_GROUPS, type ManagedAppId, type PublicCliAccount, type PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { AccountCard, type AccountView } from './AccountCard';
import { CapabilityBadges } from './CapabilityBadges';
import { CheckinRunPanel } from './CheckinRunPanel';
import { LocalAccountsImport } from './LocalAccountsImport';
import { OneClickCheckinButton, OneClickCheckinPlan, OneClickCheckinResults, useOneClickCheckin } from './OneClickCheckin';
import { QuotaCreditChip } from './QuotaCards';
import { QuotaDetail } from './QuotaDetail';
import {
  APP_ORDER,
  appLabel,
  COMMANDCODE_SOURCE_LABEL,
  commandCodeEmptyHint,
  useCommandCodeCapability,
  hasReasonLabel,
  isOfflineApp,
  localDayKey,
  platformMeta,
  reasonCodeOf,
  reasonLabel,
  reasonTechnicalCode,
  checkinParticipation,
  summarizeCheckinToday,
  unavailableLabel,
  useAccountCapabilities,
  type CapabilityView,
  type CheckinChipTone,
  type CheckinTodaySummary,
} from './accountCapabilities';
import { createCheckinBatch } from './checkinApi';
import { AddAccountEntry } from './AddAccountWizard';
import { AccountsMasterDetail, type PlatformIndexItem } from './AccountsMasterDetail';

/** 需求 2：CLI 额度来源并入同一平台列表时的短标签（长标签仍用于额度详情） */
const CLI_SOURCE_ROW_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode-Go',
  codex: 'Codex',
  commandcode: COMMANDCODE_SOURCE_LABEL,
};

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
  /**
   * ACC-CLI-MULTI（口径 A）：CLI 三来源的本机凭据登记。GET 幂等登记并返回脱敏列表，
   * 界面只拿它做真实计数与只读详情；不提供导入/切换入口（见 CLI-IMPORT / CLI-SWITCH）。
   */
  const cliList = useQuery({
    queryKey: ['cli-accounts'],
    queryFn: () => api.get<{ items: PublicCliAccount[] }>('/api/cli-accounts'),
  });
  const cliAccounts: PublicCliAccount[] = cliList.data?.items ?? [];
  const cliError = cliList.isError
    ? (cliList.error instanceof Error ? cliList.error.message : '读取本机 CLI 凭据失败')
    : null;
  const caps = useAccountCapabilities();
  // ACC-14：已下线平台（CodeBuddy Desktop）的历史账号不在界面出现；其余平台全部账号都列出（同平台多账号）
  const accounts: AccountView[] = (list.data ?? []).filter((account) => !isOfflineApp(account.app_id));
  const capabilityKnown = !caps.isPending && !caps.isError;
  /** 默认全折叠（§5 拍板）：展开是低频账号管理动作，不抢首屏。会话内状态，不持久化 */
  const [openApps, setOpenApps] = useState<Partial<Record<string, boolean>>>({});
  /** ACC-HEADER：一键签到按钮在工具栏，状态与结果分离渲染 */
  const oneClick = useOneClickCheckin({ accounts, capabilities: caps.capabilities, capabilityKnown });

  const today = localDayKey(Date.now());
  const accountsByApp = APP_ORDER.map((app) => accounts.filter((account) => account.app_id === app));
  const summaries = APP_ORDER.map((app, index) => summarizeCheckinToday(accountsByApp[index]!, caps.capabilities[app] ?? null, today));
  const todayTotal = summaries.reduce((sum, item) => sum + item.total, 0);
  const todayDone = summaries.reduce((sum, item) => sum + item.done, 0);

  /**
   * ACC-KB-B1W：`APP_ORDER` 之外的平台（新增的 qoder_cn / zcode，以及未来未知 id）
   * 一律进「其它平台」分区，按 id 字典序；来源 = 账号里出现的 app_id ∪ 能力矩阵里出现的 app_id。
   * 目的：**不允许静默丢卡**——未知平台账号必须可见，显示名/图标走 `platformMeta()` 兜底。
   */
  const extraApps = useMemo(() => {
    const known = new Set<string>(APP_ORDER);
    const ids = new Set<string>();
    for (const account of accounts) ids.add(String(account.app_id));
    for (const id of Object.keys(caps.capabilities)) {
      if (!isOfflineApp(id as ManagedAppId)) ids.add(id);
    }
    return [...ids].filter((id) => !known.has(id)).sort((left, right) => left.localeCompare(right));
  }, [accounts, caps.capabilities]);

  const setAppOpen = (app: string, open: boolean) => setOpenApps((previous) => ({ ...previous, [app]: open }));

  /**
   * ACC-B1：左栏平台索引项 = APP_ORDER（六平台）+ 「其它平台」（不静默丢卡）。
   * 右栏只渲染选中平台的 PlatformRow —— 从结构上消除六平台同屏堆叠。
   */
  const indexItems: PlatformIndexItem[] = useMemo(() => {
    const build = (app: string, appAccounts: AccountView[], summary: CheckinTodaySummary): PlatformIndexItem => {
      const meta = platformMeta(app as ManagedAppId);
      // 当前账号：is_current === true（服务端标记的当前客户端登录账号）
      const current = appAccounts.find((account) => account.is_current === true) ?? null;
      return {
        app,
        label: meta.label,
        currentLabel: current === null ? null : (current.display_name ?? null),
        accountCount: appAccounts.length,
        done: summary.done,
        total: summary.total,
        render: () => (
          <PlatformRow
            app={app}
            open
            onToggle={() => setAppOpen(app, true)}
            onOpen={() => setAppOpen(app, true)}
            capability={caps.capabilities[app as ManagedAppId] ?? null}
            capabilityKnown={capabilityKnown}
            accounts={appAccounts}
            summary={summary}
            today={today}
          />
        ),
      };
    };

    const known = APP_ORDER.map((app, index) => build(app, accountsByApp[index]!, summaries[index]!));
    const extras = extraApps.map((app) => {
      const appAccounts = accounts.filter((account) => account.app_id === app);
      return build(app, appAccounts, summarizeCheckinToday(appAccounts, caps.capabilities[app as ManagedAppId] ?? null, today));
    });
    /**
     * 需求 2：CLI 额度三来源并入同一平台列表（图2 紧凑行）。
     * ACC-CLI-MULTI（口径 A）：计数取 `/api/cli-accounts` 的本机登记结果（逐来源过滤），
     * 与右栏只读详情同源；不提供导入/切换（见 CLI-IMPORT / CLI-SWITCH）。
     */
    const sources: PlatformIndexItem[] = (QUOTA_GROUPS.find((group) => group.id === 'cli')?.sources ?? []).map((source) => {
      const sourceAccounts = cliAccounts.filter((account) => account.app_id === source);
      return {
        app: source,
        kind: 'source' as const,
        label: CLI_SOURCE_ROW_LABEL[source] ?? source,
        currentLabel: null,
        accountCount: sourceAccounts.length,
        done: 0,
        total: 0,
        render: () => (
          <div className="space-y-2">
            {/* ACC-B6：额度平台右栏详情（余额 / 时间窗口 / 积分占位）；凭据明细保留在下方 */}
            <QuotaDetail source={source} />
            <QuotaSourceDetail source={source} accounts={sourceAccounts} errorMessage={cliError} />
          </div>
        ),
      };
    });
    /**
     * ACC-CC-2：Command Code 是 CC-1 调研确认的 **CLI 来源**（不是 ManagedAppId），
     * 落 CLI 来源区；三项能力一律不可用（未实测的写回不标可用），只给中文原因 + 技术码。
     * 不新增额度来源枚举：CC-1 判定其额度接口未文档化，这里不做额度行，避免凭空造数据源。
     */
    const commandCodeAccounts = cliAccounts.filter((account) => String(account.app_id) === 'commandcode');
    sources.push({
      app: 'commandcode',
      kind: 'source',
      label: CLI_SOURCE_ROW_LABEL.commandcode ?? COMMANDCODE_SOURCE_LABEL,
      currentLabel: null,
      accountCount: commandCodeAccounts.length,
      done: 0,
      total: 0,
      render: () => <CommandCodeSourceDetail accounts={commandCodeAccounts} />,
    });
    return [...known, ...extras, ...sources];
  }, [accounts, accountsByApp, extraApps, summaries, caps.capabilities, capabilityKnown, today, cliAccounts, cliError]);

  return (
    <section aria-label="账号管理" className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
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

      {!list.isPending && !list.isError && <AccountsMasterDetail items={indexItems} />}

      {/* 需求 6：图3 工具条整体下移到主从内容之后；仍保持脱敏说明靠左、动作靠右 */}
      <div data-testid="accounts-toolbar" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
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
  app: string;
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
      return createCheckinBatch({ app_id: app as ManagedAppId, account_ids: accountIds }, idempotencyRef.current.key);
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
  // ACC-CHECKIN：平台级签到也只提交可参与账号（缺凭据/不支持签到的账号跳过，不再整批失败）
  const checkinAccounts = enabledAccounts.filter((account) => checkinParticipation(account, capability).participates);
  const skippedCheckinCount = enabledAccounts.length - checkinAccounts.length;
  const checkinEnabled = capability?.checkin === true && checkinAccounts.length > 0 && !checkin.isPending;
  const bodyId = `accounts-body-${app}`;

  /** 折叠行点 [签到] 自动展开（§6 拍板）：批次面板、通知、冲突「查看该批次」都在展开层内 */
  const startCheckin = () => {
    onOpen();
    checkin.mutate(checkinAccounts.map((account) => account.id));
  };

  return (
    <div data-testid={`accounts-app-${app}`} data-open={open ? 'true' : 'false'}>
      {/* ACC-B3：单平台批次吸顶呈现（右栏工作区顶部 sticky，依附 drawer-body 滚动容器；key 换批次重置收起态） */}
      {batchId !== null && <CheckinRunPanel key={batchId} batchId={batchId} accounts={accounts} />}
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
          {/* ACC-KB-B1W：平台名/图标走 platformMeta()（未知 id → 「未识别平台」+ ?，不出现裸 id） */}
          <span aria-hidden="true" data-testid={`accounts-glyph-${app}`} className="inline-flex size-4 shrink-0 items-center justify-center rounded border border-neutral-300 text-[10px] leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{platformMeta(app).glyph}</span>
          <span className="truncate">{appLabel(app)}</span>
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
          title={capability?.checkin === true
            ? (skippedCheckinCount > 0
                ? `为本平台 ${checkinAccounts.length} 个可签到账号发起批次；跳过 ${skippedCheckinCount} 个（缺少签到凭据或不可签到）`
                : '为本平台启用账号发起签到批次')
            : unavailableLabel(capability, 'checkin') ?? '签到不可用'}
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
            尚无{appLabel(app)}账号{usable ? '' : '；该客户端能力未验证，暂不可捕获'}。点「读取本机账号」或「捕获当前账号」后列出。
          </p>
        ) : (
          <>
            <p data-testid={`accounts-summary-${app}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
              共 {accounts.length} 个账号，其中 {checkinAccounts.length} 个启用并参与一键签到
              <span className="ml-1">· 今日已完成 {summary.done}/{summary.total}（本地记录，{today}）</span>
            </p>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account as AccountView}
                  capability={capability}
                  muted={!capabilityKnown}
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
          {/* ACC-KB-B2W：协议级「添加账号」（与捕获并列；未装配协议的平台只给 reason 文案，不给按钮） */}
          <AddAccountEntry app={app as ManagedAppId} />
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
      </div>
    </div>
  );
}

/** CLI-IMPORT：服务端只回脱敏字段（action + 身份指纹），不含 key / credential_ref */
interface CliCredentialImportResult {
  app_id: string;
  action: 'created' | 'updated';
  account: PublicCliAccount;
}

/** Codex 的导入对象（OAuth 令牌 / API key）尚未确定，入口保留但禁用并给出可见原因 */
const CLI_IMPORT_UNSUPPORTED: Record<string, string> = {
  codex: 'Codex 导入对象尚未确定（OAuth 令牌 / API key 待验证），暂不支持导入',
};

/** ACC-CC-5：CLI 账号来源文案（不新增色相，只用文字芯片） */
const CLI_ACCOUNT_SOURCE_LABEL: Record<'local' | 'manual', string> = {
  local: '本机发现',
  manual: '手动添加',
};

/**
 * ACC-CC-5：单条 CLI 账号（脱敏）。
 * 删除是两步流；本机发现的账号会提示「删掉还会被重新登记」，避免用户误以为删除能清掉本机凭据。
 */
function CliSourceAccountItem({ source, account }: { source: string; account: PublicCliAccount }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.del<{ deleted: true }>(`/api/cli-accounts/${account.id}`),
    onSuccess: () => {
      setConfirming(false);
      setErrorCode(null);
      void queryClient.invalidateQueries({ queryKey: ['cli-accounts'] });
    },
    onError: (error) => {
      setConfirming(false);
      setErrorCode(reasonCodeOf(error));
    },
  });
  return (
    <li
      data-testid={`accounts-source-item-${account.id}`}
      className="rounded-md bg-surface-raised px-2 py-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11px] text-ink" title="身份指纹（不可逆哈希前缀，不是 key）">
          {account.identity_hint}
        </span>
        {account.source !== undefined && (
          <span
            data-testid={`accounts-source-kind-${account.id}`}
            data-source={account.source}
            className="rounded border border-hairline px-1 text-[10px] text-ink-3"
          >
            {CLI_ACCOUNT_SOURCE_LABEL[account.source]}
          </span>
        )}
        <span className="text-[11px] text-ink-3">最近发现 {new Date(account.last_seen_at).toLocaleString()}</span>
        <button
          type="button"
          data-testid={`accounts-source-delete-${account.id}`}
          className="ml-auto rounded border border-hairline px-1.5 py-0.5 text-[11px] text-red-600 ab-transition hover:bg-surface-card disabled:opacity-40 dark:text-red-400"
          disabled={remove.isPending}
          onClick={() => {
            setErrorCode(null);
            setConfirming(true);
          }}
        >
          删除
        </button>
      </div>
      {confirming && (
        <div data-testid={`accounts-source-delete-confirm-${account.id}`} role="group" aria-label="确认删除该 CLI 账号">
          <p className="mt-1 text-[11px] text-ink">
            {account.source === 'local'
              ? '该账号的凭据仍在本机文件里：删除记录后，下次读取本机账号会重新登记；本机文件不会被改动。'
              : '删除该记录并回收 AgentBoard 保存的凭据密文，删除后不可恢复。'}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid={`accounts-source-delete-yes-${account.id}`}
              className="rounded border border-hairline px-1.5 py-0.5 text-[11px] font-medium text-red-600 ab-transition hover:bg-surface-card disabled:opacity-40 dark:text-red-400"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? '删除中…' : '确认删除'}
            </button>
            <button
              type="button"
              data-testid={`accounts-source-delete-cancel-${account.id}`}
              className="rounded px-1.5 py-0.5 text-[11px] text-ink-2 ab-transition hover:bg-surface-card"
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {errorCode !== null && (
        <p
          role="alert"
          data-testid={`accounts-source-delete-error-${account.id}`}
          title={errorCode}
          className="mt-1 text-[11px] text-red-600 dark:text-red-400"
        >
          删除失败：{reasonLabel(errorCode)}（{source}）
        </p>
      )}
    </li>
  );
}

/**
 * 需求 2 / ACC-CLI-MULTI：CLI 额度来源选中后的详情。
 * 只列脱敏身份指纹（哈希前缀），不显示 key / credential_ref；
 * CLI-IMPORT 起提供「导入凭据」入口（粘贴文本或选文件，一次一份），成功/重复/失败都有可见反馈。
 * 仍不提供切换按钮——写入校验未落地前保持能力禁用（见 CLI-SWITCH）。
 */
function QuotaSourceDetail({
  source,
  accounts,
  errorMessage,
  emptyHint,
  header,
  importPlaceholder,
  importLabel,
  switchNote,
}: {
  source: string;
  accounts: PublicCliAccount[];
  errorMessage: string | null;
  /** 空态文案按来源覆盖（Command Code 的未安装 / 无文件 / 格式未识别必须分开说） */
  emptyHint?: string;
  /** 列表上方的来源专属内容（Command Code 用它放真实能力矩阵） */
  header?: ReactNode;
  importPlaceholder?: string;
  /** 导入入口文案（Command Code 用「添加 API Key」；其余来源沿用通用说法） */
  importLabel?: string;
  switchNote?: string;
}) {
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; duplicate: boolean; message: string } | null>(null);
  const unsupportedReason = CLI_IMPORT_UNSUPPORTED[source] ?? null;
  const importMutation = useMutation({
    mutationFn: (credential: string) =>
      api.post<CliCredentialImportResult>('/api/cli-accounts/import', { app_id: source, credential }),
    onSuccess: (result) => {
      // 成功后立刻清空输入，凭据明文不留在界面上
      setDraft('');
      setNotice(result.action === 'updated'
        ? { tone: 'ok', duplicate: true, message: `已存在，已刷新最近发现时间（${result.account.identity_hint}）` }
        : { tone: 'ok', duplicate: false, message: `导入成功（${result.account.identity_hint}）` });
      void queryClient.invalidateQueries({ queryKey: ['cli-accounts'] });
    },
    onError: (error) => {
      setNotice({ tone: 'error', duplicate: false, message: error instanceof Error ? error.message : '导入失败' });
    },
  });
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setNotice(null);
    try {
      setDraft(await file.text());
    } catch {
      setNotice({ tone: 'error', duplicate: false, message: '文件读取失败：请重试或直接粘贴凭据' });
    }
  };
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      {header}
      {errorMessage !== null ? (
        <p data-testid={`accounts-source-error-${source}`} role="alert" className="text-red-600 dark:text-red-400">
          读取本机 CLI 凭据失败：{errorMessage}
        </p>
      ) : accounts.length === 0 ? (
        <p data-testid={`accounts-source-empty-${source}`} className="text-ink-3">
          {emptyHint ?? '本机未发现该来源的凭据（Codex 没有可枚举的凭据，恒为 0）。'}
        </p>
      ) : (
        <ul data-testid={`accounts-source-list-${source}`} className="space-y-1">
          {accounts.map((account) => (
            <CliSourceAccountItem key={account.id} source={source} account={account} />
          ))}
        </ul>
      )}

      {accounts.some((account) => account.source === 'local') && (
        <p data-testid={`accounts-source-local-hint-${source}`} className="text-[11px] text-ink-3">
          标为「本机发现」的账号，凭据仍在本机文件里：删除后下次读取本机账号会重新登记。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          data-testid={`accounts-source-import-${source}`}
          className={BUTTON_SECONDARY}
          disabled={unsupportedReason !== null}
          aria-expanded={importOpen}
          onClick={() => {
            setImportOpen((open) => !open);
            setNotice(null);
          }}
        >
          {importLabel ?? '导入凭据'}
        </button>
        {unsupportedReason !== null && (
          <span data-testid={`accounts-source-import-reason-${source}`} className="text-ink-3">
            {unsupportedReason}
          </span>
        )}
      </div>

      {importOpen && unsupportedReason === null && (
        <div
          data-testid={`accounts-source-import-form-${source}`}
          className="space-y-1.5 rounded-md border border-hairline bg-surface-card p-2"
        >
          <textarea
            data-testid={`accounts-source-import-text-${source}`}
            className={FIELD_CLASS + ' h-16 w-full py-1 font-mono text-[11px]'}
            value={draft}
            placeholder={importPlaceholder ?? '粘贴 API key（一次一份；也可从 api_key / DEEPSEEK_API_KEY 字段中解析）'}
            onChange={(event) => {
              setDraft(event.target.value);
              setNotice(null);
            }}
          />
          <input
            type="file"
            data-testid={`accounts-source-import-file-${source}`}
            className="block w-full text-[11px] text-ink-3"
            accept=".txt,.toml,.json,.yaml,.yml,.env"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid={`accounts-source-import-submit-${source}`}
              className={BUTTON_PRIMARY}
              disabled={importMutation.isPending || draft.trim().length === 0}
              onClick={() => importMutation.mutate(draft)}
            >
              {importMutation.isPending ? '导入中…' : '导入'}
            </button>
            <button
              type="button"
              data-testid={`accounts-source-import-cancel-${source}`}
              className={BUTTON_SECONDARY}
              onClick={() => {
                setImportOpen(false);
                setDraft('');
                setNotice(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {notice !== null && (
        <p
          data-testid={
            notice.tone === 'error'
              ? `accounts-source-import-error-${source}`
              : notice.duplicate
                ? `accounts-source-import-duplicate-${source}`
                : `accounts-source-import-success-${source}`
          }
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-ink'}
        >
          {notice.message}
        </p>
      )}

      <p data-testid={`accounts-source-switch-note-${source}`} className="text-ink-3">
        {switchNote ?? '暂不支持切换：需先支持导入与写入校验（见 CLI-IMPORT / CLI-SWITCH）。'}
      </p>
    </div>
  );
}

/**
 * ACC-CC-2 / ACC-CC-3：Command Code（CLI 来源）右栏详情。
 *
 * 能力来自服务端真实探测（安装 / auth.json 可读性），未安装、无凭据文件、格式未识别分别给原因，
 * 不伪造账号。导入入口开放（粘贴 Studio API key 或 COMMAND_CODE_API_KEY=…）；
 * 切换与签到只给原因，不渲染按钮——「未实测的写回」不允许出现点了没反应的入口。
 */
function CommandCodeSourceDetail({ accounts }: { accounts: PublicCliAccount[] }) {
  const { capability, isPending, isError, errorMessage } = useCommandCodeCapability();
  const dimensions = [
    {
      key: 'capture',
      label: '读取本机',
      available: capability?.capture === true,
      code: capability === null ? null : capability.capture ? null : capability.capture_reason_code,
    },
    {
      key: 'switch',
      label: '切换账号',
      available: capability?.switch === true,
      code: capability === null ? null : capability.switch ? null : capability.switch_reason_code,
    },
    {
      key: 'checkin',
      label: '签到',
      available: capability?.checkin === true,
      code: capability === null ? null : capability.checkin ? null : capability.checkin_reason_code,
    },
  ] as const;
  return (
    <QuotaSourceDetail
      source="commandcode"
      accounts={accounts}
      errorMessage={null}
      header={
        <>
          <p data-testid="accounts-source-note-commandcode" className="text-ink-3">
            Command Code 属 CLI 来源（本机凭据固定在 ~/.commandcode/auth.json）。能力按服务端实时探测展示；写回等价性与签到语义未成立，故切换/签到固定不可用。
          </p>
          {isError && (
            <p data-testid="accounts-source-cap-error-commandcode" role="alert" className="text-red-600 dark:text-red-400">
              能力状态读取失败：{errorMessage ?? '未知错误'}（不展示猜测值）
            </p>
          )}
          <ul data-testid="accounts-source-capabilities-commandcode" className="space-y-1">
            {dimensions.map((dimension) => {
              const technicalCode = capability !== null && !dimension.available && dimension.code !== null
                ? reasonTechnicalCode(dimension.code)
                : null;
              return (
                <li
                  key={dimension.key}
                  data-testid={`accounts-source-cap-commandcode-${dimension.key}`}
                  data-available={String(dimension.available)}
                  className="flex flex-wrap items-center gap-x-2"
                >
                  <span className="text-ink">{dimension.label}</span>
                  <span className="text-ink-3">
                    {dimension.available
                      ? '可用'
                      : isPending
                        ? '能力检测中…'
                        : reasonLabel(dimension.code ?? 'CAPABILITY_UNKNOWN')}
                  </span>
                  {technicalCode !== null && (
                    <details data-testid={`accounts-source-cap-code-commandcode-${dimension.key}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      <summary className="cursor-pointer select-none">技术码</summary>
                      <code className="font-mono">{technicalCode}</code>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      }
      emptyHint={commandCodeEmptyHint(capability)}
      importLabel="添加 API Key"
      importPlaceholder="粘贴 Studio API key（一次一份；也可粘贴 COMMAND_CODE_API_KEY=…）"
      switchNote="切换与签到入口不开放：写回 auth.json 是否等价于有效登录态未验证；Command Code 没有签到功能。"
    />
  );
}
