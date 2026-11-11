/**
 * SETTINGS-TRAVEL：猫猫旅行自动回收开关。
 * 断言：读 GET /api/settings 显示真实值（缺省 true）；点击只 PATCH travelAutoRecover；
 * 请求失败保留原值并显示错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { TravelAutoRecoverSection } from '../components/settings/TravelAutoRecoverSection';
import { server } from './server';

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TravelAutoRecoverSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe('TravelAutoRecoverSection', () => {
  it('读取 settings.travelAutoRecover=true 时开关为开启', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ port: 8787, maxConcurrentTurns: 3, travelAutoRecover: true })),
    );
    renderSection();
    const toggle = await screen.findByTestId('settings-travel-auto-recover');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('自动回收猫猫旅行')).toBeInTheDocument();
  });

  it('点击后只 PATCH travelAutoRecover，并按新值回读', async () => {
    let patched: unknown = null;
    let current = true;
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ travelAutoRecover: current })),
      http.patch('/api/settings', async ({ request }) => {
        patched = await request.json();
        current = false;
        return HttpResponse.json({ travelAutoRecover: current });
      }),
    );
    renderSection();
    const toggle = await screen.findByTestId('settings-travel-auto-recover');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(toggle);

    await waitFor(() => expect(patched).toEqual({ travelAutoRecover: false }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('PATCH 失败时保留原值并显示错误', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ travelAutoRecover: true })),
      http.patch('/api/settings', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: '写入失败' } }, { status: 500 }),
      ),
    );
    renderSection();
    const toggle = await screen.findByTestId('settings-travel-auto-recover');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(toggle);

    expect(await screen.findByTestId('settings-travel-save-error')).toHaveTextContent('写入失败');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
