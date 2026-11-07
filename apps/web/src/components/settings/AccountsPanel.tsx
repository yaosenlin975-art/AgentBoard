/**
 * 账号管理主从面板（ACC-B1 主从布局 + ACC-UI-PRUNE 精简）。
 * 能力一律以服务端能力矩阵为准；数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
 *
 * ACC-UI-PRUNE（2026-11-07）剔除：顶部「当前：账号名」提示条、平台容器头部行（含平台层签到按钮与签到芯片）、
 * 平台层与账号行「技术信息」折叠、「积分 未接入」徽标、账号行「签到当前」芯片与「签到」按钮、添加账号旁的
 * 链路标签、脱敏声明与刷新旁说明、「今日 x/x」合计。签到统一走工具栏「一键签到」（单账号/单平台签到入口已删）。
 *
 * 结构：主从布局（左栏平台索引 + 右栏选中平台详情）→ 工具栏（一键签到计划/按钮 + 刷新）→ 一键签到结果。
 * 保留：左栏平台索引（导航 + 今日健康态）、账号行身份展示 + 切换 + ⋯ 菜单（停用/删除）、捕获当前账号、
 * 添加账号、刷新、「N 个平台 / M 个可签到账号」计划摘要。
 *
 * testid 口径：`accounts-app-*` / `accounts-body-*` / `accounts-summary-*` / `accounts-empty-*` /
 * `accounts-capture-*` / `accounts-notice-*` / `accounts-capability-badge-*`（能力三图标）保留；
 * 已删 testid：`accounts-toggle-*` / `accounts-count-*` / `accounts-checkin-chip-*` / `accounts-checkin-all-*` /
 * `accounts-credit-*` / `accounts-checkin-current-*` / `accounts-tech-*` / `accounts-detail-current` /
 * `accounts-add-flow-*` / `accounts-desensitize-note` / `accounts-today-summary`。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QUOTA_GROUPS, type ManagedAppId, type PublicCliAccount, type PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { AccountCard, type AccountView } from './AccountCard';
import { CapabilityBadges } from './CapabilityBadges';
import { LocalAccountsImport } from './LocalAccountsImport';
import { OneClickCheckinButton, OneClickCheckinPlan, OneClickCheckinResults, useOneClickCheckin } from './OneClickCheckin';
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
  unavailableReason,
  useAccountCapabilities,
  type CapabilityView,
  type CheckinTodaySummary,
} from './accountCapabilities';
import { AddAccountEntry } from './AddAccountWizard';
import { AccountsMasterDetail, type PlatformIndexItem } from './AccountsMasterDetail';

/** 需求 2：CLI 额度来源并入同一平台列表时的短标签（长标签仍用于额度详情） */
const CLI_SOURCE_ROW_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode-Go',
  codex: 'Codex',
  commandcode: COMMANDCODE_SOURCE_LABEL,
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
  /** ACC-HEADER：一键签到按钮在工具栏，状态与结果分离渲染 */
  const oneClick = useOneClickCheckin({ accounts, capabilities: caps.capabilities, capabilityKnown });

  const today = localDayKey(Date.now());
  const accountsByApp = APP_ORDER.map((app) => accounts.filter((account) => account.app_id === app));
  const summaries = APP_ORDER.map((app, index) => summarizeCheckinToday(accountsByApp[index]!, caps.capabilities[app] ?? null, today));

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

  /**
   * ACC-B1：左栏平台索引项 = APP_ORDER（六平台）+ 「其它平台」（不静默丢卡）。
   * 右栏只渲染选中平台的 PlatformRow —— 从结构上消除六平台同屏堆叠。
   */
  const indexItems: PlatformIndexItem[] = useMemo(() => {
    const build = (app: string, appAccounts: AccountView[], summary: CheckinTodaySummary): PlatformIndexItem => {
      return {
        app,
        label: platformMeta(app as ManagedAppId).label,
        accountCount: appAccounts.length,
        done: summary.done,
        total: summary.total,
        render: () => (
          <PlatformRow
            app={app}
            capability={caps.capabilities[app as ManagedAppId] ?? null}
            capabilityKnown={capabilityKnown}
            accounts={appAccounts}
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
      accountCount: commandCodeAccounts.length,
      done: 0,
      total: 0,
      render: () => <CommandCodeSourceDetail accounts={commandCodeAccounts} />,
    });
    return [...known, ...extras, ...sources];
  }, [accounts, accountsByApp, extraApps, summaries, caps.capabilities, capabilityKnown, today, cliAccounts, cliError]);

  return (
    <section aria-label="账号管理">
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

      {/* ACC-UI-PRUNE：工具条在主从内容之后，只留一键签到计划/按钮与刷新 */}
      <div data-testid="accounts-toolbar" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <OneClickCheckinPlan controller={oneClick} />
        <OneClickCheckinButton controller={oneClick} />
        <LocalAccountsImport />
      </div>

      <div data-testid="accounts-one-click-results" className="mb-2 empty:hidden">
        <OneClickCheckinResults controller={oneClick} />
      </div>
    </section>
  );
}

