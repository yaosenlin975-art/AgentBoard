/**
 * ACC-B4：切换就地确认与切换态（口径：`Docs/prototypes/accounts-redesign-2026-11-04/b-console.html` `.acard-confirm`）。
 *
 * 覆盖：
 * ① 点「切换」→ 卡片内展开就地确认行（不弹全局层），3 秒不确认自动收回且账号状态不变（fake timers）；
 * ② 确认后进入切换中 → operation 轮询真实到达成功终态（第一次 running、第二次 succeeded），
 *    列表失效重拉后目标账号出现「客户端当前」芯片、原账号失去；
 * ③ 切换中本卡动作按钮禁用不可重复点击；失败到终态给中文原因（沿用 reasonCode 映射），
 *    裸码只进三级技术信息；失败后回到未切换态，当前账号不变；
 * ④ 切换请求本身失败且原因码无中文映射：卡面给中性文案，裸码/原始 message 不进卡面，只进 title 与三级技术信息。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, AccountOperation } from '@agentboard/shared';
import type { AccountView } from '../components/settings/AccountCard';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-wb-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-instance-0123456789',
    service_region: 'cn',
    display_name: 'WorkBuddy 账号',
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

/** 原账号（客户端当前）与目标账号（待切换） */
const CURRENT = account({ id: 'acc-wb-cur', display_name: '当前登录号', is_current: true });
const NEXT = account({ id: 'acc-wb-next', display_name: '待切换号', is_current: false });

const CAPABILITIES: AccountCapability[] = [
  {
    app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true,
    capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
  },
];

function operation(overrides: Partial<AccountOperation> = {}): AccountOperation {
  return {
    id: 'op-1',
    batch_id: null,
    account_id: 'acc-wb-next',
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
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  server.resetHandlers();
  server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)));
});

// 用例超时被 vitest 打断时 finally 可能不执行：每条用例结束兜底恢复真实时钟，防止假时钟泄漏到后续用例
afterEach(() => {
  vi.useRealTimers();
});

