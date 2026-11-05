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

  it('dry_run 清单进弹窗 → 提交后就地写回缓存并给「仅看本次退回」入口', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([running])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.post('/api/workspaces/ws-1/release-running', async ({ request }) => {
        const body = (await request.json()) as { dry_run?: boolean };
        if (body.dry_run === true) return HttpResponse.json({ released: [released], skipped: [] });
        return HttpResponse.json({ released: [released], skipped: [] });
      }),
    );
    renderBoard();
    fireEvent.click(await screen.findByTestId('column-release-running'));
    expect(await screen.findByTestId('release-summary')).toHaveTextContent('安全退回 1 张');
    const submit = await screen.findByTestId('release-submit');
    expect(submit).toHaveTextContent('退回 1 张到待规划');
    fireEvent.click(submit);

    // 不等 WS 帧：卡片立刻回到待规划列
    await waitFor(() => expect(screen.getByTestId('release-toast')).toHaveTextContent('已退回 1 张'));
    // 退回后默认进入「仅看本次退回」，可切回全部
    const toggle = screen.getByTestId('release-only-toggle');
    expect(toggle).toHaveTextContent('显示全部任务');
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('仅看本次退回（1）');
    // 卡片已回「待规划」列
    expect(screen.getByTestId(`issue-card-${running.id}`).closest('[data-testid="column-待规划"]')).not.toBeNull();
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
