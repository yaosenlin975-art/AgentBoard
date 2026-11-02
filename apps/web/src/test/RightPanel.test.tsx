import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RightPanel } from '../components/right/RightPanel';
import { usePanelStore } from '../state/panelStore';

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
  const { useState } = await import('react');
  return {
    ChatPanel: () => {
      const [draft, setDraft] = useState('');
      return (
        <input
          data-testid="chat-draft"
          aria-label="聊天草稿"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
    expect(panel).toHaveClass('transition-none');

    fireEvent.pointerUp(window, { button: 0, clientX: 180 });
    expect(panel).toHaveClass('transition-[width]');
    expect(localStorage.getItem('agentboard.right-panel-width')).toBe('440');
  });

  it('slides without covering the layout and restores chat/detail drafts and focus', () => {
    render(<RightPanel />);
    const detail = screen.getByTestId('detail-draft');
    const chat = screen.getByTestId('chat-draft');

    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '420px' });
    expect(screen.getByTestId('right-panel-content')).toHaveClass('motion-reduce:transition-none');
    expect(screen.getByTestId('chat-panel-view')).toHaveAttribute('inert');
    expect(screen.getByTestId('chat-panel-view')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.change(detail, { target: { value: 'detail draft' } });
    detail.focus();
    act(() => usePanelStore.getState().openChat());
    expect(screen.getByTestId('detail-panel-view')).toHaveAttribute('inert');
    expect(screen.getByTestId('chat-panel-view')).not.toHaveAttribute('inert');

    fireEvent.change(chat, { target: { value: 'chat draft' } });
    chat.focus();
    act(() => usePanelStore.getState().openDetail('issue-1'));
    expect(detail).toHaveValue('detail draft');
    expect(detail).toHaveFocus();

    // PANEL-ENTRY2：不再有「收起成窄条」状态；关闭 = 整块卸载，重开由入口（任务卡/顶栏聊天）触发
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'fake-trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    fireEvent.click(screen.getByTestId('right-panel-close'));
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    expect(trigger).toHaveFocus();
    trigger.remove();

    act(() => usePanelStore.getState().openDetail('issue-1'));
    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '420px' });
    // 浮窗模型：宽度上限改为 100vw - 1rem（左右各留 8px），不再是 40px 窄条口径
    expect(screen.getByTestId('right-panel')).toHaveStyle({ maxWidth: 'calc(100vw - 1rem)' });
    expect(screen.getByTestId('right-panel-content')).not.toHaveAttribute('inert');
    expect(detail).toHaveValue('detail draft');
    expect(chat).toHaveValue('chat draft');
    // 关闭会卸载整块，旧焦点元素已不在文档内 → 重开时焦点落在浮窗标题（可读、可继续 Tab）
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



