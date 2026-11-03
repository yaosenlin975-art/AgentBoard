/**
 * DUE-DATE：截止日期/时间的展示与逾期判定（前端）。
 * - `formatDueShort`：卡片「截止 11-10」/「截止 11-10 14:30」
 * - `isOverdue` / `overdueDays`：含「当天时间已过」的口径
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import { IssueCard } from '../components/board/IssueCard';
import { dueTimestamp, formatDueShort, isOverdue, overdueDays } from '../lib/planningSort';

const DAY = 24 * 60 * 60 * 1000;

const issue = (extra: Partial<Issue> = {}): Issue => ({
  id: 'i1',
  workspace_id: 'A',
  title: '截止任务',
  description: '',
  status: '待规划',
  priority: '中',
  labels: [],
  sort_order: 0,
  parent_issue_id: null,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  created_at: 1,
  updated_at: 1,
  comment_count: 0,
  ...extra,
});

describe('formatDueShort（卡片短格式）', () => {
  it('无截止 → null；只有日期 → 11-10；带时间 → 11-10 14:30', () => {
    expect(formatDueShort(issue())).toBe(null);
    expect(formatDueShort(issue({ due_date: null, due_time: null }))).toBe(null);
    expect(formatDueShort(issue({ due_date: '2026-11-10' }))).toBe('11-10');
    expect(formatDueShort(issue({ due_date: '2026-11-10', due_time: '14:30' }))).toBe('11-10 14:30');
  });
});

describe('逾期判定（含当天时间已过）', () => {
  const now = new Date(2026, 10, 10, 15, 0, 0).getTime(); // 2026-11-10 15:00 本地
  it('有时间的当天：时间已过算逾期，未到不算', () => {
    expect(isOverdue({ due_date: '2026-11-10', due_time: '14:30' }, now)).toBe(true);
    expect(isOverdue({ due_date: '2026-11-10', due_time: '15:30' }, now)).toBe(false);
  });

  it('无时间的当天不算逾期（当天 24:00 前都有效）', () => {
    expect(isOverdue({ due_date: '2026-11-10' }, now)).toBe(false);
    expect(isOverdue({ due_date: '2026-11-09' }, now)).toBe(true);
  });

  it('overdueDays：未逾期 0，逾期至少 1，跨天按天数', () => {
    expect(overdueDays({ due_date: '2026-11-10', due_time: '15:30' }, now)).toBe(0);
    expect(overdueDays({ due_date: '2026-11-10', due_time: '14:30' }, now)).toBe(1);
    expect(overdueDays({ due_date: '2026-11-08' }, now)).toBe(2);
    expect(overdueDays({ due_date: null }, now)).toBe(0);
  });

  it('dueTimestamp：无日期 null，有日期按本地时区合成', () => {
    expect(dueTimestamp(issue())).toBe(null);
    expect(dueTimestamp(issue({ due_date: '2026-11-10' }))).toBe(new Date(2026, 10, 10, 0, 0, 0).getTime());
    expect(dueTimestamp(issue({ due_date: '2026-11-10', due_time: '14:30' }))).toBe(new Date(2026, 10, 10, 14, 30).getTime());
  });
});

describe('卡片徽标', () => {
  it('有截止显示「截止 11-10」；逾期显示「逾期 N 天」并带警示态', () => {
    const far = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const { unmount } = render(<IssueCard issue={issue({ id: 'far', due_date: far })} sessionRunning={false} />);
    const badge = screen.getByTestId('due-badge-far');
    expect(badge).toHaveTextContent('截止');
    expect(badge.getAttribute('data-overdue')).toBe('false');
    unmount();

    const past = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
    render(<IssueCard issue={issue({ id: 'past', due_date: past })} sessionRunning={false} />);
    const overdueBadge = screen.getByTestId('due-badge-past');
    expect(overdueBadge).toHaveTextContent('逾期 5 天');
    expect(overdueBadge.getAttribute('data-overdue')).toBe('true');
    expect(overdueBadge.className).toContain('text-red-');
  });

  it('无截止不渲染徽标', () => {
    render(<IssueCard issue={issue({ id: 'none' })} sessionRunning={false} />);
    expect(screen.queryByTestId('due-badge-none')).toBeNull();
  });
});
