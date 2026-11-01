import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliInfo, Workspace } from '@agentboard/shared';
import { TopBar } from '../components/topbar/TopBar';
import { RightPanel } from '../components/right/RightPanel';
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

function renderTopBar(workspace: Workspace | null, withPanel = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  it('CLI 徽标两态：已装绿点带版本，未装灰', async () => {
    server.use(http.get('/api/clis', () => HttpResponse.json(clisMixed)));
    renderTopBar(null);

    const installed = await screen.findByTitle('CodeBuddy 2.0.0');
    expect(installed.querySelector('[data-installed="true"]')).not.toBeNull();
    const missing = screen.getByTitle('Codex 未安装');
    expect(missing.querySelector('[data-installed="true"]')).toBeNull();
    expect(missing.querySelector('[data-installed="false"]')).not.toBeNull();
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

  it('未选工作空间时新建 issue 禁用，选中后可用', async () => {
    const first = renderTopBar(null);
    expect(screen.getByRole('button', { name: '新建 issue' })).toBeDisabled();
    first.unmount();

    renderTopBar(ws);
    expect(screen.getByRole('button', { name: '新建 issue' })).toBeEnabled();
    expect(screen.getByText('主项目')).toBeInTheDocument();
    expect(screen.getByText('D:/WorkSpaces/main')).toBeInTheDocument();
  });

  it('WS 状态点反映连接状态', async () => {
    useAppStore.setState({ wsStatus: 'open' });
    renderTopBar(null);
    expect(screen.getByText('已连接')).toBeInTheDocument();

    useAppStore.setState({ wsStatus: 'closed' });
    await waitFor(() => expect(screen.getByText('已断开')).toBeInTheDocument());
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

    // 初始（view=null）：右侧收起窄条渲染且文字含"聊天"，展开面板不存在
    const strip = screen.getByTestId('right-panel-collapsed');
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent('聊天');
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '聊天' }));
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-empty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '聊天' })).toBeInTheDocument();
  });
});
