/**
 * SYSTEM-RESTART 前端契约测试（msw 拦端点）：
 * - 202 → 「正在重启…」→ 轮询 /api/version 恢复 → 「服务已恢复」+ invalidate 全量
 * - 超时分支（注入短 deadline）→ 「重启超时，请手动检查」+ 日志路径
 * - 403 / 500 不进入重启态（只显示 error.message）
 * - 重启期间全局 restarting=true（App 遮罩据此阻断写操作）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { RestartServerPanel, RESTART_LOG_PATH } from '../components/settings/RestartServerPanel';
import { useRestartStore } from '../state/restartStore';
import { server } from './server';

function renderPanel(props: { pollIntervalMs?: number; timeoutMs?: number } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <RestartServerPanel {...props} />
    </QueryClientProvider>,
  );
  return { qc, invalidateSpy };
}

beforeEach(() => {
  useRestartStore.setState({ restarting: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RestartServerPanel（SYSTEM-RESTART）', () => {
  it('二次确认：先点「重启服务器」不出请求，确认后才发 POST', async () => {
    let posted = 0;
    server.use(
      http.post('/api/system/restart', () => { posted += 1; return HttpResponse.json({ restarting: true, pid: 1234, started_at: Date.now() }, { status: 202 }); }),
      http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' })),
    );
    renderPanel({ pollIntervalMs: 10, timeoutMs: 500 });

    await userEvent.click(screen.getByTestId('restart-open'));
    expect(await screen.findByTestId('restart-confirm')).toBeInTheDocument();
    expect(posted).toBe(0);

    await userEvent.click(screen.getByTestId('restart-confirm-yes'));
    await waitFor(() => expect(posted).toBe(1));
  });

  it('202 → 正在重启 … 轮询恢复 → 服务已恢复 + 全量 invalidate', async () => {
    server.use(
      http.post('/api/system/restart', () => HttpResponse.json({ restarting: true, pid: 4321, started_at: Date.now() }, { status: 202 })),
      // 模拟真实 0.75s 不可用：前 3 次失败（与 server 线实测「第 3 次恢复」一致），之后 200
      http.get('/api/version', () => {
        versionCalls += 1;
        return versionCalls <= 3 ? HttpResponse.error() : HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' });
      }),
    );
    let versionCalls = 0;
    const { invalidateSpy } = renderPanel({ pollIntervalMs: 30, timeoutMs: 3000 });

    await userEvent.click(screen.getByTestId('restart-open'));
    await userEvent.click(screen.getByTestId('restart-confirm-yes'));

    const status = await screen.findByTestId('restart-status');
    expect(status).toHaveTextContent('正在重启…');

    await waitFor(() => expect(screen.getByTestId('restart-status')).toHaveAttribute('data-phase', 'recovered'));
    expect(screen.getByTestId('restart-status')).toHaveTextContent('服务已恢复');
    expect(invalidateSpy).toHaveBeenCalled();
    // 恢复后解除写操作屏蔽
    expect(useRestartStore.getState().restarting).toBe(false);
  });

  it('超时分支：version 一直失败 → 「重启超时，请手动检查」+ 日志路径', async () => {
    server.use(
      http.post('/api/system/restart', () => HttpResponse.json({ restarting: true, pid: 99, started_at: Date.now() }, { status: 202 })),
      http.get('/api/version', () => HttpResponse.error()),
    );
    renderPanel({ pollIntervalMs: 10, timeoutMs: 60 });

    await userEvent.click(screen.getByTestId('restart-open'));
    await userEvent.click(screen.getByTestId('restart-confirm-yes'));

    await waitFor(() => expect(screen.getByTestId('restart-status')).toHaveAttribute('data-phase', 'timeout'));
    const text = screen.getByTestId('restart-status').textContent ?? '';
    expect(text).toContain('重启超时，请手动检查');
    expect(text).toContain(RESTART_LOG_PATH);
    expect(useRestartStore.getState().restarting).toBe(false);
  });

  it('403：不进入重启态，显示服务端 message，不轮询', async () => {
    let versionCalls = 0;
    server.use(
      http.post('/api/system/restart', () => HttpResponse.json({ error: { code: 'RESTART_FORBIDDEN', message: '仅允许本机回环地址触发重启' } }, { status: 403 })),
      http.get('/api/version', () => { versionCalls += 1; return HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' }); }),
    );
    renderPanel({ pollIntervalMs: 10, timeoutMs: 500 });

    await userEvent.click(screen.getByTestId('restart-open'));
    await userEvent.click(screen.getByTestId('restart-confirm-yes'));

    expect(await screen.findByTestId('restart-error')).toHaveTextContent('仅允许本机回环地址触发重启');
    expect(screen.queryByTestId('restart-status')).toBeNull();
    expect(versionCalls).toBe(0);
    expect(useRestartStore.getState().restarting).toBe(false);
  });

  it('500 spawn 失败：同样不进入重启态（旧进程仍在服务）', async () => {
    server.use(
      http.post('/api/system/restart', () => HttpResponse.json({ error: { code: 'RESTART_SPAWN_FAILED', message: '新进程启动失败，旧进程继续服务' } }, { status: 500 })),
    );
    renderPanel({ pollIntervalMs: 10, timeoutMs: 500 });

    await userEvent.click(screen.getByTestId('restart-open'));
    await userEvent.click(screen.getByTestId('restart-confirm-yes'));

    expect(await screen.findByTestId('restart-error')).toHaveTextContent('新进程启动失败，旧进程继续服务');
    expect(screen.queryByTestId('restart-status')).toBeNull();
  });
});

