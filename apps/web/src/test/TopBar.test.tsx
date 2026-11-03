import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliInfo, Workspace, WorkspaceChangeLog } from '@agentboard/shared';
import { TopBar } from '../components/topbar/TopBar';
import { RightPanel } from '../components/right/RightPanel';
import { WEB_VERSION } from '../api/version';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };

const clisMixed: CliInfo[] = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0', supportsModelSelection: true },
  { id: 'codex', displayName: 'Codex', installed: false, version: null, supportsModelSelection: true },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null, supportsModelSelection: true },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null, supportsModelSelection: false },
];

function renderTopBar(
  workspace: Workspace | null,
  withPanel = false,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <TopBar workspace={workspace} />
      {withPanel && <RightPanel />}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  useAppStore.setState({ wsStatus: 'connecting' });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    rightOpen: false,
  });
});

describe('TopBar', () => {

  it('TOPBAR-CLEAN：不再渲染 CLI 徽标（CodeBuddy / Codex / OpenCode / DSH 都不出现）', async () => {
    server.use(http.get('/api/clis', () => HttpResponse.json(clisMixed)));
    renderTopBar(null);
    await waitFor(() => expect(screen.queryByTitle('CodeBuddy 2.0.0')).toBeNull());
    for (const cli of clisMixed) {
      expect(screen.queryByTitle(cli.displayName)).toBeNull();
      expect(screen.queryByText(cli.displayName)).toBeNull();
    }
    expect(document.querySelector('[data-installed]')).toBeNull();
  });

  it('主题切换按钮循环 system → light → dark 并写 localStorage', async () => {
    renderTopBar(null);
    const btn = screen.getByRole('button', { name: '切换主题' });
    expect(btn).toHaveTextContent('主题：跟随系统');

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('light');
    expect(btn).toHaveTextContent('主题：亮色');
    expect(document.documentElement).not.toHaveClass('dark');

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('dark');
    expect(btn).toHaveTextContent('主题：暗色');
    expect(document.documentElement).toHaveClass('dark');

    await userEvent.click(btn);
    expect(localStorage.getItem('agentboard.theme')).toBe('system');
    expect(btn).toHaveTextContent('主题：跟随系统');
  });

  it('顶栏不再有「新建 issue」按钮（NEW-ISSUE-PLUS 已移到待规划列头）', () => {
    const first = renderTopBar(null);
    expect(screen.queryByRole('button', { name: '新建 issue' })).toBeNull();
    first.unmount();

    renderTopBar(ws);
    expect(screen.queryByRole('button', { name: '新建 issue' })).toBeNull();
    expect(screen.getByText('主项目')).toBeInTheDocument();
    expect(screen.getByText('D:/WorkSpaces/main')).toBeInTheDocument();
  });

  it('顶栏不再有「工作区日志」入口（LOG-VIEW 已改为知识库右侧的视图入口）', () => {
    renderTopBar(ws);
    expect(screen.queryByTestId('topbar-changelog')).toBeNull();
    expect(screen.queryByRole('button', { name: '工作区日志' })).toBeNull();
  });

  it('WS 状态点反映连接状态', async () => {
    useAppStore.setState({ wsStatus: 'open' });
    renderTopBar(null);
    // PANEL-VIEW-BUG：只保留圆点颜色编码，不再展示「已连接」等文案
    const dot = screen.getByTestId('topbar-ws-status');
    expect(dot).toHaveAttribute('data-status', 'open');
    expect(screen.queryByText('已连接')).toBeNull();

    useAppStore.setState({ wsStatus: 'closed' });
    await waitFor(() => expect(screen.getByTestId('topbar-ws-status')).toHaveAttribute('data-status', 'closed'));
    expect(screen.queryByText('已断开')).toBeNull();
  });

  it('聊天按钮：未读取各会话计数总和显示徽标，点击打开聊天视图', async () => {
    renderTopBar(null);
    // 无未读：不渲染徽标
    expect(screen.queryByTestId('topbar-chat-unread')).not.toBeInTheDocument();

    act(() => usePanelStore.setState({ unread: { s1: 2, s2: 3 } }));
    expect(screen.getByTestId('topbar-chat-unread')).toHaveTextContent('5');

    await userEvent.click(screen.getByRole('button', { name: '聊天' }));
    expect(usePanelStore.getState()).toMatchObject({ view: 'chat', rightOpen: true });
  });

  it('首次加载无交互即可达聊天：右缘常驻窄条可见，顶栏按钮打开聊天视图', async () => {
    renderTopBar(null, true);

    // PANEL-ENTRY2：不再有右缘常驻窄条；聊天入口就是顶栏按钮
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
    const chatEntry = screen.getByTestId('topbar-chat');
    expect(chatEntry).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(chatEntry);
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-empty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '聊天' })).toBeInTheDocument();
  });

  it('版本号：GET /api/version 0.1.0 → 标题旁显示 v0.1.0，title 含服务端名称与前端版本', async () => {
    server.use(
      http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' })),
    );
    renderTopBar(ws);

    const label = await screen.findByText('v0.1.0');
    expect(label).toHaveAttribute('title', expect.stringContaining('agentboard-server 0.1.0'));
    expect(label).toHaveAttribute('title', expect.stringContaining(`前端 ${WEB_VERSION}`));
  });

  it('版本号：接口不可达 → 显示 v? 且顶栏正常渲染不报错', async () => {
    server.use(http.get('/api/version', () => HttpResponse.error()));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTopBar(ws, false, qc);

    await waitFor(() => expect(qc.getQueryState(['version'])?.status).toBe('error'));
    const label = screen.getByTestId('app-version');
    expect(label).toHaveTextContent(/^v\?$/);
    expect(label).toHaveAttribute('title', expect.stringContaining('服务端版本未知'));
    expect(screen.getByText('主项目')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('版本号：与前端版本一致无警示，不一致 title 警示', async () => {
    server.use(
      http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: WEB_VERSION })),
    );
    const first = renderTopBar(null);
    const same = await screen.findByText(`v${WEB_VERSION}`);
    expect(same.getAttribute('title')).not.toContain('不一致');
    first.unmount();

    server.use(
      http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: '9.9.9' })),
    );
    renderTopBar(null);
    expect(await screen.findByText('v9.9.9')).toHaveAttribute('title', expect.stringContaining('版本不一致'));
  });
});

