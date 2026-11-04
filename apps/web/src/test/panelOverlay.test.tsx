/**
 * PANEL-FLOAT 浮窗行为：互斥、三种关闭方式、焦点回收、主内容宽度不变（契约级）。
 * 几何（浮窗在按钮下方、主内容像素宽度）由 CDP 在真实浏览器验证。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SideBar } from '../components/shell/SideBar';
import { RightPanel } from '../components/right/RightPanel';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const ws = { id: 'ws-1', name: '主项目', path: 'D:\\demo', created_at: 1 };

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <div className="flex min-h-0 flex-1">
        <main data-testid="main-content" className="min-w-0 flex-1 overflow-auto" />
        <SideBar workspace={ws} />
        <RightPanel />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
  );
});

describe('PANEL-FLOAT 浮窗', () => {
  it('overlayStore 保证互斥：开左关右、开右关左', () => {
    useOverlayStore.getState().openLeft();
    expect(useOverlayStore.getState()).toMatchObject({ left: true, right: false });
    useOverlayStore.getState().openRight();
    expect(useOverlayStore.getState()).toMatchObject({ left: false, right: true });
    useOverlayStore.getState().openLeft();
    expect(useOverlayStore.getState()).toMatchObject({ left: true, right: false });
  });

  it('外部点击关闭左浮窗；Esc 同样关闭且焦点回到触发按钮', async () => {
    renderShell();
    const trigger = await screen.findByTestId('topbar-workspace');
    fireEvent.click(trigger);
    expect(await screen.findByTestId('workspace-sidebar')).toBeInTheDocument();

    // 外部点击（主内容区）
    fireEvent.pointerDown(screen.getByTestId('main-content'));
    await waitFor(() => expect(screen.queryByTestId('workspace-sidebar')).toBeNull());
    expect(trigger).toHaveFocus();

    // 再开一次，用 Esc 关闭
    fireEvent.click(trigger);
    expect(await screen.findByTestId('workspace-sidebar')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('workspace-sidebar')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('右浮窗关闭后整块卸载（无 rail 胶囊），焦点回触发元素；主内容不与浮窗争宽度', async () => {
    renderShell();
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'fake-card');
    document.body.appendChild(trigger);
    trigger.focus();

    usePanelStore.getState().openDetail('issue-1');
    const panel = await screen.findByTestId('right-panel');
    expect(panel.className).toContain('absolute');
    expect(panel.className).toContain('z-30');
    expect(screen.getByTestId('main-content').className).toContain('flex-1');

    fireEvent.click(screen.getByTestId('right-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    // PANEL-ENTRY2：不再有收起态窄条
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    expect(useOverlayStore.getState().right).toBe(false);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('Esc 在 Modal 打开时不关浮窗（让 Modal 先处理）', async () => {
    renderShell();
    fireEvent.click(await screen.findByTestId('topbar-workspace'));
    expect(await screen.findByTestId('workspace-sidebar')).toBeInTheDocument();

    // 模拟 Modal 打开：页面上存在 role=dialog
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('workspace-sidebar')).not.toBeNull();
    dialog.remove();
  });
});

describe('PANEL-ENTRY2 入口（无收起按钮 / 无 rail 胶囊）', () => {
  it('两个入口分别落在详情与广播整屏聊天，且都不产生收起态', async () => {
    renderShell();
    usePanelStore.getState().openDetail('issue-1');
    expect(await screen.findByRole('heading', { name: '任务详情' })).toBeInTheDocument();
    expect(screen.queryByTestId('right-panel-collapse')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    fireEvent.click(screen.getByTestId('right-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());

    // S2b：聊天整屏化 —— openChat 只切 navStore 并清空面板，右侧面板不出现聊天视图
    usePanelStore.getState().openChat();
    expect(usePanelStore.getState().view).toBeNull();
    expect(screen.queryByTestId('chat-panel-view')).toBeNull();
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
  });
});

describe('PANEL-FLOAT 层级', () => {
  it('浮窗 z-30 低于 Modal 的 z-50（Modal overlay 类名契约）', async () => {
    renderShell();
    fireEvent.click(await screen.findByTestId('topbar-workspace'));
    const sidebar = await screen.findByTestId('workspace-sidebar');
    expect(sidebar.className).toContain('z-30');
    // Modal 自身在 ui/Modal.tsx 里固定 z-50（见 Modal.test.tsx 的 overlay 断言）
    expect(sidebar.className).not.toContain('z-50');
  });
});


