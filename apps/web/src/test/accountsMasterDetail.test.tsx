/**
 * ACC-B1：账号面板主从布局（左栏平台索引 + 右栏单平台容器）。
 *
 * 取代旧「六行总览 + 展开层」的断言（方向 C 已废弃，旧口径不再保留双份）：
 * - 左栏索引只列**有账号**的平台/来源（ADD-FLOW-2 口径 A；有账号的未知平台仍不静默丢卡），每项带账号数与今日签到健康态；
 * - 默认选中第一个平台；右栏**只渲染选中平台**，切走后旧平台内容消失；
 * - 键盘：↑/↓/←/→ 切换，Home/End 跳首尾，`aria-selected` 同步；
 * - 额度行不再混进平台列表，落在左栏 footer（`accounts-quota-rows`）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { localDayKey } from '../components/settings/accountCapabilities';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };
const TODAY = localDayKey(Date.now());

function account(id: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id, app_id: 'workbuddy_desktop', client_instance_id: `inst-${id}`, service_region: 'cn',
    display_name: `账号 ${id}`, identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported',
    enabled: true, last_checkin_day: null, last_checkin_status: null, last_checkin_at: null,
    created_at: 1, updated_at: 2, is_current: false, ...overrides,
  };
}

const CAPS: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
];

const QUOTA = {
  workspace_id: null,
  fetched_at: 1_700_000_000_000,
  items: [
    { source: 'deepseek', status: 'ok', balance: 751.81, unit: 'CNY', windows: [], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
  ],
};

function mockBase(accounts: AccountView[], caps: AccountCapability[] = CAPS): void {
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(caps)),
    http.get('/api/managed-accounts', () => HttpResponse.json(accounts)),
    http.get('/api/managed-account-quotas', () => HttpResponse.json(QUOTA)),
    http.get('/api/account-operations', () => HttpResponse.json([])),
  );
}

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => server.resetHandlers());

describe('账号面板主从布局（ACC-B1）', () => {
  it('ACC-UI-PRUNE：详情头「当前：…」提示条不再渲染，详情直接从平台内容开始', async () => {
    mockBase([account('wb-1', { is_current: true })]);
    renderPanel();

    await screen.findByTestId('accounts-body-workbuddy_desktop');
    expect(screen.queryByTestId('accounts-detail-current')).toBeNull();
    expect(screen.queryByText(/当前：/)).toBeNull();
  });

  it('左栏索引：只列有账号的平台（口径 A），行带指标（方向 B）；默认选中第一个平台', async () => {
    mockBase([
      account('wb-1', { is_current: true }),
      account('wb-2'),
      account('mm-1', { app_id: 'minimax' }),
      account('qd-1', { app_id: 'qoder_cn' }),
      account('cb-1', { app_id: 'codebuddy_desktop' }),
    ]);
    renderPanel();

    const index = await screen.findByTestId('accounts-index');
    const items = within(index).getAllByRole('tab');
    // ADD-FLOW-2：有账号的 workbuddy / minimax + 其它平台 qoder_cn；零账号的 trae 与无登记的 CLI 来源都不占行；
    // Codex 按 0f76c59a 常驻（零账号时显示本机登录空态）
    expect(items.map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax', 'qoder_cn', 'codex']);
    // 已下线平台即使有历史账号也不出现（ACC-14 口径不变）
    expect(screen.queryByTestId('accounts-index-item-codebuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-index-item-trae')).toBeNull();

    // 方向 B：指标行取代账号数/健康角标（两账号今日均未签到 → 0/2 中性；无参与时才给「无参与账号」）
    expect(screen.getByTestId('accounts-index-metric-workbuddy_desktop')).toHaveTextContent('0/2');
    expect(screen.getByTestId('accounts-index-metric-minimax')).toHaveTextContent('0/1');
    expect(screen.queryByTestId('accounts-index-count-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-detail-current')).toBeNull();

    // 默认选中第一个
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'false');

    // 额度面板整块移除；CLI 三来源无登记账号 → 不占行（有账号时才以平台行形态并入，见 accountsCliRows）
    expect(screen.queryByTestId('accounts-quota-rows')).toBeNull();
    expect(screen.queryByTestId('quota-rows')).toBeNull();
    expect(screen.queryByTestId('accounts-overview')).toBeNull();
    for (const app of ['deepseek', 'opencode_go', 'commandcode']) {
      expect(screen.queryByTestId(`accounts-index-item-${app}`)).toBeNull();
    }
    // ACC-UI-TOPBAR：操作回退行在主从内容之前（drawer 里则 Portal 进标题栏）
    const toolbar = screen.getByTestId('accounts-toolbar');
    const master = screen.getByTestId('accounts-master-detail');
    expect(toolbar.compareDocumentPosition(master) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('右栏只渲染选中平台：切平台后旧平台账号消失', async () => {
    mockBase([
      account('wb-1', { display_name: '工作伙伴账号' }),
      account('mm-1', { app_id: 'minimax', display_name: '海螺账号' }),
    ]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    const detail = screen.getByTestId('accounts-detail');
    expect(within(detail).getByText(/工作伙伴账号/)).toBeInTheDocument();
    expect(within(detail).queryByText(/海螺账号/)).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-index-item-minimax'));
    await waitFor(() => expect(within(screen.getByTestId('accounts-detail')).getByText(/海螺账号/)).toBeInTheDocument());
    expect(within(screen.getByTestId('accounts-detail')).queryByText(/工作伙伴账号/)).toBeNull();
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'false');
  });

  it('键盘：↓/→ 前进、↑ 后退、Home/End 跳首尾，且焦点跟随', async () => {
    mockBase([account('wb-1'), account('mm-1', { app_id: 'minimax' }), account('tr-1', { app_id: 'trae' })]);
    renderPanel();

    const first = await screen.findByTestId('accounts-index-item-workbuddy_desktop');
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByTestId('accounts-index-item-minimax'));

    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{End}');
    // ADD-FLOW-2：列表只含有账号的平台；Codex 按 0f76c59a 常驻，是列表末尾
    expect(screen.getByTestId('accounts-index-item-codex')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
  });

  it('ADD-FLOW-2：workbuddy 2 + minimax 1 时左栏只有这两项（Codex 常驻），零账号平台与来源都不占行', async () => {
    mockBase([account('wb-1'), account('wb-2'), account('mm-1', { app_id: 'minimax' })]);
    renderPanel();

    const index = await screen.findByTestId('accounts-index');
    expect(within(index).getAllByRole('tab').map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax', 'codex']);
    expect(screen.getByTestId('accounts-index-metric-workbuddy_desktop')).toHaveTextContent('0/2');
    expect(screen.getByTestId('accounts-index-metric-minimax')).toHaveTextContent('0/1');
    expect(screen.queryByTestId('accounts-index-empty')).toBeNull();
  });

  it('ADD-FLOW-2：停用账号仍算有账号，该平台照样出现在左栏', async () => {
    mockBase([account('wb-off', { enabled: false }), account('mm-off', { app_id: 'minimax', enabled: false })]);
    renderPanel();

    const index = await screen.findByTestId('accounts-index');
    expect(within(index).getAllByRole('tab').map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax', 'codex']);
    // 停用账号不进签到分母（checkinParticipation 排除 enabled=false）→ 指标「无参与账号」，但行仍出现（停用 ≠ 零账号）
    expect(screen.getByTestId('accounts-index-metric-workbuddy_desktop')).toHaveTextContent('无参与账号');
    // 停用与零账号是两件事：零账号的 trae 仍不占行
    expect(screen.queryByTestId('accounts-index-item-trae')).toBeNull();
  });

  it('方向 B 规格：左栏 ≥920px 固定 244px（原 200px）', async () => {
    mockBase([account('wb-1')]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    const rail = screen.getByTestId('accounts-index').parentElement as HTMLElement;
    expect(rail.className).toContain('min-[920px]:w-[244px]');
    expect(rail.className).not.toContain('w-[200px]');
  });

  it('方向 B 签到指标异常色：全完成 ok / 部分完成 warn / 无参与中性', async () => {
    const wbDone = account('wb-1', { last_checkin_day: TODAY, last_checkin_status: 'succeeded' });
    const wbPart = account('wb-2', { last_checkin_day: TODAY, last_checkin_status: 'unknown' });
    const mmDone = account('mm-1', { app_id: 'minimax', last_checkin_day: TODAY, last_checkin_status: 'already_done' });
    mockBase([wbDone, wbPart, mmDone]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    // workbuddy 1/2：部分完成 → warn（unknown 不计入完成）
    const wbMetric = screen.getByTestId('accounts-index-metric-workbuddy_desktop');
    expect(wbMetric).toHaveTextContent('1/2');
    expect(wbMetric).toHaveAttribute('data-tone', 'warn');
    // minimax 1/1：全完成 → ok
    expect(screen.getByTestId('accounts-index-metric-minimax')).toHaveAttribute('data-tone', 'ok');
  });

  it('方向 B 额度来源指标：余额无条；窗口带迷你条；已限额 danger 色', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPS)),
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
      http.get('/api/account-operations', () => HttpResponse.json([])),
      http.get('/api/cli-accounts', () => HttpResponse.json({
        items: [
          { id: 'd-1', app_id: 'deepseek', identity_hint: 'sha256:aaaaaaaaaaaa', created_at: 1, last_seen_at: 2 },
          { id: 'o-1', app_id: 'opencode_go', identity_hint: 'sha256:bbbbbbbbbbbb', created_at: 1, last_seen_at: 2 },
          { id: 'c-1', app_id: 'codex', identity_hint: 'sha256:cccccccccccc', created_at: 1, last_seen_at: 2 },
        ],
      })),
      http.get('/api/managed-account-quotas', () => HttpResponse.json({
        workspace_id: null,
        fetched_at: 1_700_000_000_000,
        items: [
          { source: 'deepseek', status: 'ok', balance: 751.81, unit: 'CNY', windows: [], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
          { source: 'opencode_go', status: 'ok', balance: null, unit: null, windows: [
            { name: 'rolling', kind: 'rolling', used_percent: 34, used: 3.4, total: 10, reset_at: 1_700_000_000_000 },
          ], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
          { source: 'codex', status: 'ok', balance: null, unit: null, windows: [
            { name: 'rolling', kind: 'rolling', used_percent: 100, used: 10, total: 10, reset_at: 1_700_000_000_000 },
          ], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
        ],
      })),
    );
    renderPanel();

    await screen.findByTestId('accounts-index');
    // 余额来源：¥751.81，无迷你条
    expect(screen.getByTestId('accounts-index-metric-deepseek')).toHaveTextContent('¥751.81');
    expect(screen.queryByTestId('accounts-index-bar-deepseek')).toBeNull();
    // 窗口来源：首个窗口 5h · 34% + 迷你条 34%
    const ocMetric = screen.getByTestId('accounts-index-metric-opencode_go');
    expect(ocMetric).toHaveTextContent('5h · 34%');
    expect(ocMetric).toHaveAttribute('data-tone', 'idle');
    expect(screen.getByTestId('accounts-index-bar-opencode_go')).toHaveAttribute('data-width', '34');
    // 已限额：100% → danger 色 + 条也红
    const cxMetric = screen.getByTestId('accounts-index-metric-codex');
    expect(cxMetric).toHaveTextContent('5h · 100%');
    expect(cxMetric).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByTestId('accounts-index-bar-codex')).toHaveAttribute('data-width', '100');
  });
});
