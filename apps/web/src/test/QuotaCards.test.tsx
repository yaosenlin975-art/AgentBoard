/**
 * ACC-QUOTA-01：额度来源取数口径（逐来源 ok / unsupported / error）。
 * - deepseek ok：显示余额与币种；
 * - opencode_go / codex unsupported：显示可解释中文原因，裸码只在「技术码」里；
 * - 接口失败：整体错误态，不白屏；
 * - 不显示 token / 文件路径。
 *
 * ACC-PANEL-03 起三来源由「卡片」改为总览行（`QuotaRows`），本组用例随之行式 testid：
 * `quota-card-*`→`quota-row-*`、`quota-balance-*`→`quota-row-balance-*`、`quota-reason-*`→`quota-row-reason-*`、
 * `quota-code-*`→`quota-row-code-*`、`quota-window-*`→`quota-row-window-*`；状态徽标改为 `data-status` 属性；
 * 重置时间按设计 §5 只进 tooltip，不再断言行内文案。
 *
 * ACC-QUOTA-02：`QuotaRow` 行内绘制（设计 §5），三种资源类型各一条分支——余额 / 窗口迷你进度条 / 积分占位。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { QuotaRow, QuotaRows, formatRemaining, formatResetClock, formatResets, isWindowLimited, quotaAmountText, quotaRowBalance, quotaWindowShortLabel, type QuotaItem } from '../components/settings/QuotaCards';
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
  return render(<QueryClientProvider client={qc}><QuotaRows /></QueryClientProvider>);
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

describe('额度来源行（ACC-QUOTA-01）', () => {
  it('三行：DeepSeek 显示真实余额，其余两来源显示可解释中文原因（不显示裸码）', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json(okSnapshot)));
    renderCards();

    const deepseek = await screen.findByTestId('quota-row-deepseek');
    expect(deepseek).toHaveAttribute('data-status', 'ok');
    expect(within(deepseek).getByTestId('quota-row-balance-deepseek')).toHaveTextContent('¥38.42');

    const go = screen.getByTestId('quota-row-opencode_go');
    expect(go).toHaveAttribute('data-status', 'unsupported');
    expect(within(go).getByTestId('quota-row-reason-opencode_go')).toHaveTextContent('该来源没有公开的额度接口');
    expect(within(go).getByTestId('quota-row-reason-opencode_go').textContent ?? '').not.toContain('NO_PUBLIC_QUOTA_ENDPOINT');

    const codex = screen.getByTestId('quota-row-codex');
    expect(within(codex).getByTestId('quota-row-reason-codex')).toHaveTextContent('该来源没有公开的额度接口');

    expect(screen.getByTestId('quota-updated')).toHaveTextContent('更新于 11:00');
  });

  it('来源顺序按 QUOTA_ROW_ORDER，服务端漏返回的来源补成「暂时取不到额度」行', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [item({ source: 'codex', status: 'unsupported', balance: null, unit: null, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null })],
    })));
    renderCards();

    const rows = await screen.findAllByTestId(/quota-row-(deepseek|opencode_go|codex)$/);
    expect(rows.map((row) => row.getAttribute('data-source'))).toEqual(['deepseek', 'opencode_go', 'codex']);
    // 补齐行：无余额、无进度条，只有中文原因
    expect(rows[0]).toHaveAttribute('data-status', 'missing');
    expect(screen.getByTestId('quota-row-reason-deepseek')).toHaveTextContent('暂时取不到额度');
    expect(screen.queryByTestId('quota-row-windows-codex')).toBeNull();
  });

  it('窗口版式：迷你进度条（宽=used_percent）+ 百分比，重置时间只进 tooltip', async () => {
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

    const row = await screen.findByTestId('quota-row-opencode_go');
    const first = within(row).getByTestId('quota-row-window-opencode_go-0');
    expect(first).toHaveTextContent('5h');
    expect(within(row).getByTestId('quota-row-used-opencode_go-0')).toHaveTextContent('19%');
    // 进度条宽度 = used_percent
    expect(within(row).getByTestId('quota-row-bar-opencode_go-0')).toHaveAttribute('data-width', '19');
    expect(within(row).getByTestId('quota-row-bar-opencode_go-0')).toHaveStyle({ width: '19%' });
    // 重置时间进 tooltip；无来源重置时刻显示为未知
    expect(first.getAttribute('title') ?? '').toContain('Resets in 1h 20m');
    expect(within(row).getByTestId('quota-row-window-opencode_go-1').getAttribute('title') ?? '').toContain('Reset time unknown');
    expect(within(row).getByTestId('quota-row-window-opencode_go-1')).toHaveTextContent('周');
  });

  it('Codex 只显示 5h 与 周（不渲染 monthly）；unsupported 时不渲染空进度条', async () => {
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

    const codex = await screen.findByTestId('quota-row-codex');
    expect(within(codex).getAllByTestId(/quota-row-window-codex-/)).toHaveLength(2);
    expect(within(codex).getByTestId('quota-row-window-codex-0')).toHaveTextContent('5h');
    expect(within(codex).getByTestId('quota-row-window-codex-1')).toHaveTextContent('周');
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

    const codex = await screen.findByTestId('quota-row-codex');
    expect(within(codex).getByTestId('quota-row-reason-codex')).toHaveTextContent('该来源没有公开的额度接口');
    expect(within(codex).queryByTestId('quota-row-windows-codex')).toBeNull();
    expect(within(codex).queryByTestId('quota-row-bar-codex-0')).toBeNull();
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

    const deepseek = await screen.findByTestId('quota-row-deepseek');
    expect(deepseek).toHaveAttribute('data-status', 'error');
    expect(within(deepseek).getByTestId('quota-row-reason-deepseek')).toHaveTextContent('凭据已失效');

    const go = screen.getByTestId('quota-row-opencode_go');
    expect(within(go).getByTestId('quota-row-reason-opencode_go')).toHaveTextContent('暂时取不到额度');
    expect(within(go).getByTestId('quota-row-reason-opencode_go').textContent ?? '').not.toContain('SOMETHING_NEW');
    expect(within(go).getByTestId('quota-row-code-opencode_go').textContent).toContain('SOMETHING_NEW');
    // 空进度条不渲染
    expect(within(go).queryByTestId('quota-row-windows-opencode_go')).toBeNull();
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



describe('Codex 本地额度（ACC-CODEX-QUOTA-IMPL）', () => {
  it('两行窗口 + 余额为 0 时显示「额度内」而不是 0', async () => {
    server.use(http.get('/api/managed-account-quotas', () => HttpResponse.json({
      workspace_id: null,
      fetched_at: Date.now(),
      items: [
        item({ source: 'deepseek', status: 'ok', balance: 751.81, unit: 'CNY', windows: [] }),
        item({ source: 'opencode_go', status: 'ok', balance: null, unit: '%', windows: [{ name: 'rolling', remaining: 50, used_percent: 50, reset_at: null }] }),
        item({
          source: 'codex', status: 'ok', balance: 0, unit: 'USD', detail: '额度内',
          windows: [
            { name: '5h', remaining: 98, used_percent: 2, reset_at: Date.now() + 3600_000 },
            { name: 'weekly', remaining: 23, used_percent: 77, reset_at: Date.now() + 7 * 86400_000 },
          ],
        }),
      ],
    })));
    renderCards();

    const codex = await screen.findByTestId('quota-row-codex');
    expect(within(codex).getByTestId('quota-row-balance-codex')).toHaveTextContent('额度内');
    expect(within(codex).getByTestId('quota-row-balance-codex').textContent ?? '').not.toMatch(/\$0/);
    expect(within(codex).getAllByTestId(/quota-row-window-codex-/)).toHaveLength(2);
    expect(within(codex).getByTestId('quota-row-window-codex-0')).toHaveTextContent('5h');
    expect(within(codex).getByTestId('quota-row-window-codex-1')).toHaveTextContent('周');
    expect(within(codex).getByTestId('quota-row-used-codex-0')).toHaveTextContent('2%');
    expect(within(codex).getByTestId('quota-row-bar-codex-1')).toHaveAttribute('data-width', '77');
    // 「额度内」不再作为 detail 重复出现
    expect(codex.textContent?.match(/额度内/g)?.length).toBe(1);
  });
});

describe('Command Code USD 额度显示', () => {
  it('零余额显示 $0.00，窗口金额保留两位小数，缺少 reset 显示未知', () => {
    expect(quotaRowBalance(item({ source: 'commandcode', balance: 0, unit: 'USD' }))).toBe('$0.00');
    expect(formatResets(0, NOW)).toBe('Reset time unknown');
    render(
      <QuotaRow
        item={item({
          source: 'commandcode',
          balance: 0,
          unit: 'USD',
          windows: [{ name: 'weekly', kind: 'weekly', total: 35, used: 9.6445, remaining: 25.3555, used_percent: 27.55, reset_at: null }],
        })}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('quota-row-commandcode');
    expect(within(row).getByTestId('quota-row-balance-commandcode')).toHaveTextContent('$0.00');
    expect(within(row).getByTestId('quota-row-used-commandcode-0')).toHaveTextContent('$9.64/$35.00');
    expect(within(row).getByTestId('quota-row-window-commandcode-0').getAttribute('title') ?? '').toContain('Reset time unknown');
  });
});

/** ACC-QUOTA-02：行内绘制。now 固定注入，reset 时刻用相对 now 的偏移，避免用例随真实时钟漂移。 */
const NOW = new Date('2026-11-04T12:00:00+08:00').getTime();