describe('账号管理独立入口（ACCOUNT-ENTRY）', () => {
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

  it('顶栏「账号」入口可直接打开账号管理面板（三个平台分区，无 CodeBuddy），Esc 可关', async () => {
    renderTopBar(ws);
    const entry = screen.getByTestId('topbar-accounts');
    expect(entry).toHaveTextContent('账号');
    expect(entry).toHaveAttribute('aria-label', '账号管理');

    await userEvent.click(entry);
    const dialog = await screen.findByRole('dialog', { name: '账号管理' });
    expect(within(dialog).getByText('WorkBuddy Desktop')).toBeInTheDocument();
    expect(within(dialog).getByText('MiniMax')).toBeInTheDocument();
    expect(within(dialog).getByText('Trae')).toBeInTheDocument();
    expect(within(dialog).queryByText('CodeBuddy Desktop')).toBeNull();
    // 与设置弹窗同一组件：能力来自服务端矩阵
    expect(within(dialog).getByTestId('accounts-capability-minimax')).toHaveTextContent('CLIENT_NOT_INSTALLED');
    // 顶部两个入口都在
    expect(within(dialog).getByTestId('accounts-one-click-checkin')).toBeInTheDocument();
    expect(within(dialog).getByTestId('accounts-import-local')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '账号管理' })).toBeNull());
  });

  it('未选工作空间也能打开（账号与 workspace 无关）', async () => {
    renderTopBar(null);
    const entry = screen.getByTestId('topbar-accounts');
    expect(entry).toBeEnabled();
    await userEvent.click(entry);
    expect(await screen.findByRole('dialog', { name: '账号管理' })).toBeInTheDocument();
  });
});
