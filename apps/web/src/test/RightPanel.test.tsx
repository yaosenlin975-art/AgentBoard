import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RightPanel } from '../components/right/RightPanel';
import { usePanelStore } from '../state/panelStore';
import { useNavStore } from '../state/navStore';

vi.mock('../components/detail/DetailPanel', async () => {
  const { useState } = await import('react');
  return {
    DetailPanel: () => {
      const [draft, setDraft] = useState('');
      return (
        <input
          data-testid="detail-draft"
          aria-label="详情草稿"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      );
    },
  };
});

vi.mock('../components/chat/ChatPanel', async () => {
  const { usePanelStore } = await import('../state/panelStore');
  return {
    ChatPanel: () => {
      // 与真实 Composer 一致：草稿在 panelStore 按会话存，视图按需卸载也不丢
      const sessionId = usePanelStore((state) => state.sessionId);
      const draft = usePanelStore((state) => state.chatDrafts[sessionId ?? ''] ?? '');
      const setDraft = usePanelStore((state) => state.setChatDraft);
      return (
        <input
          data-testid="chat-draft"
          aria-label="聊天草稿"
          value={draft}
          onChange={(event) => setDraft(sessionId, event.target.value)}
        />
      );
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  usePanelStore.setState({
    view: 'detail',
    issueId: 'issue-1',
    sessionId: null,
    chatSession: null,
    unread: {},
    rightOpen: true,
  });
});

describe('RightPanel', () => {
  it('键盘可聚焦分隔条并按方向调整宽度', () => {
    render(<RightPanel />);
    const panel = screen.getByTestId('right-panel');
    const handle = screen.getByTestId('right-resize-handle');

    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-valuemin', '320');
    expect(handle).toHaveAttribute('aria-valuemax', '720');
    expect(handle).toHaveAttribute('aria-valuenow', '420');

    handle.focus();
    expect(handle).toHaveFocus();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel).toHaveStyle({ width: '430px' });
    expect(handle).toHaveAttribute('aria-valuenow', '430');
    expect(localStorage.getItem('agentboard.right-panel-width')).toBe('430');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel).toHaveStyle({ width: '420px' });
    expect(handle).toHaveAttribute('aria-valuenow', '420');
  });

  it('键盘调整宽度限制在最小值和最大值之间', () => {
    localStorage.setItem('agentboard.right-panel-width', '320');
    render(<RightPanel />);
    const panel = screen.getByTestId('right-panel');
    const handle = screen.getByTestId('right-resize-handle');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel).toHaveStyle({ width: '320px' });
    expect(handle).toHaveAttribute('aria-valuenow', '320');

    for (let i = 0; i < 41; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel).toHaveStyle({ width: '720px' });
    expect(handle).toHaveAttribute('aria-valuenow', '720');
    expect(localStorage.getItem('agentboard.right-panel-width')).toBe('720');
  });

  it('拖宽期间即时响应并暂停宽度过渡，释放后恢复', () => {
    render(<RightPanel />);
    const panel = screen.getByTestId('right-panel');
    const handle = screen.getByTestId('right-resize-handle');

    fireEvent.pointerDown(handle, { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { button: 0, clientX: 180 });
    expect(panel).toHaveStyle({ width: '440px' });
    // PANEL-MOTION-2：宽度不再是动画属性（拖动即时响应），只保留 transform/opacity 过渡
    expect(panel.className).not.toContain('transition-[width]');

    fireEvent.pointerUp(window, { button: 0, clientX: 180 });
    // 过渡声明在内联样式（transform/opacity），类里不再有宽度过渡
    expect(panel.style.transition).toContain('transform');
    expect(panel.style.transition).toContain('opacity');
    expect(localStorage.getItem('agentboard.right-panel-width')).toBe('440');
  });

  it('按需挂载视图：detail 时只有详情子树；openChat 后面板无任何视图（S2b 整屏化）', async () => {
    render(<RightPanel />);
    const detail = screen.getByTestId('detail-draft');

    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '420px' });
    expect(screen.getByTestId('right-panel-content')).toHaveClass('motion-reduce:transition-none');
    // DETAIL-VIEW-BUG2：detail 激活时聊天子树根本不存在（不再靠 inert/transform 遮蔽）
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);

    fireEvent.change(detail, { target: { value: 'detail draft' } });
    detail.focus();

    act(() => usePanelStore.getState().openChat());
    // S2b：聊天整屏化 —— 面板不再渲染 chat，openChat 清空面板并切 navStore
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
    expect(useNavStore.getState().view).toBe('chat');
    // 面板走退出过渡后整块卸载：子树（含 detail）随之消失
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    expect(screen.queryAllByTestId('detail-panel-view')).toHaveLength(0);

    // 详情未保存的编辑态随重挂载回到服务端初值；openDetail 会顺手把主区切回看板
    act(() => usePanelStore.getState().openDetail('issue-1'));
    expect(screen.getAllByTestId('detail-panel-view')).toHaveLength(1);
    expect(screen.queryAllByTestId('chat-panel-view')).toHaveLength(0);
    expect(useNavStore.getState().view).toBe('board');

    // 关闭整块卸载：焦点回触发元素
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'fake-trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    act(() => usePanelStore.getState().openDetail('issue-1'));
    fireEvent.click(screen.getByTestId('right-panel-close'));
    expect(screen.getByTestId('right-panel')).toHaveAttribute('data-panel-state', 'leaving');
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    trigger.remove();

    act(() => usePanelStore.getState().openDetail('issue-1'));
    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '420px' });
    expect(screen.getByTestId('right-panel')).toHaveStyle({ maxWidth: 'calc(100vw - 1rem)' });
    expect(screen.getByTestId('right-panel-content')).not.toHaveAttribute('inert');
    expect(screen.getByRole('heading', { name: '任务详情' })).toHaveFocus();
  });

  it('左缘拖拽手柄不跨越头部标题带（RIGHT-PANEL-HEADER-01）', () => {
    render(<RightPanel />);
    const handle = screen.getByTestId('right-resize-handle');
    const panel = screen.getByTestId('right-panel');
    const header = panel.querySelector('header')!;

    // 头部固定 40px；手柄从 top-10 起（=40px），不再是 inset-y-0 贯穿头部
    expect(header).toHaveClass('h-10');
    expect(handle.className).toContain('top-10');
    expect(handle.className).toContain('bottom-0');
    expect(handle.className).not.toContain('inset-y-0');
    // 手柄仍在内容区可聚焦可调宽
    expect(handle).toHaveAttribute('tabindex', '0');
  });
});



