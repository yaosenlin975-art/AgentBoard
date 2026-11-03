/**
 * ACC-HEADER：账号管理标题去重 + 一键签到上移到标题行。
 * 弹窗头部（`Modal title="账号管理"`）保留唯一标题；面板内不再渲染同名标题，
 * 只保留一行工具栏：左「脱敏说明」小字 + 右「一键签到」；窄屏（375）允许换行。
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

  it('工具栏：一键签到按钮与脱敏说明同一行，且工具栏在面板最上方（额度区之前）', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    const toolbar = screen.getByTestId('accounts-toolbar');
    expect(toolbar.className).toContain('flex-wrap');
    const button = within(toolbar).getByTestId('accounts-one-click-checkin');
    const note = within(toolbar).getByTestId('accounts-desensitize-note');
    expect(button).toHaveTextContent('一键签到');
    expect(note).toHaveTextContent('仅展示脱敏元数据');

    // 工具栏在额度区之前（DOM 顺序即视觉顺序）
    const quota = screen.getByTestId('quota-cards');
    expect(toolbar.compareDocumentPosition(quota) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 按钮在 toolbar 内靠右（说明占 mr-auto，按钮排在其后）
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('平台分区的「仅此平台签到」保持不动', async () => {
    renderPanel();
    const wbButton = await screen.findByTestId('accounts-checkin-all-workbuddy_desktop');
    expect(wbButton).toHaveTextContent('仅此平台签到');
    // 与顶部一键签到是两个不同按钮
    expect(screen.getByTestId('accounts-one-click-checkin')).not.toBe(wbButton);
  });
});
