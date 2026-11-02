/**
 * PANEL-VIEW-BUG 回归：点任务必须进详情，与 localStorage 残留 / 上次停在聊天 / 浮窗已开聊天无关。
 * 只测 RightPanel 的「视图选择 + 可见性」契约：详情/聊天内部实现由各自测试覆盖，
 * 这里替换成标记组件，避免夹具漂移干扰断言（缺陷本身就在视图判定这一层）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';

vi.mock('../components/detail/DetailPanel', () => ({
  DetailPanel: () => <div data-testid="stub-detail-panel">detail-body</div>,
}));
vi.mock('../components/chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="stub-chat-panel">chat-body</div>,
}));

const { RightPanel } = await import('../components/right/RightPanel');

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RightPanel />
    </QueryClientProvider>,
  );
}

const heading = (name: string) => screen.findByRole('heading', { name });

beforeEach(() => {
  localStorage.clear();
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
});

describe('点击任务进入详情（PANEL-VIEW-BUG）', () => {
  it('(a) 干净状态：openDetail 后渲染详情，绝不回退成聊天', async () => {
    renderPanel();
    expect(screen.queryByTestId('right-panel')).toBeNull();

    act(() => usePanelStore.getState().openDetail('iss-1'));
    expect(await heading('任务详情')).toBeInTheDocument();
    expect(useOverlayStore.getState().right).toBe(true);
    expect(screen.queryByRole('heading', { name: '聊天' })).toBeNull();
    expect(screen.getByTestId('detail-panel-view')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('chat-panel-view')).toHaveAttribute('inert');
    expect(screen.getByTestId('stub-detail-panel')).toBeInTheDocument();
  });

  it('(b) localStorage 残留「上次停在聊天」：刷新后点任务仍是详情', async () => {
    localStorage.setItem('agentboard.panel', JSON.stringify({
      state: { view: 'chat', issueId: null, sessionId: 's1', chatSession: null, rightOpen: true, unread: {} },
      version: 0,
    }));
    await act(async () => { await usePanelStore.persist.rehydrate(); });
    expect(usePanelStore.getState().view).toBeNull();
    expect(usePanelStore.getState().sessionId).toBe('s1');

    renderPanel();
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByTestId('chat-panel-view')).toBeNull();

    act(() => usePanelStore.getState().openDetail('iss-1'));
    expect(await heading('任务详情')).toBeInTheDocument();
    expect(screen.getByTestId('chat-panel-view')).toHaveAttribute('inert');
  });

  it('(c) 浮窗已开在聊天时点另一张任务：切到详情', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openChat());
    expect(await heading('聊天')).toBeInTheDocument();
    expect(usePanelStore.getState().view).toBe('chat');

    act(() => usePanelStore.getState().openDetail('iss-2'));
    expect(await heading('任务详情')).toBeInTheDocument();
    await waitFor(() => expect(usePanelStore.getState().view).toBe('detail'));
    expect(usePanelStore.getState().issueId).toBe('iss-2');
    expect(screen.getByTestId('chat-panel-view')).toHaveAttribute('inert');
    expect(screen.getByTestId('detail-panel-view')).not.toHaveAttribute('inert');
  });

  it('view 为 null 时不渲染浮窗，即便 overlayStore.right 被打开（无隐式回退）', async () => {
    renderPanel();
    act(() => useOverlayStore.getState().openRight());
    await waitFor(() => expect(useOverlayStore.getState().right).toBe(false));
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByRole('heading', { name: '聊天' })).toBeNull();
  });

  it('关闭浮窗会清空视图意图（否则同步 effect 会重新打开）', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openDetail('iss-1'));
    await heading('任务详情');

    await userEvent.click(screen.getByTestId('right-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    await waitFor(() => expect(usePanelStore.getState().view).toBeNull());
    expect(useOverlayStore.getState().right).toBe(false);
  });
});
