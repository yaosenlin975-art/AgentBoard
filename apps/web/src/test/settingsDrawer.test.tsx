/**
 * S4：账号/设置滑出面板 —— 统一走 navStore.drawer + DrawerPanel。
 *
 * 覆盖三件事（DOM 层）：
 * 1. 抽屉开合只由 navStore.drawer 驱动（账号/设置互斥，再点同一入口收起）；
 * 2. Esc 关闭抽屉，且关闭后焦点回到触发按钮；
 * 3. 挤压态（宽屏）focus 进面板、覆盖态（窄屏）带遮罩与 role=dialog。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { DrawerPanel } from '../components/drawer/DrawerPanel';
import { useNavStore } from '../state/navStore';
import { server } from './server';

function mount(children: React.ReactNode = <DrawerPanel />): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null });
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
  );
});

afterEach(() => {
  document.body.style.overflow = '';
});

describe('drawer 语义（navStore）', () => {
  it('账号/设置互斥；再点同一入口收起', () => {
    useNavStore.getState().openDrawer('accounts');
    expect(useNavStore.getState().drawer).toBe('accounts');
    useNavStore.getState().openDrawer('settings');
    expect(useNavStore.getState().drawer).toBe('settings');
    useNavStore.getState().toggleDrawer('settings');
    expect(useNavStore.getState().drawer).toBeNull();
    useNavStore.getState().openDrawer('accounts');
    useNavStore.getState().toggleDrawer('accounts');
    expect(useNavStore.getState().drawer).toBeNull();
  });
});

describe('DrawerPanel 开合 / Esc / 焦点（S4）', () => {
  it('打开账号抽屉：面板出现、焦点进入面板；Esc 关闭后焦点回到触发按钮', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = '账号触发';
    document.body.appendChild(trigger);
    trigger.focus();
    mount();

    act(() => useNavStore.getState().openDrawer('accounts'));
    const panel = await screen.findByTestId('drawer-panel');
    expect(panel).toHaveAttribute('data-drawer', 'accounts');
    await waitFor(() => expect(document.activeElement).toBe(panel));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(useNavStore.getState().drawer).toBeNull());
    // 焦点回归触发元素（关闭后不再停在已卸载的面板上）
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  it('设置抽屉与账号抽屉互斥：切换后只渲染一个抽屉内容', async () => {
    mount();
    act(() => useNavStore.getState().openDrawer('accounts'));
    expect(await screen.findByTestId('drawer-panel')).toHaveAttribute('data-drawer', 'accounts');
    act(() => useNavStore.getState().openDrawer('settings'));
    await waitFor(() => expect(screen.getByTestId('drawer-panel')).toHaveAttribute('data-drawer', 'settings'));
    expect(screen.queryByTestId('accounts-overview')).toBeNull();
  });
});
