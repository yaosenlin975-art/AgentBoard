/**
 * ACC-SW-VALID-A2：逐账号切换可用性回归。
 * 服务端 switch_available=false 时不得再渲染可点「切换」；给出中文原因与「先手动登录再补齐」出路，
 * 补齐按钮把 target_account_id 传给 capture-current，失败原因中文展示。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability } from '@agentboard/shared';
import { AccountCard, type AccountView } from '../components/settings/AccountCard';
import type { CapabilityView } from '../components/settings/accountCapabilities';
import { server } from './server';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'protocol',
    service_region: 'cn',
    display_name: '协议号',
    identity_hint: null,
    client_snapshot_version: 1,
    checkin_capability: 'supported',
    enabled: true,
    last_checkin_day: null,
    last_checkin_status: null,
    last_checkin_at: null,
    created_at: 1,
    updated_at: 1,
    is_current: false,
    ...overrides,
  };
}

function capability(overrides: Partial<AccountCapability> = {}): CapabilityView {
  return {
    app_id: 'workbuddy_desktop',
    capture: true,
    switch: true,
    checkin: true,
    capture_reason_code: 'OK',
    switch_reason_code: 'OK',
    checkin_reason_code: 'OK',
    reason_code: 'OK',
    source: 'derived',
    ...overrides,
  };
}

function mount(card: AccountView): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountCard account={card} capability={capability()} />
    </QueryClientProvider>,
  );
}

describe('ACC-SW-VALID-A2 逐账号切换可用性', () => {
  it('switch_available=false：不渲染切换按钮，给出原因与补齐出路', () => {
    mount(account({ switch_available: false, switch_reason_code: 'TARGET_INSTANCE_MISMATCH' }));
    expect(screen.queryByTestId('accounts-switch-acc-1')).toBeNull();
    const reason = screen.getByTestId('accounts-switch-unavailable-acc-1');
    expect(reason.textContent).toContain('目标账号实例不匹配');
    expect(reason.textContent).toContain('补齐本机登录态');
    expect(screen.getByTestId('accounts-adopt-acc-1')).toBeTruthy();
  });

  it('switch_available=true：维持原切换按钮，不渲染补齐入口', () => {
    mount(account({ switch_available: true, switch_reason_code: null }));
    expect(screen.getByTestId('accounts-switch-acc-1')).toBeTruthy();
    expect(screen.queryByTestId('accounts-adopt-acc-1')).toBeNull();
    expect(screen.queryByTestId('accounts-switch-unavailable-acc-1')).toBeNull();
  });

  it('补齐按钮带 target_account_id 调 capture-current，失败给中文原因', async () => {
    let body: unknown = null;
    server.use(
      http.post('/api/managed-accounts/:app/capture-current', async ({ request, params }) => {
        body = await request.json();
        expect(params.app).toBe('workbuddy_desktop');
        return HttpResponse.json(
          { error: { code: 'TARGET_IDENTITY_MISMATCH', message: '本机当前登录身份与目标账号不一致' } },
          { status: 409 },
        );
      }),
    );
    mount(account({ switch_available: false, switch_reason_code: 'TARGET_INSTANCE_MISMATCH' }));
    await userEvent.click(screen.getByTestId('accounts-adopt-acc-1'));
    await waitFor(() => expect(screen.getByTestId('accounts-adopt-error-acc-1')).toBeTruthy());
    expect(body).toEqual({ target_account_id: 'acc-1' });
    const alert = screen.getByTestId('accounts-adopt-error-acc-1');
    expect(alert.textContent).toContain('目标账号身份不匹配');
    expect(alert.getAttribute('data-code')).toBe('TARGET_IDENTITY_MISMATCH');
  });
});
