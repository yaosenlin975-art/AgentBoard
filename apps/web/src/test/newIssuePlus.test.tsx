/**
 * NEW-ISSUE-PLUS：新建任务入口只在「待规划」列头（+ 号），右上角按钮已移除；任务树在工具条给同等入口。
 * 覆盖：+ 号只出现在待规划列、点击开对话框且状态预填待规划、键盘可达、树视图入口、顶栏无入口。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Session } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { useNavStore } from '../state/navStore';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const existing: Issue = {
  id: 'i1',
  workspace_id: 'ws-1',
  title: '已有任务',
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

function renderBoard(layout: 'board' | 'tree' = 'board') {
  // FIX-2：Board 不再接收 layout prop，视图由 navStore 决定
  useNavStore.setState({ view: layout });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Board />
    </QueryClientProvider>,
  );
}

function mockData() {
  server.use(
    http.get('/api/issues', () => HttpResponse.json<Issue[]>([existing])),
    http.get('/api/sessions', () => HttpResponse.json<Session[]>([])),
    http.get('/api/issues/tree', () => HttpResponse.json({ items: [], next_cursor: null })),
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
});

describe('新建任务入口（待规划列头 +）', () => {
  it('+ 号只在「待规划」列头，可聚焦且有 aria-label', async () => {
    mockData();
    renderBoard();

    const plus = await screen.findByTestId('column-create-待规划');
    expect(plus).toHaveTextContent('+');
    expect(plus).toHaveAttribute('aria-label', '新建任务（待规划）');
    expect(plus).toHaveAttribute('title', '新建任务（待规划）');
    // 其它三列没有 + 号
    expect(screen.queryByTestId('column-create-进行中')).toBeNull();
    expect(screen.queryByTestId('column-create-待验收')).toBeNull();
    expect(screen.queryByTestId('column-create-已关闭')).toBeNull();
    // 键盘可达：可 Tab 聚焦
    plus.focus();
    expect(plus).toHaveFocus();
  });

  it('AUDIT-BOARD：空列给「+ 新建任务」，文案说明落点待规划', async () => {
    mockData();
    // 让「待规划」列真正为空（唯一一张卡在别的列）
    server.use(http.get('/api/issues', () => HttpResponse.json<Issue[]>([{ ...existing, id: 'i2', status: '进行中' }])));
    renderBoard();

    const empty = await screen.findByTestId('empty-待规划');
    expect(empty).toHaveTextContent('新任务进入待规划');
    const create = screen.getByTestId('empty-create-待规划');
    expect(create).toHaveTextContent('+ 新建任务');

    await userEvent.click(create);
    expect(await screen.findByRole('dialog', { name: '新建任务' })).toBeInTheDocument();
  });

  it('点 + 打开新建对话框，状态预填「待规划」', async () => {
    mockData();
    renderBoard();

    await userEvent.click(await screen.findByTestId('column-create-待规划'));

    expect(await screen.findByRole('dialog', { name: '新建任务' })).toBeInTheDocument();
    expect(screen.getByTestId('new-issue-status')).toHaveTextContent('待规划');
  });

  it('Enter 键触发 + 号（键盘可达）', async () => {
    mockData();
    renderBoard();

    const plus = await screen.findByTestId('column-create-待规划');
    plus.focus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByRole('dialog', { name: '新建任务' })).toBeInTheDocument();
  });

  it('提交后 POST 不带 status（服务端固定落待规划）并关闭对话框', async () => {
    let body: Record<string, unknown> | null = null;
    mockData();
    server.use(
      http.post('/api/issues', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json<Issue>({ ...existing, id: 'i9', title: '新任务' }, { status: 201 });
      }),
    );
    renderBoard();

    await userEvent.click(await screen.findByTestId('column-create-待规划'));
    await userEvent.type(await screen.findByTestId('new-issue-title'), '新任务');
    await userEvent.click(screen.getByTestId('new-issue-submit'));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ workspace_id: 'ws-1', title: '新任务' });
    expect(body).not.toHaveProperty('status');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull());
  });

  it('任务树视图：工具条给同等入口（树没有列），点它打开同一个对话框', async () => {
    mockData();
    renderBoard('tree');

    expect(await screen.findByTestId('tree-create-issue')).toHaveTextContent('+ 新建');
    // 树视图不渲染列，因此没有列头 + 号
    expect(screen.queryByTestId('column-create-待规划')).toBeNull();

    await userEvent.click(screen.getByTestId('tree-create-issue'));
    expect(await screen.findByRole('dialog', { name: '新建任务' })).toBeInTheDocument();
    expect(screen.getByTestId('new-issue-status')).toHaveTextContent('待规划');
  });
});
