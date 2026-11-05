/**
 * LABEL-BAR：默认两行封顶下的排序、「更多 +N」计数与浮层交互。
 * jsdom 无布局，两行封顶的测量收敛在真实浏览器生效；这里锁数据与交互契约。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { LabelFilterBar } from '../components/board/LabelFilterBar';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const WS = 'ws-1';

function makeIssue(id: string, labels: string[], index: number): Issue {
  return {
    id,
    workspace_id: WS,
    title: id,
    description: '',
    priority: '中',
    labels,
    status: '待规划',
    sort_order: index,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 10,
  };
}

function mockLabels(labelGroups: string[][]): void {
  server.use(
    http.get('/api/issues', () => HttpResponse.json(labelGroups.map((labels, index) => makeIssue(`i-${index}`, labels, index)))),
  );
}

function renderBar(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LabelFilterBar workspaceId={WS} />
    </QueryClientProvider>,
  );
}

/** 可见行里的 chip 顺序（排除「更多」「清除筛选」「已选」等非 chip 控件） */
async function visibleChipLabels(): Promise<string[]> {
  const bar = await screen.findByTestId('label-filter-bar');
  await waitFor(() => expect(within(bar).getAllByRole('button').length).toBeGreaterThan(0));
  return within(bar)
    .getAllByRole('button')
    .map((button) => button.getAttribute('data-testid') ?? '')
    .filter((id) => id.startsWith('label-filter-') && !['label-filter-more', 'label-filter-clear', 'label-filter-selected-count'].includes(id))
    .map((id) => id.replace('label-filter-', ''));
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
});

describe('LABEL-BAR 排序与更多浮层', () => {
  it('已选中置顶（保持原序），其余按频次降序、同频字母序', async () => {
    // 频次：高频 4 / 中频 2 / Alpha 1 / beta 1 / gamma 1 / 已选标签 1
    mockLabels([
      ['已选标签', '高频', '中频', 'Alpha'],
      ['高频', '中频', 'beta'],
      ['高频'],
      ['高频'],
      ['gamma'],
    ]);
    useAppStore.setState({ selectedLabelsByWorkspace: { [WS]: ['已选标签'] } });
    renderBar();

    expect(await visibleChipLabels()).toEqual(['已选标签', '高频', '中频', 'Alpha', 'beta', 'gamma']);
  });

  it('超过 MAX_VISIBLE 时「更多」显示动态 +N，浮层只列未显示标签', async () => {
    mockLabels(Array.from({ length: 30 }, (_, i) => [`label-${String(i + 1).padStart(2, '0')}`]));
    renderBar();

    expect(await visibleChipLabels()).toHaveLength(14);
    expect(screen.getByTestId('label-filter-more')).toHaveTextContent('更多 +16');

    await userEvent.click(screen.getByTestId('label-filter-more'));
    const panel = await screen.findByTestId('label-filter-more-panel');
    expect(within(panel).getAllByTestId(/^label-filter-more-item-/)).toHaveLength(16);
    expect(within(panel).getByTestId('label-filter-more-item-label-15')).toBeInTheDocument();
    expect(within(panel).queryByTestId('label-filter-more-item-label-01')).toBeNull();
  });

  it('标签数不超过 MAX_VISIBLE 时不渲染「更多」（N=0）', async () => {
    mockLabels([['前端'], ['后端'], ['文档'], ['测试'], ['规则'], ['技能']]);
    renderBar();

    expect((await visibleChipLabels())).toHaveLength(6);
    expect(screen.queryByTestId('label-filter-more')).toBeNull();
  });

  it('浮层可 Esc 关闭，关闭后焦点回到「更多」按钮', async () => {
    mockLabels(Array.from({ length: 30 }, (_, i) => [`label-${String(i + 1).padStart(2, '0')}`]));
    renderBar();

    await userEvent.click(await screen.findByTestId('label-filter-more'));
    expect(await screen.findByTestId('label-filter-more-panel')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('label-filter-more-panel')).toBeNull();
    expect(screen.getByTestId('label-filter-more')).toHaveFocus();
  });

  it('浮层内点击 chip 连续多选且不自动关闭，可再次点击取消', async () => {
    mockLabels(Array.from({ length: 30 }, (_, i) => [`label-${String(i + 1).padStart(2, '0')}`]));
    renderBar();

    await userEvent.click(await screen.findByTestId('label-filter-more'));
    const panel = await screen.findByTestId('label-filter-more-panel');
    const first = within(panel).getByTestId('label-filter-more-item-label-15');
    await userEvent.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveTextContent('✓ label-15');
    expect(screen.getByTestId('label-filter-more-panel')).toBeInTheDocument();

    const second = within(panel).getByTestId('label-filter-more-item-label-16');
    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('label-filter-more-panel')).toBeInTheDocument();
    expect(screen.getByTestId('label-filter-selected-count')).toHaveTextContent('已选 2');

    await userEvent.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(first).toHaveTextContent(/^label-15$/);
  });

  it('浮层顶部过滤框可按子串筛选未显示标签', async () => {
    mockLabels(Array.from({ length: 30 }, (_, i) => [`label-${String(i + 1).padStart(2, '0')}`]));
    renderBar();

    await userEvent.click(await screen.findByTestId('label-filter-more'));
    const panel = await screen.findByTestId('label-filter-more-panel');
    const filter = within(panel).getByTestId('label-filter-more-filter');
    expect(filter).toHaveFocus();
    await userEvent.type(filter, 'label-2');
    expect(within(panel).queryByTestId('label-filter-more-item-label-15')).toBeNull();
    expect(within(panel).getByTestId('label-filter-more-item-label-20')).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, '不存在');
    expect(within(panel).getByText('没有匹配的标签')).toBeInTheDocument();
  });
});
