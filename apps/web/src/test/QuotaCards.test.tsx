/**
 * ACC-QUOTA-01：账号页三张额度卡。
 * - deepseek ok：显示余额与币种；
 * - 有窗口时显示「重置 HH:mm（还剩 Xh Ym）」；
 * - opencode_go / codex unsupported：显示可解释中文原因，裸码只在「技术码」里；
 * - 接口失败：整体错误态，不白屏；
 * - 不显示 token / 文件路径。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { QuotaCards, formatRemaining, formatResetClock, quotaAmountText, type QuotaItem } from '../components/settings/QuotaCards';
import { server } from './server';

function item(overrides: Partial<QuotaItem> = {}): QuotaItem {
  return {
    source: 'deepseek',
    status: 'ok',
    balance: 38.42,
    unit: 'CNY',
    windows: [],
    fetched_at: new Date('2026-11-03T11:00:00+08:00').getTime(),
    reason_code: null,
    detail: null,
    ...overrides,
  };
}

function renderCards() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><QuotaCards /></QueryClientProvider>);
}

const okSnapshot = {
  workspace_id: null,
  fetched_at: new Date('2026-11-03T11:00:00+08:00').getTime(),
  items: [
    item(),
    item({ source: 'opencode_go', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: 'OpenCode Go 没有公开的配额接口（用量只在 console 页面查看）' }),
    item({ source: 'codex', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: 'Codex 额度窗口没有公开接口' }),
  ],
};

beforeEach(() => server.resetHandlers());

describe('额度卡（ACC-QUOTA-01）', () => {
  it('三张卡：DeepSeek 显示真实余额，其余两来源显示可解释中文原因（不显示裸码）', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(okSnapshot)));
    renderCards();

    const deepseek = await screen.findByTestId('quota-card-deepseek');
    expect(within(deepseek).getByTestId('quota-balance-deepseek')).toHaveTextContent('¥38.42');
    expect(within(deepseek).getByText('正常')).toBeInTheDocument();

    const go = screen.getByTestId('quota-card-opencode_go');
    expect(within(go).getByTestId('quota-reason-opencode_go')).toHaveTextContent('该来源没有公开的额度接口');
    expect(within(go).getByTestId('quota-reason-opencode_go').textContent ?? '').not.toContain('NO_PUBLIC_QUOTA_ENDPOINT');
    expect(within(go).getByText('不支持')).toBeInTheDocument();

    const codex = screen.getByTestId('quota-card-codex');
    expect(within(codex).getByTestId('quota-reason-codex')).toHaveTextContent('该来源没有公开的额度接口');

    expect(screen.getByTestId('quota-updated')).toHaveTextContent('更新于 11:00');
  });

  it('窗口版式（参考图）：每窗口一行 = 名称 + 「N% used」+「Resets in …」+ 进度条', async () => {
    const resetAt = Date.now() + (1 * 60 + 20) * 60_000 + 30_000;
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [
        item({ source: 'deepseek', status: 'unsupported', balance: null, unit: null, reason_code: 'CREDENTIAL_MISSING', detail: null }),
        item({
          source: 'opencode_go', status: 'ok', balance: null, unit: '%', detail: '工作区：Default',
          windows: [
            { name: 'rolling', remaining: 81, used_percent: 19, reset_at: resetAt },
            { name: 'weekly', remaining: 92, used_percent: 8, reset_at: null },
          ],
        }),
        item({ source: 'codex', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null }),
      ],
    })));
    renderCards();

    const card = await screen.findByTestId('quota-card-opencode_go');
    const first = within(card).getByTestId('quota-window-opencode_go-0');
    expect(first).toHaveTextContent('5-hour window');
    expect(within(card).getByTestId('quota-window-used-opencode_go-0')).toHaveTextContent('19% used');
    expect(within(card).getByTestId('quota-reset-opencode_go-0')).toHaveTextContent('Resets in 1h 20m');
    // 进度条宽度 = used_percent
    expect(within(card).getByTestId('quota-bar-opencode_go-0')).toHaveAttribute('data-width', '19');
    expect(within(card).getByTestId('quota-bar-opencode_go-0')).toHaveStyle({ width: '19%' });
    // 无重置时刻 → Resets soon
    expect(within(card).getByTestId('quota-reset-opencode_go-1')).toHaveTextContent('Resets soon');
    expect(within(card).getByTestId('quota-window-opencode_go-1')).toHaveTextContent('Weekly');
  });

  it('Codex 只显示 5-hour 与 Weekly（不渲染 Monthly）；unsupported 时不渲染空进度条', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [
        item({ source: 'deepseek', status: 'ok', balance: 1, unit: 'CNY', windows: [] }),
        item({ source: 'opencode_go', status: 'ok', balance: null, unit: '%', windows: [{ name: 'rolling', remaining: 50, used_percent: 50, reset_at: null }] }),
        item({
          source: 'codex', status: 'ok', balance: null, unit: '%',
          windows: [
            { name: '5h', remaining: 60, used_percent: 40, reset_at: null },
            { name: 'weekly', remaining: 80, used_percent: 20, reset_at: null },
            { name: 'monthly', remaining: 90, used_percent: 10, reset_at: null },
          ],
        }),
      ],
    })));
    renderCards();

    const codex = await screen.findByTestId('quota-card-codex');
    expect(within(codex).getAllByTestId(/quota-window-codex-/)).toHaveLength(2);
    expect(within(codex).getByTestId('quota-window-codex-0')).toHaveTextContent('5-hour window');
    expect(within(codex).getByTestId('quota-window-codex-1')).toHaveTextContent('Weekly');
    expect(codex.textContent ?? '').not.toContain('Monthly');

  });

  it('Codex unsupported 时只显示原因，不渲染空进度条', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [
        item({ source: 'deepseek', status: 'ok', balance: 1, unit: 'CNY', windows: [] }),
        item({ source: 'opencode_go', status: 'ok', balance: null, unit: '%', windows: [{ name: 'rolling', remaining: 50, used_percent: 50, reset_at: null }] }),
        item({ source: 'codex', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null }),
      ],
    })));
    renderCards();
    await waitFor(() => expect(screen.getByTestId('quota-reason-codex')).toHaveTextContent('该来源没有公开的额度接口'));
    expect(screen.queryByTestId('quota-windows-codex')).toBeNull();
    expect(screen.queryByTestId('quota-bar-codex-0')).toBeNull();
  });
  it('失败态：error 显示中文原因，未知码显示中性文案 + 可展开技术码', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [
        item({ source: 'deepseek', status: 'error', balance: null, unit: null, reason_code: 'CREDENTIAL_INVALID', detail: null }),
        item({ source: 'opencode_go', status: 'error', balance: null, unit: null, reason_code: 'SOMETHING_NEW', detail: null }),
        item({ source: 'codex', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null }),
      ],
    })));
    renderCards();

    const deepseek = await screen.findByTestId('quota-card-deepseek');
    expect(within(deepseek).getByTestId('quota-reason-deepseek')).toHaveTextContent('凭据已失效');
    expect(within(deepseek).getByText('取数失败')).toBeInTheDocument();

    const go = screen.getByTestId('quota-card-opencode_go');
    expect(within(go).getByTestId('quota-reason-opencode_go')).toHaveTextContent('暂时取不到额度');
    expect(within(go).getByTestId('quota-reason-opencode_go').textContent ?? '').not.toContain('SOMETHING_NEW');
    expect(within(go).getByTestId('quota-code-opencode_go').textContent).toContain('SOMETHING_NEW');
  });

  it('接口整体失败：显示错误态而不是白屏', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '额度服务不可用' } }, { status: 500 })));
    renderCards();
    expect(await screen.findByTestId('quota-load-error')).toHaveTextContent('额度服务不可用');
  });

  it('格式化工具：金额、重置时刻、剩余时长边界', () => {
    expect(quotaAmountText(item())).toBe('¥38.42');
    expect(quotaAmountText(item({ unit: 'USD', balance: 0 }))).toBe('$0.00');
    expect(quotaAmountText(item({ unit: null, balance: 5 }))).toBe('5.00');
    expect(quotaAmountText(item({ balance: null }))).toBeNull();
    expect(formatRemaining(Date.now() - 1000, Date.now())).toBe('已重置');
    expect(formatRemaining(Date.now() + 45 * 60_000 + 5000, Date.now())).toBe('45m');
  });
});


