import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountOperation, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

/** 与 PublicManagedAccount + is_current 对齐的列表项 */
type AccountView = PublicManagedAccount & { is_current: boolean | null };

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-wb-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-instance-0123456789',
    service_region: 'cn',
    display_name: 'WorkBuddy 主账号',
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 3,
    checkin_capability: 'unsupported',
    enabled: true,
    last_checkin_day: '2026-11-01',
    last_checkin_status: 'succeeded',
    last_checkin_at: 1_761_000_000_000,
    created_at: 1,
    updated_at: 2,
    is_current: false,
    ...overrides,
  };
}

function operation(overrides: Partial<AccountOperation> = {}): AccountOperation {
  return {
    id: 'op-1',
    batch_id: null,
    account_id: 'acc-wb-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-instance-0123456789',
    operation: 'switch',
    state: 'running',
    stage: 'validate_target',
    safe_error_code: null,
    recovery_ref: null,
    created_at: 1,
    started_at: 2,
    finished_at: null,
    recovers_operation_id: null,
    ...overrides,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>) };
}

function mockList(accounts: AccountView[]) {
  const urls: string[] = [];
  server.use(
    http.get('/api/managed-accounts', ({ request }) => {
      const app = new URL(request.url).searchParams.get('app');
      urls.push(request.url);
      return HttpResponse.json(app === null ? accounts : accounts.filter((a) => a.app_id === app));
    }),
  );
  return urls;
}

/** 能力矩阵（ACC-09）：真实服务端表达，WorkBuddy capture/switch 可用、checkin 未验证；CodeBuddy 全 false */
function mockCapabilities(overrides: { workbuddyCheckin?: boolean; source?: 'static' | 'derived' } = {}) {
  const source = overrides.source ?? 'static';
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      {
        app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: overrides.workbuddyCheckin === true,
        capture_reason_code: 'OK', switch_reason_code: 'OK',
        checkin_reason_code: overrides.workbuddyCheckin === true ? 'CHECKIN_PROVIDER_AVAILABLE' : 'CHECKIN_PROVIDER_UNVERIFIED',
        reason_code: overrides.workbuddyCheckin === true ? 'CHECKIN_PROVIDER_AVAILABLE' : 'CHECKIN_PROVIDER_UNVERIFIED', source,
      },
      {
        app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false,
        capture_reason_code: 'TARGET_KIND_UNCONFIRMED', switch_reason_code: 'TARGET_KIND_UNCONFIRMED',
        checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
        reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static',
      },
    ])),
  );
}

beforeEach(() => {
  server.resetHandlers();
  mockCapabilities();
});

