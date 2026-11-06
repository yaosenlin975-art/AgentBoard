/**
 * ACC-B3：单平台批次吸顶进度条、账号级状态与完成口径（父卡硬规则）。
 *
 * 覆盖：
 * ① unknown 账号（wb-2）计入 total 不计入 done 且带 ? 角标；平台指标显示 n/m?；
 * ② already_done（wb-3）计入 done；
 * ③ failed 落回未签到（不显示「已完成」），批次终态文案「失败」；
 * ④ authorized（tr-1/tr-2）不进入完成数；
 * ⑤ 终态批次无取消按钮、无「没有可取消的排队项」死占位行；收起/展开可用；
 * ⑥ 失败原因中文 + 技术码在折叠层（已知码与未收录码各一条）；
 * ⑦ 跨平台一键签到结果条保持原入口位置，文案口径与账号级状态一致，终态同样无取消行。
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

const WB1 = '11111111-1111-4111-8111-111111111111';
const WB2 = '22222222-2222-4222-8222-222222222222';
const WB3 = '33333333-3333-4333-8333-333333333333';
const WB4 = '44444444-4444-4444-8444-444444444444';
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
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
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

/** 发起平台签到批次并等到右栏吸顶批次条出现 */
async function startPlatformCheckin(items: ItemSeed[], status: CheckinBatch['status']): Promise<void> {
  server.use(
    http.post('/api/checkin-runs', () => HttpResponse.json({ batch: batchFor(items, status), replayed: false }, { status: 202 })),
    http.get('/api/checkin-runs/:id', () => HttpResponse.json(batchFor(items, status))),
  );
  await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));
  await screen.findByTestId('checkin-run-panel');
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

