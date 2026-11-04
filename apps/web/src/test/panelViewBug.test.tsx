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
import { useNavStore } from '../state/navStore';

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
    expect(screen.getByTestId('detail-panel-view')).toBeInTheDocument();
    // DETAIL-VIEW-BUG2：同一时刻只挂载一个视图 —— 详情激活时聊天子树计数必须为 0
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
    expect(screen.queryAllByTestId('ref-panel-view')).toHaveLength(0);
    expect(screen.getByTestId('stub-detail-panel')).toBeInTheDocument();
  });

  it('按需挂载：detail 时只有详情子树；openChat 后面板无 chat 子树（S2b 整屏化）', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openDetail('iss-1'));
    await heading('任务详情');
    expect(screen.getAllByTestId('detail-panel-view')).toHaveLength(1);
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);

    act(() => usePanelStore.getState().openChat());
    // S2b：聊天整屏化 —— 面板里不再有 chat 视图，openChat 只切 navStore 并清空面板
    expect(useNavStore.getState().view).toBe('chat');
    expect(usePanelStore.getState().view).toBeNull();
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
    // 面板走退出过渡后整块卸载，detail 子树随之消失
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    expect(screen.queryAllByTestId('detail-panel-view')).toHaveLength(0);
    expect(screen.queryAllByTestId('ref-panel-view')).toHaveLength(0);
  });

  it('(b) localStorage 残留「上次停在聊天」：刷新后点任务仍是详情', async () => {
    localStorage.setItem('agentboard.panel', JSON.stringify({
      state: { view: null, issueId: null, sessionId: 's1', chatSession: null, rightOpen: false, unread: {} },
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
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
  });

  it('(c) 整屏聊天时点另一张任务：主区切回看板并进详情', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openChat());
    expect(useNavStore.getState().view).toBe('chat');
    expect(usePanelStore.getState().view).toBeNull();

    act(() => usePanelStore.getState().openDetail('iss-2'));
    expect(await heading('任务详情')).toBeInTheDocument();
    await waitFor(() => expect(usePanelStore.getState().view).toBe('detail'));
    expect(usePanelStore.getState().issueId).toBe('iss-2');
    // S2b：从整屏聊天点任务 → 主区切回看板，详情浮窗不会盖在整屏聊天上
    expect(useNavStore.getState().view).toBe('board');
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
    expect(screen.getAllByTestId('detail-panel-view')).toHaveLength(1);
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
