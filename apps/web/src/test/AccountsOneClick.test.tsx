/**
 * ACC-14：一键签到（三平台聚合）、409 双开、读取本机账号（成功 / 失败两态）。
 *
 * 关键契约（都以真实服务端行为为准，不在前端造数据）：
 * - `POST /api/checkin-runs` 批次边界是 app_id，因此「一键」= 每个可签到平台各一个批次，结果聚合展示；
 * - 逐账号结果来自 `GET /api/checkin-runs/:id` 的 items[].state；
 * - 猫猫旅行结果来自 `GET /api/account-operations?batch_id=` 的 operation.recovery_ref（travel=...）；
 * - `409 CHECKIN_BATCH_IN_PROGRESS` 的 details.batch_id 要展示并可查看该批次；
 * - `POST /api/accounts/import-credentials` 失败只显示可解释原因，不回显 stdout/stderr。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, AccountOperation, CheckinBatch, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { localDayKey } from '../components/settings/accountCapabilities';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

const WB_1 = '11111111-1111-4111-8111-111111111111';
const WB_2 = '22222222-2222-4222-8222-222222222222';
const WB_OFF = '33333333-3333-4333-8333-333333333333';
const MM_1 = '44444444-4444-4444-8444-444444444444';
const TR_1 = '55555555-5555-4555-8555-555555555555';
const WB_BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MM_BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TR_BATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXISTING_WB_BATCH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function account(id: string, app: AccountView['app_id'], name: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    app_id: app,
    client_instance_id: `inst-${id.slice(0, 6)}`,
    service_region: 'cn',
    display_name: name,
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 1,
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
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
];

const ACCOUNTS: AccountView[] = [
  account(WB_1, 'workbuddy_desktop', 'WB 主号', { is_current: true }),
  account(WB_2, 'workbuddy_desktop', 'WB 副号'),
  account(WB_OFF, 'workbuddy_desktop', 'WB 停用号', { enabled: false }),
  account(MM_1, 'minimax', 'MM 账号', { is_current: null }),
  account(TR_1, 'trae', 'TRAE 账号', { is_current: null }),
];

type CheckinPostBody = { app_id: CheckinBatch['app_id']; account_ids: string[] };

type ItemState = 'queued' | 'running' | 'succeeded' | 'already_done' | 'failed' | 'cancelled' | 'unknown';

function batchFor(id: string, app: CheckinBatch['app_id'], items: Array<{ account_id: string; state: ItemState }>, status: CheckinBatch['status'] = 'succeeded'): CheckinBatch {
  return {
    id,
    app_id: app,
    status,
    total: items.length,
    profile_local_day: '2026-11-03',
    created_at: 1,
    finished_at: status === 'running' ? null : 2,
    items: items.map((item, index) => ({
      batch_id: id,
      account_id: item.account_id,
      seq: index,
      state: item.state,
      operation_id: `op-${item.account_id}`,
      safe_error_code: item.state === 'failed' ? 'CHECKIN_CREDENTIAL_MISSING' : null,
      updated_at: 2,
    })),
  };
}

function operation(accountId: string, app: AccountOperation['app_id'], recoveryRef: string | null): AccountOperation {
  return {
    id: `op-${accountId}`,
    batch_id: WB_BATCH,
    account_id: accountId,
    app_id: app,
    client_instance_id: 'imported',
    operation: 'checkin',
    state: 'succeeded',
    stage: 'verify',
    safe_error_code: null,
    recovery_ref: recoveryRef,
    created_at: 1,
    started_at: 1,
    finished_at: 2,
    recovers_operation_id: null,
  };
}

const checkinPosts: Array<{ body: { app_id: string; account_ids: string[] }; key: string | null }> = [];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>) };
}

beforeEach(() => {
  server.resetHandlers();
  checkinPosts.length = 0;
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)),
    http.get('/api/managed-accounts', () => HttpResponse.json(ACCOUNTS)),
    http.get('/api/account-operations', () => HttpResponse.json([])),
  );
});

describe('一键签到（ACC-14）', () => {
  it('一次点击为三个平台各发起一个批次，只提交启用账号', async () => {
    const batches: Record<string, CheckinBatch> = {
      workbuddy_desktop: batchFor(WB_BATCH, 'workbuddy_desktop', [{ account_id: WB_1, state: 'succeeded' }, { account_id: WB_2, state: 'succeeded' }]),
      minimax: batchFor(MM_BATCH, 'minimax', [{ account_id: MM_1, state: 'already_done' }]),
      trae: batchFor(TR_BATCH, 'trae', [{ account_id: TR_1, state: 'failed' }]),
    };
    server.use(
      http.post('/api/checkin-runs', async ({ request }) => {
        const body = await request.json() as CheckinPostBody;
        checkinPosts.push({ body, key: request.headers.get('Idempotency-Key') });
        return HttpResponse.json({ batch: batches[body.app_id]!, replayed: false }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', ({ params }) => {
        const found = Object.values(batches).find((item) => item.id === params.id);
        return found ? HttpResponse.json(found) : HttpResponse.json({ error: { code: 'NOT_FOUND', message: '无此批次' } }, { status: 404 });
      }),
      // workbuddy 猫猫旅行结果挂在 operation.recovery_ref 上
      http.get('/api/account-operations', ({ request }) => {
        const batchId = new URL(request.url).searchParams.get('batch_id');
        return HttpResponse.json(batchId === WB_BATCH
          ? [operation(WB_1, 'workbuddy_desktop', 'travel=claimed'), operation(WB_2, 'workbuddy_desktop', 'travel=failed:TRAVEL_HTTP_500')]
          : []);
      }),
    );
    renderPanel();

    const button = await screen.findByTestId('accounts-one-click-checkin');
    expect(within(button).getByText('一键签到')).toBeInTheDocument();
    await userEvent.click(button);

    await waitFor(() => expect(checkinPosts).toHaveLength(3));
    // 关掉按钮后按平台分组：停用账号不提交
    expect(checkinPosts.map((post) => post.body.app_id)).toEqual(['workbuddy_desktop', 'minimax', 'trae']);
    expect(checkinPosts[0]!.body.account_ids).toEqual([WB_1, WB_2]);
    expect(checkinPosts[1]!.body.account_ids).toEqual([MM_1]);
    expect(checkinPosts[2]!.body.account_ids).toEqual([TR_1]);
    expect(checkinPosts.every((post) => typeof post.key === 'string' && post.key.length > 10)).toBe(true);

    expect(await screen.findByTestId('accounts-one-click-summary')).toHaveTextContent('已发起 3 个批次');
    for (const app of ['workbuddy_desktop', 'minimax', 'trae']) {
      expect(screen.getByTestId(`accounts-one-click-outcome-${app}`)).toHaveTextContent('已发起批次');
    }

    // 逐账号结果：items[].state
    const wbPanel = within(await screen.findByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(wbPanel).getByTestId(`checkin-item-${WB_1}`)).toHaveAttribute('data-state', 'succeeded'));
    expect(within(wbPanel).getByTestId(`checkin-item-${WB_2}`)).toHaveAttribute('data-state', 'succeeded');
    // 猫猫旅行结果（成功与失败两种都要能表达）
    await waitFor(() => expect(within(wbPanel).getByTestId(`checkin-item-travel-${WB_1}`)).toHaveTextContent('猫猫旅行：已领取'));
    expect(within(wbPanel).getByTestId(`checkin-item-travel-${WB_2}`)).toHaveTextContent('猫猫旅行：失败');
    expect(within(wbPanel).getByTestId(`checkin-item-travel-${WB_2}`)).toHaveTextContent('TRAVEL_HTTP_500');

    const mmPanel = within(screen.getByTestId('accounts-one-click-batch-minimax')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(mmPanel).getByTestId(`checkin-item-${MM_1}`)).toHaveAttribute('data-state', 'already_done'));
    expect(within(mmPanel).queryByTestId(`checkin-item-travel-${MM_1}`)).not.toBeInTheDocument();

    const trPanel = within(screen.getByTestId('accounts-one-click-batch-trae')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(trPanel).getByTestId(`checkin-item-${TR_1}`)).toHaveAttribute('data-state', 'failed'));
    expect(within(trPanel).getByTestId(`checkin-item-error-${TR_1}`)).toHaveTextContent('该账号没有签到凭据');
  });

  it('409 CHECKIN_BATCH_IN_PROGRESS：展示已有批次 id 并可直接查看该批次，其它平台照常发起', async () => {
    server.use(
      http.post('/api/checkin-runs', async ({ request }) => {
        const body = await request.json() as CheckinPostBody;
        checkinPosts.push({ body, key: request.headers.get('Idempotency-Key') });
        if (body.app_id === 'workbuddy_desktop') {
          return HttpResponse.json({ error: { code: 'CHECKIN_BATCH_IN_PROGRESS', message: '该产品已有进行中的签到批次', details: { batch_id: EXISTING_WB_BATCH } } }, { status: 409 });
        }
        const id = body.app_id === 'minimax' ? MM_BATCH : TR_BATCH;
        return HttpResponse.json({
          batch: batchFor(id, body.app_id, [{ account_id: body.account_ids[0]!, state: 'running' }], 'running'),
          replayed: false,
        }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', ({ params }) => {
        if (params.id === EXISTING_WB_BATCH) {
          return HttpResponse.json(batchFor(EXISTING_WB_BATCH, 'workbuddy_desktop', [{ account_id: WB_1, state: 'running' }], 'running'));
        }
        const app = params.id === MM_BATCH ? 'minimax' : 'trae';
        return HttpResponse.json(batchFor(String(params.id), app, [{ account_id: params.id === MM_BATCH ? MM_1 : TR_1, state: 'running' }], 'running'));
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));
    await waitFor(() => expect(checkinPosts).toHaveLength(3));

    const conflictRow = await screen.findByTestId('accounts-one-click-outcome-workbuddy_desktop');
    expect(conflictRow).toHaveTextContent('已有进行中的批次');
    expect(conflictRow).toHaveTextContent(EXISTING_WB_BATCH.slice(0, 8));
    expect(await screen.findByTestId('accounts-one-click-summary')).toHaveTextContent('1 个平台已有进行中的批次');

    // 已有批次可直接查看，逐账号状态照常展示
    const existingPanel = within(screen.getByTestId('accounts-one-click-batch-workbuddy_desktop')).getByTestId('checkin-batch-panel');
    await waitFor(() => expect(within(existingPanel).getByTestId(`checkin-item-${WB_1}`)).toHaveAttribute('data-state', 'running'));
    expect(screen.getByTestId('accounts-one-click-outcome-minimax')).toHaveTextContent('已发起批次');
    expect(screen.getByTestId('accounts-one-click-outcome-trae')).toHaveTextContent('已发起批次');
  });

  it('签到能力不可用的平台跳过并给出原因，不伪造请求', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        CAPABILITIES[0]!,
        {
          app_id: 'minimax', capture: true, switch: false, checkin: false,
          capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
          reason_code: 'CLIENT_NOT_INSTALLED', source: 'static',
        } as AccountCapability,
        CAPABILITIES[2]!,
      ])),
      http.post('/api/checkin-runs', async ({ request }) => {
        const body = await request.json() as CheckinPostBody;
        checkinPosts.push({ body, key: request.headers.get('Idempotency-Key') });
        const id = body.app_id === 'workbuddy_desktop' ? WB_BATCH : TR_BATCH;
        return HttpResponse.json({ batch: batchFor(id, body.app_id, [{ account_id: body.account_ids[0]!, state: 'queued' }], 'queued'), replayed: false }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', ({ params }) => HttpResponse.json(
        batchFor(String(params.id), params.id === WB_BATCH ? 'workbuddy_desktop' : 'trae', [{ account_id: params.id === WB_BATCH ? WB_1 : TR_1, state: 'queued' }], 'queued'),
      )),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));
    await waitFor(() => expect(checkinPosts).toHaveLength(2));
    expect(checkinPosts.map((post) => post.body.app_id)).toEqual(['workbuddy_desktop', 'trae']);
    const skipped = await screen.findByTestId('accounts-one-click-outcome-minimax');
    expect(skipped).toHaveTextContent('跳过');
    expect(skipped).toHaveTextContent('签到能力未验证');
  });

  it('缺签到凭据：单账号签到入口已删（ACC-UI-PRUNE），一键签到跳过该账号并在结果里列出', async () => {
    const accounts: AccountView[] = [
      account(WB_1, 'workbuddy_desktop', 'WB 主号', { is_current: true }),
      account(WB_2, 'workbuddy_desktop', 'WB 副号', { has_checkin_credential: false }),
      account(MM_1, 'minimax', 'MM 账号', { is_current: null }),
      account(TR_1, 'trae', 'TRAE 账号', { is_current: null }),
    ];
    const batches: Record<string, CheckinBatch> = {
      workbuddy_desktop: batchFor(WB_BATCH, 'workbuddy_desktop', [{ account_id: WB_1, state: 'succeeded' }]),
      minimax: batchFor(MM_BATCH, 'minimax', [{ account_id: MM_1, state: 'succeeded' }]),
      trae: batchFor(TR_BATCH, 'trae', [{ account_id: TR_1, state: 'succeeded' }]),
    };
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json(accounts)),
      http.post('/api/checkin-runs', async ({ request }) => {
        const body = await request.json() as CheckinPostBody;
        checkinPosts.push({ body, key: request.headers.get('Idempotency-Key') });
        return HttpResponse.json({ batch: batches[body.app_id]!, replayed: false }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', ({ params }) => {
        const found = Object.values(batches).find((item) => item.id === params.id);
        return found ? HttpResponse.json(found) : HttpResponse.json({ error: { code: 'NOT_FOUND', message: '无此批次' } }, { status: 404 });
      }),
    );
    renderPanel();

    // ACC-UI-PRUNE：单账号与平台级签到入口均已删除
    await screen.findByTestId('accounts-app-workbuddy_desktop');
    expect(screen.queryByTestId(`accounts-checkin-${WB_2}`)).toBeNull();
    expect(screen.queryByTestId('accounts-checkin-all-workbuddy_desktop')).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-one-click-checkin'));
    await waitFor(() => expect(checkinPosts).toHaveLength(3));
    // 缺凭据账号不进批次请求，其余照常发起（不整批静默失败）
    expect(checkinPosts[0]!.body.account_ids).toEqual([WB_1]);
    const skipped = await screen.findByTestId('accounts-one-click-skipped-workbuddy_desktop');
    expect(skipped).toHaveTextContent('跳过 1 个账号：WB 副号（缺少签到凭据，请先刷新或重新获取）');
  });

  it('今日 done/total 口径（左栏索引健康角标）：succeeded/already_done 计入 done；failed/authorized/缺凭据不计入分母', async () => {
    const today = localDayKey(Date.now());
    const accounts: AccountView[] = [
      account(WB_1, 'workbuddy_desktop', 'WB 成功', { last_checkin_day: today, last_checkin_status: 'succeeded' }),
      account(WB_2, 'workbuddy_desktop', 'WB 已完成', { last_checkin_day: today, last_checkin_status: 'already_done' }),
      account('66666666-6666-4666-8666-666666666666', 'workbuddy_desktop', 'WB 未知', { last_checkin_day: today, last_checkin_status: 'unknown' }),
      account('77777777-7777-4777-8777-777777777777', 'workbuddy_desktop', 'WB 失败', { last_checkin_day: today, last_checkin_status: 'failed' }),
      account('88888888-8888-4888-8888-888888888888', 'workbuddy_desktop', 'WB 授权中', { last_checkin_day: today, last_checkin_status: 'authorized' }),
      account('99999999-9999-4999-8999-999999999999', 'workbuddy_desktop', 'WB 缺凭据', { last_checkin_day: today, last_checkin_status: 'succeeded', has_checkin_credential: false }),
    ];
    server.use(http.get('/api/managed-accounts', () => HttpResponse.json(accounts)));
    renderPanel();

    // 分母 5（缺凭据被排除）；分子 2（succeeded + already_done）；签到芯片已删（ACC-UI-PRUNE），口径在左栏指标行（方向 B）
    const health = await screen.findByTestId('accounts-index-metric-workbuddy_desktop');
    expect(health).toHaveTextContent('2/5');
    expect(health).toHaveAttribute('title', '今日签到 2/5');
    expect(screen.queryByTestId('accounts-checkin-chip-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-today-summary')).toBeNull();
    // ACC-UI-TOPBAR：「其中 N 个启用并参与一键签到」列表摘要已删，今日口径只剩左栏指标行
    expect(screen.queryByTestId('accounts-summary-workbuddy_desktop')).toBeNull();
  });
});

describe('读取本机账号（ACC-14）', () => {
  it('成功态：汇总发现/新增/已存在，并按平台给出明细，随后刷新账号列表', async () => {
    let listCalls = 0;
    server.use(
      http.get('/api/managed-accounts', () => {
        listCalls += 1;
        return HttpResponse.json(ACCOUNTS);
      }),
      http.post('/api/accounts/import-credentials', () => HttpResponse.json({
        batch_id: 'imp-1',
        actor: 'web',
        duration_ms: 812,
        platforms: [
          { platform: 'workbuddy', app_id: 'workbuddy_desktop', found: 2, created: 1, updated: 1, skipped: 0, error: null },
          { platform: 'minimax', app_id: 'minimax', found: 1, created: 1, updated: 0, skipped: 0, error: null },
          { platform: 'trae', app_id: 'trae', found: 1, created: 1, updated: 0, skipped: 0, error: null },
        ],
        accounts: [],
        error: null,
      })),
    );
    renderPanel();

    const before = listCalls;
    await userEvent.click(await screen.findByTestId('accounts-import-local'));
    expect(await screen.findByTestId('accounts-import-summary')).toHaveTextContent('发现 4 个账号，新增 3，已存在 1');
    expect(screen.getByTestId('accounts-import-platform-workbuddy')).toHaveTextContent('发现 2 · 新增 1 · 已存在 1');
    expect(screen.getByTestId('accounts-import-platform-minimax')).toHaveTextContent('已读取');
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it('失败态：python 缺失给可解释原因，不显示脚本 stdout/stderr 原文', async () => {
    server.use(
      http.post('/api/accounts/import-credentials', () => HttpResponse.json({
        error: { code: 'PYTHON_UNAVAILABLE', message: 'python missing' },
      }, { status: 503 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-import-local'));
    const error = await screen.findByTestId('accounts-import-error');
    expect(error).toHaveTextContent('本机未找到 python，无法读取本机账号');
    // 不回显原始错误文本/堆栈
    expect(error.textContent).not.toContain('python missing');
    expect(document.body.innerHTML).not.toContain('Traceback');
  });

  it('扫描失败但接口 200（平台级错误码）：整批错误码转成可解释文案', async () => {
    server.use(
      http.post('/api/accounts/import-credentials', () => HttpResponse.json({
        batch_id: 'imp-2',
        actor: 'web',
        duration_ms: 300,
        platforms: [
          { platform: 'workbuddy', app_id: 'workbuddy_desktop', found: 0, created: 0, updated: 0, skipped: 0, error: 'EXPORT_TIMEOUT' },
          { platform: 'minimax', app_id: 'minimax', found: 0, created: 0, updated: 0, skipped: 0, error: 'EXPORT_OUTPUT_INVALID' },
          { platform: 'trae', app_id: 'trae', found: 0, created: 0, updated: 0, skipped: 0, error: null },
        ],
        accounts: [],
        error: null,
      })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-import-local'));
    expect(await screen.findByTestId('accounts-import-summary')).toHaveTextContent('发现 0 个账号，新增 0，已存在 0');
    expect(screen.getByTestId('accounts-import-platform-workbuddy')).toHaveTextContent('读取超时');
    expect(screen.getByTestId('accounts-import-platform-minimax')).toHaveTextContent('输出无法解析');
  });
});
