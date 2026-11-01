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
import { setTheme } from '../theme';
import { server } from './server';

const settingsPayload = { port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 2 };

function renderSettings(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
});
