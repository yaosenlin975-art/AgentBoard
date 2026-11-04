/**
 * S2a：左栏是唯一导航，App 的视图切换全部由 navStore 驱动（不再有/knowledgeOpen/logOpen 三态）。
 * 覆盖：五视图逐一点切、选中态、幂等、刷新后保持、工具条入口与左栏写同一份 store。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import App from '../App';
import { server } from './server';
import { resetOverlays } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';
import { NAV_STORAGE_KEY, useNavStore } from '../state/navStore';
import { useAppStore } from '../state/appStore';

class InertWebSocket {
  close(): void {}
}

const workspaces = [{ id: 'ws-1', name: '主项目', path: 'D:\\demo', created_at: 1 }];

function renderApp() {
  vi.stubGlobal('WebSocket', InertWebSocket);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
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
    chatDraft: '',
    rightOpen: false,
  });
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json(workspaces)),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/clis', () => HttpResponse.json([])),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/workspaces/:id/statuses', () => HttpResponse.json([])),
    http.get('/api/workspaces/:id/changelog', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('S2a 左栏导航（navStore 驱动）', () => {
  it('默认渲染左栏：五入口 + 工作区名/路径 + 当前视图选中态', async () => {
    renderApp();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    for (const view of ['board', 'tree', 'knowledge', 'log', 'chat']) {
      expect(screen.getByTestId(`sidebar-entry-${view}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('sidebar-entry-board')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-entry-tree')).not.toHaveAttribute('aria-current');
    return waitFor(() => {
      expect(screen.getByTestId('sidebar-workspace')).toHaveTextContent('主项目');
      expect(screen.getByTestId('sidebar-workspace-path')).toHaveTextContent('D:\\demo');
    });
  });

  it('逐个点五入口：navStore.view 跟着变，main 渲染对应视图', async () => {
    renderApp();

    fireEvent.click(screen.getByTestId('sidebar-entry-tree'));
    expect(useNavStore.getState().view).toBe('tree');
    expect(screen.getByTestId('sidebar-entry-tree')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-entry-board')).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(screen.getByTestId('issue-tree-view')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sidebar-entry-knowledge'));
    expect(useNavStore.getState().view).toBe('knowledge');
    await waitFor(() => expect(screen.getByRole('region', { name: '共享知识库' })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sidebar-entry-log'));
    expect(useNavStore.getState().view).toBe('log');
    await waitFor(() => expect(screen.getByTestId('changelog-panel')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sidebar-entry-chat'));
    expect(useNavStore.getState().view).toBe('chat');
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-entry-board'));
    expect(useNavStore.getState().view).toBe('board');
    expect(screen.getByTestId('board-columns')).toBeInTheDocument();
  });

  it('再点已激活入口保持该视图（导航语义是「选一个」，不是 toggle）', () => {
    useNavStore.setState({ view: 'knowledge' });
    renderApp();
    fireEvent.click(screen.getByTestId('sidebar-entry-knowledge'));
    expect(useNavStore.getState().view).toBe('knowledge');
  });

  it('刷新后回到同一视图（view 持久化）', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ state: { view: 'knowledge' }, version: 0 }));
    await act(async () => {
      await useNavStore.persist.rehydrate();
    });
    expect(useNavStore.getState().view).toBe('knowledge');

    renderApp();
    expect(screen.getByTestId('sidebar-entry-knowledge')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(screen.getByRole('region', { name: '共享知识库' })).toBeInTheDocument());
  });

  it('FIX-2 后视图切换只走左栏入口（工具条不再有 ViewSwitcher）', async () => {
    renderApp();
    // 工具条已无 ViewSwitcher：main 里不再有「任务树」按钮
    const main = screen.getByTestId('main-content');
    expect(within(main).queryByRole('button', { name: '任务树' })).toBeNull();
    // 左栏入口负责切换，状态写同一份 navStore
    fireEvent.click(screen.getByTestId('sidebar-entry-tree'));
    expect(useNavStore.getState().view).toBe('tree');
    expect(screen.getByTestId('sidebar-entry-tree')).toHaveAttribute('aria-current', 'page');
  });
});
