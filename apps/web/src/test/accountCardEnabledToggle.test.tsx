/**
 * ACC-KB-A2W 接线回归：AccountCard 的能力徽标互斥 + 启用/停用按钮（PATCH + 409 可读提示）。
 *
 * 判定逻辑本身在 accountCapabilityBadge.test.ts 用纯数据钉死了，这里只验「DOM 真的按两个布尔渲染、
 * 按钮真的打 PATCH、409 真的给可读文案」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountCard, type AccountView } from '../components/settings/AccountCard';
import type { CapabilityView } from '../components/settings/accountCapabilities';
import { server } from './server';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'inst-0123456789',
    service_region: 'cn',
    display_name: '主账号',
    identity_hint: 'a1b2c3d4',
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

function mount(card: AccountView, cap: CapabilityView | null): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountCard account={card} capability={cap} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('能力徽标互斥（DOM 层，ACC-KB-A2W）', () => {
  it('能力未知 → 只有灰标，且只有一个子节点、没有强调色样式', () => {
    mount(account(), null);
    const badge = screen.getByTestId('accounts-capability-badge-acc-1');
    expect(badge).toHaveAttribute('data-state', 'unknown');
    expect(badge.children).toHaveLength(1);
    expect(badge).toHaveTextContent('能力未知');
    expect(badge.querySelector('.bg-accent-soft')).toBeNull();
    expect(badge.getAttribute('title')).toContain('能力矩阵未取到该平台');
  });

  it('能力可用 → 只有蓝标；全不可用 → 只有灰标「能力不可用」', () => {
    mount(account(), capability());
    const blue = screen.getByTestId('accounts-capability-badge-acc-1');
    expect(blue).toHaveAttribute('data-state', 'supported');
    expect(blue.children).toHaveLength(1);
    expect(blue.querySelector('.bg-accent-soft')).not.toBeNull();
    expect(blue).toHaveTextContent('能力可用');
  });

  it('全维度不可用（qoder_cn 式）→ 单个灰标，title 带 reason_code', () => {
    mount(
      account({ app_id: 'qoder_cn' as AccountView['app_id'] }),
      capability({ app_id: 'qoder_cn', capture: false, switch: false, checkin: false, capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED', switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED', checkin_reason_code: 'PROVIDER_NOT_IMPLEMENTED', reason_code: 'PROVIDER_NOT_IMPLEMENTED', source: 'static' }),
    );
    const gray = screen.getByTestId('accounts-capability-badge-acc-1');
    expect(gray).toHaveAttribute('data-state', 'unsupported');
    expect(gray.children).toHaveLength(1);
    expect(gray).toHaveTextContent('能力不可用');
    expect(gray.querySelector('.bg-accent-soft')).toBeNull();
    expect(gray.getAttribute('title')).toContain('PROVIDER_NOT_IMPLEMENTED');
  });
});

describe('启用/停用按钮（ACC-KB-A2W）', () => {
  it('启用中的账号 → 按钮文案「停用」，点击 PATCH {enabled:false}', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.patch('/api/managed-accounts/:id', async ({ request }) => {
        calls.push({ url: request.url, body: await request.json() });
        return HttpResponse.json(account({ enabled: false }));
      }),
    );
    mount(account({ enabled: true }), capability());
    const button = screen.getByTestId('accounts-enabled-toggle-acc-1');
    expect(button).toHaveTextContent('停用');
    await userEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('/api/managed-accounts/acc-1');
    expect(calls[0]!.body).toEqual({ enabled: false });
  });

  it('已停用的账号 → 按钮文案「启用」，点击 PATCH {enabled:true}', async () => {
    const calls: unknown[] = [];
    server.use(
      http.patch('/api/managed-accounts/:id', async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json(account({ enabled: true }));
      }),
    );
    mount(account({ enabled: false }), capability());
    const button = screen.getByTestId('accounts-enabled-toggle-acc-1');
    expect(button).toHaveTextContent('启用');
    expect(screen.getByText('已停用（只读）')).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ enabled: true });
  });

  it('服务端 409 ACCOUNT_BUSY → 行内可读提示（带 data-code，不静默）', async () => {
    server.use(
      http.patch('/api/managed-accounts/:id', () =>
        HttpResponse.json({ error: { code: 'ACCOUNT_BUSY', message: '账号有排队或进行中的操作，稍后再改启用状态' } }, { status: 409 }),
      ),
    );
    mount(account({ enabled: true }), capability());
    await userEvent.click(screen.getByTestId('accounts-enabled-toggle-acc-1'));
    const alert = await screen.findByTestId('accounts-enabled-error-acc-1');
    expect(alert).toHaveTextContent('账号有排队或进行中的操作，稍后再改启用状态');
    expect(alert).toHaveAttribute('data-code', 'ACCOUNT_BUSY');
    expect(within(alert.closest('[data-testid="accounts-card-acc-1"]') as HTMLElement).getByTestId('accounts-enabled-toggle-acc-1')).toBeEnabled();
  });
});
