/**
 * SIDEBAR-3：收起态 tooltip / 角标 / 当前项指示 / aria-label 同步。
 *
 * 收起态的行为大多由 index.css 的 `.ab-sidebar[data-mode='collapsed']` 作用域承担，
 * jsdom 不跑布局与伪元素，所以这里断言「数据接线」：data-tip 文案、角标文本与 99+、
 * data-active/aria-current、aria-label 带数量；视觉规格由 dev 页截图与 CSS 本身保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { SideBar } from '../components/shell/SideBar';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { resetOverlays } from '../state/overlayStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };

function renderSideBar(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SideBar workspace={ws} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  useAppStore.setState({ wsStatus: 'open' });
  useNavStore.setState({
    view: 'board',
    drawer: null,
    sidebarMode: 'collapsed',
    sidebarModeExplicit: false,
    chatOrigin: null,
    decisionFocus: null,
  });
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
  resetOverlays();
  // 待决策数固定为 3（grace 1 + open 2），供 tooltip / aria-label / 角标断言
  server.use(
    http.get('/api/workspaces/:id/decisions/count', () =>
      HttpResponse.json({ grace: 1, open: 2, stale_open: 0, answered_recent: 0 }),
    ),
  );
});

describe('收起态 tooltip / 角标 / 当前项（SIDEBAR-3）', () => {
  it('[T1] 六个入口都有 data-tip，数量进 tooltip；账号/设置/状态行也有提示', async () => {
    renderSideBar();
    for (const view of ['board', 'decisions', 'tree', 'knowledge', 'log', 'chat']) {
      const li = screen.getByTestId(`sidebar-entry-${view}`).closest('li');
      expect(li).not.toBeNull();
      expect(li).toHaveAttribute('data-tip');
    }
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-entry-decisions').closest('li')).toHaveAttribute('data-tip', '待决策 · 3'),
    );
    expect(screen.getByTestId('sidebar-entry-chat').closest('li')).toHaveAttribute('data-tip', '聊天');
    expect(screen.getByTestId('topbar-accounts')).toHaveAttribute('data-tip', '账号管理');
    expect(screen.getByTestId('topbar-settings')).toHaveAttribute('data-tip', '设置');
    expect(screen.getByTestId('sidebar-status').getAttribute('data-tip')).toBe('服务运行中 · 主题：跟随系统');
  });

  it('[T2] 角标：有数才渲染，>99 显示 99+，tooltip 同步 99+', () => {
    renderSideBar();
    expect(screen.queryByTestId('sidebar-chat-unread')).toBeNull();

    act(() => usePanelStore.setState({ unread: { s1: 60, s2: 60 } }));
    const badge = screen.getByTestId('sidebar-chat-unread');
    expect(badge).toHaveTextContent('99+');
    expect(badge.className).toContain('ab-sidebar-badge');
    expect(screen.getByTestId('sidebar-entry-chat').closest('li')).toHaveAttribute('data-tip', '聊天 · 99+');
  });

  it('[T3] 当前项：data-active 与 aria-current 同步', () => {
    renderSideBar();
    expect(screen.getByTestId('sidebar-entry-board')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('sidebar-entry-board')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-entry-tree')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('sidebar-entry-tree')).not.toHaveAttribute('aria-current');
  });

  it('[T4] aria-label 带数量：待决策 N 条 / 聊天 N 条未读', async () => {
    renderSideBar();
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-entry-decisions')).toHaveAttribute('aria-label', '待决策，3 条'),
    );
    act(() => usePanelStore.setState({ unread: { s1: 2, s2: 3 } }));
    expect(screen.getByTestId('sidebar-entry-chat')).toHaveAttribute('aria-label', '聊天，5 条未读');
  });
});
