/**
 * SYS2：状态字典单源 —— 树筛选含「已废弃」、行内状态只出现一次、工作区统计加总 = 任务总数且不溢出。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueTreeItem, IssueTreePage, Workspace, WorkspaceStatus } from '@agentboard/shared';
import { IssueTreeView } from '../components/board/IssueTreeView';
import { WorkspaceList } from '../components/workspace/WorkspaceList';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const STATUSES: WorkspaceStatus[] = [
  { id: 's-open', workspace_id: 'ws-1', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
  { id: 's-started', workspace_id: 'ws-1', name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
  { id: 's-review', workspace_id: 'ws-1', name: '待验收', kind: 'review', sort_order: 20, is_builtin: 1 },
  { id: 's-done', workspace_id: 'ws-1', name: '已关闭', kind: 'done', sort_order: 30, is_builtin: 1 },
  { id: 's-deprecated', workspace_id: 'ws-1', name: '已废弃', kind: 'deprecated', sort_order: 40, is_builtin: 1 },
];

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: id,
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
    updated_at: 10,
    ...overrides,
  };
}

function treeItem(id: string, overrides: Partial<IssueTreeItem> = {}): IssueTreeItem {
  return { ...makeIssue(id), child_count: 0, descendant_count: 0, descendants_closed_count: 0, ...overrides };
}

function page(items: IssueTreeItem[]): IssueTreePage {
  return { items, ancestors: [], next_cursor: null };
}

function renderTree(issues: Issue[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IssueTreeView workspaceId="ws-1" issues={issues} query="" />
    </QueryClientProvider>,
  );
}

const workspace: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/demo', created_at: 1 };

function renderWorkspaceList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
  server.use(http.get('/api/workspaces/ws-1/statuses', () => HttpResponse.json(STATUSES)));
});

describe('状态字典单源（SYS2）', () => {
  it('树的状态筛选包含全部 5 个状态，且「已废弃」卡可筛出', async () => {
    const active = treeItem('active', { title: '普通卡', status: '待规划' });
    const deprecated = treeItem('deprecated', { title: '废弃卡', status: '已废弃' as unknown as Issue['status'] });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([active, deprecated]))));
    renderTree([active, deprecated]);

    const select = await screen.findByLabelText('按状态筛选');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      '全部状态', '待规划', '进行中', '待验收', '已关闭', '已废弃',
    ]);

    await userEvent.selectOptions(select, '已废弃');
    expect(await screen.findByTestId('tree-node-deprecated')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-node-active')).not.toBeInTheDocument();
  });

  it('行内状态与徽标合并：同一行「已关闭」不再重复出现', async () => {
    const done = treeItem('done', { title: '已关闭卡', status: '已关闭' });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([done]))));
    renderTree([done]);

    const node = await screen.findByTestId('tree-node-done');
    const selects = node.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    expect((selects[0] as HTMLSelectElement).value).toBe('已关闭');
    // 徽标 span 已移除：除 select/option 外不应再有单独的「已关闭」文本节点容器
    const badgeSpans = [...node.querySelectorAll('span')].filter((span) => span.textContent === '已关闭');
    expect(badgeSpans).toHaveLength(0);
  });

  it('工作区统计格读字典：含已废弃、加总等于任务总数且超过 4 格换行不溢出', async () => {
    const issues: Issue[] = [
      makeIssue('i1', { status: '待规划' }),
      makeIssue('i2', { status: '待规划' }),
      makeIssue('i3', { status: '进行中' }),
      makeIssue('i4', { status: '待验收' }),
      makeIssue('i5', { status: '已关闭' }),
      makeIssue('i6', { status: '已废弃' as unknown as Issue['status'] }),
    ];
    const counts: Record<string, number> = {};
    for (const issue of issues) counts[issue.status] = (counts[issue.status] ?? 0) + 1;
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([workspace])),
      // PERF-4b：统计格优先用 counts 聚合（含字典外状态，由卡片归「其他」）
      http.get('/api/issues/counts', () =>
        HttpResponse.json({ items: [{ workspace_id: 'ws-1', total: issues.length, counts }] }),
      ),
      http.get('/api/issues', () => HttpResponse.json(issues)),
    );
    renderWorkspaceList();

    const card = await screen.findByTestId('workspace-card-ws-1');
    await waitFor(() => expect(within(card).getByTestId('stat-已废弃').firstElementChild).toHaveTextContent('1'));

    const cells = [...card.querySelectorAll('[data-testid^="stat-"]')];
    expect(cells).toHaveLength(5);
    const total = cells.reduce((sum, cell) => sum + Number(cell.firstElementChild?.textContent ?? 0), 0);
    expect(total).toBe(issues.length);

    // 5 格超过 4 → 换行（3 列），不横向溢出
    const grid = cells[0]!.parentElement!;
    expect(grid.className).toContain('grid-cols-3');
  });
});
