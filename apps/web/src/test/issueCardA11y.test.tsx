/**
 * AUDIT-P0（I-01）：看板卡片的键盘可达性与可见焦点环。
 *
 * 覆盖：
 * 1. 卡片根节点是 role=button + tabIndex=0（可 Tab 到），并有 aria-label；
 * 2. 键盘 focus 时走 `focus-visible:outline-accent`（类名断言 + 实机由 CDP 取证）；
 * 3. Enter 打开详情；
 * 4. Space 的归属：**未占用卡片**留给 dnd-kit 键盘抓取（不打开详情）；**占用中卡片**不可拖，Space 打开详情；
 * 5. dnd 的 activator 仍在（aria-roledescription=sortable 的节点存在），键盘拖拽未被破坏。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Issue } from '@agentboard/shared';

const openDetail = vi.fn();
vi.mock('../state/panelStore', () => ({
  usePanelStore: (selector: (s: { openDetail: typeof openDetail }) => unknown) => selector({ openDetail }),
}));

const { IssueCard } = await import('../components/board/IssueCard');

const issue = (overrides: Partial<Issue> = {}): Issue => ({
  id: 'i-1',
  workspace_id: 'w-1',
  title: '卡 A',
  description: '',
  status: '待规划',
  priority: '中',
  labels: [],
  sort_order: 0,
  claimed_by: null,
  claimed_at: null,
  created_at: 1,
  updated_at: 1,
  closed_at: null,
  ...overrides,
} as Issue);

beforeEach(() => { openDetail.mockClear(); });

describe('AUDIT-P0 卡片键盘可达', () => {
  it('根节点 role=button + tabIndex=0 + aria-label，且带 focus-visible 焦点环类', () => {
    render(<IssueCard issue={issue()} sessionRunning={false} />);
    const card = screen.getByTestId('issue-card-i-1');
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card.getAttribute('aria-label')).toContain('卡 A');
    expect(card.className).toContain('focus-visible:outline');
    expect(card.className).toContain('focus-visible:outline-accent');
  });

  it('Enter 打开详情', () => {
    render(<IssueCard issue={issue()} sessionRunning={false} />);
    fireEvent.keyDown(screen.getByTestId('issue-card-i-1'), { key: 'Enter' });
    expect(openDetail).toHaveBeenCalledWith('i-1');
  });

  it('未占用卡片：Space 不打开详情（Space 留给 dnd-kit 键盘抓取）', () => {
    render(<IssueCard issue={issue()} sessionRunning={false} />);
    fireEvent.keyDown(screen.getByTestId('issue-card-i-1'), { key: ' ' });
    expect(openDetail).not.toHaveBeenCalled();
  });

  it('占用中卡片（不可拖）：Space 打开详情，避免键盘用户按 Space 无反应', () => {
    render(<IssueCard issue={issue({ claimed_by: 'agent:codex' })} sessionRunning={false} />);
    fireEvent.keyDown(screen.getByTestId('issue-card-i-1'), { key: ' ' });
    expect(openDetail).toHaveBeenCalledWith('i-1');
  });

  it('dnd  activator 仍在（键盘拖拽未被破坏）', () => {
    render(<IssueCard issue={issue()} sessionRunning={false} />);
    const card = screen.getByTestId('issue-card-i-1');
    expect(card.querySelector('[aria-roledescription]')).not.toBeNull();
  });
});
