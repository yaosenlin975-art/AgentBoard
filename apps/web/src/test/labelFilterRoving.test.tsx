/**
 * A11Y-TABNOISE + LABEL-BAR：默认只展示前 14 个 chip（两行封顶），其余进「更多」浮层。
 * 本文件只锁 roving tabindex 与 chip 点击语义；排序/浮层行为见 labelBarOverflow.test.tsx。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { LabelFilterBar } from '../components/board/LabelFilterBar';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const LABELS = Array.from({ length: 30 }, (_, i) => `label-${String(i + 1).padStart(2, '0')}`);

function makeIssue(id: string, label: string, index: number): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: id,
    description: '',
    priority: '中',
    labels: [label],
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

function renderBar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LabelFilterBar workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
  server.use(http.get('/api/issues', () => HttpResponse.json(LABELS.map((label, i) => makeIssue(`i-${i}`, label, i)))));
});

describe('标签筛选 roving tabindex（A11Y-TABNOISE）', () => {
  it('默认只展示 14 个 chip，且只有 1 个 Tab 停靠点', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(14);
    const tabbable = chips.filter((chip) => chip.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(chips[0]!.getAttribute('tabindex')).toBe('0');
    expect(chips.filter((chip) => chip.getAttribute('tabindex') === '-1')).toHaveLength(13);
  });

  it('Tab 进入 chip 组后，←/→/Home/End 在可见 chip 内移动焦点并同步 roving 位', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(14);

    await userEvent.tab();
    expect(chips[0]).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(chips[1]).toHaveFocus();
    expect(chips[0]!.getAttribute('tabindex')).toBe('-1');
    expect(chips[1]!.getAttribute('tabindex')).toBe('0');

    await userEvent.keyboard('{End}');
    expect(chips[13]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(chips[13]).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(chips[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(chips[0]).toHaveFocus();
  });

  it('Space 仍可选中（aria-pressed 翻转），鼠标点击行为不变', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(14);

    await userEvent.tab();
    expect(chips[0]).toHaveAttribute('aria-pressed', 'false');
    await userEvent.keyboard(' ');
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');

    // LABEL-BAR：选中项置顶，其余标签仍在可见行（不整条收进「更多」）
    expect(screen.getByTestId('label-filter-selected-count')).toHaveTextContent('已选 1');
    expect(screen.getByTestId('label-filter-label-05')).toBeInTheDocument();
    expect(screen.getByTestId('label-filter-more')).toHaveTextContent('更多 +16');

    // 浮层内的 chip 同样是原生 button，点击翻转选中态
    await userEvent.click(screen.getByTestId('label-filter-more'));
    const panel = await screen.findByTestId('label-filter-more-panel');
    expect(panel).toBeInTheDocument();
    const hiddenChip = screen.getByTestId('label-filter-more-item-label-16');
    await userEvent.click(hiddenChip);
    expect(hiddenChip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hiddenChip);
    expect(hiddenChip).toHaveAttribute('aria-pressed', 'false');

    // 清掉首项后，清除按钮随之消失（选中集合为空）
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('label-filter-more-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('label-filter-label-01'));
    expect(screen.getByTestId('label-filter-label-01')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('label-filter-clear')).toBeNull();
  });
});
