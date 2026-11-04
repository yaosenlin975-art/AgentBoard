/**
 * A11Y-TABNOISE：标签筛选条 roving tabindex —— chip 组只占 1 个 Tab 停靠点，
 * 方向键在 chip 间移动，Space/Enter 与鼠标点击的 aria-pressed 语义不变。
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
  it('30 个 chip 只有 1 个 Tab 停靠点（改动前为 30 个）', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(30);
    const tabbable = chips.filter((chip) => chip.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(chips[0]!.getAttribute('tabindex')).toBe('0');
    expect(chips.filter((chip) => chip.getAttribute('tabindex') === '-1')).toHaveLength(29);
  });

  it('Tab 进入 chip 组后，←/→/Home/End 移动焦点并同步 roving 位', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(30);

    await userEvent.tab();
    expect(chips[0]).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(chips[1]).toHaveFocus();
    expect(chips[0]!.getAttribute('tabindex')).toBe('-1');
    expect(chips[1]!.getAttribute('tabindex')).toBe('0');

    await userEvent.keyboard('{End}');
    expect(chips[29]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(chips[29]).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(chips[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(chips[0]).toHaveFocus();
  });

  it('Space 仍可选中（aria-pressed 翻转），鼠标点击行为不变', async () => {
    renderBar();
    const chips = await screen.findAllByTestId(/^label-filter-label-/);
    expect(chips).toHaveLength(30);

    await userEvent.tab();
    expect(chips[0]).toHaveAttribute('aria-pressed', 'false');
    await userEvent.keyboard(' ');
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(chips[4]!);
    expect(chips[4]).toHaveAttribute('aria-pressed', 'true');
    expect(chips[4]).toHaveFocus();
    expect(screen.getByTestId('label-filter-clear')).toBeInTheDocument();

    await userEvent.click(chips[4]!);
    expect(chips[4]).toHaveAttribute('aria-pressed', 'false');

    // 清掉 Space 选中的首项后，清除按钮随之消失（选中集合为空）
    await userEvent.click(chips[0]!);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('label-filter-clear')).toBeNull();
  });
});