function PlatformRow({
  app,
  capability,
  capabilityKnown,
  accounts,
}: {
  app: string;
  capability: CapabilityView | null;
  capabilityKnown: boolean;
  accounts: PublicManagedAccount[];
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<AppNotice | null>(null);

  const capture = useMutation({
    mutationFn: () => api.post<{ account: PublicManagedAccount }>(`/api/managed-accounts/${app}/capture-current`, {}),
    onSuccess: () => {
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (e) => setNotice(noticeOf(reasonCodeOf(e), e instanceof Error ? e.message : '捕获失败')),
  });

  const usable = capability ? capability.capture || capability.switch : false;
  // ACC-CHECKIN：一键签到只提交可参与账号（缺凭据/不支持签到的账号跳过）；单账号/单平台签到入口已删
  const enabledAccounts = accounts.filter((account) => account.enabled !== false);
  const checkinAccounts = enabledAccounts.filter((account) => checkinParticipation(account, capability).participates);

  return (
    <div data-testid={`accounts-app-${app}`}>
      <div data-testid={`accounts-body-${app}`} className="pb-3">
        {/* ACC-UI-2：能力三图标 + 参与签到数的次级说明（「技术信息」折叠与积分徽标已删） */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CapabilityBadges app={app} capability={capability} />
          {accounts.length > 0 && (
            <p data-testid={`accounts-summary-${app}`} className="text-[11px] text-ink-3">
              其中 {checkinAccounts.length} 个启用并参与一键签到
            </p>
          )}
        </div>

        {/* ACC-UI-2：不可用原因可见——捕获/切换没有可点按钮时，用文字说明原因与出路 */}
        {capability !== null && capability.capture !== true && (
          <p className="mt-1 text-[11px] text-ink-3">
            捕获不可用：{unavailableLabel(capability, 'capture') ?? '原因未知'}，只读展示已有记录。
          </p>
        )}
        {capability !== null && capability.switch !== true && (
          <p
            data-testid={`accounts-switch-unavailable-${app}`}
            className="mt-0.5 text-[11px] text-ink-3"
            title={`${unavailableLabel(capability, 'switch') ?? '切换不可用'} · ${unavailableReason(capability, 'switch') ?? '能力未知'}，需在客户端手动切换`}
          >
            切换不可用：{unavailableLabel(capability, 'switch') ?? '原因未知'}，需在客户端手动切换
          </p>
        )}

        {accounts.length === 0 ? (
          <p data-testid={`accounts-empty-${app}`} className="mt-1 rounded-md border border-dashed border-neutral-300 px-3 py-3 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            尚无{appLabel(app)}账号{usable ? '' : '；该客户端能力未验证，暂不可捕获'}。点「读取本机账号」或「捕获当前账号」后列出。
          </p>
        ) : (
          <div className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account as AccountView}
                capability={capability}
                muted={!capabilityKnown}
              />
            ))}
          </div>
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
