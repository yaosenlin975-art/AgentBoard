/**
 * accounts-add-flow：全局「添加账号」供应商选择页。
 *
 * 断言口径：
 * - 8 卡平铺；「授权添加」只出现在服务端装配了协议的平台，「读取本机」只出现在 import-credentials 支持的平台；
 * - Command Code 进入 CLI 来源详情；DeepSeek / Codex 没有可用接口 → 只给原因，不出按钮；
 * - 打开后焦点落第一张卡的第一个按钮；
 * - 读取本机按平台限定调用 import-credentials，并回显「发现/新增/已存在」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AddAccountProtocolInfo } from '@agentboard/shared';
import { AddAccountPicker } from '../components/settings/AddAccountPicker';
import { server } from './server';

const PROTOCOLS: AddAccountProtocolInfo[] = [
  { app_id: 'workbuddy_desktop', protocol: 'workbuddy_oneid', provider_version: '1', requires_browser: true, regions: ['cn'] },
  { app_id: 'minimax', protocol: 'minimax_device', provider_version: '1', requires_browser: true, regions: ['cn', 'global'] },
  { app_id: 'trae', protocol: 'trae_oauth', provider_version: '1', requires_browser: true, regions: ['cn', 'global'] },
  { app_id: 'qoder_cn', protocol: 'qoder_device', provider_version: '1', requires_browser: true, regions: ['global'] },
  { app_id: 'zcode', protocol: 'zcode_cli', provider_version: '1', requires_browser: true, regions: ['global'] },
];

function mockBase(): void {
  server.use(
    http.get('/api/add-account-protocols', () => HttpResponse.json({ items: PROTOCOLS })),
  );
}

function renderPicker(): {
  onImported: ReturnType<typeof vi.fn>;
  onSelectSource: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onImported = vi.fn();
  const onSelectSource = vi.fn();
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddAccountPicker onClose={onClose} onImported={onImported} onSelectSource={onSelectSource} />
    </QueryClientProvider>,
  );
  return { onImported, onSelectSource, onClose };
}

beforeEach(() => server.resetHandlers());

describe('AddAccountPicker', () => {
  it('按能力表渲染 8 卡：Command Code 可进入，DeepSeek/Codex 只给原因', async () => {
    mockBase();
    renderPicker();

    await screen.findByTestId('accounts-add-picker-action-authorize-qoder_cn');
    for (const app of ['workbuddy_desktop', 'minimax', 'trae', 'qoder_cn', 'zcode']) {
      expect(screen.getByTestId(`accounts-add-picker-card-${app}`)).toBeTruthy();
      expect(screen.getByTestId(`accounts-add-picker-action-authorize-${app}`)).toBeTruthy();
    }
    for (const app of ['workbuddy_desktop', 'minimax', 'trae']) {
      expect(screen.getByTestId(`accounts-add-picker-action-read-${app}`)).toBeTruthy();
    }
    // 只授权平台没有读取按钮
    expect(screen.queryByTestId('accounts-add-picker-action-read-qoder_cn')).toBeNull();
    // DeepSeek / Codex：无按钮，只有原因
    expect(screen.queryByTestId('accounts-add-picker-action-authorize-deepseek')).toBeNull();
    expect(screen.queryByTestId('accounts-add-picker-action-read-codex')).toBeNull();
    expect(screen.getByTestId('accounts-add-picker-reason-deepseek').textContent).toContain('CLI 凭据导入尚未接入');
    expect(screen.getByTestId('accounts-add-picker-reason-codex').textContent).toContain('本机读取尚未接入');
    expect(screen.getByTestId('accounts-add-picker-card-commandcode')).toBeTruthy();
    expect(screen.getByTestId('accounts-add-picker-name-commandcode')).toHaveTextContent('Command Code');
    expect(screen.getByTestId('accounts-add-picker-action-commandcode')).toHaveTextContent('添加 API Key');
    expect(screen.queryByTestId('accounts-add-picker-reason-commandcode')).toBeNull();
  });

  it('点 Command Code 切换来源并关闭选择页', async () => {
    mockBase();
    const { onSelectSource, onClose } = renderPicker();

    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-commandcode'));

    expect(onSelectSource).toHaveBeenCalledWith('commandcode');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('协议清单失败时 Command Code 仍可进入', async () => {
    server.use(http.get('/api/add-account-protocols', () => HttpResponse.error()));
    renderPicker();

    expect(await screen.findByTestId('accounts-add-picker-action-commandcode')).toHaveTextContent('添加 API Key');
    expect(screen.queryByTestId('accounts-add-picker-reason-commandcode')).toBeNull();
  });

  it('打开后焦点落在第一张卡的第一个按钮', async () => {
    mockBase();
    renderPicker();
    await waitFor(() =>
      expect(screen.getByTestId('accounts-add-picker-action-authorize-workbuddy_desktop')).toHaveFocus(),
    );
  });

  it('读取本机按平台限定调用 import-credentials 并回显结果', async () => {
    mockBase();
    let body: unknown = null;
    server.use(
      http.post('/api/accounts/import-credentials', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          batch_id: 'b1', actor: 'web', duration_ms: 5, accounts: [], error: null,
          platforms: [{ platform: 'trae', app_id: 'trae', found: 3, created: 1, updated: 2, skipped: 0, error: null }],
        });
      }),
    );
    const { onImported } = renderPicker();

    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-read-trae'));

    await waitFor(() =>
      expect(screen.getByTestId('accounts-add-picker-result-trae').textContent).toContain('发现 3 · 新增 1 · 已存在 2'),
    );
    expect(body).toEqual({ actor: 'web', platforms: ['trae'] });
    expect(onImported).toHaveBeenCalledWith('trae');
  });

  it('读取失败只显示可解释原因', async () => {
    mockBase();
    server.use(
      http.post('/api/accounts/import-credentials', () => HttpResponse.json({
        batch_id: 'b2', actor: 'web', duration_ms: 5, accounts: [], error: null,
        platforms: [{ platform: 'minimax', app_id: 'minimax', found: 0, created: 0, updated: 0, skipped: 0, error: 'PYTHON_UNAVAILABLE' }],
      })),
    );
    renderPicker();

    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-read-minimax'));

    await waitFor(() =>
      expect(screen.getByTestId('accounts-add-picker-result-minimax').textContent).not.toBe(''),
    );
    expect(screen.getByTestId('accounts-add-picker-result-minimax').className).toContain('text-red');
  });

  it('点「授权添加」复用既有向导', async () => {
    mockBase();
    renderPicker();

    await userEvent.click(await screen.findByTestId('accounts-add-picker-action-authorize-workbuddy_desktop'));

    expect(await screen.findByTestId('accounts-add-panel-workbuddy_desktop')).toBeTruthy();
  });
});