describe('账号管理面板（ACC-08）', () => {
  it('CodeBuddy 分区显式「不可用」：能力取服务端矩阵、不提供可用操作按钮、点击不发请求', async () => {
    const urls = mockList([account()]);
    renderPanel();

    const codebuddy = await screen.findByTestId('accounts-app-codebuddy_desktop');
    // 能力徽章为「不可用」，具体原因取自服务端 reason_code（不再使用前端副本的 TARGET_KIND_UNCONFIRMED）
    // 徽章取「切换」维度原因；明细行按维度分别展示（capture/switch = TARGET_KIND_UNCONFIRMED，checkin = CHECKIN_PROVIDER_UNVERIFIED）
    expect(within(codebuddy).getByText('目标未确认，不可用')).toBeInTheDocument();
    const capText = within(codebuddy).getByTestId('accounts-capability-codebuddy_desktop').textContent ?? '';
    expect(capText).toContain('捕获 TARGET_KIND_UNCONFIRMED');
    expect(capText).toContain('切换 TARGET_KIND_UNCONFIRMED');
    expect(capText).toContain('签到 CHECKIN_PROVIDER_UNVERIFIED');
    expect(within(codebuddy).getByTestId('accounts-capture-codebuddy_desktop')).toHaveTextContent('捕获不可用（目标未确认，不可用）');
    const capture = within(codebuddy).getByTestId('accounts-capture-codebuddy_desktop');
    expect(capture).toBeDisabled();
    await userEvent.click(capture);
    expect(urls.filter((u) => u.includes('capture-current'))).toHaveLength(0);
    // 也不应出现可用的切换按钮
    expect(within(codebuddy).queryByTestId('accounts-switch-acc-wb-2')).not.toBeInTheDocument();
  });

  it('两个客户端分区各自独立：WorkBuddy 账号不串到 CodeBuddy 区', async () => {
    mockList([
      account({ id: 'acc-wb-1', app_id: 'workbuddy_desktop', display_name: 'WB 主账号' }),
      account({ id: 'acc-cb-1', app_id: 'codebuddy_desktop', display_name: 'CB 账号', is_current: null }),
    ]);
    renderPanel();

    const wb = await screen.findByTestId('accounts-app-workbuddy_desktop');
    const cb = screen.getByTestId('accounts-app-codebuddy_desktop');
    expect(within(wb).getByText('WB 主账号')).toBeInTheDocument();
    expect(within(wb).queryByText('CB 账号')).not.toBeInTheDocument();
    expect(within(cb).getByText('CB 账号')).toBeInTheDocument();
    expect(within(cb).queryByText('WB 主账号')).not.toBeInTheDocument();
  });

  it('切换账号：二次确认 → POST 后显示阶段 → 轮询到成功', async () => {
    mockList([account({ id: 'acc-wb-2', display_name: 'WB 备用账号' })]);
    const posts: string[] = [];
    let pollCount = 0;
    server.use(
      http.post('/api/managed-accounts/acc-wb-2/switch', () => {
        posts.push('acc-wb-2');
        return HttpResponse.json({ operation_id: 'op-1', operation: operation() }, { status: 202 });
      }),
      http.get('/api/account-operations/op-1', () => {
        pollCount += 1;
        return HttpResponse.json(operation({ state: pollCount > 1 ? 'succeeded' : 'running', stage: pollCount > 1 ? 'verify' : 'write' }));
      }),
    );
    renderPanel();

    const card = await screen.findByTestId('accounts-card-acc-wb-2');
    await userEvent.click(within(card).getByTestId('accounts-switch-acc-wb-2'));
    // 二次确认后才发请求
    expect(posts).toHaveLength(0);
    const dialogText = await screen.findByTestId('accounts-switch-confirm');
    expect(dialogText).toHaveTextContent('确认切换');
    await userEvent.click(screen.getByTestId('accounts-switch-confirm-yes'));
    await waitFor(() => expect(posts).toEqual(['acc-wb-2']));

    await waitFor(() => expect(within(card).getByTestId('accounts-op-acc-wb-2')).toHaveTextContent('切换成功'));
  });

  it('切换恢复失败（recovery_required）：冻结该账号切换并显示恢复引用', async () => {
    mockList([account({ id: 'acc-wb-3', display_name: 'WB 恢复账号' })]);
    server.use(
      http.post('/api/managed-accounts/acc-wb-3/switch', () =>
        HttpResponse.json({ operation_id: 'op-3', operation: operation({ id: 'op-3', recovery_ref: 'rec-9' }) }, { status: 202 }),
      ),
      http.get('/api/account-operations/op-3', () =>
        HttpResponse.json(operation({
          id: 'op-3',
          state: 'recovery_required',
          stage: 'rollback',
          safe_error_code: 'START_FAILED',
          recovery_ref: 'rec-9',
        })),
      ),
    );
    renderPanel();

    const card = await screen.findByTestId('accounts-card-acc-wb-3');
    await userEvent.click(within(card).getByTestId('accounts-switch-acc-wb-3'));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    await waitFor(() => expect(within(card).getByTestId('accounts-op-acc-wb-3')).toHaveTextContent('需要恢复'));
    expect(within(card).getByTestId('accounts-op-acc-wb-3')).toHaveTextContent('rec-9');
    await waitFor(() => expect(within(card).getByTestId('accounts-switch-acc-wb-3')).toBeDisabled());
  });

  it('签到能力未验证：签到按钮禁用并给出原因，不发请求', async () => {
    const urls = mockList([account()]);
    renderPanel();
    const card = await screen.findByTestId('accounts-card-acc-wb-1');
    const checkin = within(card).getByTestId('accounts-checkin-acc-wb-1');
    expect(checkin).toBeDisabled();
    expect(checkin).toHaveAttribute('title', expect.stringContaining('签到能力未验证'));
    await userEvent.click(checkin);
    expect(urls.filter((u) => u.includes('checkin'))).toHaveLength(0);
  });

  it('无账号时两个分区各显示空态', async () => {
    mockList([]);
    renderPanel();
    const wb = await screen.findByTestId('accounts-app-workbuddy_desktop');
    const cb = screen.getByTestId('accounts-app-codebuddy_desktop');
    expect(within(wb).getByTestId('accounts-empty-workbuddy_desktop')).toHaveTextContent('尚未捕获');
    expect(within(cb).getByTestId('accounts-empty-codebuddy_desktop')).toBeInTheDocument();
  });

  it('列表读取失败显示错误态', async () => {
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '账号服务不可用' } }, { status: 500 })));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('账号服务不可用');
  });

  it('当前账号标记：is_current=true 显示「当前账号」且切换禁用；null 显示未知', async () => {
    mockList([
      account({ id: 'acc-wb-cur', display_name: '当前账号卡', is_current: true }),
      account({ id: 'acc-wb-unk', display_name: '未知账号卡', is_current: null }),
    ]);
    renderPanel();
    const current = await screen.findByTestId('accounts-card-acc-wb-cur');
    expect(within(current).getByTestId('accounts-current-acc-wb-cur')).toHaveTextContent('当前账号');
    expect(within(current).getByTestId('accounts-switch-acc-wb-cur')).toBeDisabled();
    const unknown = screen.getByTestId('accounts-card-acc-wb-unk');
    expect(within(unknown).getByTestId('accounts-current-acc-wb-unk')).toHaveTextContent('当前身份未知');
  });

  it('DOM 不含秘密字段：identity_hash / client_snapshot_ref / token 一律不渲染', async () => {
    mockList([account({ id: 'acc-wb-secret', display_name: '秘密检查账号' })] as AccountView[]);
    // 即使服务端误带敏感字段，也不得出现在 DOM
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json([
      { ...account({ id: 'acc-wb-secret', display_name: '秘密检查账号' }), identity_hash: 'f'.repeat(64), client_snapshot_ref: 'snap-uuid-secret', checkin_credential_ref: 'cred-secret', access_token: 'token-secret-value' },
    ])));
    renderPanel();
    await screen.findByTestId('accounts-card-acc-wb-secret');
    const html = document.body.innerHTML;
    expect(html).not.toContain('f'.repeat(64));
    expect(html).not.toContain('snap-uuid-secret');
    expect(html).not.toContain('cred-secret');
    expect(html).not.toContain('token-secret-value');
    // 但非敏感标识可见
    expect(screen.getByTestId('accounts-card-acc-wb-secret')).toHaveTextContent('a1b2c3d4');
  });
});



