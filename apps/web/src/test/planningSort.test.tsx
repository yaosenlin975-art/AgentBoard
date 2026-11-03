/**
 * SORT-PLAN：待规划列五种排序（design §5）。
 * 权重表逐值断言（≥8 组）、逾期压过高优先级无截止、同分按创建时间升序、本地存储保持、只作用于待规划列。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Priority } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import {
  PLANNING_SORT_KEY,
  PRIORITY_SCORE,
  URGENCY_SCORE,
  comboScore,
  dueTimestamp,
  isOverdue,
  readPlanningSort,
  sortPlanning,
  urgencyScore,
  writePlanningSort,
} from '../lib/planningSort';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const DAY = 24 * 60 * 60 * 1000;
/** 固定时间基准：2026-11-03 12:00（本地时区），让「今天/几天后/逾期」可复现 */
const NOW = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();

const pad = (value: number): string => String(value).padStart(2, '0');

/** now + days 天的本地日期字符串（YYYY-MM-DD） */
function dayOffset(days: number, base = NOW): string {
  const date = new Date(base + days * DAY);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

let seq = 0;
function issue(overrides: Partial<Issue> & { title: string }): Issue {
  seq += 1;
  return {
    id: `i-${overrides.title}`,
    workspace_id: 'ws-1',
    description: '',
    priority: '中' as Priority,
    labels: [],
    status: '待规划',
    sort_order: seq * 1000,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1000 + seq,
    updated_at: 1000 + seq,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
});

describe('权重表（逐值断言）', () => {
  const cases: Array<{ label: string; issue: Issue; priority: number; urgency: number }> = [
    { label: '高 + 无截止', issue: issue({ title: 'c1', priority: '高' }), priority: PRIORITY_SCORE.高, urgency: URGENCY_SCORE.none },
    { label: '中 + 无截止', issue: issue({ title: 'c2', priority: '中' }), priority: PRIORITY_SCORE.中, urgency: URGENCY_SCORE.none },
    { label: '低 + 无截止', issue: issue({ title: 'c3', priority: '低' }), priority: PRIORITY_SCORE.低, urgency: URGENCY_SCORE.none },
    { label: '低 + 逾期', issue: issue({ title: 'c4', priority: '低', due_date: dayOffset(-5) }), priority: PRIORITY_SCORE.低, urgency: URGENCY_SCORE.overdue },
    { label: '高 + 2 天后', issue: issue({ title: 'c5', priority: '高', due_date: dayOffset(2) }), priority: PRIORITY_SCORE.高, urgency: URGENCY_SCORE.within3Days },
    { label: '中 + 5 天后', issue: issue({ title: 'c6', priority: '中', due_date: dayOffset(5) }), priority: PRIORITY_SCORE.中, urgency: URGENCY_SCORE.within7Days },
    { label: '低 + 10 天后', issue: issue({ title: 'c7', priority: '低', due_date: dayOffset(10) }), priority: PRIORITY_SCORE.低, urgency: URGENCY_SCORE.later },
    { label: '高 + 逾期', issue: issue({ title: 'c8', priority: '高', due_date: dayOffset(-3) }), priority: PRIORITY_SCORE.高, urgency: URGENCY_SCORE.overdue },
    { label: '中 + 今天（无时间）', issue: issue({ title: 'c9', priority: '中', due_date: dayOffset(0) }), priority: PRIORITY_SCORE.中, urgency: URGENCY_SCORE.within3Days },
    { label: '低 + 3 天后', issue: issue({ title: 'c10', priority: '低', due_date: dayOffset(3) }), priority: PRIORITY_SCORE.低, urgency: URGENCY_SCORE.within3Days },
  ];

  it.each(cases)('$label：优先级 $priority + 紧迫度 $urgency = score', ({ issue: target, priority, urgency }) => {
    expect(PRIORITY_SCORE[target.priority]).toBe(priority);
    expect(urgencyScore(target, NOW)).toBe(urgency);
    expect(comboScore(target, NOW)).toBe(priority + urgency);
  });

  it('保持权重常量本身正确（高30/中20/低10；逾期50/≤3天30/≤7天15/>7天5/无截止0）', () => {
    expect(PRIORITY_SCORE).toEqual({ 高: 30, 中: 20, 低: 10 });
    expect(URGENCY_SCORE).toEqual({ overdue: 50, within3Days: 30, within7Days: 15, later: 5, none: 0 });
  });

  it('due_date 缺失或非法（字段尚未上线）一律按无截止处理，不抛错', () => {
    const missing = issue({ title: 'no-due' });
    expect(missing.due_date ?? null).toBeNull();
    expect(dueTimestamp(missing)).toBeNull();
    expect(urgencyScore(missing, NOW)).toBe(0);
    expect(isOverdue(missing, NOW)).toBe(false);

    const broken = issue({ title: 'bad-due', due_date: 'not-a-date' });
    expect(dueTimestamp(broken)).toBeNull();
    expect(urgencyScore(broken, NOW)).toBe(0);
  });
});

describe('组合排序（combo）', () => {
  it('逾期压过高优先级无截止（设计意图）', () => {
    const overdueLow = issue({ title: '低优先级但逾期', priority: '低', due_date: dayOffset(-5), created_at: 9000 });
    const highNoDue = issue({ title: '高优先级无截止', priority: '高', created_at: 1 });
    expect(comboScore(overdueLow, NOW)).toBe(60);
    expect(comboScore(highNoDue, NOW)).toBe(30);
    expect(sortPlanning([highNoDue, overdueLow], 'combo', NOW).map((i) => i.title)).toEqual([
      '低优先级但逾期',
      '高优先级无截止',
    ]);
  });

  it('同分按 created_at 升序（老的在前，防止饿死）', () => {
    const older = issue({ title: '老卡', priority: '高', created_at: 100 });
    const newer = issue({ title: '新卡', priority: '高', created_at: 900 });
    expect(comboScore(older, NOW)).toBe(comboScore(newer, NOW));
    expect(sortPlanning([newer, older], 'combo', NOW).map((i) => i.title)).toEqual(['老卡', '新卡']);
  });

  it('多卡顺序与 score 降序一致', () => {
    const cards = [
      issue({ title: 'A', priority: '低', due_date: dayOffset(10) }), // 10+5=15
      issue({ title: 'B', priority: '高' }), // 30
      issue({ title: 'C', priority: '中', due_date: dayOffset(2) }), // 20+30=50
      issue({ title: 'D', priority: '低', due_date: dayOffset(-5) }), // 10+50=60
      issue({ title: 'E', priority: '中', due_date: dayOffset(5) }), // 20+15=35
    ];
    expect(sortPlanning(cards, 'combo', NOW).map((i) => i.title)).toEqual(['D', 'C', 'E', 'B', 'A']);
  });
});

describe('A-Z / Z-A / 截止日期 / 优先级', () => {
  it('A-Z 与 Z-A：中文按 localeCompare("zh")，不分大小写', () => {
    const cards = [
      issue({ title: 'beta' }),
      issue({ title: 'Alpha' }),
      issue({ title: '王' }),
      issue({ title: '张' }),
    ];
    const names = ['beta', 'Alpha', '王', '张'];
    const zhAsc = [...names].sort((left, right) => left.localeCompare(right, 'zh', { sensitivity: 'base' }));
    const asc = sortPlanning(cards, 'az', NOW).map((i) => i.title);
    // 与 ICU 的 zh 规则一致（不假定中英文族的相对先后）
    expect(asc).toEqual(zhAsc);
    // 拉丁内部不分大小写、中文内部按拼音
    expect(asc.indexOf('Alpha')).toBeLessThan(asc.indexOf('beta'));
    expect(asc.indexOf('王')).toBeLessThan(asc.indexOf('张'));
    expect(sortPlanning(cards, 'za', NOW).map((i) => i.title)).toEqual([...zhAsc].reverse());
  });

  it('截止日期：近→远，无截止排最后', () => {
    const cards = [
      issue({ title: 'far', due_date: dayOffset(30) }),
      issue({ title: 'none' }),
      issue({ title: 'near', due_date: dayOffset(1) }),
      issue({ title: 'mid', due_date: dayOffset(7) }),
    ];
    expect(sortPlanning(cards, 'due', NOW).map((i) => i.title)).toEqual(['near', 'mid', 'far', 'none']);
  });

  it('优先级：高→中→低，同优先级按创建时间升序', () => {
    const cards = [
      issue({ title: 'low', priority: '低' }),
      issue({ title: 'mid-new', priority: '中', created_at: 800 }),
      issue({ title: 'high', priority: '高' }),
      issue({ title: 'mid-old', priority: '中', created_at: 200 }),
    ];
    expect(sortPlanning(cards, 'priority', NOW).map((i) => i.title)).toEqual(['high', 'mid-old', 'mid-new', 'low']);
  });
});

describe('本地存储', () => {
  it('写入后读回；非法值回落组合', () => {
    expect(readPlanningSort()).toBe('combo');
    writePlanningSort('az');
    expect(window.localStorage.getItem(PLANNING_SORT_KEY)).toBe('az');
    expect(readPlanningSort()).toBe('az');
    window.localStorage.setItem(PLANNING_SORT_KEY, 'not-a-sort');
    expect(readPlanningSort()).toBe('combo');
  });
});

describe('看板接线', () => {
  function renderBoard(issues: Issue[]) {
    server.use(
      http.get('/api/issues', () => HttpResponse.json(issues)),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <Board layout="board" />
      </QueryClientProvider>,
    );
  }

  function cardOrder(status: string): string[] {
    const column = screen.getByTestId(`column-${status}`);
    return [...column.querySelectorAll('[data-testid^="issue-card-"]')].map((n) => n.getAttribute('data-testid') ?? '');
  }

  const cards = [
    issue({ title: 'Bravo', priority: '低', sort_order: 1000, created_at: 1 }),
    issue({ title: 'alpha', priority: '高', sort_order: 2000, created_at: 2 }),
    issue({ title: '进行中任务', priority: '中', sort_order: 1000, status: '进行中', created_at: 3 }),
  ];

  it('排序控件只在待规划列（+ 号右侧），默认组合；点击切换后写本地存储', async () => {
    renderBoard(cards);
    await screen.findByTestId('planning-sort');
    expect(await screen.findByTestId('issue-card-i-alpha')).toBeInTheDocument();

    // SORT-ICON：控件在待规划列头，紧跟 + 号右侧，其它列没有
    const pendingColumn = screen.getByTestId('column-待规划');
    const sortButton = within(pendingColumn).getByTestId('planning-sort');
    expect(sortButton).toHaveAttribute('data-sort', 'combo');
    expect(sortButton.parentElement).toBe(screen.getByTestId('column-create-待规划').parentElement);
    expect(within(screen.getByTestId('column-进行中')).queryByTestId('planning-sort')).toBeNull();

    // 默认组合：高优先级 alpha 在前
    expect(cardOrder('待规划')).toEqual(['issue-card-i-alpha', 'issue-card-i-Bravo']);

    // 组合 → 截止日期 → 优先级：点两次
    await userEvent.click(sortButton);
    expect(window.localStorage.getItem(PLANNING_SORT_KEY)).toBe('due');
    await userEvent.click(sortButton);
    expect(window.localStorage.getItem(PLANNING_SORT_KEY)).toBe('priority');
    expect(sortButton).toHaveAttribute('data-sort', 'priority');
    await waitFor(() => expect(cardOrder('待规划')).toEqual(['issue-card-i-alpha', 'issue-card-i-Bravo']));
    // 其它列不受影响
    expect(cardOrder('进行中')).toHaveLength(1);
  });

  it('刷新后保持上次选择（localStorage）', async () => {
    writePlanningSort('za');
    renderBoard(cards);
    expect(await screen.findByTestId('planning-sort')).toHaveAttribute('data-sort', 'za');
    await screen.findByTestId('issue-card-i-Bravo');
    // Z-A：Bravo 在 alpha 之前
    expect(cardOrder('待规划')).toEqual(['issue-card-i-Bravo', 'issue-card-i-alpha']);
  });
});
