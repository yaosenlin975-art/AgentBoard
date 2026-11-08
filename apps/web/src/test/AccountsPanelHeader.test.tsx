/**
 * ACC-HEADER：账号管理标题去重 + 操作上顶栏（ACC-UI-TOPBAR）。
 * 弹窗头部（drawer 标题栏「账号管理」）保留唯一标题；面板内不再渲染同名标题。
 * ACC-UI-TOPBAR：操作行上标题栏（添加账号 / 一键签到 / 刷新，Portal 进 drawer 标题栏，
 * 独立渲染回退为面板顶部 accounts-toolbar 一行）；「N 个平台 / N 个可签到账号」计划摘要删除。
 * ACC-UI-DEDUP：平台级「添加」（accounts-add-<app>）删除，唯一添加入口是「添加账号」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const CAPABILITIES = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
];

const ACCOUNT = {
  id: 'wb-1', app_id: 'workbuddy_desktop', client_instance_id: 'inst-1', service_region: 'cn',
  display_name: 'WB 主号', identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported',
  enabled: true, last_checkin_day: null, last_checkin_status: null, last_checkin_at: null,
  created_at: 1, updated_at: 2, is_current: true,
};

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

describe('账号页头部（ACC-HEADER / ACC-UI-TOPBAR）', () => {
  it('面板内不再出现重复的「账号管理」标题（唯一标题在弹窗头部）', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    // 面板内既没有同名 h1-h6，也没有同名文本
    expect(screen.queryByRole('heading', { name: '账号管理' })).toBeNull();
    expect(screen.queryByText('账号管理')).toBeNull();
    // section 的 aria-label 仍用于可访问性定名
    expect(screen.getByLabelText('账号管理')).toBeInTheDocument();
  });

  it('操作上顶栏：回退操作行依次含 添加账号/一键签到/刷新；计划摘要与旧说明字样零残留；整排位于主从内容之前', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    const toolbar = screen.getByTestId('accounts-toolbar');
    expect(toolbar.className).toContain('flex-wrap');
    // 三个按钮依次在操作行内（drawer 宿主下 Portal 进标题栏，见 drawerPanel.test 的标题栏断言）
    expect(within(toolbar).getByTestId('accounts-add-toggle')).toHaveTextContent('添加账号');
    expect(within(toolbar).getByTestId('accounts-one-click-checkin')).toHaveTextContent('一键签到');
    expect(within(toolbar).getByTestId('accounts-import-local')).toHaveTextContent('刷新');
    // ACC-UI-DEDUP：平台级「添加」按钮删除，标题栏只剩「添加账号」一个添加入口
    expect(within(toolbar).queryByTestId('accounts-add-workbuddy_desktop')).toBeNull();
    expect(within(toolbar).queryByTestId('accounts-add-minimax')).toBeNull();
    // 计划摘要（N 个平台 / N 个可签到账号）与历史说明字样不再渲染
    expect(within(toolbar).queryByTestId('accounts-one-click-plan')).toBeNull();
    expect(within(toolbar).queryByTestId('accounts-desensitize-note')).toBeNull();
    expect(within(toolbar).queryByTestId('accounts-today-summary')).toBeNull();
    expect(screen.queryByText('仅展示脱敏元数据')).toBeNull();
    expect(screen.queryByText(/个可签到账号/)).toBeNull();
    // 捕获当前账号按钮整体删除
    expect(screen.queryByTestId('accounts-capture-workbuddy_desktop')).toBeNull();

    // 回退操作行在主从内容之前；额度面板整块移除
    const master = screen.getByTestId('accounts-master-detail');
    expect(toolbar.compareDocumentPosition(master) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('quota-rows')).toBeNull();
  });

  it('ACC-UI-PRUNE：平台头部行不再渲染（toggle/签到芯片/平台签到按钮全删，签到只剩一键签到）', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    expect(screen.queryByTestId('accounts-toggle-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-checkin-chip-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-checkin-all-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-credit-workbuddy_desktop')).toBeNull();
    expect(screen.getByTestId('accounts-one-click-checkin')).toBeEnabled();
  });
});
