/**
 * REL-2：看板「进行中」列头救火键 + 预览弹窗。
 * 覆盖：按钮只出现在进行中列；dry_run 清单进弹窗；提交后就地写回缓存（不等 WS 帧）；
 * 「仅看本次退回」过滤；mode=all 必须显式确认才可提交。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'ws-1',
    title: '运行中任务',
    description: '',
    priority: '中',
    labels: [],
    status: '进行中',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: 'agent:exec-a',
    claimed_at: 1000,
    session_id: null,
    comment_count: 0,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

const running = makeIssue();
const released = { ...running, status: '待规划' as const, claimed_by: null, claimed_at: null };
const closed = makeIssue({ id: '33333333-3333-4333-8333-333333333333', title: '已关闭任务', status: '已关闭', claimed_by: null, claimed_at: null, sort_order: 100 });
const leaseActive = makeIssue({ id: '22222222-2222-4222-8222-222222222222', title: '租约生效任务', claimed_at: Date.now() });
const otherPlanning = makeIssue({
  id: '44444444-4444-4444-8444-444444444444',
  title: '另一张待规划任务',
  status: '待规划',
  sort_order: 1,
  claimed_by: null,
  claimed_at: null,
});

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Board />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
});

describe('REL-2 进行中列头救火键', () => {
  it('只在「进行中」列出现，其它列没有该按钮', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([running])),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    renderBoard();
    await screen.findByTestId('column-进行中');
    expect(await screen.findByTestId('column-release-running')).toBeInTheDocument();
    expect(screen.queryByTestId('column-release-running-待规划')).toBeNull();
  });

  it('dry_run 清单进弹窗 → 提交后就地写回缓存；全板不自动塌缩，「仅看本次退回」手动开启（REL-UI）', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([running, closed, otherPlanning])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.post('/api/workspaces/ws-1/release-running', async ({ request }) => {
        const body = (await request.json()) as { dry_run?: boolean };
        if (body.dry_run === true) return HttpResponse.json({ released: [released], skipped: [] });
        return HttpResponse.json({ released: [released], skipped: [] });
      }),
    );
    renderBoard();
    expect(await screen.findByTestId(`issue-card-${closed.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('count-已关闭')).toHaveTextContent('1');
    fireEvent.click(await screen.findByTestId('column-release-running'));
    expect(await screen.findByTestId('release-summary')).toHaveTextContent('安全退回 1 张');
    const submit = await screen.findByTestId('release-submit');
    expect(submit).toHaveTextContent('退回 1 张到待规划');
    fireEvent.click(submit);

    // 不等 WS 帧：卡片立刻回到待规划列
    await waitFor(() => expect(screen.getByTestId('release-toast')).toHaveTextContent('已退回 1 张'));
    // REL-UI：不再自动切进「仅看本次退回」——其它列计数保持（不塌缩），过滤等用户手动开启
    expect(screen.getByTestId('count-已关闭')).toHaveTextContent('1');
    expect(screen.getByTestId('count-待规划')).toHaveTextContent('2');
    expect(screen.getByTestId(`issue-card-${closed.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`issue-card-${otherPlanning.id}`)).toBeInTheDocument();
    const toggle = screen.getByTestId('release-only-toggle');
    expect(toggle).toHaveTextContent('仅看本次退回（1）');
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('显示全部任务');
    expect(screen.queryByTestId(`issue-card-${closed.id}`)).toBeNull();
    expect(screen.queryByTestId(`issue-card-${otherPlanning.id}`)).not.toBeInTheDocument();
    // 再点一次恢复全板
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('仅看本次退回（1）');
    expect(screen.getByTestId(`issue-card-${closed.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`issue-card-${otherPlanning.id}`)).toBeInTheDocument();
    // 卡片已回「待规划」列
    expect(screen.getByTestId(`issue-card-${running.id}`).closest('[data-testid="column-待规划"]')).not.toBeNull();
  });

  it('REL-UI 提交含租约跳过：弹窗不静默关闭，明示跳过张数与列表；成功张数仍写回看板', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([running, leaseActive])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.post('/api/workspaces/ws-1/release-running', async ({ request }) => {
        const body = (await request.json()) as { dry_run?: boolean };
        if (body.dry_run === true) {
          return HttpResponse.json({ released: [released], skipped: [{ id: leaseActive.id, reason: 'LEASE_ACTIVE' }] });
        }
        return HttpResponse.json({ released: [released], skipped: [{ id: leaseActive.id, reason: 'LEASE_ACTIVE' }] });
      }),
    );
    renderBoard();
    fireEvent.click(await screen.findByTestId('column-release-running'));
    expect(await screen.findByTestId('release-summary')).toHaveTextContent('租约生效 1 张');
    // 显式勾选租约生效卡再提交
    fireEvent.click(screen.getByTestId(`release-check-${leaseActive.id}`));
    fireEvent.click(screen.getByTestId('release-submit'));

    // 结果面板替换预览区：成功 1 张 + 跳过 1 张（租约生效），弹窗不关闭
    const result = await screen.findByTestId('release-result');
    expect(result).toHaveTextContent('已退回 1 张到待规划');
    expect(screen.getByTestId('release-skipped')).toHaveTextContent('跳过 1 张（其中 1 张因租约生效）');
    expect(screen.getByTestId(`release-skipped-row-${leaseActive.id}`)).toHaveTextContent('租约生效');
    expect(screen.getByTestId('release-running-dialog')).toBeInTheDocument();
    // 成功张数仍就地写回 + toast 只报成功数（不显示成全部成功）
    await waitFor(() => expect(screen.getByTestId('release-toast')).toHaveTextContent('已退回 1 张'));
    expect(screen.getByTestId(`issue-card-${running.id}`).closest('[data-testid="column-待规划"]')).not.toBeNull();
    // 被跳过卡状态不变：仍在进行中列
    expect(screen.getByTestId(`issue-card-${leaseActive.id}`).closest('[data-testid="column-进行中"]')).not.toBeNull();
  });

  it('REL-UI 全部被跳过时不当成成功：无成功 toast、卡片原样、弹窗停在结果面板', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([leaseActive])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.post('/api/workspaces/ws-1/release-running', () =>
        HttpResponse.json({ released: [], skipped: [{ id: leaseActive.id, reason: 'LEASE_ACTIVE' }] }),
      ),
    );
    renderBoard();
    fireEvent.click(await screen.findByTestId('column-release-running'));
    await screen.findByTestId('release-summary');
    // 预检只有租约生效卡（默认不勾）→ 手动勾选才能提交
    fireEvent.click(screen.getByTestId(`release-check-${leaseActive.id}`));
    fireEvent.click(screen.getByTestId('release-submit'));

    await screen.findByTestId('release-result');
    expect(screen.getByTestId('release-result-none')).toHaveTextContent('没有退回任何任务');
    expect(screen.getByTestId('release-skipped')).toHaveTextContent('跳过 1 张（其中 1 张因租约生效）');
    expect(screen.getByTestId('release-running-dialog')).toBeInTheDocument();
    // 无成功 toast（不当成成功）；被跳过卡仍在进行中
    expect(screen.queryByTestId('release-toast')).toBeNull();
    expect(screen.queryByTestId('release-banner')).toBeNull();
    expect(screen.getByTestId(`issue-card-${leaseActive.id}`).closest('[data-testid="column-进行中"]')).not.toBeNull();
  });

  it('mode=all 未勾选确认时主按钮 disabled，勾选后可提交', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([running])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.post('/api/workspaces/ws-1/release-running', () =>
        HttpResponse.json({ released: [released], skipped: [] }),
      ),
    );
    renderBoard();
    fireEvent.click(await screen.findByTestId('column-release-running'));
    await screen.findByTestId('release-summary');
    fireEvent.click(screen.getByTestId('release-mode-all'));
    expect(screen.getByTestId('release-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('release-confirm-all-check'));
    expect(screen.getByTestId('release-submit')).not.toBeDisabled();
  });
});
