/**
 * 左栏品牌位与控件（NAV-TOPBAR-01：顶栏工作区名/路径移除，主题/聊天/账号/设置迁入左栏）。
 *
 * 迁移自原 `TopBar.test.tsx`（断言逐条保留，只改锚点与形态）：
 * - 无 CLI 徽标 / 无「新建 issue」按钮 / 无「工作区日志」入口；
 * - 工作区名 `text-xl`、路径 `text-xs + truncate + title 全路径`（顶栏不再有路径）；
 * - WS 状态圆点反映连接状态（不再展示文字）；
 * - 聊天入口徽标 = 未读合计，点击切 navStore 到 chat；
 * - 账号/设置入口走 drawer，Esc 可关。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliInfo, Workspace } from '@agentboard/shared';
import { SideBar } from '../components/shell/SideBar';
import { DrawerPanel } from '../components/drawer/DrawerPanel';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { resetOverlays } from '../state/overlayStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };

const clisMixed: CliInfo[] = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0', supportsModelSelection: true },
  { id: 'codex', displayName: 'Codex', installed: false, version: null, supportsModelSelection: true },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null, supportsModelSelection: true },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null, supportsModelSelection: false },
];

function renderSideBar(workspace: Workspace | null = ws): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SideBar workspace={workspace} />
      {/* 账号/设置面板由 DrawerPanel 渲染（左栏只负责触发） */}
      <DrawerPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  useAppStore.setState({ wsStatus: 'connecting' });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  resetOverlays();
});

