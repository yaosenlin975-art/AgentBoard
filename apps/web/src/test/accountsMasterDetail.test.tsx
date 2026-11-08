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

  it('左栏索引：只列有账号的平台（口径 A），带账号数；默认选中第一个平台', async () => {
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
    // ADD-FLOW-2：有账号的 workbuddy / minimax + 其它平台 qoder_cn；零账号的 trae 与无登记的 CLI 来源都不占行
    expect(items.map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax', 'qoder_cn']);
    // 已下线平台即使有历史账号也不出现（ACC-14 口径不变）
    expect(screen.queryByTestId('accounts-index-item-codebuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-index-item-trae')).toBeNull();

    // 账号数（「当前：…」提示条已删，ACC-UI-PRUNE）
    expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('2');
    expect(screen.queryByTestId('accounts-detail-current')).toBeNull();

    // 默认选中第一个
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'false');

    // 额度面板整块移除；CLI 三来源无登记账号 → 不占行（有账号时才以平台行形态并入，见 accountsCliRows）
    expect(screen.queryByTestId('accounts-quota-rows')).toBeNull();
    expect(screen.queryByTestId('quota-rows')).toBeNull();
    expect(screen.queryByTestId('accounts-overview')).toBeNull();
    for (const app of ['deepseek', 'opencode_go', 'codex', 'commandcode']) {
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
    // ADD-FLOW-2：列表只含有账号的平台，末尾是 trae（CLI 来源无登记账号，不占行）
    expect(screen.getByTestId('accounts-index-item-trae')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
  });

  it('ADD-FLOW-2：workbuddy 2 + minimax 1 时左栏只有这两项，零账号平台与来源都不占行', async () => {
    mockBase([account('wb-1'), account('wb-2'), account('mm-1', { app_id: 'minimax' })]);
    renderPanel();

    const index = await screen.findByTestId('accounts-index');
    expect(within(index).getAllByRole('tab').map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax']);
    expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('2');
    expect(screen.getByTestId('accounts-index-count-minimax')).toHaveTextContent('1');
    expect(screen.queryByTestId('accounts-index-empty')).toBeNull();
  });

  it('ADD-FLOW-2：停用账号仍算有账号，该平台照样出现在左栏', async () => {
    mockBase([account('wb-off', { enabled: false }), account('mm-off', { app_id: 'minimax', enabled: false })]);
    renderPanel();

    const index = await screen.findByTestId('accounts-index');
    expect(within(index).getAllByRole('tab').map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax']);
    expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('1');
    // 停用与零账号是两件事：零账号的 trae 仍不占行
    expect(screen.queryByTestId('accounts-index-item-trae')).toBeNull();
  });
});
