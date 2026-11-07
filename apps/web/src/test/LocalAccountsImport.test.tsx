/**
 * ACC-REFRESH：设置面板首次可用时前端自动刷新一次（服务端仍无启动/定时扫描）。
 *
 * 口径：
 * - 只触发一次：StrictMode 双挂载、卸载后重挂载都不重复扫描；
 * - 启动失败静默、不重试；手动刷新失败才显示可解释原因；
 * - 手动刷新按钮 busy 态禁用，文案为「刷新 / 刷新中…」。
 */
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import {
  LocalAccountsImport,
  resetLocalAccountsStartupRefreshForTests,
} from '../components/settings/LocalAccountsImport';
import { server } from './server';

const OK_RESULT = {
  batch_id: 'auto-1',
  actor: 'web',
  duration_ms: 3,
  platforms: [
    { platform: 'workbuddy', app_id: 'workbuddy_desktop', found: 0, created: 0, updated: 0, skipped: 0, error: null },
    { platform: 'minimax', app_id: 'minimax', found: 0, created: 0, updated: 0, skipped: 0, error: null },
    { platform: 'trae', app_id: 'trae', found: 0, created: 0, updated: 0, skipped: 0, error: null },
  ],
  accounts: [],
  error: null,
};

function renderImport(strict = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <LocalAccountsImport />
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui);
}

beforeEach(() => {
  resetLocalAccountsStartupRefreshForTests();
});

describe('ACC-REFRESH', () => {
  it('启动自动刷新在 StrictMode 双挂载与重挂载下只触发一次', async () => {
    let calls = 0;
    server.use(http.post('/api/accounts/import-credentials', () => {
      calls += 1;
      return HttpResponse.json(OK_RESULT);
    }));

    const first = renderImport(true);
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);

    first.unmount();
    renderImport();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
  });

  it('按钮文案为「刷新」，手动刷新时 busy 态禁用', async () => {
    let calls = 0;
    server.use(http.post('/api/accounts/import-credentials', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return HttpResponse.json(OK_RESULT);
    }));

    renderImport();
    await waitFor(() => expect(calls).toBe(1));

    const button = screen.getByTestId('accounts-import-local');
    expect(button).toHaveTextContent('刷新');
    // ACC-UI-PRUNE：刷新旁说明文案已删
    expect(screen.queryByText(/启动时自动扫描一次，也可手动刷新/)).toBeNull();

    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('刷新中…');
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('启动失败静默、不重试，也不弹错误提示', async () => {
    let calls = 0;
    server.use(http.post('/api/accounts/import-credentials', () => {
      calls += 1;
      return HttpResponse.json({ error: { code: 'PYTHON_UNAVAILABLE', message: 'python missing' } }, { status: 503 });
    }));

    renderImport();
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(screen.queryByTestId('accounts-import-error')).toBeNull();
  });

  it('手动刷新失败有可见提示（与启动静默区分）', async () => {
    let calls = 0;
    server.use(http.post('/api/accounts/import-credentials', () => {
      calls += 1;
      return HttpResponse.json({ error: { code: 'PYTHON_UNAVAILABLE', message: 'python missing' } }, { status: 503 });
    }));

    renderImport();
    await waitFor(() => expect(calls).toBe(1));
    expect(screen.queryByTestId('accounts-import-error')).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-import-local'));
    const error = await screen.findByTestId('accounts-import-error');
    expect(error).toHaveTextContent('刷新失败');
    expect(error).toHaveTextContent('本机未找到 python，无法读取本机账号');
    expect(error.textContent).not.toContain('python missing');
  });
});
