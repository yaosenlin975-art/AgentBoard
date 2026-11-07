/**
 * ACC-B3 完成口径（ACC-UI-PRUNE 后）：单平台吸顶批次条已随单平台签到入口删除，
 * 批次呈现只剩一键签到结果条（OneClickCheckin → CheckinBatchPanel）；
 * 平台今日口径在左栏索引健康角标（done/total，succeeded/already_done 计入 done）。
 *
 * 覆盖：
 * ① authorized 账号不进入完成数（左栏索引健康角标 0/2，摘要不含「今日已完成」）；
 * ② 一键签到结果条保持原入口位置，文案口径一致，终态无取消行。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, CheckinBatch, CheckinBatchItem, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { localDayKey } from '../components/settings/accountCapabilities';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

const TR1 = '55555555-5555-4555-8555-555555555555';
const TR2 = '66666666-6666-4666-8666-666666666666';
const MM1 = '77777777-7777-4777-8777-777777777777';
const BATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODAY = localDayKey(Date.now());

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
    has_checkin_credential: true,
    ...overrides,
  };
}

const CAPABILITIES: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
];

type ItemSeed = { account_id: string; state: CheckinBatchItem['state']; safe_error_code?: string | null };

/** 终态批次夹具（succeeded/partial/failed/cancelled 均已 finished；queued/running 未结束） */
function batchFor(items: ItemSeed[], status: CheckinBatch['status'], app: CheckinBatch['app_id'] = 'workbuddy_desktop'): CheckinBatch {
  const terminal = status !== 'queued' && status !== 'running';
  return {
    id: BATCH_ID,
    app_id: app,
    status,
    total: items.length,
    profile_local_day: TODAY,
    created_at: 1,
    finished_at: terminal ? 2 : null,
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

function mount(accounts: AccountView[], capabilities: AccountCapability[] = CAPABILITIES): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json(accounts)),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(capabilities)),
    http.get('/api/account-operations', () => HttpResponse.json([])),
  );
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  server.resetHandlers();
});

describe('完成口径（ACC-B3 硬规则，左栏索引健康角标）', () => {
  it('① authorized（tr-1/tr-2）不进入完成数；吸顶批次条与签到芯片不再渲染', async () => {
    mount([
      account(TR1, 'trae', 'TR 授权一', { last_checkin_day: TODAY, last_checkin_status: 'authorized' }),
      account(TR2, 'trae', 'TR 授权二', { last_checkin_day: TODAY, last_checkin_status: 'authorized' }),
    ]);
    // 切到 Trae 平台看右栏指标
    await userEvent.click(await screen.findByTestId('accounts-index-item-trae'));

    // 参与分母（有凭据、启用），但不计入完成
    expect(screen.getByTestId('accounts-index-health-trae')).toHaveTextContent('0/2');
    expect(screen.getByTestId('accounts-summary-trae')).not.toHaveTextContent('今日已完成');
    // 左栏 Workbuddy 无账号，不出健康角标
    expect(screen.queryByTestId('accounts-index-health-workbuddy_desktop')).toBeNull();
    // ACC-UI-PRUNE：吸顶批次条与行头签到芯片已随单平台签到入口删除
    expect(screen.queryByTestId('checkin-run-panel')).toBeNull();
    expect(screen.queryByTestId('accounts-checkin-chip-trae')).toBeNull();
    expect(screen.queryByTestId('accounts-checkin-all-trae')).toBeNull();
  });
});

describe('一键签到结果条（ACC-UI-PRUNE 后唯一批次呈现）', () => {
  it('② 一键签到结果条保持原入口位置，文案口径一致，终态无取消行', async () => {
    mount([account(MM1, 'minimax', 'MM 账号')], CAPABILITIES.filter((cap) => cap.app_id === 'minimax'));
    server.use(
      http.post('/api/checkin-runs', () =>
        HttpResponse.json({ batch: batchFor([ { account_id: MM1, state: 'already_done' } ], 'succeeded', 'minimax'), replayed: false }, { status: 202 })),
      http.get('/api/checkin-runs/:id', () =>
        HttpResponse.json(batchFor([ { account_id: MM1, state: 'already_done' } ], 'succeeded', 'minimax'))),
    );

    await userEvent.click(await screen.findByTestId('accounts-one-click-checkin'));
    const results = await screen.findByTestId('accounts-one-click-results');
    expect(within(results).getByTestId('accounts-one-click-summary')).toHaveTextContent('已发起 1 个批次');

    // 同一套中文对照：already_done → 今日已完成
    const panel = within(results).getByTestId('checkin-batch-panel');
    const item = within(panel).getByTestId(`checkin-item-${MM1}`);
    expect(item).toHaveAttribute('data-state', 'already_done');
    expect(item).toHaveTextContent('今日已完成');
    // 终态无取消行（跨平台结果条同口径）
    expect(within(panel).queryByTestId('checkin-cancel')).toBeNull();
    expect(within(panel).queryByText('没有可取消的排队项')).toBeNull();
  });
});
