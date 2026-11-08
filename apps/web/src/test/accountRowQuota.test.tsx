/**
 * ACC-ROW-QUOTA：账号行显示所属平台的余额/积分与窗口剩余。
 *
 * 断言口径（设计页 knowledge:eab8cbaf-78db-45b7-9cca-88810d2a0a40）：
 * - ok：余额（quotaRowBalance：CNY→¥xx.xx / 积分 / 次 / 0→「额度内」）+ 窗口（kind 标签 + 已用/总量，
 *   已限额出「已限额」，无 total/used 回落百分比），` · ` 连接；
 * - status≠ok：quotaReasonView 中文原因；
 * - 快照缺来源 →「暂时取不到额度」；query pending/error → 读取中/读取失败；
 * - 无额度来源 app（CLI 来源不入 AccountCard，用直接渲染验证 null 分支）→「该平台无额度数据源」；
 * - 平台级同源：面板内同平台两张账号卡显示同一份额度文本。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { PublicManagedAccount } from '@agentboard/shared';
import { AccountCard, type AccountView } from '../components/settings/AccountCard';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const CAPABILITY = {
  app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true,
  capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
  reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
} as const;

function account(overrides: Partial<PublicManagedAccount> = {}): AccountView {
  return {
    id: 'acc-quota-1', app_id: 'workbuddy_desktop', client_instance_id: 'inst-1', service_region: 'cn',
    display_name: '额度账号', identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported',
    enabled: true, last_checkin_day: null, last_checkin_status: null, last_checkin_at: null,
    created_at: 1, updated_at: 2, is_current: false,
    ...overrides,
  };
}

function quotaItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'workbuddy', status: 'ok', balance: null, unit: null, windows: [],
    fetched_at: 1_700_000_000_000, reason_code: null, detail: null,
    ...overrides,
  };
}

function mountCard(card: AccountView): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountCard account={card} capability={{ ...CAPABILITY }} />
    </QueryClientProvider>,
  );
}

function mountPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([CAPABILITY])),
    http.get('/api/managed-accounts', () => HttpResponse.json([account()])),
  );
});

describe('账号行额度（ACC-ROW-QUOTA）', () => {
  it('ok + CNY 余额：显示 ¥金额，无窗口时不拼窗口段', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ balance: 809.42, unit: 'CNY' })],
    })));
    mountCard(account());
    expect(await screen.findByText('¥809.42')).toBeInTheDocument();
    const row = screen.getByTestId('accounts-quota-acc-quota-1');
    expect(row).toHaveTextContent('¥809.42');
    expect(row.getAttribute('data-status')).toBe('ok');
  });

  it('ok + 积分余额与 credit 窗口：金额带单位，窗口按 已用/总量', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({
        balance: 1782.83, unit: '积分',
        windows: [{ name: '积分包', remaining: 1782, reset_at: null, kind: 'credit', total: 9200, used: 7417.17, used_percent: 80.6 }],
      })],
    })));
    mountCard(account());
    expect(await screen.findByText(/1782\.83 积分/)).toBeInTheDocument();
    const row = screen.getByTestId('accounts-quota-acc-quota-1');
    expect(row).toHaveTextContent('积分 7417/9200');
  });

  it('ok + 次数余额与多窗口：全部窗口拼在一行，已限额窗口出「已限额」', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({
        balance: 2000, unit: '次',
        windows: [
          { name: '5h', remaining: 5, reset_at: null, kind: 'rolling', total: 5, used: 0, used_percent: 0 },
          { name: '额度窗口', remaining: 0, reset_at: null, kind: 'monthly', total: 1, used: 10002, used_percent: 100 },
        ],
      })],
    })));
    mountCard(account());
    expect(await screen.findByText(/2000\.00 次/)).toBeInTheDocument();
    const row = screen.getByTestId('accounts-quota-acc-quota-1');
    expect(row).toHaveTextContent('5h 0/5');
    expect(row).toHaveTextContent('月 已限额');
  });

  it('ok + 余额 0：读作「额度内」', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ balance: 0, unit: 'CNY' })],
    })));
    mountCard(account());
    expect(await screen.findByText('额度内')).toBeInTheDocument();
  });

  it('ok 但无余额无窗口：读作「正常」', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ balance: null, unit: null, windows: [] })],
    })));
    mountCard(account());
    expect(await screen.findByText('正常')).toBeInTheDocument();
  });

  it('status=error（CREDENTIAL_INVALID）：显示中文原因而非占位', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ status: 'error', reason_code: 'CREDENTIAL_INVALID' })],
    })));
    mountCard(account());
    expect(await screen.findByText('凭据已失效，请更新后重试')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-quota-acc-quota-1').getAttribute('data-status')).toBe('error');
  });

  it('status=unsupported（NO_CREDENTIAL）：显示「未接入」中文原因', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ status: 'unsupported', reason_code: 'NO_CREDENTIAL' })],
    })));
    mountCard(account());
    expect(await screen.findByText(/未接入/)).toBeInTheDocument();
    expect(screen.getByTestId('accounts-quota-acc-quota-1').getAttribute('data-status')).toBe('unsupported');
  });

  it('快照缺该平台来源 →「暂时取不到额度」（默认夹具只有 CLI 三来源）', async () => {
    mountCard(account());
    expect(await screen.findByText('暂时取不到额度')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-quota-acc-quota-1').getAttribute('data-status')).toBe('missing');
  });

  it('额度请求失败 →「额度读取失败」（不吞网络错误）', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({}, { status: 500 })));
    mountCard(account());
    expect(await screen.findByText('额度读取失败')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-quota-acc-quota-1').getAttribute('data-status')).toBe('error');
  });

  it('无额度来源的 app（deepseek CLI 来源直渲染）→「该平台无额度数据源」', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null, fetched_at: 1_700_000_000_000,
      items: [quotaItem({ source: 'deepseek', balance: 1, unit: 'CNY' })],
    })));
    mountCard(account({ app_id: 'deepseek' as unknown as PublicManagedAccount['app_id'] }));
    expect(await screen.findByText('该平台无额度数据源')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-quota-acc-quota-1').getAttribute('data-status')).toBe('unsupported');
  });

  it('平台级同源：面板内同平台两张账号卡显示同一份额度文本', async () => {
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([
        account({ id: 'acc-wb-a', display_name: '账号A' }),
        account({ id: 'acc-wb-b', display_name: '账号B' }),
      ])),
      http.get('/api/managed-account-quotas', () => HttpResponse.json({
        workspace_id: null, fetched_at: 1_700_000_000_000,
        items: [quotaItem({ balance: 42.5, unit: 'CNY' })],
      })),
    );
    mountPanel();
    const cardA = await screen.findByTestId('accounts-card-acc-wb-a');
    const cardB = await screen.findByTestId('accounts-card-acc-wb-b');
    const quotaA = within(cardA).getByTestId('accounts-quota-acc-wb-a');
    const quotaB = within(cardB).getByTestId('accounts-quota-acc-wb-b');
    expect(quotaA).toHaveTextContent('¥42.50');
    expect(quotaB).toHaveTextContent('¥42.50');
    expect(quotaA.textContent).toBe(quotaB.textContent);
  });
});
