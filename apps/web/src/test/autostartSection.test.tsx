/**
 * SETTINGS-AUTOSTART：设置页「开机自启」分区。
 * 壳命令契约见 f21a02a7；这里用假的 `window.__TAURI_INTERNALS__.invoke` 覆盖各状态与失败分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutostartSection } from '../components/settings/AutostartSection';

type InvokeArgs = Record<string, unknown>;
type Handler = (cmd: string, args?: InvokeArgs) => Promise<unknown>;

function installInvoke(handler: Handler) {
  const invoke = vi.fn(handler);
  (window as unknown as { __TAURI_INTERNALS__?: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

const NONE = { supported: true, enabled: false, owner: 'none', provider: 'hkcu-run' };
const DESKTOP_ON = { supported: true, enabled: true, owner: 'desktop', provider: 'hkcu-run' };
const CLI_OFF = {
  supported: true,
  enabled: false,
  owner: 'cli',
  provider: 'hkcu-run',
  detail: 'C:\\AgentBoard\\scripts\\agentboard.vbs autostart',
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('AutostartSection', () => {
  it('非 Tauri 环境：显示不可用、开关禁用、点击不抛错', async () => {
    render(<AutostartSection />);
    expect(screen.getByTestId('autostart-unavailable')).toHaveTextContent('浏览器访问时不可用');
    const toggle = screen.getByTestId('settings-autostart-toggle');
    expect(toggle).toBeDisabled();
    expect(() => fireEvent.click(toggle)).not.toThrow();
    expect(screen.queryByTestId('autostart-error')).not.toBeInTheDocument();
  });

  it('壳返回 supported=false（dev 态）：按不可用展示并给出 detail，不写成已关闭', async () => {
    installInvoke(async () => ({
      supported: false,
      enabled: true,
      owner: 'cli',
      provider: 'hkcu-run',
      detail: 'tauri dev 没有稳定入口',
    }));
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('autostart-status')).toBeInTheDocument());
    expect(screen.getByTestId('autostart-status')).toHaveTextContent('当前环境不可用：tauri dev 没有稳定入口');
    expect(screen.getByTestId('settings-autostart-toggle')).toBeDisabled();
    expect(screen.queryByText(/未启用/)).not.toBeInTheDocument();
  });

  it('owner=none 点击开启：调 autostart_set({enabled:true}) 并以回读状态更新开关', async () => {
    const invoke = installInvoke(async (cmd, args) => {
      if (cmd === 'autostart_status') return NONE;
      return { ...NONE, enabled: args?.enabled === true, owner: 'desktop' };
    });
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('autostart-status')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('settings-autostart-toggle'));
    await waitFor(() => expect(screen.getByTestId('settings-autostart-toggle')).toBeChecked());
    expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: true });
    expect(screen.getByTestId('autostart-status')).toHaveTextContent('已启用 · 由桌面应用管理');
  });

  it('关闭成功的桌面入口：调 autostart_set({enabled:false}) 且开关关闭', async () => {
    const invoke = installInvoke(async (cmd) =>
      cmd === 'autostart_status' ? DESKTOP_ON : { ...DESKTOP_ON, enabled: false },
    );
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('settings-autostart-toggle')).toBeChecked());

    await userEvent.click(screen.getByTestId('settings-autostart-toggle'));
    await waitFor(() => expect(screen.getByTestId('settings-autostart-toggle')).not.toBeChecked());
    expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: false });
  });

  it('owner=cli 开启：确认后带 takeOver:true 接管；取消则不调用', async () => {
    const invoke = installInvoke(async (cmd) =>
      cmd === 'autostart_status' ? CLI_OFF : { ...NONE, enabled: true, owner: 'desktop' },
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('autostart-status')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('settings-autostart-toggle'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('autostart_set', expect.anything());

    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByTestId('settings-autostart-toggle'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: true, takeOver: true }),
    );
  });

  it('AUTOSTART_NOT_OWNED：提示由 CLI 管理，开关保持原状态', async () => {
    installInvoke(async (cmd) => {
      if (cmd === 'autostart_status') return { ...CLI_OFF, enabled: true };
      throw new Error(
        JSON.stringify({ code: 'AUTOSTART_NOT_OWNED', detail: '请先执行 kb autostart uninstall' }),
      );
    });
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('settings-autostart-toggle')).toBeChecked());

    await userEvent.click(screen.getByTestId('settings-autostart-toggle'));
    await waitFor(() => expect(screen.getByTestId('autostart-error')).toBeInTheDocument());
    expect(screen.getByTestId('autostart-error')).toHaveTextContent('不归桌面应用管理');
    expect(screen.getByTestId('autostart-error')).toHaveTextContent('请先执行 kb autostart uninstall');
    expect(screen.getByTestId('settings-autostart-toggle')).toBeChecked();
  });

  it('AUTOSTART_PERMISSION / 读状态 reject：映射成人话，不抛未捕获错误', async () => {
    installInvoke(async () => {
      throw new Error(JSON.stringify({ code: 'AUTOSTART_PERMISSION', detail: '拒绝访问注册表' }));
    });
    render(<AutostartSection />);
    await waitFor(() => expect(screen.getByTestId('autostart-error')).toBeInTheDocument());
    expect(screen.getByTestId('autostart-error')).toHaveTextContent('系统拒绝修改开机自启（权限不足）');
    expect(screen.getByTestId('autostart-error')).not.toHaveTextContent('{');
  });
});
