/**
 * ADD-FLOW-1：全局「添加账号」入口接线（外部可触达）。
 *
 * 断言口径：
 * - 顶栏「添加账号」是全局入口，不依赖选中平台是否装配协议（左栏过滤后零账号平台靠它进入）；
 * - 打开即 7 卡供应商选择页，再点收起；
 * - 卡内「授权添加」复用既有 AddAccountWizard，不新造向导；
 * - 平台体内只留指路文案，不再有第二个添加入口按钮（原型 Q2=A「行内加号迁出」）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const CAPABILITIES = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
];

const ACCOUNT = {
  id: 'wb-1', app_id: 'workbuddy_desktop', client_instance_id: 'inst-1', service_region: 'cn',
  display_name: 'WB 主号', identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported',
  enabled: true, last_checkin_day: null, last_checkin_status: null, last_checkin_at: null,
  created_at: 1, updated_at: 2, is_current: true,
};

const VENDORS = ['workbuddy_desktop', 'minimax', 'trae', 'qoder_cn', 'zcode', 'deepseek', 'codex'];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)),
    http.get('/api/managed-accounts', () => HttpResponse.json([ACCOUNT])),
  );
});

describe('全局「添加账号」入口（ADD-FLOW-1）', () => {
  it('顶栏点「添加账号」打开 7 卡选择页，再点收起', async () => {
    renderPanel();

    const toggle = await screen.findByTestId('accounts-add-toggle');
    expect(toggle).toHaveTextContent('添加账号');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('accounts-add-picker')).toBeNull();

    await userEvent.click(toggle);

    const picker = await screen.findByTestId('accounts-add-picker');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const vendor of VENDORS) {
      expect(within(picker).getByTestId(`accounts-add-picker-card-${vendor}`)).toBeInTheDocument();
    }

    await userEvent.click(toggle);
    expect(screen.queryByTestId('accounts-add-picker')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('选择页内「收起」按钮同样关闭选择页', async () => {
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-add-toggle'));
    await userEvent.click(await screen.findByTestId('accounts-add-picker-close'));

    expect(screen.queryByTestId('accounts-add-picker')).toBeNull();
  });

  it('卡内「授权添加」打开既有向导面板（复用 AddAccountWizard）', async () => {
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-add-toggle'));
    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-authorize-workbuddy_desktop'));

    expect(await screen.findByTestId('accounts-add-panel-workbuddy_desktop')).toBeInTheDocument();
  });

  it('选中平台没装配协议时全局入口仍在：零账号平台可从选择页添加', async () => {
    // ACC-UI-DEDUP：平台级「添加」按钮已删除——即使 minimax 装配了协议也不出 accounts-add-<app>，只能走全局选择页
    server.use(http.get('/api/add-account-protocols', () => HttpResponse.json({
      items: [
        { app_id: 'minimax', protocol: 'minimax_device', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
      ],
    })));
    renderPanel();

    const toggle = await screen.findByTestId('accounts-add-toggle');
    expect(screen.queryByTestId('accounts-add-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-add-minimax')).toBeNull();

    await userEvent.click(toggle);
    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-authorize-minimax'));

    expect(await screen.findByTestId('accounts-add-panel-minimax')).toBeInTheDocument();
  });

  it('平台体内只留指路文案，没有第二个添加入口按钮', async () => {
    renderPanel();

    const body = await screen.findByTestId('accounts-body-workbuddy_desktop');
    expect(within(body).getByTestId('accounts-add-moved-workbuddy_desktop')).toHaveTextContent('添加账号已移到顶部「添加账号」');
    expect(within(body).queryByRole('button', { name: '添加账号' })).toBeNull();
    // 唯一全局入口在顶栏回退操作行内
    expect(within(screen.getByTestId('accounts-toolbar')).getByTestId('accounts-add-toggle')).toBeInTheDocument();
  });
});