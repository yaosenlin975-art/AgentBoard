/**
 * ACC-B1：账号面板主从布局（左栏平台索引 + 右栏单平台容器）。
 *
 * 取代旧「六行总览 + 展开层」的断言（方向 C 已废弃，旧口径不再保留双份）：
 * - 左栏索引覆盖六平台与「其它平台」（不静默丢卡），每项带账号数与今日签到健康态；
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
  it('左栏索引：六平台 + 其它平台都在，带账号数与当前账号；默认选中第一个平台', async () => {
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
    // 六平台 + 其它平台（qoder_cn），已下线的 codebuddy_desktop 不出现
    expect(items.map((el) => el.dataset.app)).toEqual(['workbuddy_desktop', 'minimax', 'trae', 'qoder_cn']);
    expect(screen.queryByTestId('accounts-index-item-codebuddy_desktop')).toBeNull();

    // 账号数 + 当前账号 + 健康态
    expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('2');
    expect(screen.getByTestId('accounts-detail-current')).toHaveTextContent('当前：账号 wb-1');

    // 默认选中第一个
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'false');

    // 额度行不再混进平台列表，落在左栏 footer
    expect(screen.getByTestId('accounts-quota-rows')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-overview')).toBeNull();
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
    expect(screen.getByTestId('accounts-index-item-trae')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
  });
});
