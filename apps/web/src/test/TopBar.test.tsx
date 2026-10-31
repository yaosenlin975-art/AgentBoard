import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliInfo, Workspace } from '@agentboard/shared';
import { TopBar } from '../components/topbar/TopBar';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };

const clisMixed: CliInfo[] = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' },
  { id: 'codex', displayName: 'Codex', installed: false, version: null },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null },
];

function renderTopBar(workspace: Workspace | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TopBar workspace={workspace} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  useAppStore.setState({ wsStatus: 'connecting' });
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
});
