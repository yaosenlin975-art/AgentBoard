/**
 * ACC-DEL-02 展开层删除账号两步流（接 DELETE /api/managed-accounts/:id）。
 * 设计依据 §7/§8：Docs/designs/accounts/2026-11-04-accounts-unified-panel.md。
 *
 * 覆盖：两步确认（未确认不发请求）→ 调用 → 失效重拉；3 秒未确认自动收回；取消收回；
 * 409 走中文主文案（裸码只进 title）；is_current=true 追加「不会退出客户端登录」警示；
 * 能力矩阵未就绪时删除按钮禁用。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

const WB_ID = 'acc-wb-1';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: WB_ID, app_id: 'workbuddy_desktop', client_instance_id: 'wb-instance-0123456789',
    service_region: 'cn', display_name: 'WB 主账号', identity_hint: 'a1b2c3d4', client_snapshot_version: 3,
    checkin_capability: 'supported', enabled: true, last_checkin_day: null, last_checkin_status: null,
    last_checkin_at: null, created_at: 1, updated_at: 2, is_current: false, ...overrides,
  };
}

const CAPABILITIES: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
];

/**
 * 列表是否为空由「删除是否已发生」决定，而不是调用次数：
 * ACC-REFRESH 启动刷新会额外触发一次失效重拉，按次数收敛会误判。
 */
function mockList(accounts: AccountView[], isRemoved: () => boolean = () => false) {
  const getCalls: number[] = [];
  server.use(
    http.get('/api/managed-accounts', () => {
      getCalls.push(Date.now());
      return HttpResponse.json(isRemoved() ? [] : accounts);
    }),
  );
  return getCalls;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

/** 默认全折叠：删除按钮在展开层里，先展开 WorkBuddy 行 */
async function openWorkBuddyRow() {
  await screen.findByTestId('accounts-card-' + WB_ID);
  await userEvent.click(screen.getByTestId('accounts-toggle-workbuddy_desktop'));
}

beforeEach(() => {
  server.resetHandlers();
  server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)));
});

describe('展开层删除两步流（ACC-DEL-02）', () => {
  it('两步流：点删除只出确认行，确认后才发 DELETE，成功后失效重拉列表', async () => {
    let removed = false;
    const getCalls = mockList([account()], () => removed);
    const deletes: string[] = [];
    server.use(
      http.delete('/api/managed-accounts/:id', ({ params }) => {
        deletes.push(String(params.id));
        removed = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();
    await openWorkBuddyRow();
    const callsAfterOpen = getCalls.length;

    await userEvent.click(screen.getByTestId(`accounts-delete-${WB_ID}`));
    const confirm = screen.getByTestId(`accounts-delete-confirm-${WB_ID}`);
    expect(confirm).toBeInTheDocument();
    expect(deletes).toHaveLength(0);

    await userEvent.click(within(confirm).getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));
    await waitFor(() => expect(deletes).toEqual([WB_ID]));
    await waitFor(() => expect(screen.queryByTestId(`accounts-card-${WB_ID}`)).not.toBeInTheDocument());
    expect(getCalls.length).toBeGreaterThan(callsAfterOpen);
  });

  it('取消收回，且 3 秒未确认自动收回；自动收回后不发请求', async () => {
    mockList([account()]);
    const deletes: string[] = [];
    server.use(http.delete('/api/managed-accounts/:id', () => {
      deletes.push('called');
      return new HttpResponse(null, { status: 204 });
    }));
    renderPanel();
    await openWorkBuddyRow();

    // 手动取消
    await userEvent.click(screen.getByTestId(`accounts-delete-${WB_ID}`));
    const confirm = screen.getByTestId(`accounts-delete-confirm-${WB_ID}`);
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId(`accounts-delete-confirm-${WB_ID}`)).not.toBeInTheDocument();

    // 超时自动收回（真定时器：确认窗就是 3 秒，缩短断言等待只会让用例说谎）
    await userEvent.click(screen.getByTestId(`accounts-delete-${WB_ID}`));
    expect(screen.getByTestId(`accounts-delete-confirm-${WB_ID}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId(`accounts-delete-confirm-${WB_ID}`)).not.toBeInTheDocument(), { timeout: 4_000 });
    expect(deletes).toHaveLength(0);
  });

  it('409 ACCOUNT_BUSY：主文案中文，裸码只进 title；确认行收回', async () => {
    mockList([account()]);
    server.use(
      http.delete('/api/managed-accounts/:id', () => HttpResponse.json(
        { error: { code: 'ACCOUNT_BUSY', message: '该账号仍有进行中的操作' } }, { status: 409 }),
      ),
    );
    renderPanel();
    await openWorkBuddyRow();

    await userEvent.click(screen.getByTestId(`accounts-delete-${WB_ID}`));
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));

    const alert = await screen.findByTestId(`accounts-delete-error-${WB_ID}`);
    expect(alert).toHaveTextContent('账号正忙，暂时无法删除');
    expect(alert.textContent ?? '').not.toContain('ACCOUNT_BUSY');
    expect(alert).toHaveAttribute('title', 'ACCOUNT_BUSY');
    expect(screen.queryByTestId(`accounts-delete-confirm-${WB_ID}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`accounts-card-${WB_ID}`)).toBeInTheDocument();
  });

  it('未收录的失败码走中性中文文案，裸码仍只在 title', async () => {
    mockList([account()]);
    server.use(
      http.delete('/api/managed-accounts/:id', () => HttpResponse.json(
        { error: { code: 'SERVER_ADDED_A_NEW_CODE', message: '服务端新码' } }, { status: 409 }),
      ),
    );
    renderPanel();
    await openWorkBuddyRow();

    await userEvent.click(screen.getByTestId(`accounts-delete-${WB_ID}`));
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));
    const alert = await screen.findByTestId(`accounts-delete-error-${WB_ID}`);
    expect(alert).toHaveTextContent('该操作暂不可用');
    expect(alert.textContent ?? '').not.toContain('SERVER_ADDED_A_NEW_CODE');
  });

  it('is_current=true：确认行追加「不会退出客户端登录」警示，删除仍可执行', async () => {
    mockList([account({ is_current: true })]);
    const deletes: string[] = [];
    server.use(http.delete('/api/managed-accounts/:id', () => {
      deletes.push('called');
      return new HttpResponse(null, { status: 204 });
    }));
    renderPanel();
    await openWorkBuddyRow();

    const deleteButton = screen.getByTestId(`accounts-delete-${WB_ID}`);
    expect(deleteButton).toBeEnabled();
    await userEvent.click(deleteButton);
    expect(await screen.findByTestId(`accounts-delete-current-warning-${WB_ID}`))
      .toHaveTextContent('该账号是当前客户端登录账号；删除记录不会退出客户端登录');
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));
    await waitFor(() => expect(deletes).toEqual(['called']));
  });

  it('能力矩阵失败：删除按钮禁用，点击不发请求（与其余写操作同口径）', async () => {
    mockList([account()]);
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json(
      { error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 }),
    ));
    const deletes: string[] = [];
    server.use(http.delete('/api/managed-accounts/:id', () => {
      deletes.push('called');
      return new HttpResponse(null, { status: 204 });
    }));
    renderPanel();
    await openWorkBuddyRow();

    const button = screen.getByTestId(`accounts-delete-${WB_ID}`);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '能力矩阵未就绪，暂时不能删除账号');
    await userEvent.click(button);
    expect(deletes).toHaveLength(0);
    expect(screen.queryByTestId(`accounts-delete-confirm-${WB_ID}`)).not.toBeInTheDocument();
  });
});
