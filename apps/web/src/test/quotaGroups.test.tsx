/**
 * ACC-KB-B5W：额度行分组 + 窗口 kind/total/used 渲染 + unsupported 如实展示。
 *
 * 纯函数与组件两层分开测：
 * - `quotaGroupedRows`：CLI 额度组（3）与平台账号组（5）各自成组、组内顺序 = 组 sources、缺失来源留占位；
 * - `QuotaRow`：`kind/total/used` 存在时显示「已用/总量」与 kind 标签；**老数据没有这些字段时回落百分比不崩**；
 *   `unsupported` 只显示可读原因，不出现进度条/0%。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { QuotaResult } from '@agentboard/shared';
import { QUOTA_GROUPS } from '@agentboard/shared';
import { QuotaRow, quotaGroupedRows, quotaWindowKindLabel } from '../components/settings/QuotaCards';

const item = (overrides: Partial<QuotaResult> = {}): QuotaResult => ({
  source: 'deepseek', status: 'ok', balance: 42.5, unit: 'CNY', windows: [], fetched_at: 1_700_000_000_000,
  reason_code: null, detail: null, ...overrides,
});

describe('分组：CLI 额度 3 + 平台账号 5', () => {
  it('两组都按 QUOTA_GROUPS 成组，组内顺序与组 sources 一致，缺失来源留占位', () => {
    const grouped = quotaGroupedRows([item({ source: 'zcode' }), item({ source: 'deepseek' })]);
    expect(grouped.map((group) => group.id)).toEqual(QUOTA_GROUPS.map((group) => group.id));
    expect([...grouped[0]!.sources]).toEqual(['deepseek', 'opencode_go', 'codex']);
    expect([...grouped[1]!.sources]).toEqual(['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode']);
    // 行与来源一一对位（缺失的是 undefined，不是把后面的挤上来）
    expect(grouped[0]!.rows[0]).toMatchObject({ source: 'deepseek' });
    // 服务端只回了两个来源 → 其余是 undefined 占位，不会错位
    expect(grouped[0]!.rows[1]).toBeUndefined();
    expect(grouped[1]!.rows[4]).toMatchObject({ source: 'zcode' });
  });
});

describe('窗口渲染：kind/total/used 与老数据回落', () => {
  it('有 total/used 时显示「已用/总量」，标签走 kind', () => {
    render(<QuotaRow item={item({ source: 'trae', balance: 60, unit: '积分', windows: [
      { name: '积分包', kind: 'credit', remaining: 60, total: 100, used: 40, used_percent: 40, reset_at: null },
    ] })} />);
    const window = screen.getByTestId('quota-row-window-trae-0');
    expect(window.getAttribute('data-kind')).toBe('credit');
    expect(screen.getByTestId('quota-row-used-trae-0')).toHaveTextContent('40/100');
  });

  it('老数据（无 kind/total/used）回落百分比且不崩', () => {
    render(<QuotaRow item={item({ source: 'codex', balance: null, unit: null, windows: [
      { name: '5h', remaining: 5, reset_at: null, used_percent: 95 },
    ] })} />);
    const window = screen.getByTestId('quota-row-window-codex-0');
    expect(window.getAttribute('data-kind')).toBe('legacy');
    expect(screen.getByTestId('quota-row-used-codex-0')).toHaveTextContent('95%');
    expect(quotaWindowKindLabel({ name: '5h', remaining: 1, reset_at: null })).toBe('5h');
  });

  it('weekly / monthly / rolling 的 kind 标签', () => {
    expect(quotaWindowKindLabel({ name: 'weekly', kind: 'weekly', remaining: 1, reset_at: null })).toBe('周');
    expect(quotaWindowKindLabel({ name: 'monthly', kind: 'monthly', remaining: 1, reset_at: null })).toBe('月');
    expect(quotaWindowKindLabel({ name: '5h', kind: 'rolling', remaining: 1, reset_at: null })).toBe('5h');
  });
});

describe('unsupported 如实展示（不是 0 / 0%）', () => {
  it('NO_CREDENTIAL 显示「未接入」原因，且不渲染窗口进度条', () => {
    render(<QuotaRow item={item({
      source: 'minimax', status: 'unsupported', balance: null, unit: null, windows: [],
      reason_code: 'NO_CREDENTIAL', detail: '本机缺少 MiniMax 会员签名材料',
    })} />);
    expect(screen.getByTestId('quota-row-reason-minimax')).toHaveTextContent('未接入');
    expect(screen.queryByTestId('quota-row-windows-minimax')).toBeNull();
    expect(screen.queryByTestId('quota-row-balance-minimax')).toBeNull();
    expect(screen.queryByTestId('quota-row-bar-minimax-0')).toBeNull();
  });
});
