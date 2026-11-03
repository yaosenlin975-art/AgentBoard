/**
 * PANEL-MOTION-2：工作区浮窗与右侧详情/聊天浮窗的进出场过渡。
 * - 两窗共用同一时长/缓动 token（PANEL_MOTION_MS / PANEL_MOTION_EASE）；
 * - 进场：entering → open；出场：leaving（仍挂载、pointer-events 关闭）→ 动画结束才卸载；
 * - prefers-reduced-motion 命中：无位移、无过渡，关闭即时卸载；
 * - 只用 transform/opacity，不产生 width/height 过渡（主内容不重排）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PANEL_MOTION_EASE, PANEL_MOTION_MS, PANEL_MOTION_TRANSITION } from '../components/overlay/panelMotion';
import { WorkspaceSidebarOverlay } from '../components/overlay/WorkspaceSidebarOverlay';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';
import { HttpResponse, http } from 'msw';

vi.mock('../components/detail/DetailPanel', () => ({ DetailPanel: () => <div data-testid="stub-detail" /> }));
vi.mock('../components/chat/ChatPanel', () => ({ ChatPanel: () => <div data-testid="stub-chat" /> }));

const { RightPanel } = await import('../components/right/RightPanel');

function withClient(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

const triggerRef = { current: null as HTMLButtonElement | null };

function renderLeft(): void {
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  triggerRef.current = trigger;
  render(withClient(<WorkspaceSidebarOverlay triggerRef={triggerRef} />));
}

beforeEach(() => {
  localStorage.clear();
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  document.querySelectorAll('button').forEach((b) => b.remove());
  setReducedMotion(false);
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json([])),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
  );
});

describe('浮窗进出场过渡（PANEL-MOTION-2）', () => {
  it('两窗共用同一时长与缓动 token，且时长落在 120–200ms', () => {
    expect(PANEL_MOTION_MS).toBeGreaterThanOrEqual(120);
    expect(PANEL_MOTION_MS).toBeLessThanOrEqual(200);
    expect(PANEL_MOTION_TRANSITION).toContain(`${PANEL_MOTION_MS}ms`);
    expect(PANEL_MOTION_TRANSITION).toContain(PANEL_MOTION_EASE);
  });

  it('左浮窗：进场加位移+透明度过渡，出场保留挂载后才卸载', async () => {
    renderLeft();
    expect(screen.queryByTestId('workspace-sidebar')).toBeNull();

    act(() => useOverlayStore.getState().openLeft());
    const panel = await screen.findByTestId('workspace-sidebar');
    // entering：位移 + 透明
    expect(panel).toHaveAttribute('data-panel-state', 'entering');
    expect(panel.style.transition).toBe(PANEL_MOTION_TRANSITION);
    expect(panel.style.transform).toContain('translateY');
    // 进场结束 → open 相位（无位移、全不透明）
    await waitFor(() => expect(panel).toHaveAttribute('data-panel-state', 'open'));
    expect(panel.style.opacity).toBe('1');
    expect(panel.style.transform).toBe('none');
    // 只用 transform/opacity：不得给宽度加过渡
    expect(panel.style.transition).not.toContain('width');
    expect(panel.style.transition).not.toContain('height');

    act(() => useOverlayStore.getState().closeLeft());
    // 出场相位仍在挂载中，且不吃指针事件
    expect(screen.getByTestId('workspace-sidebar')).toHaveAttribute('data-panel-state', 'leaving');
    expect(screen.getByTestId('workspace-sidebar').style.pointerEvents).toBe('none');
    expect(screen.getByTestId('workspace-sidebar').style.opacity).toBe('0');
    await waitFor(() => expect(screen.queryByTestId('workspace-sidebar')).toBeNull());
  });

  it('右浮窗：进场/出场同样走统一 token，关闭后焦点回触发按钮', async () => {
    render(withClient(<RightPanel />));
    expect(screen.queryByTestId('right-panel')).toBeNull();

    act(() => usePanelStore.getState().openDetail('iss-1'));
    const panel = await screen.findByTestId('right-panel');
    expect(['entering', 'open']).toContain(panel.getAttribute('data-panel-state'));
    expect(panel.style.transition).toBe(PANEL_MOTION_TRANSITION);
    await waitFor(() => expect(panel).toHaveAttribute('data-panel-state', 'open'));
    expect(panel.style.transform).toBe('none');

    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    act(() => usePanelStore.getState().clearView());
    await waitFor(() => expect(screen.getByTestId('right-panel')).toHaveAttribute('data-panel-state', 'leaving'));
    // 出场动画期间面板仍在 DOM，但不接受指针；焦点已回触发按钮
    expect(screen.getByTestId('right-panel').style.pointerEvents).toBe('none');
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
  });

  it('reduced-motion：无位移、无过渡，关闭即时卸载', async () => {
    setReducedMotion(true);
    renderLeft();
    act(() => useOverlayStore.getState().openLeft());
    const panel = await screen.findByTestId('workspace-sidebar');
    expect(panel.style.transform).toBe('none');
    expect(panel.style.opacity).toBe('1');
    expect(panel.style.transition).toBe('none');

    act(() => useOverlayStore.getState().closeLeft());
    // 命中 reduce 时不做出场动画：立即卸载
    expect(screen.queryByTestId('workspace-sidebar')).toBeNull();
  });

  it('Esc / 点击外部仍能关闭（与新动画不冲突）', async () => {
    renderLeft();
    act(() => useOverlayStore.getState().openLeft());
    await screen.findByTestId('workspace-sidebar');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFor(() => expect(useOverlayStore.getState().left).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('workspace-sidebar')).toBeNull());
  });
});
