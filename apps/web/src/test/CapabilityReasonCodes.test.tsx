/**
 * 能力矩阵分维度原因码（ACC-09 增量）：
 * - 捕获/切换/签到各取自己的 reason_code，不用顶层 reason_code 当唯一来源；
 * - 'OK' 走正常可用态，不显示成错误文案；
 * - CodeBuddy 的捕获/切换真实原因 TARGET_KIND_UNCONFIRMED 必须落在文案映射里；
 * - 旧结构（只有顶层 reason_code）仍能容错，不把签到码误显示成捕获/切换原因。
 * - accounts-redesign 方向 B：能力徽标整行删除后，分维度原因码经平台级异常文字提示（switch 不可用）与技术层承载。
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
  it('捕获可用但切换不可用：切换不可用提示用 switch_reason_code，原因码只进技术层', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      {
        app_id: 'workbuddy_desktop', capture: true, switch: false, checkin: false,
        capture_reason_code: 'OK', switch_reason_code: 'TARGET_KIND_UNCONFIRMED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
        reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static',
      },
      { app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false, reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static' },
    ] satisfies AccountCapability[])));
    renderPanel();

    await screen.findByTestId('accounts-app-workbuddy_desktop');
    // accounts-redesign 方向 B：能力徽标整行删除，分维度原因码不再进图标 tooltip；
    // 异常（switch 不可用）落平台级可见原因（中文主文案 + 技术码进 title）
    expect(screen.queryByTestId('accounts-badge-workbuddy_desktop-capture')).toBeNull();
    expect(screen.queryByTestId('accounts-badge-workbuddy_desktop-switch')).toBeNull();
    // ACC-UI-TOPBAR：捕获按钮已整体删除（不因 checkin/switch 的码出现）
    expect(screen.queryByTestId('accounts-capture-workbuddy_desktop')).toBeNull();
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
    // accounts-redesign 方向 B：全可用属正常态，不渲染徽标、也不出现「不可用」文字
    expect(within(wb).queryByTestId('accounts-badge-workbuddy_desktop-switch')).toBeNull();
    expect(wb.textContent).not.toContain('不可用');
    // ACC-UI-PRUNE：平台头部签到按钮已删，签到入口只剩工具栏一键签到（能力可用 → 可点）
    expect(within(wb).queryByTestId('accounts-checkin-all-workbuddy_desktop')).toBeNull();
    expect(screen.getByTestId('accounts-one-click-checkin')).toBeEnabled();
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
