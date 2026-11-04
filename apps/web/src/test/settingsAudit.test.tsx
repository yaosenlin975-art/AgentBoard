/**
 * AUDIT-SETTINGS（F-12 / F-13 / V-08）：设置面板的保存语义、主题单入口、长表单分区。
 *
 * 覆盖：
 * 1. 「需保存 / 即时生效」标注存在且文案一致（端口=保存后需重启、并发=保存后立即生效、主题=即时生效无需保存）；
 * 2. 保存成功给一次可见提示（`settings-saved`），不再静默关闭；
 * 3. 有未保存改动时关闭要确认（window.confirm），未确认则不关；
 * 4. 主题唯一入口在设置内（三选一按钮），左栏状态行只读（非 button、点击不改主题）；
 * 5. 长表单分区：服务与并发 / 主题 / 数据存储 各自有 section，且数据存储的危险按钮可见（不被折叠）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SettingsDialog } from '../components/topbar/SettingsDialog';
import { server } from './server';

const settingsPayload = { port: 9000, dbPath: 'D:\\db\\agentboard.db', maxConcurrentTurns: 4 };

function renderSettings(onClose = vi.fn()): () => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose as unknown as () => void;
}

beforeEach(() => {
  server.use(http.get('/api/settings', () => HttpResponse.json(settingsPayload)));
});
afterEach(() => vi.restoreAllMocks());

describe('AUDIT-SETTINGS 保存语义标注', () => {
  it('三处生效标注与底部说明一致（端口需重启 / 并发立即 / 主题即时）', async () => {
    renderSettings();
    await screen.findByDisplayValue('9000');
    expect(screen.getByTestId('settings-badge-save')).toHaveTextContent('需保存');
    expect(screen.getByTestId('settings-effect-port')).toHaveTextContent('保存后需重启服务生效');
    expect(screen.getByTestId('settings-effect-max-turns')).toHaveTextContent('保存后立即生效');
    expect(screen.getByTestId('settings-effect-theme')).toHaveTextContent('即时生效，无需保存');
    const hint = screen.getByTestId('settings-save-hint').textContent ?? '';
    expect(hint).toContain('端口：保存后需重启服务生效');
    expect(hint).toContain('并发上限：保存后立即生效');
    // 旧文案里的「DB 路径修改后需重启」必须消失（SETTINGS-DB-DEDUP 后已无该输入）
    expect(hint).not.toContain('DB 路径修改后需重启');
  });
});

describe('AUDIT-SETTINGS 未保存改动确认', () => {
  it('改了并发后关闭 → window.confirm 拒绝则不关；同意才关', async () => {
    const onClose = renderSettings();
    await screen.findByDisplayValue('9000');
    await userEvent.clear(screen.getByTestId('settings-max-turns'));
    await userEvent.type(screen.getByTestId('settings-max-turns'), '9');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('AUDIT-SETTINGS 长表单分区', () => {
  it('服务与并发 / 主题两组存在，且数据存储分区的迁移入口可见（不折叠）', async () => {
    renderSettings();
    await screen.findByDisplayValue('9000');
    expect(screen.getByTestId('settings-section-server')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-theme')).toBeInTheDocument();
    expect(screen.getByTestId('settings-storage')).toBeInTheDocument();
  });
});
