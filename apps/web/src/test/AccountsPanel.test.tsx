/**
 * 账号管理面板（ACC-08 基线 + ACC-14 + ACC-UI-PRUNE）：三平台多账号、客户端当前芯片、切换可用性、脱敏。
 * ACC-14 起平台范围是 WorkBuddy / MiniMax / Trae；CodeBuddy Desktop 栏位移除（历史账号在界面过滤）。
 * ACC-UI-PRUNE：行头计数、账号行「签到当前」芯片与单账号「签到」按钮已删，签到统一走一键签到。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, AccountOperation, PublicManagedAccount } from '@agentboard/shared';
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
    checkin_capability: 'supported',
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

/** ACC-13/ACC-12 的真实能力形态：workbuddy 三项可用；minimax 有捕获+签到、切换因本机未安装客户端不可用；trae 只能签到 */
const REAL_CAPABILITIES: AccountCapability[] = [
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
];

function mockCapabilities(rows: AccountCapability[] = REAL_CAPABILITIES) {
  server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json(rows)));
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

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>) };
}

beforeEach(() => {
  server.resetHandlers();
  mockCapabilities();
});

describe('账号管理面板（ACC-08 / ACC-14）', () => {
  it('三平台多账号：每个平台列全部账号，CodeBuddy 栏与历史账号都不出现', async () => {
    mockList([
      account({ id: 'wb-1', app_id: 'workbuddy_desktop', display_name: 'WB 账号一' }),
      account({ id: 'wb-2', app_id: 'workbuddy_desktop', display_name: 'WB 账号二' }),
      account({ id: 'mm-1', app_id: 'minimax', display_name: 'MM 账号', is_current: null }),
      account({ id: 'tr-1', app_id: 'trae', display_name: 'TRAE 账号', is_current: null }),
      account({ id: 'cb-1', app_id: 'codebuddy_desktop', display_name: 'CB 历史账号', is_current: null }),
    ]);
    renderPanel();

    // ACC-B1 主从布局：右栏只渲染选中平台，逐个切换后断言
    const wb = await screen.findByTestId('accounts-app-workbuddy_desktop');
    expect(within(wb).getByText('WB 账号一')).toBeInTheDocument();
    expect(within(wb).getByText('WB 账号二')).toBeInTheDocument();
    // ACC-UI-TOPBAR：「其中 N 个启用并参与一键签到」次级说明已删
    expect(within(wb).queryByTestId('accounts-summary-workbuddy_desktop')).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-index-item-minimax'));
    const mm = await screen.findByTestId('accounts-app-minimax');
    expect(within(mm).getByText('MM 账号')).toBeInTheDocument();
    expect(screen.queryByText('WB 账号一')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('accounts-index-item-trae'));
    const tr = await screen.findByTestId('accounts-app-trae');
    expect(within(tr).getByText('TRAE 账号')).toBeInTheDocument();
    // CodeBuddy Desktop 栏位移除：无分区，且历史账号不渲染
    expect(screen.queryByTestId('accounts-app-codebuddy_desktop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accounts-card-cb-1')).not.toBeInTheDocument();
    expect(screen.queryByText('CB 历史账号')).not.toBeInTheDocument();
    expect(screen.queryByText('CodeBuddy Desktop')).not.toBeInTheDocument();
  });

  it('客户端当前芯片取 is_current；停用号出「已停用」芯片；签到当前芯片已随 ACC-UI-PRUNE 删除', async () => {
    mockList([
      account({ id: 'acc-wb-cur', display_name: '客户端当前号', is_current: true }),
      account({ id: 'acc-wb-next', display_name: '仅签到号', is_current: false }),
      account({ id: 'acc-wb-off', display_name: '停用号', is_current: false, enabled: false }),
    ]);
    renderPanel();

    const cur = await screen.findByTestId('accounts-card-acc-wb-cur');
    expect(within(cur).getByTestId('accounts-client-current-acc-wb-cur')).toHaveTextContent('客户端当前');
    expect(within(cur).queryByTestId('accounts-checkin-current-acc-wb-cur')).toBeNull();
    // ACC-UI-2：当前账号不渲染灰切换按钮（已有「客户端当前」芯片表达同一事实）
    expect(within(cur).queryByTestId('accounts-switch-acc-wb-cur')).toBeNull();

    const next = screen.getByTestId('accounts-card-acc-wb-next');
    // ACC-B2：负向信息不渲染——「客户端非当前」退到 title
    expect(within(next).queryByText('客户端非当前')).toBeNull();
    expect(within(next).getByTestId('accounts-client-current-acc-wb-next')).toBeEmptyDOMElement();
    expect(within(next).getByTestId('accounts-client-current-acc-wb-next')).toHaveAttribute('title', '客户端非当前');
    expect(within(next).getByTestId('accounts-switch-acc-wb-next')).toBeEnabled();

    const off = screen.getByTestId('accounts-card-acc-wb-off');
    expect(within(off).getByText('已停用')).toBeInTheDocument();
    expect(within(off).queryByTestId('accounts-checkin-current-acc-wb-off')).toBeNull();
    expect(within(off).queryByTestId(`accounts-checkin-acc-wb-off`)).toBeNull();
  });

  it('is_current=null 时负向信息不渲染：「客户端当前未知」退到 title，不假装非当前', async () => {
    mockList([account({ id: 'acc-mm-unk', app_id: 'minimax', display_name: '未知账号', is_current: null })]);
    renderPanel();
    // ACC-B1：右栏只渲染选中平台 → 先切到 MiniMax
    await userEvent.click(await screen.findByTestId('accounts-index-item-minimax'));
    const card = await screen.findByTestId('accounts-card-acc-mm-unk');
    expect(within(card).queryByText('客户端当前未知')).toBeNull();
    expect(within(card).getByTestId('accounts-client-current-acc-mm-unk')).toBeEmptyDOMElement();
    expect(within(card).getByTestId('accounts-client-current-acc-mm-unk')).toHaveAttribute('title', '客户端当前未知');
  });

  it('切换按 switch_reason_code 决定可用性：不可用时禁用并给原因，可用时二次确认后才发请求', async () => {
    mockList([
      account({ id: 'acc-mm-1', app_id: 'minimax', display_name: 'MM 账号', is_current: false }),
      account({ id: 'acc-wb-2', app_id: 'workbuddy_desktop', display_name: 'WB 备用账号', is_current: false }),
    ]);
    const posts: string[] = [];
    server.use(
      http.post('/api/managed-accounts/acc-wb-2/switch', () => {
        posts.push('acc-wb-2');
        return HttpResponse.json({ operation_id: 'op-1', operation: operation() }, { status: 202 });
      }),
      http.get('/api/account-operations/op-1', () => HttpResponse.json(operation({ state: 'succeeded', stage: 'verify' }))),
    );
    renderPanel();

    // ACC-B1：右栏只渲染选中平台 → 先切到 MiniMax
    await userEvent.click(await screen.findByTestId('accounts-index-item-minimax'));
    const mmCard = await screen.findByTestId('accounts-card-acc-mm-1');
    // ACC-UI-2：不可用时不给灰按钮，改为平台级可见原因（含服务端 switch_reason_code 与出路）
    expect(within(mmCard).queryByTestId('accounts-switch-acc-mm-1')).toBeNull();
    const mmReason = screen.getByTestId('accounts-switch-unavailable-minimax');
    expect(mmReason).toHaveTextContent('切换不可用');
    expect(mmReason).toHaveAttribute('title', expect.stringContaining('本机未安装该客户端'));
    expect(mmReason).toHaveAttribute('title', expect.stringContaining('CLIENT_NOT_INSTALLED'));
    expect(mmReason).toHaveAttribute('title', expect.stringContaining('需在客户端手动切换'));
    expect(posts).toHaveLength(0);

    // ACC-B1：切回 WorkBuddy，右栏默认展开
    await userEvent.click(screen.getByTestId('accounts-index-item-workbuddy_desktop'));
    const wbCard = await screen.findByTestId('accounts-card-acc-wb-2');
    await userEvent.click(within(wbCard).getByTestId('accounts-switch-acc-wb-2'));
    expect(posts).toHaveLength(0);
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));
    await waitFor(() => expect(posts).toEqual(['acc-wb-2']));
    await waitFor(() => expect(within(wbCard).getByTestId('accounts-op-acc-wb-2')).toHaveTextContent('切换成功'));
  });

  it('切换成功后刷新账号列表：is_current 与结果一致，旧「客户端当前」芯片消失', async () => {
    let switched = false;
    const wbCurrent = account({ id: 'acc-wb-cur', display_name: 'WB 当前', is_current: true });
    const wbNext = account({ id: 'acc-wb-next', display_name: 'WB 待切', is_current: false });
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([
        { ...wbCurrent, is_current: !switched },
        { ...wbNext, is_current: switched },
      ])),
      http.post('/api/managed-accounts/acc-wb-next/switch', () =>
        HttpResponse.json({ operation_id: 'op-sw', operation: operation() }, { status: 202 }),
      ),
      http.get('/api/account-operations/op-sw', () => {
        switched = true;
        return HttpResponse.json(operation({ state: 'succeeded', stage: 'verify' }));
      }),
    );
    renderPanel();

    const nextCard = await screen.findByTestId('accounts-card-acc-wb-next');
    await userEvent.click(within(nextCard).getByTestId('accounts-switch-acc-wb-next'));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    await waitFor(
      () => expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toHaveTextContent('客户端当前'),
      { timeout: 3000 },
    );
    expect(screen.getByTestId('accounts-client-current-acc-wb-cur')).toBeEmptyDOMElement();
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

  it('无账号时三个平台各显示空态', async () => {
    mockList([]);
    renderPanel();
    for (const app of ['workbuddy_desktop', 'minimax', 'trae']) {
      await userEvent.click(await screen.findByTestId(`accounts-index-item-${app}`));
      const section = await screen.findByTestId(`accounts-app-${app}`);
      expect(within(section).getByTestId(`accounts-empty-${app}`)).toHaveTextContent('尚无');
    }
    expect(screen.queryByTestId('accounts-empty-codebuddy_desktop')).not.toBeInTheDocument();
  });

  it('列表读取失败显示错误态', async () => {
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '账号服务不可用' } }, { status: 500 })));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('账号服务不可用');
  });

  it('能力矩阵读取失败：错误态、不发请求、签到入口禁用', async () => {
    mockList([account()]);
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 })));
    renderPanel();

    expect(await screen.findByTestId('accounts-capabilities-error')).toHaveTextContent('能力矩阵不可用');
    expect(await screen.findByTestId('accounts-one-click-checkin')).toBeDisabled();
    const card = await screen.findByTestId('accounts-card-acc-wb-1');
    // ACC-UI-2：能力未知时不渲染切换按钮（避免假入口）；单账号签到按钮已删（ACC-UI-PRUNE）；
    // ACC-UI-TOPBAR：捕获按钮已整体删除
    expect(within(card).queryByTestId('accounts-switch-acc-wb-1')).toBeNull();
    expect(within(card).queryByTestId('accounts-checkin-acc-wb-1')).toBeNull();
    expect(screen.queryByTestId('accounts-capture-workbuddy_desktop')).toBeNull();
  });

  it('DOM 不含秘密字段：identity_hash / client_snapshot_ref / token / 路径一律不渲染', async () => {
    mockList([account({ id: 'acc-wb-secret', display_name: '秘密检查账号' })]);
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json([
      {
        ...account({ id: 'acc-wb-secret', display_name: '秘密检查账号' }),
        identity_hash: 'f'.repeat(64),
        client_snapshot_ref: 'snap-uuid-secret',
        checkin_credential_ref: 'cred-secret',
        access_token: 'token-secret-value',
        vault_ref: 'vault-ref-secret',
        file_path: 'C:\\Users\\secret\\auth.json',
      },
    ])));
    renderPanel();
    await screen.findByTestId('accounts-card-acc-wb-secret');
    const html = document.body.innerHTML;
    expect(html).not.toContain('f'.repeat(64));
    expect(html).not.toContain('snap-uuid-secret');
    expect(html).not.toContain('cred-secret');
    expect(html).not.toContain('token-secret-value');
    expect(html).not.toContain('vault-ref-secret');
    expect(html).not.toContain('auth.json');
    // 但非敏感标识可见
    expect(screen.getByTestId('accounts-card-acc-wb-secret')).toHaveTextContent('a1b2c3d4');
  });
});
