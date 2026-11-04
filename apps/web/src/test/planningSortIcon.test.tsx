/**
 * SORT-ICON：待规划列排序从 select 改成单个图标按钮（紧跟 + 号右侧）。
 * 覆盖：循环顺序、localStorage 写入、title/aria-label 文案、图标随模式变化、键盘可达、无 emoji。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { PLANNING_SORT_CYCLE, nextPlanningSort, planningSortLabel } from '../components/board/PlanningSortButton';
import { PLANNING_SORT_KEY, writePlanningSort } from '../lib/planningSort';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const card: Issue = {
  id: 'i1',
  workspace_id: 'ws-1',
  title: '唯一的卡',
  description: '',
  priority: '中',
  labels: [],
  status: '待规划',
  sort_order: 0,
  parent_issue_id: null,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  comment_count: 0,
  created_at: 1,
  updated_at: 1,
};

function renderBoard() {
  server.use(
    http.get('/api/issues', () => HttpResponse.json<Issue[]>([card])),
    http.get('/api/sessions', () => HttpResponse.json([])),
  );
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Board />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
});

describe('循环顺序（纯函数）', () => {
  it('组合 → 截止日期 → 优先级 → A-Z → Z-A → 组合', () => {
    expect(PLANNING_SORT_CYCLE).toEqual(['combo', 'due', 'priority', 'az', 'za']);
    expect(nextPlanningSort('combo')).toBe('due');
    expect(nextPlanningSort('due')).toBe('priority');
    expect(nextPlanningSort('priority')).toBe('az');
    expect(nextPlanningSort('az')).toBe('za');
    expect(nextPlanningSort('za')).toBe('combo');
  });

  it('每个模式都有中文名', () => {
    expect(PLANNING_SORT_CYCLE.map(planningSortLabel)).toEqual(['组合', '截止日期', '优先级', 'A-Z', 'Z-A']);
  });
});

describe('排序图标按钮', () => {
  it('位置：待规划列头、+ 号右侧；是 button 而不是 select', async () => {
    renderBoard();
    const button = await screen.findByTestId('planning-sort');
    expect(button.tagName).toBe('BUTTON');
    expect(screen.queryByRole('combobox', { name: '待规划排序' })).toBeNull();
    // 与 + 号同一个 flex 容器，且排在 + 号之后（DOM 顺序 = 视觉顺序）
    const plus = screen.getByTestId('column-create-待规划');
    expect(button.parentElement).toBe(plus.parentElement);
    expect(plus.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 按钮内没有文字，只有图标
    expect(button.textContent?.trim() ?? '').toBe('');
    expect(within(button).getByTestId('planning-sort-icon-combo')).toBeInTheDocument();
  });

  it('连点 5 次回到初始模式，每步都写 localStorage 并更新 title / aria-label / 图标', async () => {
    renderBoard();
    const button = await screen.findByTestId('planning-sort');
    expect(button).toHaveAttribute('data-sort', 'combo');
    expect(button).toHaveAttribute('title', '排序：组合');
    expect(button).toHaveAttribute('aria-label', '待规划排序：组合（点击切换为截止日期）');

    const expected = ['due', 'priority', 'az', 'za', 'combo'];
    const labels = ['截止日期', '优先级', 'A-Z', 'Z-A', '组合'];
    const nextLabels = ['优先级', 'A-Z', 'Z-A', '组合', '截止日期'];
    for (let i = 0; i < expected.length; i += 1) {
      await userEvent.click(button);
      expect(button).toHaveAttribute('data-sort', expected[i]!);
      expect(window.localStorage.getItem(PLANNING_SORT_KEY)).toBe(expected[i]);
      expect(button).toHaveAttribute('title', `排序：${labels[i]}`);
      expect(button).toHaveAttribute('aria-label', `待规划排序：${labels[i]}（点击切换为${nextLabels[i]}）`);
      expect(within(button).getByTestId(`planning-sort-icon-${expected[i]}`)).toBeInTheDocument();
    }
  });

  it('五个模式图标各不相同（path d 不重复）', async () => {
    renderBoard();
    const button = await screen.findByTestId('planning-sort');
    const paths: string[] = [];
    for (let i = 0; i < PLANNING_SORT_CYCLE.length; i += 1) {
      const svg = button.querySelector('svg path');
      paths.push(svg?.getAttribute('d') ?? '');
      await userEvent.click(button);
    }
    expect(paths.every((d) => d !== '')).toBe(true);
    expect(new Set(paths).size).toBe(PLANNING_SORT_CYCLE.length);
  });

  it('键盘可达：Tab 聚焦、Enter 与 Space 都能触发切换', async () => {
    renderBoard();
    const button = await screen.findByTestId('planning-sort');

    await userEvent.tab();
    // Tab 顺序里按钮可聚焦（+ 号在前，排序按钮紧随其后）
    button.focus();
    expect(button).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(button).toHaveAttribute('data-sort', 'due');

    await userEvent.keyboard(' ');
    expect(button).toHaveAttribute('data-sort', 'priority');
  });

  it('刷新后保持所选模式（localStorage）', async () => {
    writePlanningSort('az');
    renderBoard();
    const button = await screen.findByTestId('planning-sort');
    expect(button).toHaveAttribute('data-sort', 'az');
    expect(within(button).getByTestId('planning-sort-icon-az')).toBeInTheDocument();
  });

  it('按钮里没有 emoji', async () => {
    renderBoard();
    const button = await screen.findByTestId('planning-sort');
    expect(button.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
