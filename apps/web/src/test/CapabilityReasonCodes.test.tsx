/**
 * 能力矩阵分维度原因码（ACC-09 增量）：
 * - 捕获/切换/签到各取自己的 reason_code，不用顶层 reason_code 当唯一来源；
 * - 'OK' 走正常可用态，不显示成错误文案；
 * - CodeBuddy 的捕获/切换真实原因 TARGET_KIND_UNCONFIRMED 必须落在文案映射里；
 * - 旧结构（只有顶层 reason_code）仍能容错，不把签到码误显示成捕获/切换原因。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { normalizeCapability } from '../components/settings/accountCapabilities';
import { server } from './server';

const WB_ID = '55555555-5555-4555-8555-555555555555';

const account: PublicManagedAccount & { is_current: boolean | null } = {
  id: WB_ID,
  app_id: 'workbuddy_desktop',
  client_instance_id: 'wb-inst-cccc',
  service_region: 'cn',
  display_name: '分维度账号',
  identity_hint: 'deadbeef',
  client_snapshot_version: 1,
  checkin_capability: 'supported',
  enabled: true,
  last_checkin_day: null,
  last_checkin_status: null,
  last_checkin_at: null,
  created_at: 1,
  updated_at: 2,
  is_current: true,
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(http.get('/api/managed-accounts', () => HttpResponse.json([account])));
});

describe('能力矩阵分维度原因码（ACC-09）', () => {
  it('捕获可用但切换不可用：切换按钮用 switch_reason_code，捕获按钮保持可用', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      {
        app_id: 'workbuddy_desktop', capture: true, switch: false, checkin: false,
        capture_reason_code: 'OK', switch_reason_code: 'TARGET_KIND_UNCONFIRMED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
        reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static',
      },
      { app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false, reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static' },
    ] satisfies AccountCapability[])));
    renderPanel();

    const capText = (await screen.findByTestId('accounts-capability-workbuddy_desktop')).textContent ?? '';
    expect(capText).toContain('捕获 OK');
    expect(capText).toContain('切换 TARGET_KIND_UNCONFIRMED');
    expect(capText).toContain('签到 CHECKIN_PROVIDER_UNVERIFIED');
    // 捕获按钮可用（不因 checkin/switch 的码被禁）
    expect(screen.getByTestId('accounts-capture-workbuddy_desktop')).toBeEnabled();
    // ACC-UI-2：切换不可用不再渲染灰按钮，改为平台级可见原因（技术码仍在 title）
    const card = screen.getByTestId(`accounts-card-${WB_ID}`);
    expect(within(card).queryByTestId(`accounts-switch-${WB_ID}`)).toBeNull();
    const switchReason = screen.getByTestId('accounts-switch-unavailable-workbuddy_desktop');
    expect(switchReason).toHaveTextContent('切换不可用');
    expect(switchReason).toHaveAttribute('title', expect.stringContaining('TARGET_KIND_UNCONFIRMED'));
    expect(switchReason).toHaveAttribute('title', expect.stringContaining('目标未确认，不可用'));
  });

  it('全部可用（三项均 OK）时不显示任何「不可用」文案', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      {
        app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true,
        capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
        reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
      },
      {
        app_id: 'minimax', capture: true, switch: false, checkin: true,
        capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
        reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived',
      },
      {
        app_id: 'trae', capture: false, switch: false, checkin: true,
        capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED',
        checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived',
      },
    ] satisfies AccountCapability[])));
    renderPanel();

    const wb = await screen.findByTestId('accounts-app-workbuddy_desktop');
    // ACC-UI-01 D2：能力改用三图标徽标，不再有「切换可用」这类文字徽章（原因码只进 tooltip/details）
    expect(within(wb).getByTestId('accounts-badge-workbuddy_desktop-switch')).toHaveAttribute('data-state', 'available');
    // UNSLOP：三态改线性图标，状态由 data-state + 图标 + aria-label 表达
    const switchBadge = within(wb).getByTestId('accounts-badge-workbuddy_desktop-switch');
    expect(switchBadge.querySelector('svg')).not.toBeNull();
    expect(switchBadge.getAttribute('aria-label')).toContain('可用');
    expect(wb.textContent).not.toContain('不可用');
    expect(within(wb).getByTestId('accounts-checkin-all-workbuddy_desktop')).toBeEnabled();
    // ACC-PANEL-03：行上按钮文案收敛为「签到」（长说明交给 tooltip / 芯片）
    expect(within(wb).getByTestId('accounts-checkin-all-workbuddy_desktop')).toHaveTextContent('签到');
  });

  it('旧结构兜底：缺少分维度字段时按顶层 reason_code 补齐，不把签到码当成捕获/切换原因', () => {
    const legacy: AccountCapability = {
      app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false,
      reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static',
    };
    const view = normalizeCapability(legacy);
    expect(view.capture_reason_code).toBe('OK');
    expect(view.switch_reason_code).toBe('OK');
    expect(view.checkin_reason_code).toBe('CHECKIN_PROVIDER_UNVERIFIED');
  });
});
