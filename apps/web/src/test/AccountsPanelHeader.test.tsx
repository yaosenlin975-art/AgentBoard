/**
 * ACC-HEADER：账号管理标题去重 + 一键签到在工具栏。
 * 弹窗头部（`Modal title="账号管理"`）保留唯一标题；面板内不再渲染同名标题。
 * ACC-UI-PRUNE：工具栏只剩一键签到计划/按钮与刷新（脱敏说明、「今日 x/x」已删）。
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

describe('账号页头部（ACC-HEADER）', () => {
  it('面板内不再出现重复的「账号管理」标题（唯一标题在弹窗头部）', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    // 面板内既没有同名 h1-h6，也没有同名文本
    expect(screen.queryByRole('heading', { name: '账号管理' })).toBeNull();
    expect(screen.queryByText('账号管理')).toBeNull();
    // section 的 aria-label 仍用于可访问性定名
    expect(screen.getByLabelText('账号管理')).toBeInTheDocument();
  });

  it('工具栏只剩一键签到计划/按钮与刷新，脱敏说明与「今日 x/x」不再渲染，整排位于主从内容之后', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    const toolbar = screen.getByTestId('accounts-toolbar');
    expect(toolbar.className).toContain('flex-wrap');
    expect(within(toolbar).getByTestId('accounts-one-click-checkin')).toHaveTextContent('一键签到');
    expect(within(toolbar).getByTestId('accounts-one-click-plan')).toBeInTheDocument();
    expect(within(toolbar).getByTestId('accounts-import-local')).toHaveTextContent('刷新');
    expect(within(toolbar).queryByTestId('accounts-desensitize-note')).toBeNull();
    expect(within(toolbar).queryByTestId('accounts-today-summary')).toBeNull();
    expect(screen.queryByText('仅展示脱敏元数据')).toBeNull();

    // 工具栏在主从内容下方；额度面板整块移除
    const master = screen.getByTestId('accounts-master-detail');
    expect(master.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
