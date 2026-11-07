/**
 * ACC-KB-B4W：`recovery_required` 状态下界面要给出**可操作的下一步**（指向 restore），
 * 而不是只显示失败；新增的失败原因码都要有中文文案。
 *
 * 覆盖：
 * 1. 切换进入 `recovery_required` → 卡片出现恢复提示与「恢复客户端状态」按钮；
 * 2. 点按钮 → 调 `POST /api/managed-accounts/:id/restore`；失败给中文文案（裸码只进 title）；
 * 3. 恢复成功后不再显示恢复提示（冻结解除）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, AccountOperation } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

const CAPABILITIES: AccountCapability[] = [
  {
    app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false,
    capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
    reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static',
  },
];

const ACCOUNT = {
  id: ACCOUNT_ID,
  app_id: 'workbuddy_desktop',
  client_instance_id: 'wb-inst-1',
  service_region: 'cn',
  display_name: 'WorkBuddy 副号',
  identity_hint: 'a1b2c3d4',
  client_snapshot_version: 1,
  checkin_capability: 'unsupported',
  enabled: true,
  last_checkin_day: null,
  last_checkin_status: null,
  last_checkin_at: null,
  created_at: 1,
  updated_at: 2,
  is_current: false,
};

function operation(overrides: Partial<AccountOperation> = {}): AccountOperation {
  return {
    id: 'op-1',
    batch_id: null,
    account_id: ACCOUNT_ID,
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-inst-1',
    operation: 'switch',
    state: 'recovery_required',
    stage: 'rollback',
    safe_error_code: 'RECOVERY_REQUIRED',
    recovery_ref: 'rec-1',
    created_at: 1,
    started_at: 2,
    finished_at: 3,
    recovers_operation_id: null,
    ...overrides,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)),
    http.get('/api/managed-accounts', () => HttpResponse.json([ACCOUNT])),
    http.post('/api/managed-accounts/:id/switch', () => HttpResponse.json({ operation_id: 'op-1', operation: operation({ state: 'running', safe_error_code: null }) }, { status: 202 })),
    http.get('/api/account-operations/op-1', () => HttpResponse.json(operation())),
  );
});

describe('恢复提示与恢复入口（ACC-KB-B4W）', () => {
  it('recovery_required 时给出可操作的下一步（恢复按钮 + 说明），而不是只显示失败', async () => {
    renderPanel();
    await userEvent.click(await screen.findByTestId(`accounts-switch-${ACCOUNT_ID}`));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    const hint = await screen.findByTestId(`accounts-recovery-${ACCOUNT_ID}`);
    expect(hint).toHaveTextContent('上次切换未完成');
    expect(hint).toHaveTextContent('恢复会把客户端写回切换前的快照');
    expect(screen.getByTestId(`accounts-recovery-action-${ACCOUNT_ID}`)).toHaveTextContent('恢复客户端状态');
    // 裸码不进可见文案（技术码只在 title）
    expect(hint.textContent ?? '').not.toContain('RECOVERY_REQUIRED');
  });

  it('点「恢复客户端状态」调 restore 端点；失败给中文文案', async () => {
    let restoreCalls = 0;
    server.use(
      http.post('/api/managed-accounts/:id/restore', () => {
        restoreCalls += 1;
        return HttpResponse.json({ error: { code: 'RECOVERY_NOT_REQUIRED', message: '没有需要恢复的操作' } }, { status: 409 });
      }),
    );
    renderPanel();
        await userEvent.click(await screen.findByTestId(`accounts-switch-${ACCOUNT_ID}`));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    await userEvent.click(await screen.findByTestId(`accounts-recovery-action-${ACCOUNT_ID}`));
    await waitFor(() => expect(restoreCalls).toBe(1));
    const error = await screen.findByTestId(`accounts-recovery-error-${ACCOUNT_ID}`);
    expect(error).toHaveTextContent('该账号没有需要恢复的操作');
    expect(error.textContent ?? '').not.toContain('RECOVERY_NOT_REQUIRED');
  });

  it('恢复成功后恢复提示消失（冻结解除）', async () => {
    server.use(
      http.post('/api/managed-accounts/:id/restore', () => HttpResponse.json({
        operation_id: 'op-2', operation: operation({ id: 'op-2', operation: 'restore', state: 'succeeded', safe_error_code: null }), replayed: false,
      }, { status: 202 })),
    );
    renderPanel();
        await userEvent.click(await screen.findByTestId(`accounts-switch-${ACCOUNT_ID}`));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    await userEvent.click(await screen.findByTestId(`accounts-recovery-action-${ACCOUNT_ID}`));
    await waitFor(() => expect(screen.queryByTestId(`accounts-recovery-${ACCOUNT_ID}`)).not.toBeInTheDocument());
  });
});
