/**
 * App 布局（PANEL-FLOAT）：根容器固定视口、主内容 flex-1、左右栏改为浮窗（不再占位）。
 * 侧栏开合 = TopBar「工作空间」按钮 + 左浮窗；SIDEBAR01 的「侧栏让位」语义由浮窗模型取代。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import App from '../App';
import { server } from './server';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';

/** 惰性 WS 桩：App 挂载即 connectWs，测试环境不建立真实连接 */
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
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json(workspaces)),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/clis', () => HttpResponse.json([])),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App 布局容器（PANEL-FLOAT）', () => {
  it('根容器固定视口高度且整体不滚动（h-screen overflow-hidden），主内容独立滚动', () => {
    const { container } = renderApp();
    const root = container.firstElementChild;
    expect(root).toHaveClass('h-screen');
    expect(root).toHaveClass('overflow-hidden');
    expect(root!.className).not.toContain('min-h-screen');
    const main = screen.getByTestId('main-content');
    expect(main.className).toContain('flex-1');
    expect(main.className).toContain('overflow-auto');
  });

  it('右栏默认不存在（不再有常驻窄条），左栏默认没有 DOM', () => {
    renderApp();
    const main = screen.getByTestId('main-content');
    expect(main.className).toContain('flex-1');
    // PANEL-ENTRY2：右浮窗关闭态整块卸载，DOM 里既没有 right-panel 也没有 collapsed 窄条
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    expect(screen.queryByTestId('workspace-sidebar')).toBeNull();
    expect(useOverlayStore.getState().left).toBe(false);
  });

  it('「工作空间」按钮开合左浮窗：aria-expanded/aria-controls 正确，关闭后焦点回到按钮', async () => {
    renderApp();
    const trigger = await screen.findByTestId('topbar-workspace');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'workspace-sidebar');
    expect(screen.queryByTestId('workspace-sidebar')).toBeNull();

    fireEvent.click(trigger);
    const sidebar = await screen.findByTestId('workspace-sidebar');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar).toHaveAttribute('id', 'workspace-sidebar');
    expect(sidebar.className).toContain('absolute');
    expect(screen.getByTestId('workspace-sidebar-content')).toBeInTheDocument();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByTestId('workspace-sidebar')).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('左浮窗与右浮窗互斥：打开右浮窗会关掉左浮窗', async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId('topbar-workspace'));
    expect(await screen.findByTestId('workspace-sidebar')).toBeInTheDocument();

    usePanelStore.getState().openDetail('issue-1');
    await waitFor(() => expect(useOverlayStore.getState().right).toBe(true));
    expect(useOverlayStore.getState().left).toBe(false);
    expect(screen.queryByTestId('workspace-sidebar')).toBeNull();
  });

  it('浮窗内工作空间卡片与标题行左右内边距一致（SIDEBAR-CARD-WIDTH）', async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId('topbar-workspace'));
    const heading = await screen.findByRole('heading', { name: '工作空间' });
    expect(heading.parentElement!.className).toContain('px-2');
    expect(screen.getByRole('list', { name: '工作空间列表' }).className).toContain('px-2');
  });
});

