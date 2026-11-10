/**
 * P3-B：专家组视图（左侧栏下半部分入口 + 团队快照只读呈现）。
 *
 * 覆盖：
 * - 左栏「专家组」入口位于「账号」与「设置」之间，点击切到 experts 视图（App 接线可达）；
 * - 无团队时展示空态引导（数据全部来自 REST，不伪造）；
 * - 有团队时渲染成员名册 / 状态 / 轮次 / tokens / 工具调用，token 护栏进度条；
 * - 点成员行展开只读消息区。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { TeamDetail } from '@agentboard/shared';
import App from '../App';
import { ExpertsView } from '../components/experts/ExpertsView';
import { server } from './server';
import { resetOverlays } from '../state/overlayStore';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';

class InertWebSocket {
  close(): void {}
}

const workspaces = [{ id: 'ws-1', name: '主项目', path: 'D:\\demo', created_at: 1 }];

const teamFixture: TeamDetail = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: '通用专家组',
  lead_session_id: 'lead-session-0001',
  status: 'active',
  max_turns_per_member: 20,
  budget_tokens: 200_000,
  created_at: 1,
  updated_at: 1,
  members: [
    {
      session_id: 'member-session-1',
      role: '架构',
      agent_name: 'Alice',
      status: 'done',
      usage: { turns: 2, tokens: 1200, tool_calls: 3 },
      session: {
        id: 'member-session-1',
        workspace_id: 'ws-1',
        issue_id: null,
        cli: 'codebuddy',
        model: null,
        status: '已结束',
        adapter_session_id: null,
        created_at: 1,
      },
    },
    {
      session_id: 'member-session-2',
      role: '测试',
      agent_name: 'Bob',
      status: 'working',
      usage: { turns: 1, tokens: 800, tool_calls: 1 },
      session: null,
    },
  ],
};

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function renderApp() {
  vi.stubGlobal('WebSocket', InertWebSocket);
  return renderWithClient(<App />);
}

beforeEach(() => {
  localStorage.clear();
  resetOverlays();
  useNavStore.setState({ view: 'board', drawer: null });
  useAppStore.setState({ workspaceId: 'ws-1', wsStatus: 'open' });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    refPanel: null,
    chatDrafts: {},
    rightOpen: false,
  });
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json(workspaces)),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/workspaces/:id/statuses', () => HttpResponse.json([])),
    http.get('/api/workspaces/:id/changelog', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
    http.get('/api/teams', () => HttpResponse.json([])),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P3-B 专家组视图', () => {
  it('左栏入口在「账号」与「设置」之间，点击切到 experts 视图', async () => {
    renderApp();
    const accounts = screen.getByTestId('topbar-accounts');
    const experts = screen.getByTestId('sidebar-entry-experts');
    const settings = screen.getByTestId('topbar-settings');

    expect(accounts.compareDocumentPosition(experts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(experts.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(experts);
    expect(useNavStore.getState().view).toBe('experts');
    expect(experts).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(screen.getByTestId('experts-view')).toBeInTheDocument());
  });

  it('无团队时展示空态引导', async () => {
    renderWithClient(<ExpertsView />);
    await waitFor(() => expect(screen.getByTestId('experts-empty')).toBeInTheDocument());
    expect(screen.getByTestId('experts-empty')).toHaveTextContent('还没有专家组');
    expect(screen.getByTestId('experts-create-toggle')).toBeInTheDocument();
  });

  it('有团队时渲染成员名册与用量，点成员展开只读消息区', async () => {
    server.use(http.get('/api/teams', () => HttpResponse.json([teamFixture])));
    renderWithClient(<ExpertsView />);

    await waitFor(() => expect(screen.getByTestId('experts-team-card')).toBeInTheDocument());
    expect(screen.getByTestId('experts-team-status')).toHaveTextContent('进行中');
    expect(screen.getByText('通用专家组')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getAllByTestId('experts-member-row')).toHaveLength(2);
    expect(screen.getByText('1,200 tok')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    const [firstRow] = screen.getAllByTestId('experts-member-row');
    fireEvent.click(firstRow!.querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('experts-member-messages')).toBeInTheDocument());
    expect(screen.getByTestId('experts-member-messages')).toHaveTextContent('成员会话 member-s');
  });

  it('无工作区时提示先选工作区（不发团队请求）', () => {
    useAppStore.setState({ workspaceId: null });
    renderWithClient(<ExpertsView />);
    expect(screen.getByTestId('experts-view')).toHaveTextContent('请先在左上角选择工作区');
  });
});
