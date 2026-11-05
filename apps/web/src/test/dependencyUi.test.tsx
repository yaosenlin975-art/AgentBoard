/**
 * DEP-3 测试：依赖角标（卡片）、详情「依赖」区（增删 + 409 ISSUE_CLAIMED）、
 * 树视图锁标与子树未解除总数、claim（派发）入口的 blocker 清单拦截。
 * 依赖状态一律取服务端字段（blocked_by_count / blocked_by_open_count / resolved），前端不推断。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueTreeItem, IssueTreePage, Workspace } from '@agentboard/shared';
import { IssueCardPreview } from '../components/board/IssueCard';
import { IssueTreeView } from '../components/board/IssueTreeView';
import { DependencySection } from '../components/detail/DependencySection';
import { DetailPanel } from '../components/detail/DetailPanel';
import { dependencyBadge, countSubtreeOpenBlockers, type DependencyRef } from '../lib/dependency';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: `任务${id}`,
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
    ...overrides,
  };
}

function treeItem(id: string, overrides: Partial<IssueTreeItem> = {}): IssueTreeItem {
  return { ...makeIssue(id), child_count: 0, descendant_count: 0, descendants_closed_count: 0, ...overrides };
}

function treePage(items: IssueTreeItem[], next_cursor: string | null = null): IssueTreePage {
  return { items, ancestors: [], next_cursor };
}

function withClient(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, rightOpen: false });
  server.use(http.get('/api/workspaces', () => HttpResponse.json([ws])));
});

describe('dependencyBadge（角标口径，只用服务端字段）', () => {
  it('未解除数 > 0 → 等 N 项；有前置且 resolved=true → 依赖已清；无前置 → 不显示', () => {
    expect(dependencyBadge(makeIssue('a', { blocked_by_count: 2, blocked_by_open_count: 2, resolved: false })))
      .toEqual({ kind: 'blocked', open: 2 });
    // 混合：1 项已解除、1 项未解除
    expect(dependencyBadge(makeIssue('b', { blocked_by_count: 2, blocked_by_open_count: 1, resolved: false })))
      .toEqual({ kind: 'blocked', open: 1 });
    expect(dependencyBadge(makeIssue('c', { blocked_by_count: 2, blocked_by_open_count: 0, resolved: true })))
      .toEqual({ kind: 'cleared', total: 2 });
    expect(dependencyBadge(makeIssue('d', { blocked_by_count: 0, blocked_by_open_count: 0, resolved: true })))
      .toBeNull();
  });

  it('worktree 里没有依赖字段（服务端未投影）时按无依赖处理', () => {
    expect(dependencyBadge(makeIssue('e'))).toBeNull();
  });
});

describe('卡片依赖角标', () => {
  it('未解除 2 项显示「等 2 项」，全部解除显示淡色「依赖已清」', () => {
    const blocked = makeIssue('blk', { blocked_by_count: 2, blocked_by_open_count: 2, resolved: false });
    const cleared = makeIssue('clr', { blocked_by_count: 1, blocked_by_open_count: 0, resolved: true });
    const none = makeIssue('none');
    render(
      <>
        <IssueCardPreview issue={blocked} sessionRunning={false} />
        <IssueCardPreview issue={cleared} sessionRunning={false} />
        <IssueCardPreview issue={none} sessionRunning={false} />
      </>,
    );
    expect(screen.getByTestId('dependency-badge-blk')).toHaveTextContent('等 2 项');
    expect(screen.queryByTestId('dependency-cleared-blk')).not.toBeInTheDocument();
    expect(screen.getByTestId('dependency-cleared-clr')).toHaveTextContent('依赖已清');
    expect(screen.queryByTestId('dependency-badge-clr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dependency-badge-none')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dependency-cleared-none')).not.toBeInTheDocument();
  });
});

describe('树视图依赖锁标', () => {
  it('被阻塞卡标题前有锁标，父卡显示子树未解除依赖总数', async () => {
    const parent = treeItem('p', { title: '父卡', child_count: 2, descendant_count: 2, descendants_closed_count: 0 });
    // 工作区全量列表（锁标与子树汇总都从这里取服务端投影字段）
    const issues: Issue[] = [
      makeIssue('p', { title: '父卡' }),
      makeIssue('child-blocked', { title: '子卡被阻塞', parent_issue_id: 'p', blocked_by_count: 2, blocked_by_open_count: 2, resolved: false }),
      makeIssue('child-clear', { title: '子卡无依赖', parent_issue_id: 'p' }),
    ];
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parentId = new URL(request.url).searchParams.get('parent_issue_id');
        if (parentId === 'p') {
          return HttpResponse.json(treePage([
            treeItem('child-blocked', {
              title: '子卡被阻塞', parent_issue_id: 'p',
              blocked_by_count: 2, blocked_by_open_count: 2, resolved: false,
            }),
            treeItem('child-clear', { title: '子卡无依赖', parent_issue_id: 'p' }),
          ]));
        }
        return HttpResponse.json(treePage([parent]));
      }),
      http.get('/api/issues', () => HttpResponse.json(issues)),
    );
    render(withClient(<IssueTreeView workspaceId="ws-1" issues={issues} query="" />));

    expect(await screen.findByTestId('tree-node-p')).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-node-p')).getByTestId('tree-subtree-deps-p')).toHaveTextContent('子树待解除依赖 2 项');
    expect(within(screen.getByTestId('tree-node-p')).queryByTestId('tree-lock-p')).not.toBeInTheDocument();

    // 展开子卡：被阻塞的那张有锁标
    await userEvent.click(screen.getByRole('button', { name: '展开子任务：父卡' }));
    expect(await screen.findByTestId('tree-node-child-blocked')).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-node-child-blocked')).getByTestId('tree-lock-child-blocked')).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-node-child-clear')).queryByTestId('tree-lock-child-clear')).not.toBeInTheDocument();
  });

  it('countSubtreeOpenBlockers 只累加子树的未解除数（不含自身）', () => {
    const issues: Issue[] = [
      makeIssue('root', { blocked_by_open_count: 5 }),
      makeIssue('c1', { parent_issue_id: 'root', blocked_by_open_count: 2 }),
      makeIssue('c2', { parent_issue_id: 'c1', blocked_by_open_count: 1 }),
    ];
    expect(countSubtreeOpenBlockers(issues, 'root')).toBe(3);
    expect(countSubtreeOpenBlockers(issues, 'c2')).toBe(0);
  });
});

describe('详情「依赖」区', () => {
  const base = makeIssue('iss-1', { title: '主任务' });
  const blocker = { issue_id: 'blk-1', title: '前置任务一', status: '进行中' as const, resolved: false };
  const doneBlocker = { issue_id: 'blk-2', title: '前置任务二', status: '待验收' as const, resolved: true };

  it('默认收起；点开摘要后列出 blockers（标题/状态/解除标记）与被阻塞者', async () => {
    server.use(
      http.get('/api/issues/iss-1/dependencies', () =>
        HttpResponse.json({
          blockers: [blocker, doneBlocker],
          blocked: [{ issue_id: 'down-1', title: '后续任务', status: '待规划' as const, resolved: false }],
        }),
      ),
      http.get('/api/issues', () => HttpResponse.json([base, makeIssue('cand-1', { title: '候选任务' })])),
    );
    render(withClient(<DependencySection issue={base} />));

    const summary = await screen.findByTestId('dep-summary');
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');

    const row = await screen.findByTestId('dep-blocker-blk-1');
    expect(row).toHaveTextContent('前置任务一');
    expect(row).toHaveTextContent('进行中');
    expect(screen.getByTestId('dep-blocker-blk-1-resolved')).toHaveTextContent('未解除');
    expect(screen.getByTestId('dep-blocker-blk-2-resolved')).toHaveTextContent('已解除');
    expect(screen.getByTestId('dep-blocked-down-1')).toHaveTextContent('后续任务');
  });

  it('默认收起：摘要行显示前置/未解除/阻塞与「暂不可领取」；展开/收起同步 aria-expanded', async () => {
    server.use(
      http.get('/api/issues/iss-1/dependencies', () =>
        HttpResponse.json({
          blockers: [blocker, doneBlocker],
          blocked: [{ issue_id: 'down-1', title: '后续任务', status: '待规划' as const, resolved: false }],
        }),
      ),
      http.get('/api/issues', () => HttpResponse.json([base])),
    );
    render(withClient(<DependencySection issue={base} />));

    const summary = await screen.findByTestId('dep-summary');
    await waitFor(() => expect(summary).toHaveTextContent('前置 2 · 1 项未解除 · 阻塞 1'));
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('dep-summary-badge')).toHaveTextContent('暂不可领取');
    expect(screen.getByTestId('dep-body').className).toContain('grid-rows-[0fr]');

    await userEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('dep-body').className).toContain('grid-rows-[1fr]');
    expect(screen.getByTestId('dep-blockers-group')).toBeInTheDocument();

    await userEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('dep-body').className).toContain('grid-rows-[0fr]');
  });

  it('BORROW-2.2：关联与重复合并为「关联·重复」（前置→阻塞→关联·重复），空组不渲染空状态', async () => {
    server.use(
      http.get('/api/issues/iss-1/dependencies', () =>
        HttpResponse.json({
          blockers: [blocker],
          blocked: [],
          related: [{ issue_id: 'rel-1', title: '关联任务', status: '进行中' as const, resolved: false, relation: 'related' }],
          duplicate: [{ issue_id: 'dup-1', title: '重复任务', status: '待规划' as const, resolved: false, relation: 'duplicate' }],
        }),
      ),
      http.get('/api/issues', () => HttpResponse.json([base])),
    );
    render(withClient(<DependencySection issue={base} />));

    await userEvent.click(await screen.findByTestId('dep-summary'));
    expect(await screen.findByTestId('dep-related-rel-1')).toHaveTextContent('关联任务');
    expect(screen.getByTestId('dep-duplicate-dup-1')).toHaveTextContent('重复任务');
    // 分组顺序：前置组 → 关联·重复组；组内 related 行 → duplicate 行
    const blockersGroup = screen.getByTestId('dep-blockers-group');
    const relationsGroup = screen.getByTestId('dep-relations-group');
    expect(blockersGroup.compareDocumentPosition(relationsGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const relatedRow = screen.getByTestId('dep-related-rel-1');
    const dupRow = screen.getByTestId('dep-duplicate-dup-1');
    expect(relatedRow.compareDocumentPosition(dupRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 空组不渲染整块空状态
    expect(screen.queryByTestId('dep-blocked-group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dep-related-empty')).not.toBeInTheDocument();
  });

  it('添加前置：提交 workspace_id + blocker_issue_id，成功后刷新列表', async () => {
    const posts: unknown[] = [];
    let blockers: DependencyRef[] = [];
    server.use(
      http.get('/api/issues/iss-1/dependencies', () => HttpResponse.json({ blockers, blocked: [] })),
      http.post('/api/issues/iss-1/dependencies', async ({ request }) => {
        const body = (await request.json()) as { workspace_id: string; blocker_issue_id: string };
        posts.push(body);
        blockers = [{ issue_id: body.blocker_issue_id, title: '候选任务', status: '待规划', resolved: false }];
        return HttpResponse.json({ blockers, blocked: [] }, { status: 201 });
      }),
      http.get('/api/issues', () => HttpResponse.json([base, makeIssue('cand-1', { title: '候选任务' })])),
    );
    render(withClient(<DependencySection issue={base} />));

    // D3：添加入口在展开区里；空组不渲染空状态
    const summary = await screen.findByTestId('dep-summary');
    await waitFor(() => expect(summary).toHaveTextContent('前置 0 · 0 项未解除 · 阻塞 0'));
    await userEvent.click(summary);
    expect(screen.queryByTestId('dep-blockers-group')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dep-candidate')).toHaveValue('cand-1'));
    await userEvent.click(screen.getByTestId('dep-add'));

    await waitFor(() => expect(posts).toEqual([{ workspace_id: 'ws-1', blocker_issue_id: 'cand-1' }]));
    expect(await screen.findByTestId('dep-blocker-cand-1')).toHaveTextContent('候选任务');
  });

  it('移除前置：DELETE 带 workspace_id，成功后条目消失', async () => {
    const deletes: string[] = [];
    let blockers: DependencyRef[] = [blocker];
    server.use(
      http.get('/api/issues/iss-1/dependencies', () => HttpResponse.json({ blockers, blocked: [] })),
      http.delete('/api/issues/iss-1/dependencies/blk-1', ({ request }) => {
        deletes.push(new URL(request.url).searchParams.get('workspace_id') ?? '');
        blockers = [];
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('/api/issues', () => HttpResponse.json([base])),
    );
    render(withClient(<DependencySection issue={base} />));

    await userEvent.click(await screen.findByTestId('dep-summary'));
    await userEvent.click(await screen.findByTestId('dep-remove-blk-1'));
    await waitFor(() => expect(deletes).toEqual(['ws-1']));
    await waitFor(() => expect(screen.queryByTestId('dep-blocker-blk-1')).not.toBeInTheDocument());
  });

  it('已占用卡添加前置：展示服务端 409 ISSUE_CLAIMED 的中文原因', async () => {
    server.use(
      http.get('/api/issues/iss-1/dependencies', () => HttpResponse.json({ blockers: [], blocked: [] })),
      http.post('/api/issues/iss-1/dependencies', () =>
        HttpResponse.json(
          { error: { code: 'ISSUE_CLAIMED', message: '任务已被占用，请先 release 再新增前置' } },
          { status: 409 },
        ),
      ),
      http.get('/api/issues', () => HttpResponse.json([base, makeIssue('cand-1', { title: '候选任务' })])),
    );
    render(withClient(<DependencySection issue={makeIssue('iss-1', { claimed_by: 'agent:codex', claimed_at: 5 })} />));

    await userEvent.click(await screen.findByTestId('dep-summary'));
    await waitFor(() => expect(screen.getByTestId('dep-candidate')).toHaveValue('cand-1'));
    await userEvent.click(screen.getByTestId('dep-add'));
    expect(await screen.findByTestId('dep-error')).toHaveTextContent('任务已被占用，请先 release 再新增前置');
  });
});

describe('claim（派发）入口前置拦截', () => {
  function mockDetail(issue: Issue): void {
    server.use(
      http.get('/api/issues/iss-1', () => HttpResponse.json(issue)),
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json([])),
      http.get('/api/issues/iss-1/pending-attachments', () => HttpResponse.json({ items: [], next_offset: null })),
      http.get('/api/issues/iss-1/dependencies', () =>
        HttpResponse.json({
          blockers: [
            { issue_id: 'blk-1', title: '前置任务一', status: '进行中', resolved: false },
            { issue_id: 'blk-2', title: '前置任务二', status: '待验收', resolved: true },
          ],
          blocked: [],
        }),
      ),
      http.get('/api/issues', () => HttpResponse.json([issue])),
    );
  }

  it('有未解除前置时点派发：不打开派发弹窗，列出未解除的 blocker 清单', async () => {
    mockDetail(makeIssue('iss-1', { blocked_by_count: 2, blocked_by_open_count: 1, resolved: false }));
    usePanelStore.setState({ view: 'detail', issueId: 'iss-1', sessionId: null, rightOpen: true });
    render(withClient(<DetailPanel />));

    const dispatch = await screen.findByTestId('dispatch-btn');
    await userEvent.click(dispatch);

    const panel = await screen.findByTestId('claim-blocked-panel');
    expect(panel).toHaveTextContent('存在 1 项未解除的前置任务');
    expect(within(panel).getByTestId('claim-blocked-blk-1')).toHaveTextContent('前置任务一（进行中）');
    expect(within(panel).queryByTestId('claim-blocked-blk-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-prompt')).not.toBeInTheDocument();
  });

  it('无未解除前置时点派发：直接打开派发弹窗，不出现拦截清单', async () => {
    mockDetail(makeIssue('iss-1', { blocked_by_count: 1, blocked_by_open_count: 0, resolved: true }));
    usePanelStore.setState({ view: 'detail', issueId: 'iss-1', sessionId: null, rightOpen: true });
    render(withClient(<DetailPanel />));

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    expect(await screen.findByTestId('dispatch-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('claim-blocked-panel')).not.toBeInTheDocument();
  });
});
