/**
 * ACC-B5：删除账号就地确认增强（口径：`Docs/prototypes/accounts-redesign-2026-11-04/b-console.html`
 * `.acard-confirm / .acard-error`）。
 *
 * 覆盖：
 * ① 三种 409（ACCOUNT_BUSY / CHECKIN_AUTHORIZATION_EXISTS / RECOVERY_REQUIRED）各给删除语境中文主文案，
 *    裸码不进主文案，进三级「技术信息」技术码行（accounts-tech-code-*，details 折叠内）；卡片仍在、确认行收回；
 * ② is_current=true 确认行追加当前账号警示与 3 秒倒计时收缩条；非当前不出现警示；
 * ③ 删除成功卡片消失（列表失效重拉），左栏平台计数与今日 n/m 重算；
 * ④ 删除失败卡片与选中态不变，删除按钮可再次操作。
 *
 * 全程真实时钟：确认窗 3 秒远大于 MSW 往返，自动收回不会插队断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability } from '@agentboard/shared';
import type { AccountView } from '../components/settings/AccountCard';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const WB_ID = 'acc-wb-del';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: WB_ID,
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-instance-0123456789',
    service_region: 'cn',
    display_name: 'WB 待删号',
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 3,
    checkin_capability: 'supported',
    enabled: true,
    last_checkin_day: null,
    last_checkin_status: null,
    last_checkin_at: null,
    created_at: 1,
    updated_at: 2,
    is_current: false,
    ...overrides,
  };
}

const CAPABILITIES: AccountCapability[] = [
  {
    app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true,
    capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
  },
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

/** 展开就地删除确认行（卡片在右栏选中平台详情里，无需再展开折叠行） */
async function openDeleteConfirm(): Promise<void> {
  const card = await screen.findByTestId(`accounts-card-${WB_ID}`);
  await userEvent.click(within(card).getByTestId(`accounts-delete-${WB_ID}`));
  expect(screen.getByTestId(`accounts-delete-confirm-${WB_ID}`)).toBeInTheDocument();
}

beforeEach(() => {
  localStorage.clear();
  server.resetHandlers();
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([account()])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)),
  );
});

// 用例超时被 vitest 打断时兜底恢复真实时钟，防止假时钟泄漏到后续用例
afterEach(() => {
  vi.useRealTimers();
});

describe('删除就地确认与三种 409（ACC-B5）', () => {
  it.each([
    { code: 'ACCOUNT_BUSY', label: '账号正忙' },
    { code: 'CHECKIN_AUTHORIZATION_EXISTS', label: '已有进行中的签到授权' },
    { code: 'RECOVERY_REQUIRED', label: '上次切换仍需恢复' },
  ])('①409 $code：主文案「$label…」中文前缀，裸码进三级技术信息，卡片仍在', async ({ code, label }) => {
    server.use(http.delete('/api/managed-accounts/:id', () =>
      HttpResponse.json({ error: { code, message: 'server says no' } }, { status: 409 })));
    renderPanel();
    await openDeleteConfirm();
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));

    // 主文案走删除语境中文映射；裸码与服务端 message 都不进主文案
    const alert = await screen.findByTestId(`accounts-delete-error-${WB_ID}`);
    expect(alert).toHaveTextContent(label);
    expect(alert.textContent ?? '').not.toContain(code);
    expect(alert.textContent ?? '').not.toContain('server says no');
    expect(alert).toHaveAttribute('title', code);

    // 裸码进三级「技术信息」（details 折叠内）的 dt 技术码行
    const tech = screen.getByTestId(`accounts-tech-${WB_ID}`);
    expect(tech.tagName).toBe('DETAILS');
    expect(within(tech).getByTestId(`accounts-tech-code-${WB_ID}`)).toHaveTextContent(code);

    // 确认行收回；卡片仍在
    expect(screen.queryByTestId(`accounts-delete-confirm-${WB_ID}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`accounts-card-${WB_ID}`)).toBeInTheDocument();
  });

  it('②is_current=true 确认行追加当前账号警示与倒计时收缩条；非当前不出现警示', async () => {
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json([account({ is_current: true, display_name: 'WB 当前号' })])));
    const view = renderPanel();
    await openDeleteConfirm();
    const confirm = screen.getByTestId(`accounts-delete-confirm-${WB_ID}`);
    expect(within(confirm).getByTestId(`accounts-delete-current-warning-${WB_ID}`))
      .toHaveTextContent('该账号是当前客户端登录账号');
    expect(within(confirm).getByTestId(`accounts-delete-countdown-${WB_ID}`)).toHaveAttribute('aria-hidden', 'true');
    view.unmount();

    // 非当前账号：确认行照常出现，警示不出现
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json([account({ is_current: false })])));
    renderPanel();
    await openDeleteConfirm();
    const confirmAgain = screen.getByTestId(`accounts-delete-confirm-${WB_ID}`);
    expect(within(confirmAgain).queryByTestId(`accounts-delete-current-warning-${WB_ID}`)).not.toBeInTheDocument();
    expect(within(confirmAgain).getByTestId(`accounts-delete-countdown-${WB_ID}`)).toBeInTheDocument();
  });

  it('③删除成功：卡片消失，左栏平台计数与今日 n/m 重算', async () => {
    let removed = false;
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json(removed ? [] : [account({ is_current: true })])),
      http.delete('/api/managed-accounts/:id', () => {
        removed = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();
    await screen.findByTestId(`accounts-card-${WB_ID}`);
    // 初始：左栏平台计数 1、今日 0/1、索引健康态出现
    expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('1');
    expect(screen.getByTestId('accounts-today-summary')).toHaveTextContent('今日 0/1');
    expect(screen.getByTestId('accounts-index-health-workbuddy_desktop')).toHaveTextContent('0/1');

    await openDeleteConfirm();
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));

    // 卡片消失；失效重拉带动左栏平台指标与今日 n/m
    await waitFor(() => expect(screen.queryByTestId(`accounts-card-${WB_ID}`)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('accounts-index-count-workbuddy_desktop')).toHaveTextContent('0'));
    await waitFor(() => expect(screen.getByTestId('accounts-today-summary')).toHaveTextContent('今日 0/0'));
    expect(screen.queryByTestId('accounts-index-health-workbuddy_desktop')).not.toBeInTheDocument();
    expect(screen.getByTestId('accounts-detail-current')).toHaveTextContent('未设置当前账号');
  });

  it('④删除失败：卡片与选中态不变，删除按钮可再次打开确认行', async () => {
    let calls = 0;
    server.use(http.delete('/api/managed-accounts/:id', () => {
      calls += 1;
      return HttpResponse.json({ error: { code: 'ACCOUNT_BUSY', message: 'busy' } }, { status: 409 });
    }));
    renderPanel();
    await openDeleteConfirm();
    await userEvent.click(screen.getByTestId(`accounts-delete-confirm-yes-${WB_ID}`));
    await screen.findByTestId(`accounts-delete-error-${WB_ID}`);

    // 卡片仍在、左栏选中态不变
    expect(screen.getByTestId(`accounts-card-${WB_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');

    // 删除按钮恢复可点，可再次打开确认行继续操作
    const deleteButton = screen.getByTestId(`accounts-delete-${WB_ID}`);
    await waitFor(() => expect(deleteButton).toBeEnabled());
    await userEvent.click(deleteButton);
    expect(screen.getByTestId(`accounts-delete-confirm-${WB_ID}`)).toBeInTheDocument();
    expect(calls).toBe(1);
  });
});
