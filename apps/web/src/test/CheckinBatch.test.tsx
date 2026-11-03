/**
 * 签到批次与能力矩阵接入（ACC-09）：
 * 能力以服务端为准、checkin=false 不发请求、批次 items 各状态、409 双开展示已有批次、取消只对 queued 生效、能力矩阵失败错误态。
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
  it('checkin=false：签到与批量签到禁用并显示服务端 reason_code，点击不发请求', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
      capability({ checkin: false, reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' }),
      capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
    ])));
    renderPanel();

    const card = await screen.findByTestId(`accounts-card-${WB_ID}`);
    const single = within(card).getByTestId(`accounts-checkin-${WB_ID}`);
    const batchBtn = screen.getByTestId('accounts-checkin-all-workbuddy_desktop');
    expect(single).toBeDisabled();
    expect(batchBtn).toBeDisabled();
    expect(batchBtn).toHaveTextContent('签到能力未验证');
    await userEvent.click(single);
    await userEvent.click(batchBtn);
    expect(checkinPosts).toHaveLength(0);
  });

  it('checkin=true（source=derived）：批量签到发起批次并展示 items 各状态', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json(batch([{ account_id: WB_ID, state: 'succeeded' }, { account_id: WB_ID2, state: 'failed', safe_error_code: 'ACCOUNT_BUSY' }]))),
    );
    renderPanel();

    expect(await screen.findByTestId('accounts-capability-source-workbuddy_desktop')).toHaveTextContent('由已验证 provider 推导');
    await userEvent.click(screen.getByTestId('accounts-checkin-all-workbuddy_desktop'));

    await waitFor(() => expect(checkinPosts).toHaveLength(1));
    expect(checkinPosts[0]!.body).toEqual({ app_id: 'workbuddy_desktop', account_ids: [WB_ID, WB_ID2] });
    expect(checkinPosts[0]!.idempotencyKey).toBeTruthy();

    const panel = await screen.findByTestId('checkin-batch-panel');
    expect(within(panel).getByTestId('checkin-batch-id')).toHaveTextContent(BATCH_ID.slice(0, 8));
    await waitFor(() => expect(within(panel).getByTestId(`checkin-item-${WB_ID}`)).toHaveAttribute('data-state', 'succeeded'));
    expect(within(panel).getByTestId(`checkin-item-${WB_ID2}`)).toHaveAttribute('data-state', 'failed');
    expect(within(panel).getByTestId(`checkin-item-error-${WB_ID2}`)).toHaveTextContent('账号正忙，本轮未发起');
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

    await screen.findByTestId('accounts-checkin-all-workbuddy_desktop');
    const btn = screen.getByTestId('accounts-checkin-all-workbuddy_desktop');
    await userEvent.click(btn);
    await waitFor(() => expect(checkinPosts).toHaveLength(1));
    await userEvent.click(btn);
    await waitFor(() => expect(checkinPosts).toHaveLength(2));
    expect(checkinPosts[0]!.idempotencyKey).toBe(checkinPosts[1]!.idempotencyKey);
  });

  it('409 CHECKIN_BATCH_IN_PROGRESS：展示已有批次 id 并可查看该批次', async () => {
    const existing = '44444444-4444-4444-8444-444444444444';
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        capability({ checkin: true, reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' }),
        capability({ app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false }),
      ])),
      http.post('/api/checkin-runs', () =>
        HttpResponse.json({ error: { code: 'CHECKIN_BATCH_IN_PROGRESS', message: '该产品已有进行中的签到批次', details: { batch_id: existing } } }, { status: 409 }),
      ),
      http.get(`/api/checkin-runs/${existing}`, () => HttpResponse.json({ ...batch([{ account_id: WB_ID, state: 'running' }]), id: existing })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));
    const conflict = await screen.findByTestId('accounts-conflict-batch-workbuddy_desktop');
    expect(conflict).toHaveTextContent(existing);
    expect(screen.getByTestId('accounts-notice-workbuddy_desktop')).toHaveTextContent('该产品已有进行中的签到批次');

    await userEvent.click(screen.getByTestId('accounts-view-batch-workbuddy_desktop'));
    const panel = await screen.findByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(panel).getByTestId(`checkin-item-${WB_ID}`)).toHaveAttribute('data-state', 'running'));
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

    await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));
    const panel = await screen.findByTestId('checkin-batch-panel');
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

    await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));
    const panel = await screen.findByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(panel).getByTestId('checkin-cancel')).toBeDisabled());
    expect(within(panel).getByTestId('checkin-cancel-hint')).toHaveTextContent('已发出请求，无法取消');
  });

  it('能力矩阵读取失败：显示错误态且不提供可点操作按钮', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 })));
    renderPanel();

    expect(await screen.findByTestId('accounts-capabilities-error')).toHaveTextContent('能力矩阵不可用');
    const card = await screen.findByTestId(`accounts-card-${WB_ID}`);
    expect(within(card).getByTestId(`accounts-switch-${WB_ID}`)).toBeDisabled();
    expect(within(card).getByTestId(`accounts-checkin-${WB_ID}`)).toBeDisabled();
    expect(screen.getByTestId('accounts-capture-workbuddy_desktop')).toBeDisabled();
    expect(screen.getByTestId('accounts-checkin-all-workbuddy_desktop')).toBeDisabled();
    expect(checkinPosts).toHaveLength(0);
  });
});