describe('完成口径（ACC-B3 父卡硬规则）', () => {
  it('① unknown 计入 total 不计入 done 并带 ? 角标，平台指标显示 n/m?；终态文案「部分成功」', async () => {
    mount([
      account(WB1, 'workbuddy_desktop', 'WB 成功', { last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account(WB2, 'workbuddy_desktop', 'WB 未知', { last_checkin_day: TODAY, last_checkin_status: 'unknown' }),
    ]);
    await startPlatformCheckin(
      [ { account_id: WB1, state: 'succeeded' }, { account_id: WB2, state: 'unknown' } ],
      'partial',
    );

    // 吸顶批次条结构（sticky 依附 drawer-body，样式锚在类名上）
    const bar = screen.getByTestId('checkin-run-bar');
    expect(bar).toHaveClass('sticky', 'top-0', 'z-10');
    expect(screen.getByTestId('checkin-run-status')).toHaveTextContent('部分成功');

    // 批次进度：unknown 计入 total 不计入 done，计数带 ?
    const progress = screen.getByTestId('checkin-run-progress');
    expect(progress).toHaveTextContent('1/2?');
    expect(progress).toHaveAttribute('data-done', '1');
    expect(progress).toHaveAttribute('data-total', '2');
    expect(progress).toHaveAttribute('data-unknown', '1');

    // 账号级状态：unknown 行带 ? 角标
    const unknownItem = screen.getByTestId(`checkin-run-item-${WB2}`);
    expect(unknownItem).toHaveAttribute('data-state', 'unknown');
    expect(screen.getByTestId(`checkin-run-item-unknown-${WB2}`)).toHaveTextContent('?');

    // 平台指标：芯片 n/m?（unknown 加 ?）
    const chip = screen.getByTestId('accounts-checkin-chip-workbuddy_desktop');
    expect(chip).toHaveTextContent('1/2 ?');
    // ACC-UI-2：摘要不再重复「今日已完成 n/m」，只保留参与账号数口径
    expect(screen.getByTestId('accounts-summary-workbuddy_desktop')).not.toHaveTextContent('今日已完成');
  });

  it('② already_done 计入 done；终态文案「全部成功」', async () => {
    mount([account(WB3, 'workbuddy_desktop', 'WB 已完成', { last_checkin_day: TODAY, last_checkin_status: 'already_done' })]);
    await startPlatformCheckin([ { account_id: WB3, state: 'already_done' } ], 'succeeded');

    expect(screen.getByTestId('checkin-run-status')).toHaveTextContent('全部成功');
    const progress = screen.getByTestId('checkin-run-progress');
    expect(progress).toHaveTextContent('1/1');
    expect(progress).toHaveAttribute('data-done', '1');
    expect(progress).toHaveAttribute('data-unknown', '0');
    expect(screen.getByTestId(`checkin-run-item-${WB3}`)).toHaveTextContent('今日已完成');
    // 平台指标把 already_done 记为完成
    expect(screen.getByTestId('accounts-checkin-chip-workbuddy_desktop')).toHaveTextContent('✓ 1/1');
  });

  it('③ failed 落回未签到（平台指标不显示已完成）；终态文案「失败」', async () => {
    mount([account(WB4, 'workbuddy_desktop', 'WB 失败')]);
    await startPlatformCheckin(
      [ { account_id: WB4, state: 'failed', safe_error_code: 'ACCOUNT_BUSY' } ],
      'failed',
    );

    expect(screen.getByTestId('checkin-run-status')).toHaveTextContent('失败');
    const item = screen.getByTestId(`checkin-run-item-${WB4}`);
    expect(item).toHaveAttribute('data-state', 'failed');
    expect(item).toHaveTextContent('签到失败');
    // failed 不计入完成：进度 0/1，平台指标 0/1（不是 ✓，也没有「已完成」）
    expect(screen.getByTestId('checkin-run-progress')).toHaveTextContent('0/1');
    expect(screen.getByTestId('accounts-checkin-chip-workbuddy_desktop')).toHaveTextContent('0/1');
    expect(screen.getByTestId('accounts-summary-workbuddy_desktop')).not.toHaveTextContent('今日已完成');
    expect(screen.queryByTestId('checkin-run-cancel')).toBeNull();
  });

  it('④ authorized（tr-1/tr-2）不进入完成数', async () => {
    mount([
      account(TR1, 'trae', 'TR 授权一', { last_checkin_day: TODAY, last_checkin_status: 'authorized' }),
      account(TR2, 'trae', 'TR 授权二', { last_checkin_day: TODAY, last_checkin_status: 'authorized' }),
    ]);
    // 切到 Trae 平台看右栏指标
    await userEvent.click(await screen.findByTestId('accounts-index-item-trae'));

    // 参与分母（有凭据、启用），但不计入完成
    expect(screen.getByTestId('accounts-checkin-chip-trae')).toHaveTextContent('0/2');
    expect(screen.getByTestId('accounts-summary-trae')).not.toHaveTextContent('今日已完成');
    expect(screen.getByTestId('accounts-index-health-trae')).toHaveTextContent('0/2');
    // 左栏 Workbuddy 无账号，不出 ✓
    expect(screen.queryByTestId('accounts-index-health-workbuddy_desktop')).toBeNull();
  });
});

describe('终态呈现（ACC-B3）', () => {
  it('⑤ 终态无取消按钮、无死占位行；收起/展开可用', async () => {
    mount([
      account(WB1, 'workbuddy_desktop', 'WB 成功'),
      account(WB2, 'workbuddy_desktop', 'WB 取消'),
    ]);
    await startPlatformCheckin(
      [ { account_id: WB1, state: 'succeeded' }, { account_id: WB2, state: 'cancelled' } ],
      'partial',
    );

    const panel = screen.getByTestId('checkin-run-panel');
    expect(panel).toHaveAttribute('data-active', 'false');
    // 终态：无取消按钮、无提示行、无「没有可取消的排队项」死占位
    expect(screen.queryByTestId('checkin-run-cancel')).toBeNull();
    expect(screen.queryByTestId('checkin-run-cancel-hint')).toBeNull();
    expect(within(panel).queryByText('没有可取消的排队项')).toBeNull();
    // 终态口径说明可见；已取消条目如实展示
    expect(screen.getByTestId('checkin-run-note')).toHaveTextContent('失败落回未签到');
    expect(screen.getByTestId(`checkin-run-item-${WB2}`)).toHaveTextContent('已取消');

    // 收起/展开：收起后账号级列表与说明整体隐藏，再展开恢复
    const toggle = screen.getByTestId('checkin-run-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('展开');
    expect(screen.queryByTestId('checkin-run-items')).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByTestId('checkin-run-items')).toBeInTheDocument();
  });

  it('⑥ 失败原因中文 + 技术码在折叠层（已知码与未收录码）', async () => {
    mount([
      account(WB1, 'workbuddy_desktop', 'WB 忙'),
      account(WB2, 'workbuddy_desktop', 'WB 未知码'),
    ]);
    await startPlatformCheckin(
      [
        { account_id: WB1, state: 'failed', safe_error_code: 'ACCOUNT_BUSY' },
        { account_id: WB2, state: 'failed', safe_error_code: 'FUTURE_CODE_X' },
      ],
      'failed',
    );

    // 已知码：中文主文案，裸码在折叠层
    const known = screen.getByTestId(`checkin-run-item-error-${WB1}`);
    expect(known).toHaveTextContent('账号正忙，本轮未发起');
    const knownCode = screen.getByTestId(`checkin-run-item-error-${WB1}-code`);
    expect(knownCode).not.toHaveAttribute('open');
    expect(knownCode).toHaveTextContent('ACCOUNT_BUSY');
    await userEvent.click(within(knownCode).getByText('技术码'));
    expect(knownCode).toHaveAttribute('open');

    // 未收录码：中性中文主文案 + 折叠层原始码
    const future = screen.getByTestId(`checkin-run-item-error-${WB2}`);
    expect(future).toHaveTextContent('该操作暂不可用');
    expect(screen.getByTestId(`checkin-run-item-error-${WB2}-code`)).toHaveTextContent('FUTURE_CODE_X');
  });

  it('⑦ 一键签到结果条保持原入口位置，文案口径一致，终态无取消行', async () => {
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