describe('额度行内绘制（ACC-QUOTA-02）', () => {
  it('余额分支：金额 + 「余额」注，同栏不出窗口条', () => {
    render(<QuotaRow item={item({ balance: 751.81, unit: 'CNY' })} now={NOW} />);
    const row = screen.getByTestId('quota-row-deepseek');
    expect(row).toHaveAttribute('data-source', 'deepseek');
    expect(row).toHaveAttribute('data-status', 'ok');
    expect(within(row).getByTestId('quota-row-balance-deepseek')).toHaveTextContent('¥751.81');
    expect(within(row).getByTestId('quota-row-balance-deepseek').textContent).toContain('余额');
    expect(within(row).queryByTestId('quota-row-windows-deepseek')).toBeNull();
    expect(within(row).queryByTestId('quota-row-reason-deepseek')).toBeNull();
    // C3 面板行栏直接嵌入，行本身不套卡片边框
    expect(row.className).not.toContain('rounded-lg');
  });

  it('无符号币种仍带单位；余额 0 读作「额度内」而不是 $0.00', () => {
    expect(quotaRowBalance(item({ balance: 12.5, unit: 'POINT' }))).toBe('12.50 POINT');
    expect(quotaRowBalance(item({ balance: 0, unit: 'USD' }))).toBe('额度内');
    expect(quotaRowBalance(item({ balance: null }))).toBeNull();

    render(<QuotaRow item={item({ source: 'codex', balance: 0, unit: 'USD', windows: [] })} now={NOW} />);
    expect(screen.getByTestId('quota-row-balance-codex')).toHaveTextContent('额度内');
    expect(screen.getByTestId('quota-row-balance-codex').textContent ?? '').not.toMatch(/\$0/);
    // 「额度内」不再追加「余额」注（否则读成「额度内余额」），有金额时才带注
    expect(screen.getByTestId('quota-row-balance-codex').textContent ?? '').not.toContain('余额');
    render(<QuotaRow item={item({ source: 'deepseek', balance: 12.5, unit: 'CNY', windows: [] })} now={NOW} />);
    expect(screen.getByTestId('quota-row-balance-deepseek')).toHaveTextContent('余额');
  });

  it('窗口分支：迷你进度条宽 = used_percent，% 标注同行，重置时间只进 tooltip', () => {
    render(
      <QuotaRow
        item={item({
          source: 'opencode_go',
          balance: null,
          unit: '%',
          windows: [
            { name: 'rolling', remaining: 81, used_percent: 19, reset_at: NOW + (1 * 60 + 20) * 60_000 },
            { name: 'weekly', remaining: 92, used_percent: 8, reset_at: null },
            { name: 'monthly', remaining: 60, used_percent: 40, reset_at: NOW + 3 * 86_400_000 },
          ],
        })}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('quota-row-opencode_go');
    expect(within(row).getByTestId('quota-row-windows-opencode_go')).toBeInTheDocument();
    expect(within(row).getAllByTestId(/quota-row-window-opencode_go-/)).toHaveLength(3);
    expect(within(row).getByTestId('quota-row-window-opencode_go-0')).toHaveTextContent('5h');
    expect(within(row).getByTestId('quota-row-used-opencode_go-0')).toHaveTextContent('19%');

    const bar = within(row).getByTestId('quota-row-bar-opencode_go-0');
    expect(bar).toHaveAttribute('data-width', '19');
    expect(bar).toHaveStyle({ width: '19%' });
    expect(bar.parentElement).toHaveClass('h-[2px]');
    // 重置时间不再占行内文字位（设计 §5：进 tooltip）
    expect(within(row).getByTestId('quota-row-window-opencode_go-0').getAttribute('title') ?? '').toContain('Resets in 1h 20m');
    expect(within(row).getByTestId('quota-row-window-opencode_go-1').getAttribute('title') ?? '').toContain('Reset time unknown');
    expect(row.textContent ?? '').not.toContain('Resets in');
    expect(within(row).queryByTestId('quota-row-balance-opencode_go')).toBeNull();
  });

  it('limited 窗口：「已限额」芯片替换百分比 + 警示色，进度条转警示色', () => {
    expect(isWindowLimited({ name: 'weekly', remaining: 0, used_percent: 100, reset_at: null })).toBe(true);
    expect(isWindowLimited({ name: 'limited', remaining: 5, used_percent: 10, reset_at: null })).toBe(true);
    expect(isWindowLimited({ name: 'weekly', remaining: 50, used_percent: 99.4, reset_at: null })).toBe(false);

    render(
      <QuotaRow
        item={item({ source: 'opencode_go', balance: null, unit: '%', windows: [{ name: 'monthly', remaining: 0, used_percent: 100, reset_at: null }] })}
        now={NOW}
      />,
    );
    const chip = screen.getByTestId('quota-row-limited-opencode_go-0');
    expect(chip).toHaveTextContent('已限额');
    expect(chip.className).toContain('bg-accent-soft');
    expect(screen.getByTestId('quota-row-bar-opencode_go-0').className).toContain('bg-accent');
    expect(screen.queryByTestId('quota-row-used-opencode_go-0')).toBeNull();
  });

  it('Codex 不画 monthly 行（design-2026-11-03 D3 不变）', () => {
    render(
      <QuotaRow
        item={item({
          source: 'codex', balance: null, unit: '%',
          windows: [
            { name: '5h', remaining: 60, used_percent: 40, reset_at: null },
            { name: 'weekly', remaining: 80, used_percent: 20, reset_at: null },
            { name: 'monthly', remaining: 90, used_percent: 10, reset_at: null },
          ],
        })}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('quota-row-codex');
    expect(within(row).getAllByTestId(/quota-row-window-codex-/)).toHaveLength(2);
    expect(within(row).getByTestId('quota-row-window-codex-0')).toHaveTextContent('5h');
    expect(within(row).getByTestId('quota-row-window-codex-1')).toHaveTextContent('周');
    expect(row.textContent ?? '').not.toContain('月');
    expect(quotaWindowShortLabel('rolling')).toBe('5h');
  });

  it('原因分支：中文主文案在行内，裸码只进可展开技术码，且不渲染空进度条', () => {
    render(<QuotaRow item={item({ source: 'codex', status: 'error', balance: null, unit: null, reason_code: 'SOMETHING_NEW', detail: null })} now={NOW} />);
    const row = screen.getByTestId('quota-row-codex');
    expect(within(row).getByTestId('quota-row-reason-codex')).toHaveTextContent('暂时取不到额度');
    expect(within(row).getByTestId('quota-row-reason-codex').textContent ?? '').not.toContain('SOMETHING_NEW');
    expect(within(row).getByTestId('quota-row-code-codex').textContent).toContain('SOMETHING_NEW');
    expect(within(row).queryByTestId('quota-row-windows-codex')).toBeNull();

    render(<QuotaRow item={item({ source: 'deepseek', status: 'error', balance: null, unit: null, reason_code: 'CREDENTIAL_INVALID', detail: null })} now={NOW} />);
    expect(screen.getByTestId('quota-row-reason-deepseek')).toHaveTextContent('凭据已失效');
    expect(screen.queryByTestId('quota-row-code-deepseek')).toBeNull();
  });

  it('prefers-reduced-motion：进度条只过渡宽度且带 motion-reduce 兜底，无高度动画', () => {
    render(<QuotaRow item={item({ source: 'opencode_go', balance: null, unit: '%', windows: [{ name: '5h', remaining: 1, used_percent: 30, reset_at: null }] })} now={NOW} />);
    const bar = screen.getByTestId('quota-row-bar-opencode_go-0');
    expect(bar.className).toContain('transition-[width]');
    expect(bar.className).toContain('motion-reduce:transition-none');
    expect(bar.className).not.toMatch(/transition-(height|max-h|all)/);
  });
});
