/**
 * SettingsDialog 测试（issue 65898a1b）：打开拉取接口值回填、保存发 PATCH、
 * 服务端 400 展示错误且不关闭、主题三选项即时生效（html.dark + localStorage）并同步选中态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SettingsDialog } from '../components/topbar/SettingsDialog';
import { WEB_VERSION } from '../api/version';
import { setTheme } from '../theme';
import { server } from './server';

const settingsPayload = { port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 2 };

function renderSettings(
  onClose = vi.fn(),
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): ReturnType<typeof vi.fn> {
  render(
    <QueryClientProvider client={qc}>
      <SettingsDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setTheme('system'); // 归一主题单一状态源（同步 currentTheme + 移除 dark class）
  // 设置页内含账号管理区（ACC-08）：默认给出空列表，避免该区的读取失败混进「无错误提示」类断言
  server.use(http.get('/api/managed-accounts', () => HttpResponse.json([])));
  server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json([
    { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false, reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static' },
  ])));
});

describe('SettingsDialog', () => {
  it('打开拉取 GET /api/settings 并回填端口/并发上限/DB 路径', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(settingsPayload)));
    renderSettings();

    expect(await screen.findByDisplayValue('9000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('D:\\db\\a.db')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2')).toBeInTheDocument();
  });

  it('保存发送 PATCH 请求体并静默关闭', async () => {
    let patched: unknown = null;
    server.use(
      http.get('/api/settings', () => HttpResponse.json(settingsPayload)),
      http.patch('/api/settings', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ ...settingsPayload, maxConcurrentTurns: 1 });
      }),
    );
    const onClose = renderSettings();
    await screen.findByDisplayValue('9000');

    await userEvent.clear(screen.getByTestId('settings-max-turns'));
    await userEvent.type(screen.getByTestId('settings-max-turns'), '1');
    await userEvent.click(screen.getByTestId('settings-save'));

    await waitFor(() =>
      expect(patched).toEqual({ port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 1 }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('服务端 400 → 展示服务端错误信息且不关闭', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json(settingsPayload)),
      http.patch('/api/settings', () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'port: 端口必须为 1-65535 的整数' } },
          { status: 400 },
        ),
      ),
    );
    const onClose = renderSettings();
    await screen.findByDisplayValue('9000');

    await userEvent.clear(screen.getByTestId('settings-port'));
    await userEvent.type(screen.getByTestId('settings-port'), '0');
    await userEvent.click(screen.getByTestId('settings-save'));

    expect(await screen.findByTestId('settings-error')).toHaveTextContent('端口必须为 1-65535 的整数');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('主题三选项即时切换、写 localStorage 且选中态同步', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(settingsPayload)));
    renderSettings();
    await screen.findByDisplayValue('9000');

    await userEvent.click(screen.getByTestId('theme-dark'));
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('agentboard.theme')).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');

    await userEvent.click(screen.getByTestId('theme-light'));
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('agentboard.theme')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');

    await userEvent.click(screen.getByTestId('theme-system'));
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('agentboard.theme')).toBe('system');
    // jsdom matchMedia 不命中深色 → 跟随系统无 dark class
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('底部显示服务端版本（GET /api/version）与前端版本', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json(settingsPayload)),
      http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' })),
    );
    renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId('settings-version')).toHaveTextContent(`服务端 0.1.0 · 前端 ${WEB_VERSION}`),
    );
  });

  it('版本接口失败 → 显示「服务端 ?」，设置照常读取且无错误提示', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json(settingsPayload)),
      http.get('/api/version', () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, { status: 404 }),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderSettings(vi.fn(), qc);

    expect(await screen.findByDisplayValue('9000')).toBeInTheDocument();
    await waitFor(() => expect(qc.getQueryState(['version'])?.status).toBe('error'));
    expect(screen.getByTestId('settings-version')).toHaveTextContent(`服务端 ? · 前端 ${WEB_VERSION}`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
it('设置里不再混入账号管理内容（SETTINGS-CLEAN）：无 accounts-* 节点', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(settingsPayload)));
    renderSettings();
    await screen.findByDisplayValue('9000');

    // 账号管理的唯一入口是顶栏「账号」按钮（TopBar ACCOUNT-ENTRY 用例覆盖）；
    // 设置弹窗内不得出现账号管理面板的任何节点
    expect(document.querySelectorAll('[data-testid^="accounts-"]').length).toBe(0);
    expect(screen.queryByTestId('accounts-one-click-checkin')).toBeNull();
    expect(screen.queryByTestId('accounts-import-local')).toBeNull();
    // 设置自身内容仍在（不是靠整块卸载来「清理」）
    expect(screen.getByTestId('settings-save')).toBeInTheDocument();
    expect(screen.getByTestId('settings-version')).toBeInTheDocument();
  });
});