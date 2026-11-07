/**
 * ACC-TOKEN-3（卡 4d8c5172-43cb-4f72-b3ad-84e02b9b060e）：账号行凭据过期徽标 + 刷新按钮。
 *
 * 覆盖：
 * ① 三态渲染：expired/invalid 出红色徽标（已过期/已失效）+「刷新」次级小按钮；expiring 只出
 *    中性黄「即将过期」提示、不给按钮；valid/unknown 不加任何新元素；
 * ② 点「刷新」→ POST /api/managed-accounts/:id/refresh-credential，带 Idempotency-Key（UUID）；
 *    请求在途按钮禁用 +「刷新中…」，结束后恢复且无行内报错；
 * ③ 失败 → 行内中文口径提示（裸码只进 title）；
 * ④ 409 CREDENTIAL_RELOGIN_REQUIRED → 打开该平台的添加账号向导（重新登录；受控 wizardOpen 机制）；
 * ⑤ 成功 → 失效重拉 managed-accounts，状态回 valid 后徽标与按钮消失。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability } from '@agentboard/shared';
import { AccountCard, type AccountView } from '../components/settings/AccountCard';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import type { CapabilityView } from '../components/settings/accountCapabilities';
import { server } from './server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'inst-0123456789abcdef',
    service_region: 'cn',
    display_name: '主账号',
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 3,
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
    checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    source: 'derived',
    ...overrides,
  };
}

function mountCard(card: AccountView, onReloginRequired?: (appId: AccountView['app_id']) => void): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountCard account={card} capability={capability()} onReloginRequired={onReloginRequired} />
    </QueryClientProvider>,
  );
}

function mountPanel(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  server.resetHandlers();
});

describe('三态渲染（ACC-TOKEN-3 ①）', () => {
  it('expired：红色徽标「已过期」+「刷新」按钮', () => {
    mountCard(account({ credential_status: 'expired', credential_expires_at: 1, refresh_method: 'recapture' }));
    const badge = screen.getByTestId('accounts-credential-badge-acc-1');
    expect(badge).toHaveTextContent('已过期');
    expect(badge).toHaveAttribute('data-status', 'expired');
    expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toHaveTextContent('刷新');
  });

  it('invalid：红色徽标「已失效」+「刷新」按钮', () => {
    mountCard(account({ credential_status: 'invalid', refresh_method: 'refresh_token' }));
    const badge = screen.getByTestId('accounts-credential-badge-acc-1');
    expect(badge).toHaveTextContent('已失效');
    expect(badge).toHaveAttribute('data-status', 'invalid');
    expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toBeInTheDocument();
  });

  it('expiring：中性提示「即将过期」，不给刷新按钮', () => {
    mountCard(account({ credential_status: 'expiring', credential_expires_at: Date.now() + 3_600_000, refresh_method: 'refresh_token' }));
    const badge = screen.getByTestId('accounts-credential-badge-acc-1');
    expect(badge).toHaveTextContent('即将过期');
    expect(badge).toHaveAttribute('data-status', 'expiring');
    expect(screen.queryByTestId('accounts-credential-refresh-acc-1')).toBeNull();
  });

  it('valid / unknown：不渲染徽标也不渲染按钮', () => {
    for (const credential_status of ['valid', 'unknown'] as const) {
      const mounted = mountCard(account({ credential_status }));
      expect(screen.queryByTestId('accounts-credential-badge-acc-1')).toBeNull();
      expect(screen.queryByTestId('accounts-credential-refresh-acc-1')).toBeNull();
      expect(screen.queryByTestId('accounts-credential-error-acc-1')).toBeNull();
      mounted.unmount();
    }
  });
});

describe('点击刷新（ACC-TOKEN-3 ②）', () => {
  it('POST refresh-credential 带 Idempotency-Key（UUID）；在途禁用并显示「刷新中…」，结束后恢复', async () => {
    const posts: Array<{ key: string | null; body: unknown }> = [];
    let release: (() => void) | null = null;
    server.use(
      http.post('/api/managed-accounts/acc-1/refresh-credential', async ({ request }) => {
        posts.push({ key: request.headers.get('Idempotency-Key'), body: await request.json() });
        await new Promise<void>((resolve) => { release = resolve; });
        return HttpResponse.json({ refreshed: true, method: 'refresh_token' }, { status: 202 });
      }),
    );
    mountCard(account({ credential_status: 'expired', credential_expires_at: 1, refresh_method: 'refresh_token' }));

    fireEvent.click(screen.getByTestId('accounts-credential-refresh-acc-1'));
    await waitFor(() => expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toBeDisabled());
    expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toHaveTextContent('刷新中…');

    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toMatch(UUID_RE);
    expect(posts[0]!.body).toEqual({});

    act(() => { release?.(); });
    await waitFor(() => expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toHaveTextContent('刷新'));
    expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toBeEnabled();
    expect(screen.queryByTestId('accounts-credential-error-acc-1')).toBeNull();
  });

  it('失败：行内中文口径提示，裸码只进 title（ACC-REASON-01）', async () => {
    server.use(
      http.post('/api/managed-accounts/acc-1/refresh-credential', () =>
        HttpResponse.json({ error: { code: 'CREDENTIAL_REFRESH_FAILED', message: '刷新凭据失败，请稍后重试或重新登录' } }, { status: 409 })),
    );
    mountCard(account({ credential_status: 'expired', credential_expires_at: 1, refresh_method: 'refresh_token' }));

    fireEvent.click(screen.getByTestId('accounts-credential-refresh-acc-1'));
    const error = await screen.findByTestId('accounts-credential-error-acc-1');
    expect(error).toHaveTextContent('刷新凭据失败，请稍后重试或重新登录');
    expect(error).toHaveAttribute('title', 'CREDENTIAL_REFRESH_FAILED');
    // 失败后按钮回到可点态，可再次尝试
    await waitFor(() => expect(screen.getByTestId('accounts-credential-refresh-acc-1')).toBeEnabled());
  });

  it('409 CREDENTIAL_RELOGIN_REQUIRED 且无宿主回调（独立渲染）：退化为行内重新登录提示', async () => {
    server.use(
      http.post('/api/managed-accounts/acc-1/refresh-credential', () =>
        HttpResponse.json({ error: { code: 'CREDENTIAL_RELOGIN_REQUIRED', message: '该账号的凭据无法自动刷新，请重新登录' } }, { status: 409 })),
    );
    mountCard(account({ credential_status: 'invalid', refresh_method: null }));

    fireEvent.click(screen.getByTestId('accounts-credential-refresh-acc-1'));
    const error = await screen.findByTestId('accounts-credential-error-acc-1');
    expect(error).toHaveTextContent('该账号的凭据无法自动刷新，请重新登录');
    expect(error).toHaveAttribute('title', 'CREDENTIAL_RELOGIN_REQUIRED');
  });

  it('409 CREDENTIAL_RELOGIN_REQUIRED 且有宿主回调：回调收到该账号平台（开向导），不出行内报错', async () => {
    server.use(
      http.post('/api/managed-accounts/acc-1/refresh-credential', () =>
        HttpResponse.json({ error: { code: 'CREDENTIAL_RELOGIN_REQUIRED', message: '该账号的凭据无法自动刷新，请重新登录' } }, { status: 409 })),
    );
    const reloginApps: string[] = [];
    mountCard(
      account({ app_id: 'minimax', credential_status: 'expired', refresh_method: null }),
      (appId) => { reloginApps.push(appId); },
    );

    fireEvent.click(screen.getByTestId('accounts-credential-refresh-acc-1'));
    await waitFor(() => expect(reloginApps).toEqual(['minimax']));
    expect(screen.queryByTestId('accounts-credential-error-acc-1')).toBeNull();
  });
});

describe('面板集成（ACC-TOKEN-3 ④⑤）', () => {
  const CAPABILITIES: AccountCapability[] = [
    {
      app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true,
      capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
      reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
    },
    {
      app_id: 'minimax', capture: true, switch: true, checkin: true,
      capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
      reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
    },
  ];

  beforeEach(() => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)));
  });

  it('成功：失效重拉 managed-accounts，状态回 valid 后徽标与按钮消失', async () => {
    const expiredAccount = account({
      id: 'acc-wb-x',
      credential_status: 'expired',
      credential_expires_at: 1,
      refresh_method: 'recapture',
    });
    const validAccount = { ...expiredAccount, credential_status: 'valid' as const, credential_expires_at: Date.now() + 86_400_000 };
    let refreshed = false;
    const posts: string[] = [];
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json(refreshed ? [validAccount] : [expiredAccount])),
      http.post('/api/managed-accounts/acc-wb-x/refresh-credential', ({ request }) => {
        posts.push(request.headers.get('Idempotency-Key') ?? '');
        refreshed = true;
        return HttpResponse.json({ refreshed: true, method: 'recapture' }, { status: 202 });
      }),
    );
    mountPanel();
    const card = await screen.findByTestId('accounts-card-acc-wb-x');
    expect(within(card).getByTestId('accounts-credential-badge-acc-wb-x')).toHaveTextContent('已过期');
    expect(within(card).getByTestId('accounts-credential-refresh-acc-wb-x')).toBeInTheDocument();

    fireEvent.click(within(card).getByTestId('accounts-credential-refresh-acc-wb-x'));
    await waitFor(() => expect(screen.queryByTestId('accounts-credential-badge-acc-wb-x')).toBeNull());
    expect(screen.queryByTestId('accounts-credential-refresh-acc-wb-x')).toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(UUID_RE);
  });

  it('409 CREDENTIAL_RELOGIN_REQUIRED：打开该平台的添加账号向导（重新登录）', async () => {
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([
        account({
          id: 'acc-mm-1',
          app_id: 'minimax',
          credential_status: 'expired',
          credential_expires_at: 1,
          refresh_method: null,
        }),
      ])),
      http.post('/api/managed-accounts/acc-mm-1/refresh-credential', () =>
        HttpResponse.json(
          { error: { code: 'CREDENTIAL_RELOGIN_REQUIRED', message: '该账号的凭据无法自动刷新，请重新登录' } },
          { status: 409 },
        )),
    );
    mountPanel();
    // 默认选中第一平台（workbuddy_desktop）；先切到 minimax 平台才能看到它的账号卡
    fireEvent.click(await screen.findByTestId('accounts-index-item-minimax'));
    const card = await screen.findByTestId('accounts-card-acc-mm-1');
    expect(screen.queryByTestId('accounts-add-panel-minimax')).toBeNull();

    fireEvent.click(within(card).getByTestId('accounts-credential-refresh-acc-mm-1'));
    // 向导以受控 wizardOpen 机制展开（协议清单默认夹具含 minimax），预选平台即当前平台
    expect(await screen.findByTestId('accounts-add-panel-minimax')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-add-start-minimax')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-credential-error-acc-mm-1')).toBeNull();
  });
});
