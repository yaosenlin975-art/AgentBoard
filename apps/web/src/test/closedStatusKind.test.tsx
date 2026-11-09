/**
 * ARCH-03：前端「关闭类」统一按 status kind 判定。
 *
 * 用自定义 kind=done 的「已完成」覆盖四个渲染点：详情状态 chip、依赖行圆点、
 * 阻塞下游状态 chip、任务树关闭门禁；blocked 不被当作关闭类。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueTreeItem, IssueTreePage, WorkspaceStatus } from '@agentboard/shared';
import { IssueTreeView } from '../components/board/IssueTreeView';
import { BlockedDownstream } from '../components/decisions/BlockedDownstream';
import { DependencySection } from '../components/detail/DependencySection';
import { MetaRow } from '../components/detail/MetaRow';
import type { DependencyRef } from '../lib/dependency';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const WS = 'ws-1';

const STATUSES: WorkspaceStatus[] = [
  { id: 's-open', workspace_id: WS, name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
  { id: 's-started', workspace_id: WS, name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
  { id: 's-review', workspace_id: WS, name: '待验收', kind: 'review', sort_order: 20, is_builtin: 1 },
  { id: 's-done', workspace_id: WS, name: '已完成', kind: 'done', sort_order: 30, is_builtin: 0 },
  { id: 's-blocked', workspace_id: WS, name: '等外部确认', kind: 'blocked', sort_order: 40, is_builtin: 0 },
];

function makeIssue(status: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    workspace_id: WS,
    title: '测试任务',
    description: '',
    priority: '中',
    labels: [],
    status: status as Issue['status'],
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function dep(status: string): DependencyRef {
  return {
    issue_id: 'dep-1',
    title: '依赖卡',
    status: status as Issue['status'],
    resolved: true,
    relation: 'blocks',
    claimed_by: null,
    blocked_reason: null,
    depth: 1,
    via: null,
  };
}

function renderWithQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function treeItem(id: string, overrides: Partial<IssueTreeItem> = {}): IssueTreeItem {
  return { ...makeIssue('待规划', { id, title: id }), child_count: 0, descendant_count: 0, descendants_closed_count: 0, ...overrides };
}

function page(items: IssueTreeItem[]): IssueTreePage {
  return { items, ancestors: [], next_cursor: null };
}

function mockStatuses(): void {
  server.use(http.get(`/api/workspaces/${WS}/statuses`, () => HttpResponse.json(STATUSES)));
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: WS, selectedLabelsByWorkspace: {} });
});

describe('ARCH-03 四处的关闭态渲染（kind=done 的「已完成」）', () => {
  it('详情状态 chip：按关闭态样式渲染', async () => {
    mockStatuses();
    renderWithQuery(
      <MetaRow
        issue={makeIssue('已完成')}
        priority="中"
        dueDate=""
        dueTime=""
        statusBlocked={null}
        onPriorityChange={() => {}}
        onDueChange={() => {}}
      />,
    );

    const chip = await screen.findByTestId('status-chip');
    // 状态字典加载前按名字兜底为非关闭态，加载后 kind=done 必须变成关闭态
    await waitFor(() => expect(chip.className).toContain('text-ink-3'));
    expect(chip.className).not.toContain('text-ink-2');
  });

  it('依赖行圆点：按关闭态颜色渲染', async () => {
    mockStatuses();
    server.use(
      http.get('/api/issues/:id/dependencies', () => HttpResponse.json({ blockers: [dep('已完成')], blocked: [] })),
    );
    renderWithQuery(<DependencySection issue={makeIssue('待规划')} />);

    await userEvent.click(await screen.findByTestId('dep-summary'));
    const dot = await screen.findByTestId('dep-blocker-dep-1-dot');
    await waitFor(() => expect(dot.className).toContain('bg-ink-3'));
  });

  it('阻塞下游状态 chip：按关闭态样式渲染', async () => {
    mockStatuses();
    server.use(
      http.get('/api/issues/:id/dependencies', () => HttpResponse.json({ blockers: [], blocked: [dep('已完成')] })),
    );
    renderWithQuery(
      <BlockedDownstream issueId="iss-1" workspaceId={WS} count={1} onOpenIssue={() => {}} />,
    );

    await userEvent.click(screen.getByTestId('decision-blocks-iss-1'));
    const row = await screen.findByTestId('blocked-downstream-row-dep-1');
    const chip = within(row).getByText('已完成');
    await waitFor(() => expect(chip.className).toContain('text-ink-3'));
  });

  it('任务树关闭门禁：关闭类卡不再显示未关闭告警，且已完成选项参与门禁', async () => {
    mockStatuses();
    const doneParent = treeItem('done-parent', {
      title: '已完成父任务',
      status: '已完成' as IssueTreeItem['status'],
      child_count: 1,
      descendant_count: 2,
      descendants_closed_count: 0,
    });
    const openParent = treeItem('open-parent', {
      title: '普通父任务',
      child_count: 1,
      descendant_count: 1,
      descendants_closed_count: 0,
    });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([doneParent, openParent]))));

    renderWithQuery(<IssueTreeView workspaceId={WS} issues={[doneParent, openParent]} query="" />);

    const progress = await screen.findByText(/后代进度：0\/2 已关闭/);
    await waitFor(() => expect(progress.className).not.toContain('text-amber-700'));

    // 未关闭的父卡上，kind=done 的「已完成」仍受关闭门禁禁用
    const select = screen.getByLabelText('状态：普通父任务') as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: '已完成' })).toBeDisabled();
  });
});