describe('切换就地确认与切换态（ACC-B4）', () => {
  it('①点切换出现就地确认行；3 秒不确认自动收回且账号状态不变', async () => {
    const switchPosts: string[] = [];
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([CURRENT, NEXT])),
      http.post('/api/managed-accounts/acc-wb-next/switch', () => {
        switchPosts.push('acc-wb-next');
        return HttpResponse.json({ operation_id: 'op-x', operation: operation({ id: 'op-x' }) }, { status: 202 });
      }),
    );
    renderPanel();
    const nextCard = await screen.findByTestId('accounts-card-acc-wb-next');
    expect(within(nextCard).queryByTestId('accounts-switch-confirm')).toBeNull();
    expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toBeEmptyDOMElement();

    // fake timers 只包住确认窗口：初次加载用真实时钟等 MSW 返回；窗口内的点击用 fireEvent（同步，不依赖时钟）
    vi.useFakeTimers();
    try {
      fireEvent.click(within(nextCard).getByTestId('accounts-switch-acc-wb-next'));
      const confirm = screen.getByTestId('accounts-switch-confirm');
      expect(confirm).toHaveTextContent('切换后客户端将以该账号登录');
      expect(confirm).toHaveTextContent('3 秒内未确认会自动收回');
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(screen.queryByTestId('accounts-switch-confirm')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    // 未确认不发切换请求；两个账号的「客户端当前」芯片保持原状
    expect(switchPosts).toHaveLength(0);
    expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toBeEmptyDOMElement();
    expect(screen.getByTestId('accounts-client-current-acc-wb-cur')).toHaveTextContent('客户端当前');
  });

  it('②确认后切换成功：operation 轮询真实到达终态，「客户端当前」芯片转移到目标账号', async () => {
    let switched = false;
    let polls = 0;
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([
        { ...CURRENT, is_current: !switched },
        { ...NEXT, is_current: switched },
      ])),
      http.post('/api/managed-accounts/acc-wb-next/switch', () =>
        HttpResponse.json({ operation_id: 'op-sw', operation: operation({ id: 'op-sw', state: 'queued', stage: 'preflight' }) }, { status: 202 })),
      http.get('/api/account-operations/op-sw', () => {
        polls += 1;
        // 第一次轮询给进行中，第二次才给成功终态：终态判定必须由轮询推进到，不一步 mock 到位
        if (polls === 1) return HttpResponse.json(operation({ id: 'op-sw', state: 'running', stage: 'write' }));
        switched = true;
        return HttpResponse.json(operation({ id: 'op-sw', state: 'succeeded', stage: 'verify', finished_at: 3 }));
      }),
    );
    renderPanel();
    const nextCard = await screen.findByTestId('accounts-card-acc-wb-next');
    await userEvent.click(within(nextCard).getByTestId('accounts-switch-acc-wb-next'));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    const op = await waitFor(() => {
      const el = within(nextCard).getByTestId('accounts-op-acc-wb-next');
      expect(el).toHaveAttribute('data-state', 'succeeded');
      return el;
    }, { timeout: 3_000 });
    expect(op).toHaveTextContent('切换成功');
    expect(polls).toBeGreaterThanOrEqual(2);

    // 列表失效重拉后：目标账号获得芯片，原账号失去
    await waitFor(
      () => expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toHaveTextContent('客户端当前'),
      { timeout: 3_000 },
    );
    await waitFor(() => expect(screen.getByTestId('accounts-client-current-acc-wb-cur')).toBeEmptyDOMElement());
  });

  it('③切换中本卡动作按钮禁用；失败到终态给中文原因并回到未切换态，当前账号不变', async () => {
    let polls = 0;
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([CURRENT, NEXT])),
      http.post('/api/managed-accounts/acc-wb-next/switch', () =>
        HttpResponse.json({ operation_id: 'op-f', operation: operation({ id: 'op-f', state: 'queued', stage: 'preflight' }) }, { status: 202 })),
      http.get('/api/account-operations/op-f', () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json(operation({ id: 'op-f', state: 'running', stage: 'write' }));
        return HttpResponse.json(operation({ id: 'op-f', state: 'failed', stage: 'rollback', safe_error_code: 'TARGET_CREDENTIAL_MISSING', finished_at: 3 }));
      }),
    );
    renderPanel();
    const nextCard = await screen.findByTestId('accounts-card-acc-wb-next');
    await userEvent.click(within(nextCard).getByTestId('accounts-switch-acc-wb-next'));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    // 切换中（operation 未到终态）：本卡全部动作按钮禁用，不可重复点击
    const switchBtn = within(nextCard).getByTestId('accounts-switch-acc-wb-next');
    await waitFor(() => expect(switchBtn).toBeDisabled());
    expect(within(nextCard).getByTestId('accounts-checkin-acc-wb-next')).toBeDisabled();
    expect(within(nextCard).getByTestId('accounts-enabled-toggle-acc-wb-next')).toBeDisabled();
    expect(within(nextCard).getByTestId('accounts-delete-acc-wb-next')).toBeDisabled();

    // 轮询真实到达失败终态：主文案走中文映射（TARGET_CREDENTIAL_MISSING → 目标账号缺少可用凭据），裸码不进卡面
    const op = await waitFor(() => {
      const el = within(nextCard).getByTestId('accounts-op-acc-wb-next');
      expect(el).toHaveAttribute('data-state', 'failed');
      return el;
    }, { timeout: 3_000 });
    expect(op).toHaveTextContent('目标账号缺少可用凭据');
    expect(op.textContent ?? '').not.toContain('TARGET_CREDENTIAL_MISSING');
    expect(within(nextCard).getByTestId('accounts-tech-code-acc-wb-next')).toHaveTextContent('TARGET_CREDENTIAL_MISSING');

    // 失败后回到未切换态：切换按钮恢复可点；当前账号芯片不变、目标账号无芯片
    await waitFor(() => expect(switchBtn).toBeEnabled());
    expect(screen.getByTestId('accounts-client-current-acc-wb-cur')).toHaveTextContent('客户端当前');
    expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toBeEmptyDOMElement();
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('④切换请求失败且原因码无中文映射：卡面给中性文案，裸码只进三级技术信息，账号状态不变', async () => {
    const switchPosts: string[] = [];
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([CURRENT, NEXT])),
      http.post('/api/managed-accounts/acc-wb-next/switch', () => {
        switchPosts.push('acc-wb-next');
        return HttpResponse.json({ error: { code: 'FUTURE_SWITCH_REASON', message: 'mystery failure' } }, { status: 500 });
      }),
    );
    renderPanel();
    const nextCard = await screen.findByTestId('accounts-card-acc-wb-next');
    await userEvent.click(within(nextCard).getByTestId('accounts-switch-acc-wb-next'));
    await userEvent.click(await screen.findByTestId('accounts-switch-confirm-yes'));

    const alert = await screen.findByTestId('accounts-switch-error-acc-wb-next');
    expect(alert).toHaveTextContent('该操作暂不可用');
    expect(alert.textContent ?? '').not.toContain('FUTURE_SWITCH_REASON');
    expect(alert.textContent ?? '').not.toContain('mystery failure');
    expect(alert).toHaveAttribute('title', 'FUTURE_SWITCH_REASON');

    // 确认行收回；未进入切换中（无 operation 状态块）；裸码进三级技术信息
    expect(screen.queryByTestId('accounts-switch-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accounts-op-acc-wb-next')).not.toBeInTheDocument();
    expect(within(nextCard).getByTestId('accounts-tech-code-acc-wb-next')).toHaveTextContent('FUTURE_SWITCH_REASON');

    // 回到未切换态：当前账号不变，目标账号无芯片
    expect(within(nextCard).getByTestId('accounts-switch-acc-wb-next')).toBeEnabled();
    expect(screen.getByTestId('accounts-client-current-acc-wb-cur')).toHaveTextContent('客户端当前');
    expect(within(nextCard).getByTestId('accounts-client-current-acc-wb-next')).toBeEmptyDOMElement();
    expect(switchPosts).toEqual(['acc-wb-next']);
  });
});