describe('SideBar 品牌位与控件（NAV-TOPBAR-01）', () => {
  it('NAV-TOPBAR-01：左栏自带工作区名与路径；顶栏路径锚点已随顶栏移除', () => {
    renderSideBar(ws);
    expect(screen.getByTestId('topbar-workspace')).toHaveTextContent('主项目');
    const path = screen.getByTestId('sidebar-workspace-path');
    expect(path).toHaveTextContent('D:/WorkSpaces/main');
    // 路径完整值进 title（窄屏截断但不丢信息）
    expect(path).toHaveAttribute('title', 'D:/WorkSpaces/main');
    expect(path.className).toContain('truncate');
    expect(path.className).toContain('text-xs');
    // 旧的顶栏专属锚点不应再存在（不允许「锚点还在元素已删」的反向残留）
    expect(screen.queryByTestId('topbar-workspace-path')).toBeNull();
    // FIX-1：NAV-TOPBAR-01 的四宫格已删除，账号/设置下沉到底部，主题并入状态行
    expect(screen.queryByTestId('sidebar-controls')).toBeNull();
    const bottom = screen.getByTestId('sidebar-account-settings');
    expect(within(bottom).getByTestId('topbar-accounts')).toBeInTheDocument();
    expect(within(bottom).getByTestId('topbar-settings')).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar-status')).getByTestId('topbar-theme')).toBeInTheDocument();
  });

  it('FIX-1 结构顺序：工作空间 → 五入口 → 账号/设置 → 状态行', () => {
    renderSideBar(ws);
    const sidebar = screen.getByTestId('sidebar');
    const testids = [...sidebar.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
    const idx = (id: string): number => testids.indexOf(id);
    const workspace = idx('sidebar-workspace');
    const firstEntry = idx('sidebar-entry-board');
    const lastEntry = idx('sidebar-entry-chat');
    const bottom = idx('sidebar-account-settings');
    const status = idx('sidebar-status');
    expect(workspace).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeLessThan(firstEntry);
    expect(firstEntry).toBeLessThan(lastEntry);
    expect(lastEntry).toBeLessThan(bottom);
    expect(bottom).toBeLessThan(status);
    // 聊天入口全树唯一：没有第二个聊天按钮（四宫格里的重复入口已删）
    expect(screen.queryByTestId('topbar-chat')).toBeNull();
    expect(screen.getAllByTestId('sidebar-entry-chat')).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: '聊天' })).toHaveLength(1);
  });

  it('FIX-1 工作区浮窗锚定：品牌位容器 relative + 浮窗 absolute top-full', async () => {
    renderSideBar(ws);
    const brand = screen.getByTestId('sidebar-workspace');
    expect(brand.className).toContain('relative');
    fireEvent.click(screen.getByTestId('topbar-workspace'));
    const panel = await screen.findByTestId('workspace-sidebar');
    expect(panel.className).toContain('absolute');
    expect(panel.className).toContain('top-full');
    // 浮窗必须是品牌位的后代（相对自身定位，而不是按视口飞走）
    expect(brand.contains(panel)).toBe(true);
  });

  it('工作区标题字号加大 3 档（text-sm → text-xl，14px → 20px）', () => {
    renderSideBar(ws);
    const title = screen.getByTestId('topbar-workspace');
    expect(title.className).toContain('text-xl');
    expect(title.className).not.toContain('text-sm');
    // 路径副标题不跟着放大
    expect(screen.getByTestId('sidebar-workspace-path').className).toContain('text-xs');
  });

  it('未选工作区时显示占位文案（名称与路径都占位）', () => {
    renderSideBar(null);
    expect(screen.getByTestId('topbar-workspace')).toHaveTextContent('未选择工作区');
    const path = screen.getByTestId('sidebar-workspace-path');
    expect(path).toHaveTextContent('未选择工作区');
    expect(path).toHaveAttribute('title', '未选择工作区');
  });

  it('FIX-1 状态行：主题小字循环 system → light → dark 并写 localStorage', async () => {
    renderSideBar(ws);
    const btn = screen.getByRole('button', { name: '切换主题' });
    expect(btn).toHaveTextContent('跟随系统');
    expect(btn).toHaveAttribute('title', expect.stringContaining('主题：跟随系统'));
    // 主题小字在状态行里（与 WS 圆点同一行）
    expect(screen.getByTestId('sidebar-status').contains(btn)).toBe(true);

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('light');
    expect(btn).toHaveTextContent('浅色');
    expect(document.documentElement).not.toHaveClass('dark');

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('dark');
    expect(btn).toHaveTextContent('深色');
    expect(document.documentElement).toHaveClass('dark');

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('system');
    expect(btn).toHaveTextContent('跟随系统');
  });

  it('不再渲染 CLI 徽标（CodeBuddy / Codex / OpenCode / DSH 都不出现）', async () => {
    server.use(http.get('/api/clis', () => HttpResponse.json(clisMixed)));
    renderSideBar(null);
    await waitFor(() => expect(screen.queryByTitle('CodeBuddy 2.0.0')).toBeNull());
    for (const cli of clisMixed) {
      expect(screen.queryByTitle(cli.displayName)).toBeNull();
      expect(screen.queryByText(cli.displayName)).toBeNull();
    }
    expect(document.querySelector('[data-installed]')).toBeNull();
  });

  it('不再有「新建 issue」与「工作区日志」入口', () => {
    renderSideBar(ws);
    expect(screen.queryByRole('button', { name: '新建 issue' })).toBeNull();
    expect(screen.queryByTestId('topbar-changelog')).toBeNull();
    expect(screen.queryByRole('button', { name: '工作区日志' })).toBeNull();
    expect(screen.queryByTestId('app-version')).toBeNull();
  });

  it('WS 状态点反映连接状态（只保留圆点，无文字）', async () => {
    useAppStore.setState({ wsStatus: 'open' });
    renderSideBar(null);
    const dot = screen.getByTestId('topbar-ws-status');
    expect(dot).toHaveAttribute('data-status', 'open');
    expect(screen.queryByText('已连接')).toBeNull();

    useAppStore.setState({ wsStatus: 'closed' });
    await waitFor(() => expect(screen.getByTestId('topbar-ws-status')).toHaveAttribute('data-status', 'closed'));
    expect(screen.queryByText('已断开')).toBeNull();
  });

  it('聊天入口：徽标 = 未读合计，点击把 navStore 切到 chat（整屏聊天）', async () => {
    renderSideBar(null);
    expect(screen.queryByTestId('sidebar-chat-unread')).not.toBeInTheDocument();

    act(() => usePanelStore.setState({ unread: { s1: 2, s2: 3 } }));
    expect(screen.getByTestId('sidebar-chat-unread')).toHaveTextContent('5');

    const chatEntry = screen.getByTestId('sidebar-entry-chat');
    expect(chatEntry).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(chatEntry);
    expect(useNavStore.getState().view).toBe('chat');
    expect(usePanelStore.getState()).toMatchObject({ view: null, rightOpen: false });
    expect(chatEntry).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('账号管理入口（ACCOUNT-ENTRY，迁到左栏）', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static' },
        { app_id: 'minimax', capture: true, switch: false, checkin: false, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', reason_code: 'CLIENT_NOT_INSTALLED', source: 'static' },
        { app_id: 'trae', capture: false, switch: false, checkin: false, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'static' },
      ])),
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
    );
  });

  it('「账号」入口打开账号抽屉（三个平台分区，无 CodeBuddy），Esc 可关', async () => {
    renderSideBar(ws);
    const entry = screen.getByTestId('topbar-accounts');
    expect(entry).toHaveTextContent('账号');
    expect(entry).toHaveAttribute('aria-label', '账号管理');

    await userEvent.click(entry);
    const drawer = await screen.findByTestId('drawer-panel');
    expect(drawer).toHaveAttribute('data-drawer', 'accounts');
    expect(entry).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByText('WorkBuddy Desktop')).toBeInTheDocument();
    expect(within(drawer).getByText('MiniMax')).toBeInTheDocument();
    expect(within(drawer).getByText('Trae')).toBeInTheDocument();
    expect(within(drawer).queryByText('CodeBuddy Desktop')).toBeNull();
    expect(within(drawer).getByTestId('accounts-capability-minimax')).toHaveTextContent('CLIENT_NOT_INSTALLED');
    expect(within(drawer).getByTestId('accounts-one-click-checkin')).toBeInTheDocument();
    expect(within(drawer).getByTestId('accounts-import-local')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useNavStore.getState().drawer).toBeNull());
    expect(entry).toHaveAttribute('aria-expanded', 'false');
  });

  it('未选工作空间也能打开（账号与 workspace 无关）', async () => {
    renderSideBar(null);
    const entry = screen.getByTestId('topbar-accounts');
    expect(entry).toBeEnabled();
    await userEvent.click(entry);
    expect(await screen.findByTestId('drawer-panel')).toHaveAttribute('data-drawer', 'accounts');
  });
});
