/**
 * PALETTE-SETTINGS：设置对话框的旧色板清剿（主题三按钮 / 保存 / 取消 / 输入 focus）。
 *
 * 只断言 class 契约（jsdom 无颜色计算）：选中态用 unslop 令牌 `border-accent bg-accent-soft text-accent`；
 * 主操作 `bg-accent text-accent-ink`；次级/取消 `border-hairline bg-surface-card text-ink`；
 * 输入 `focus:border-accent`；且这些元素上不再出现 `blue` 旧色板类。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SettingsDialog } from '../components/topbar/SettingsDialog';
import { setTheme } from '../theme';
import { server } from './server';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setTheme('system');
  server.use(
    http.get('/api/settings', () => HttpResponse.json({ port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 2 })),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
  );
});

function renderSettings(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SettingsDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('PALETTE-SETTINGS 设置对话框色板', () => {
  it('主题三按钮：选中态用令牌（border-accent/bg-accent-soft/text-accent），未选中不再有 blue', async () => {
    renderSettings();
    const selected = await screen.findByTestId('theme-system');
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(selected.className).toContain('border-accent');
    expect(selected.className).toContain('bg-accent-soft');
    expect(selected.className).toContain('text-accent');

    for (const value of ['system', 'light', 'dark']) {
      const btn = screen.getByTestId(`theme-${value}`);
      expect(btn.className).not.toMatch(/\b(bg|text|border|ring)-blue-\d/);
    }
    // 未选中态用 hairline/ink-2 令牌
    const idle = screen.getByTestId('theme-light');
    expect(idle.className).toContain('border-hairline');
    expect(idle.className).toContain('text-ink-2');
  });

  it('保存为主操作令牌色，取消为次级令牌色，输入 focus 环走 accent', async () => {
    renderSettings();
    const save = await screen.findByTestId('settings-save');
    expect(save.className).toContain('bg-accent');
    expect(save.className).toContain('text-accent-ink');
    expect(save.className).not.toMatch(/bg-blue-600|text-white/);

    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel.className).toContain('border-hairline');
    expect(cancel.className).toContain('bg-surface-card');
    expect(cancel.className).toContain('text-ink');
    expect(cancel.className).not.toMatch(/neutral-\d/);

    const portInput = await screen.findByDisplayValue('9000');
    expect(portInput.className).toContain('focus:border-accent');
    expect(portInput.className).not.toMatch(/focus:border-blue/);
  });
});
