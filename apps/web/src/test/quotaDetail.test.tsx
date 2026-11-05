/**
 * ACC-B6：额度平台右栏详情（余额 / 时间窗口 / 积分占位）。
 *
 * 验收口径：
 * - DeepSeek 显示余额大数字 + 抓取时间，且不出现进度条；切平台不串数据；
 * - opencode-go 三个时间窗口各有 2px 进度条、已用/上限与重置时间；Codex 的已限额窗口出「已限额」语义色；
 * - 积分走虚线占位块，不以灰块冒充实数；
 * - 无数据 / 余额未知给明确空态，不静默显示 0；
 * - 「刷新额度」触发请求并更新数值，失败给中文提示。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { QuotaItem } from '../components/settings/QuotaCards';
import { QuotaDetail, quotaDetailKind, quotaDetailResetText, quotaDetailWindowAmount } from '../components/settings/QuotaDetail';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const FETCHED_AT = 1_700_000_000_000;

function item(overrides: Partial<QuotaItem> = {}): QuotaItem {
  return {
    source: 'deepseek',
    status: 'ok',
    balance: null,
    unit: null,
    windows: [],
    fetched_at: FETCHED_AT,
    reason_code: null,
    detail: null,
    ...overrides,
  };
}

function snapshot(items: QuotaItem[]) {
  return { workspace_id: null, fetched_at: FETCHED_AT, items };
}

function renderDetail(source: QuotaItem['source']): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><QuotaDetail source={source} /></QueryClientProvider>);
}

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

const WINDOWS: QuotaItem['windows'] = [
  { name: '5h', kind: 'rolling', remaining: 70, total: 100, used: 30, used_percent: 30, reset_at: FETCHED_AT + 3_600_000 },
  { name: 'weekly', kind: 'weekly', remaining: 60, total: 100, used: 40, used_percent: 40, reset_at: FETCHED_AT + 86_400_000 },
  { name: 'monthly', kind: 'monthly', remaining: 10, total: 100, used: 90, used_percent: 90, reset_at: FETCHED_AT + 604_800_000 },
];

beforeEach(() => server.resetHandlers());

describe('ACC-B6 额度平台右栏详情', () => {
  it('DeepSeek：余额大数字 + 抓取时间，不出现进度条', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
      item({ source: 'deepseek', balance: 128.6, unit: 'CNY' }),
    ]))));
    renderDetail('deepseek');

    const detail = await screen.findByTestId('quota-detail-deepseek');
    const value = await within(detail).findByTestId('quota-detail-balance-value-deepseek');
    expect(detail).toHaveAttribute('data-status', 'ok');
    expect(value).toHaveTextContent('¥128.60');
    expect(within(detail).queryByTestId('quota-detail-bar-deepseek-0')).toBeNull();
    expect(within(detail).getByTestId('quota-detail-fetched-deepseek')).toHaveTextContent('更新于');
  });

  it('opencode-go：三条时间窗口各有进度条、已用/上限与重置时间', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
      item({ source: 'opencode_go', windows: WINDOWS }),
    ]))));
    renderDetail('opencode_go');

    const detail = await screen.findByTestId('quota-detail-opencode_go');
    await within(detail).findByTestId('quota-detail-window-opencode_go-2');
    for (const index of [0, 1, 2]) {
      expect(within(detail).getByTestId(`quota-detail-window-opencode_go-${index}`)).toBeInTheDocument();
    }
    expect(within(detail).getByTestId('quota-detail-amount-opencode_go-0')).toHaveTextContent('30 / 100');
    expect(within(detail).getByTestId('quota-detail-bar-opencode_go-0')).toHaveAttribute('data-width', '30');
    expect(within(detail).getByTestId('quota-detail-bar-opencode_go-2')).toHaveAttribute('data-width', '90');
    expect(within(detail).getByTestId('quota-detail-reset-opencode_go-0')).toHaveTextContent(/^重置 \d{2}:\d{2}$/);
    // 余额形态不该同时出现（同一来源两种形态互斥）
    expect(within(detail).queryByTestId('quota-detail-balance-opencode_go')).toBeNull();
  });

  it('Codex：已限额窗口显示「已限额」并用语义色替代数字', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
      item({
        source: 'codex',
        windows: [
          { name: '5h', kind: 'rolling', remaining: 0, total: 100, used: 100, used_percent: 100, reset_at: FETCHED_AT + 3_600_000 },
          { name: 'weekly', kind: 'weekly', remaining: 60, total: 100, used: 40, used_percent: 40, reset_at: FETCHED_AT + 86_400_000 },
        ],
      }),
    ]))));
    renderDetail('codex');

    const detail = await screen.findByTestId('quota-detail-codex');
    const limited = await within(detail).findByTestId('quota-detail-limited-codex-0');
    expect(limited).toHaveTextContent('已限额');
    expect(limited.className).toContain('text-accent');
    expect(within(detail).queryByTestId('quota-detail-amount-codex-0')).toBeNull();
    expect(within(detail).getByTestId('quota-detail-amount-codex-1')).toHaveTextContent('40 / 100');
    expect(within(detail).getByTestId('quota-detail-bar-codex-0').className).toContain('bg-accent');
  });

  it('积分窗口走虚线占位块，不冒充数值', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
      item({ source: 'workbuddy', windows: [{ name: 'credit', kind: 'credit', remaining: 0, used_percent: null, reset_at: null }] }),
    ]))));
    renderDetail('workbuddy');

    const detail = await screen.findByTestId('quota-detail-workbuddy');
    const placeholder = await within(detail).findByTestId('quota-detail-credit-placeholder-workbuddy');
    expect(placeholder).toHaveTextContent('积分暂未接入');
    expect(placeholder.className).toContain('border-dashed');
    expect(within(detail).queryByTestId('quota-detail-balance-value-workbuddy')).toBeNull();
    expect(within(detail).queryByTestId('quota-detail-bar-workbuddy-0')).toBeNull();
  });

  it('无数据 / 余额未知：给明确空态，不静默显示 0', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
      item({ source: 'opencode_go', status: 'unsupported', reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT' }),
    ]))));
    renderDetail('deepseek');

    const detail = await screen.findByTestId('quota-detail-deepseek');
    expect(await within(detail).findByTestId('quota-detail-empty-deepseek')).toHaveTextContent('暂未返回');
    expect(within(detail).queryByTestId('quota-detail-balance-value-deepseek')).toBeNull();
  });

  it('余额为 null 的 ok 数据判为余额形态但展示「余额暂不可用」，不显示 0', () => {
    const codex = item({ source: 'codex', balance: null });
    expect(quotaDetailKind(codex)).toBe('balance');
    expect(quotaDetailKind(item({ source: 'opencode_go', windows: WINDOWS }))).toBe('windows');
  });

  it('刷新额度：触发请求并更新数值', async () => {
    let calls = 0;
    server.use(http.get('/api/managed-account-quotas', () => {
      calls += 1;
      return HttpResponse.json(snapshot([item({ source: 'deepseek', balance: calls === 1 ? 128.6 : 200.5, unit: 'CNY' })]));
    }));
    renderDetail('deepseek');

    const detail = await screen.findByTestId('quota-detail-deepseek');
    expect(await within(detail).findByTestId('quota-detail-balance-value-deepseek')).toHaveTextContent('¥128.60');

    await userEvent.click(within(detail).getByTestId('quota-detail-refresh-deepseek'));
    await waitFor(() => expect(within(screen.getByTestId('quota-detail-deepseek')).getByTestId('quota-detail-balance-value-deepseek')).toHaveTextContent('¥200.50'));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('刷新失败：中文提示，不白屏', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(
      { error: { code: 'INTERNAL', message: '额度服务不可用' } },
      { status: 500 },
    )));
    renderDetail('deepseek');

    const detail = await screen.findByTestId('quota-detail-deepseek');
    expect(await within(detail).findByTestId('quota-detail-error-deepseek')).toHaveTextContent('额度读取失败');
  });

  it('切平台不串数据：DeepSeek 余额与 opencode-go 窗口互斥', async () => {
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
      http.get('/api/cli-accounts', () => HttpResponse.json({ items: [] })),
      http.get('/api/managed-account-quotas', () => HttpResponse.json(snapshot([
        item({ source: 'deepseek', balance: 12.34, unit: 'CNY' }),
        item({ source: 'opencode_go', windows: WINDOWS }),
      ]))),
    );
    renderPanel();
    await screen.findByTestId('accounts-index');

    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    const detail = screen.getByTestId('accounts-detail');
    expect(await within(detail).findByTestId('quota-detail-balance-value-deepseek')).toHaveTextContent('¥12.34');
    expect(within(detail).queryByTestId('quota-detail-windows-opencode_go')).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-index-item-opencode_go'));
    const after = screen.getByTestId('accounts-detail');
    expect(await within(after).findByTestId('quota-detail-windows-opencode_go')).toBeInTheDocument();
    expect(within(after).queryByTestId('quota-detail-deepseek')).toBeNull();
    expect(within(after).queryByText('¥12.34')).toBeNull();
  });

  it('文案辅助：老数据没有 total/used 时回落百分比，缺重置时刻明确说未知', () => {
    expect(quotaDetailWindowAmount({ name: '5h', remaining: 1, used_percent: 37, reset_at: null })).toBe('37%');
    expect(quotaDetailResetText(null)).toBe('重置时刻未知');
    expect(quotaDetailKind(item({ status: 'unsupported' }))).toBe('reason');
  });
});
