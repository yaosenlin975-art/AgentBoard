/**
 * 签到批次与能力矩阵接入（ACC-09；ACC-UI-PRUNE 起单平台签到入口已删，批次统一由一键签到发起，
 * 结果条 = accounts-one-click-batch-* 内的 CheckinBatchPanel）：
 * 能力以服务端为准、checkin=false 不发请求、批次 items 各状态、取消只对 queued 生效、能力矩阵失败错误态。
 * 409 CHECKIN_BATCH_IN_PROGRESS 的展示断言在 AccountsOneClick.test.tsx。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, CheckinBatch, CheckinBatchItem, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

const WB_ID = '11111111-1111-4111-8111-111111111111';
const WB_ID2 = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';

function account(id: string, name: string): AccountView {
  return {
    id,
    app_id: 'workbuddy_desktop',
    client_instance_id: `inst-${id.slice(0, 6)}`,
    service_region: 'cn',
    display_name: name,
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 1,
    checkin_capability: 'unknown',
    enabled: true,
    last_checkin_day: null,
    last_checkin_status: null,
    last_checkin_at: null,
    created_at: 1,
    updated_at: 2,
    is_current: true,
    has_checkin_credential: true,
  };
}

function capability(overrides: Partial<AccountCapability> = {}): AccountCapability {
  return {
    app_id: 'workbuddy_desktop',
    capture: true,
    switch: true,
    checkin: false,
    capture_reason_code: 'OK',
    switch_reason_code: 'OK',
    checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
    reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
    source: 'static',
    ...overrides,
  };
}

function batch(items: Array<{ account_id: string; state: CheckinBatchItem['state']; safe_error_code?: string | null }>): CheckinBatch {
  return {
    id: BATCH_ID,
    app_id: 'workbuddy_desktop',
    status: items.some((i) => i.state === 'running') ? 'running' : items.every((i) => i.state === 'succeeded' || i.state === 'already_done') ? 'succeeded' : 'queued',
    total: items.length,
    profile_local_day: '2026-11-02',
    created_at: 1,
    finished_at: null,
    items: items.map((item, index) => ({
      batch_id: BATCH_ID,
      account_id: item.account_id,
      seq: index,
      state: item.state,
      operation_id: null,
      safe_error_code: item.safe_error_code ?? null,
      updated_at: 2,
    })),
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

const checkinPosts: Array<{ body: unknown; idempotencyKey: string | null }> = [];

beforeEach(() => {
  server.resetHandlers();
  checkinPosts.length = 0;
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([account(WB_ID, 'WB 账号一'), account(WB_ID2, 'WB 账号二')])),
    // ACC-14：批次面板额外读 operation 记录（猫猫旅行结果）；这里默认无 operation
    http.get('/api/account-operations', () => HttpResponse.json([])),
    http.post('/api/checkin-runs', async ({ request }) => {
      checkinPosts.push({ body: await request.json(), idempotencyKey: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ batch: batch([{ account_id: WB_ID, state: 'running' }, { account_id: WB_ID2, state: 'queued' }]), replayed: false }, { status: 202 });
    }),
  );
});

describe('签到批次（ACC-09）', () => {
  it('checkin=false：单平台/单账号签到入口已删，一键签到禁用并显示原因，点击不发请求', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      capability({ checkin: false, reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' }),
      capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
    ])));
    renderPanel();

    await screen.findByTestId(`accounts-card-${WB_ID}`);
    // ACC-UI-PRUNE：平台级与单账号签到按钮不再渲染
    expect(screen.queryByTestId('accounts-checkin-all-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId(`accounts-checkin-${WB_ID}`)).toBeNull();

    const oneClick = screen.getByTestId('accounts-one-click-checkin');
    expect(oneClick).toBeDisabled();
    expect(oneClick).toHaveAttribute('title', expect.stringContaining('没有可签到的平台'));
    expect(screen.getByTestId('accounts-one-click-plan')).toHaveTextContent('当前没有可签到的平台');
    await userEvent.click(oneClick);
    expect(checkinPosts).toHaveLength(0);
  });

  it('checkin=true（source=derived）：一键签到发起批次并在结果条展示 items 各状态', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([{ account_id: WB_ID, state: 'succeeded' }, { account_id: WB_ID2, state: 'failed', safe_error_code: 'ACCOUNT_BUSY' }]))),
    );
    renderPanel();

    await screen.findByTestId(`accounts-card-${WB_ID}`);
    await userEvent.click(screen.getByTestId('accounts-one-click-checkin'));

    await waitFor(() => expect(checkinPosts).toHaveLength(1));
    expect(checkinPosts[0]!.body).toEqual({ app_id: 'workbuddy_desktop', account_ids: [WB_ID, WB_ID2] });
    expect(checkinPosts[0]!.idempotencyKey).toBeTruthy();

    const panel = within(await screen.findByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    expect(within(panel).getByTestId('checkin-batch-id')).toHaveTextContent(BATCH_ID.slice(0, 8));
    await waitFor(() => expect(within(panel).getByTestId(`checkin-item-${WB_ID}`)).toHaveAttribute('data-state', 'succeeded'));
    expect(within(panel).getByTestId(`checkin-item-${WB_ID2}`)).toHaveAttribute('data-state', 'failed');
    expect(within(panel).getByTestId(`checkin-item-error-${WB_ID2}`)).toHaveTextContent('账号正忙，本轮未发起');
  });

  it('失败原因可读：无安全码给兜底文案，已知码给中文原因（裸码折叠进技术码层）', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([
        { account_id: WB_ID, state: 'failed', safe_error_code: null },
        { account_id: WB_ID2, state: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_INVALID' },
      ]))),
    );
    renderPanel();
    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));

    const panel = within(await screen.findByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(panel).getByTestId(`checkin-item-error-${WB_ID}`)).toHaveTextContent('原因未记录，请重试'));
    // 已知码转中文文案作为主文案，裸码收进折叠层
    expect(within(panel).getByTestId(`checkin-item-error-${WB_ID2}`)).toHaveTextContent('凭据已失效，请重新读取本机账号');
    const codeDetails = within(panel).getByTestId(`checkin-item-error-${WB_ID2}-code`);
    expect(codeDetails).not.toHaveAttribute('open');
    expect(codeDetails).toHaveTextContent('CHECKIN_CREDENTIAL_INVALID');
  });

  it('重试复用同一 Idempotency-Key（同批账号），换批次换 key', async () => {
    let attempt = 0;
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.post('/api/checkin-runs', async ({ request }) => {
        attempt += 1;
        checkinPosts.push({ body: await request.json(), idempotencyKey: request.headers.get('Idempotency-Key') });
        if (attempt === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: '临时故障' } }, { status: 500 });
        return HttpResponse.json({ batch: batch([{ account_id: WB_ID, state: 'queued' }, { account_id: WB_ID2, state: 'queued' }]), replayed: false }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([{ account_id: WB_ID, state: 'queued' }, { account_id: WB_ID2, state: 'queued' }]))),
    );
    renderPanel();

    const btn = await screen.findByTestId('accounts-one-click-checkin');
    await userEvent.click(btn);
    await waitFor(() => expect(checkinPosts).toHaveLength(1));
    await userEvent.click(btn);
    await waitFor(() => expect(checkinPosts).toHaveLength(2));
    expect(checkinPosts[0]!.idempotencyKey).toBe(checkinPosts[1]!.idempotencyKey);
  });

  it('取消只对 queued 生效：running 项如实提示已发出请求', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.post('/api/checkin-runs', () => HttpResponse.json({ batch: batch([{ account_id: WB_ID, state: 'running' }, { account_id: WB_ID2, state: 'queued' }]), replayed: false }, { status: 202 })),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([{ account_id: WB_ID, state: 'running' }, { account_id: WB_ID2, state: 'queued' }]))),
      http.post('/api/checkin-runs/:id/cancel', () => HttpResponse.json({ batch_id: BATCH_ID, cancelled: [WB_ID2], running: [WB_ID] })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));
    const panel = within(await screen.findByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    const cancelBtn = within(panel).getByTestId('checkin-cancel');
    expect(cancelBtn).toBeEnabled();
    expect(within(panel).getByTestId('checkin-cancel-hint')).toHaveTextContent('可取消 1 项');
    await userEvent.click(cancelBtn);
    await waitFor(() => expect(within(panel).getByTestId('checkin-cancel-result')).toHaveTextContent('已取消 1 项'));
    expect(within(panel).getByTestId('checkin-cancel-result')).toHaveTextContent('1 项已发出请求，未取消');
  });

  it('只有 running 项时取消按钮禁用并提示已发出请求', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.post('/api/checkin-runs', () => HttpResponse.json({ batch: batch([{ account_id: WB_ID, state: 'running' }]), replayed: false }, { status: 202 })),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([{ account_id: WB_ID, state: 'running' }]))),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));
    const panel = within(await screen.findByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(panel).getByTestId('checkin-cancel')).toBeDisabled());
    expect(within(panel).getByTestId('checkin-cancel-hint')).toHaveTextContent('已发出请求，无法取消');
  });

  it('能力矩阵读取失败：显示错误态且一键签到禁用，不提供可点写操作', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 })));
    renderPanel();

    expect(await screen.findByTestId('accounts-capabilities-error')).toHaveTextContent('能力矩阵不可用');
    const card = await screen.findByTestId(`accounts-card-${WB_ID}`);
    // ACC-UI-2：能力未知时不渲染切换假入口；ACC-UI-PRUNE：单账号签到按钮已删
    expect(within(card).queryByTestId(`accounts-switch-${WB_ID}`)).toBeNull();
    expect(within(card).queryByTestId(`accounts-checkin-${WB_ID}`)).toBeNull();
    expect(screen.getByTestId('accounts-capture-workbuddy_desktop')).toBeDisabled();
    expect(screen.getByTestId('accounts-one-click-checkin')).toBeDisabled();
    expect(screen.queryByTestId('accounts-checkin-all-workbuddy_desktop')).toBeNull();
    expect(checkinPosts).toHaveLength(0);
  });
});
