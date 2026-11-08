/**
 * 账号管理主从面板（ACC-B1 主从布局 + ACC-UI-PRUNE 精简 + ACC-UI-TOPBAR 顶栏化）。
 * 能力一律以服务端能力矩阵为准；数据只来自脱敏接口，不显示 identity_hash / 快照 ref / token / 路径。
 *
 * ACC-UI-PRUNE（2026-11-07）剔除：顶部「当前：账号名」提示条、平台容器头部行（含平台层签到按钮与签到芯片）、
 * 平台层与账号行「技术信息」折叠、「积分 未接入」徽标、账号行「签到当前」芯片与「签到」按钮、添加账号旁的
 * 链路标签、脱敏声明与刷新旁说明、「今日 x/x」合计。
 *
 * ACC-UI-TOPBAR（2026-11-07）：操作上标题栏、去两处字样——
 * - 顶栏（drawer 标题栏「账号管理 … 关闭」一行，关闭左侧）依次渲染「添加」（原平台行「添加账号」改名，
 *   只对选中平台且装配了协议的平台出现）、「一键签到」（次级样式）、「刷新」；有 drawer 宿主时经
 *   Portal 渲进标题栏，独立渲染（单测/无宿主）回退为面板顶部 `accounts-toolbar` 一行。
 * - 删除：底部操作行与「N 个平台 / N 个可签到账号」计划摘要（`accounts-one-click-plan` 不再渲染）、
 *   平台容器「其中 N 个启用并参与一键签到」次级说明（`accounts-summary-*`）、
 *   「捕获当前账号」按钮及捕获 notice（workbuddy/trae 免登录捕获 UI 入口移除；API 保留，添加账号向导仍可用）。
 * - 保留：导入结果框（点刷新后的「发现 N 个账号…」明细，含失败原因，挂在面板底部）、
 *   左栏平台索引、账号行元素与 ⋯ 菜单、能力三图标徽标（✓✗?）。
 *
 * 结构：标题栏动作（Portal 或回退行）→ 主从布局（左栏平台索引 + 右栏选中平台详情）→ 导入结果 → 一键签到结果。
 *
 * testid 口径：`accounts-app-*` / `accounts-body-*` / `accounts-empty-*` / `accounts-capability-badge-*`
 * （能力三图标）保留；`accounts-add-<app>`（顶栏添加入口）/ `accounts-add-panel-*`（向导在平台体内）沿用；
 * ADD-FLOW-1 新增：`accounts-add-toggle`（全局「添加账号」）/ `accounts-add-picker`（7 卡选择页）/
 * `accounts-add-moved-<app>`（平台底部指路文案）；
 * 已删 testid：`accounts-toggle-*` / `accounts-count-*` / `accounts-checkin-chip-*` / `accounts-checkin-all-*` /
 * `accounts-credit-*` / `accounts-checkin-current-*` / `accounts-tech-*` / `accounts-detail-current` /
 * `accounts-add-flow-*` / `accounts-desensitize-note` / `accounts-today-summary` /
 * `accounts-summary-*` / `accounts-capture-*` / `accounts-notice-*`。
 */
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QUOTA_GROUPS, type ManagedAppId, type PublicCliAccount, type PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { DrawerHeaderActionsContext } from '../drawer/drawerHeaderActions';
import { AccountCard, type AccountView } from './AccountCard';
import { CapabilityBadges } from './CapabilityBadges';
import { LocalAccountsImportButton, LocalAccountsImportResult, useLocalAccountsImport } from './LocalAccountsImport';
import { OneClickCheckinButton, OneClickCheckinResults, useOneClickCheckin } from './OneClickCheckin';
import { QuotaDetail } from './QuotaDetail';
import {
  APP_ORDER,
  appLabel,
  COMMANDCODE_SOURCE_LABEL,
  commandCodeEmptyHint,
  useCommandCodeCapability,
  isOfflineApp,
  localDayKey,
  platformMeta,
  reasonCodeOf,
  reasonLabel,
  reasonTechnicalCode,
  summarizeCheckinToday,
  unavailableLabel,
  unavailableReason,
  useAccountCapabilities,
  type CapabilityView,
  type CheckinTodaySummary,
} from './accountCapabilities';
import { fetchAddAccountProtocols } from './addAccountApi';
import { AddAccountPicker } from './AddAccountPicker';
import { AddAccountEntry } from './AddAccountWizard';
import { AccountsMasterDetail, type PlatformIndexItem } from './AccountsMasterDetail';

