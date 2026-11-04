/**
 * SYS1（I-02/I-09）：详情浮窗与导航视图解耦 —— 切到知识库/日志时自动收起，
 * 回到看板不强行重开；知识页里点任务软链接则把主区切回看板，浮窗跟随详情。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { usePanelStore } from '../state/panelStore';
import { useNavStore } from '../state/navStore';

vi.mock('../components/detail/DetailPanel', () => ({
  DetailPanel: () => <div data-testid="stub-detail-panel">detail-body</div>,
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

beforeEach(() => {
  localStorage.clear();
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null });
});

describe('详情浮窗与导航视图解耦（SYS1）', () => {
  it('打开详情后切到知识库：浮窗自动收起，主区不再被覆盖', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openDetail('iss-1'));
    expect(await screen.findByRole('heading', { name: '任务详情' })).toBeInTheDocument();

    act(() => useNavStore.getState().setView('knowledge'));
    await waitFor(() => expect(usePanelStore.getState().view).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    expect(useOverlayStore.getState().right).toBe(false);
  });

  it('切到日志同样收起；回到看板不强行重开详情', async () => {
    renderPanel();
    act(() => usePanelStore.getState().openDetail('iss-1'));
    await screen.findByRole('heading', { name: '任务详情' });

    act(() => useNavStore.getState().setView('log'));
    await waitFor(() => expect(usePanelStore.getState().view).toBeNull());

    act(() => useNavStore.getState().setView('board'));
    expect(usePanelStore.getState().view).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
  });

  it('任务树仍可开详情；知识页内点任务链接会切回看板并保留详情', async () => {
    renderPanel();
    act(() => useNavStore.getState().setView('tree'));
    act(() => usePanelStore.getState().openDetail('iss-1'));
    expect(await screen.findByRole('heading', { name: '任务详情' })).toBeInTheDocument();

    act(() => usePanelStore.getState().clearView());
    act(() => useNavStore.getState().setView('knowledge'));
    act(() => usePanelStore.getState().openDetail('iss-2'));
    expect(await screen.findByRole('heading', { name: '任务详情' })).toBeInTheDocument();
    expect(useNavStore.getState().view).toBe('board');
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'iss-2' });
  });
});