/** 需求 2：CLI 额度来源并入同一平台列表时的短标签（长标签仍用于额度详情） */
const CLI_SOURCE_ROW_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode-Go',
  codex: 'Codex',
  commandcode: COMMANDCODE_SOURCE_LABEL,
};

export function AccountsPanel() {
  // ACC-UI-TOPBAR：drawer 标题栏操作区宿主；无宿主（单测/独立渲染）时回退为面板顶部内联操作行
  const actionsHost = useContext(DrawerHeaderActionsContext);
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
  /** ACC-HEADER：一键签到按钮在标题栏，状态与结果分离渲染 */
  const oneClick = useOneClickCheckin({ accounts, capabilities: caps.capabilities, capabilityKnown });
  /** ACC-UI-TOPBAR：刷新按钮上标题栏；导入结果框留在面板底部（同一份状态） */
  const importer = useLocalAccountsImport();
  /** 顶栏「添加」可用性：与平台内向导共用同一份协议清单（同一 queryKey → 一次请求、全局缓存） */
  const protocols = useQuery({
    queryKey: ['add-account-protocols'],
    queryFn: fetchAddAccountProtocols,
    staleTime: 60_000,
  });

  // 选中平台上提到面板：顶栏「添加」作用于右栏当前平台；切平台即关向导
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** ADD-FLOW-1：全局「添加账号」→ 供应商选择页；平台级「添加」只作用于选中平台，零账号平台靠这里进入 */
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  /**
   * ACC-TOKEN-3：刷新凭据收到 409 CREDENTIAL_RELOGIN_REQUIRED → 打开该平台的添加账号向导重新登录。
   * 复用顶栏「添加」的同一份受控向导状态（addOpen + selectedApp）：选中该平台并打开；
   * 关闭回调与顶栏「添加」共用 onWizardClose。向导 authorized 后已有失效重拉逻辑，徽标自动恢复。
   */
  const openReloginWizard = useCallback((app: string) => {
    setSelectedApp(app);
    setAddOpen(true);
  }, []);
  /**
   * 右栏当前平台（ACC-UI-TOPBAR 起顶栏动作需要它）。
   * 未选择时默认第一项：indexItems 的 known 段（APP_ORDER）恒非空且排最前，故首项恒为 `APP_ORDER[0]`。
   */
  const activeApp = selectedApp ?? APP_ORDER[0] ?? '';

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
            wizardOpen={addOpen && activeApp === app}
            onWizardClose={() => setAddOpen(false)}
            onReloginRequired={openReloginWizard}
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
  }, [accounts, accountsByApp, extraApps, summaries, caps.capabilities, capabilityKnown, today, cliAccounts, cliError, addOpen, activeApp, openReloginWizard]);

  /** 顶栏「添加」只对装配了协议的当前平台出现（不可用给面板内 reason 文案，不给必败按钮） */
  const activeProtocol = protocols.data?.items.find((item) => item.app_id === activeApp) ?? null;

  /** 标题栏动作（添加账号 / 添加 / 一键签到 / 刷新，依次排在关闭左侧；次级样式不抢关闭） */
  const headerActions = (
    <>
      <button
        type="button"
        data-testid="accounts-add-toggle"
        className={BUTTON_SECONDARY}
        aria-expanded={addPickerOpen}
        title="选择供应商添加账号（含左栏还没有账号的平台）"
        onClick={() => setAddPickerOpen((previous) => !previous)}
      >
        添加账号
      </button>
      {activeProtocol !== null && (
        <button
          type="button"
          data-testid={`accounts-add-${activeApp}`}
          className={BUTTON_SECONDARY}
          title={`通过 ${appLabel(activeApp as ManagedAppId)} 的官方授权流程添加账号（不需要客户端在跑）`}
          onClick={() => setAddOpen(true)}
        >
          添加
        </button>
      )}
      <OneClickCheckinButton controller={oneClick} variant="secondary" />
      <LocalAccountsImportButton controller={importer} />
    </>
  );

  return (
    <section aria-label="账号管理">
      {caps.isError && (
        <p role="alert" data-testid="accounts-capabilities-error" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          能力矩阵读取失败：{caps.errorMessage ?? '未知错误'}；为避免误操作，切换/签到均已禁用
        </p>
      )}
      {caps.isPending && <p data-testid="accounts-capabilities-loading" className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">读取能力矩阵…</p>}

      {list.isPending && <p data-testid="accounts-list-loading" className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">读取托管账号…</p>}
      {list.isError && (
        <p role="alert" data-testid="accounts-list-error" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error instanceof Error ? list.error.message : '读取托管账号失败'}
        </p>
      )}

      {/* ACC-UI-TOPBAR：有 drawer 宿主 → 标题栏 Portal；无宿主 → 面板顶部回退行（testid 沿用 accounts-toolbar） */}
      {actionsHost !== null
        ? createPortal(headerActions, actionsHost)
        : (
          <div data-testid="accounts-toolbar" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {headerActions}
          </div>
        )}

      {addPickerOpen && <AddAccountPicker onClose={() => setAddPickerOpen(false)} />}

      {!list.isPending && !list.isError && (
        <AccountsMasterDetail
          items={indexItems}
          selected={activeApp}
          onSelect={(app) => {
            setSelectedApp(app);
            setAddOpen(false);
          }}
        />
      )}

      {/* ACC-UI-TOPBAR：导入结果框（含手动刷新失败原因）不随按钮上顶栏，留在面板底部原区域 */}
      <div className="mt-3 empty:hidden">
        <LocalAccountsImportResult controller={importer} />
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
  wizardOpen,
  onWizardClose,
  onReloginRequired,
}: {
  app: string;
  capability: CapabilityView | null;
  capabilityKnown: boolean;
  accounts: PublicManagedAccount[];
  /** 顶栏「添加」打开的向导（ACC-UI-TOPBAR：入口按钮在标题栏，向导面板仍在平台体内） */
  wizardOpen: boolean;
  onWizardClose: () => void;
  /** ACC-TOKEN-3：账号行刷新凭据需重新登录时，打开该平台的添加账号向导（受控状态在 AccountsPanel） */
  onReloginRequired: (appId: ManagedAppId) => void;
}) {
  return (
    <div data-testid={`accounts-app-${app}`}>
      <div data-testid={`accounts-body-${app}`} className="pb-3">
        {/* ACC-UI-2：能力三图标（「其中 N 个参与一键签到」次级说明已随 ACC-UI-TOPBAR 删除） */}
        <CapabilityBadges app={app} capability={capability} />

        {/* ACC-UI-2：不可用原因可见——切换没有可点按钮时，用文字说明原因与出路 */}
        {capability !== null && capability.switch !== true && (
          <p
            data-testid={`accounts-switch-unavailable-${app}`}
            className="mt-1 text-[11px] text-ink-3"
            title={`${unavailableLabel(capability, 'switch') ?? '切换不可用'} · ${unavailableReason(capability, 'switch') ?? '能力未知'}，需在客户端手动切换`}
          >
            切换不可用：{unavailableLabel(capability, 'switch') ?? '原因未知'}，需在客户端手动切换
          </p>
        )}

        {accounts.length === 0 ? (
          <p data-testid={`accounts-empty-${app}`} className="mt-1 rounded-md border border-dashed border-neutral-300 px-3 py-3 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            尚无{appLabel(app)}账号。点顶栏「添加」或「刷新」后列出。
          </p>
        ) : (
          <div className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account as AccountView}
                capability={capability}
                muted={!capabilityKnown}
                onReloginRequired={onReloginRequired}
              />
            ))}
          </div>
        )}

        {/* ACC-KB-B2W / ACC-UI-TOPBAR：协议级「添加账号」入口在标题栏；这里渲染向导面板与能力不可用文案 */}
        <AddAccountEntry app={app as ManagedAppId} wizardOpen={wizardOpen} onWizardClose={onWizardClose} />

        {/* ADD-FLOW-1（原型 Q2=A）：行内加号迁出后只留一句指路，不在平台体里放第二个添加入口 */}
        <p data-testid={`accounts-add-moved-${app}`} className="mt-1 text-[11px] text-ink-3">
          添加账号已移到顶部「添加账号」
        </p>
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
