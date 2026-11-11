/**
 * B06（MAC-TRIAL）：壳注入 `window.__AGENTBOARD_SHELL__.nativeTitleBar` 的两平台分支。
 * Windows / 旧壳（无字段或 false）→ 渲染自绘 ─□× 三键；
 * macOS（true，原生红绿灯 overlay）→ 隐藏自绘三键、data-native-titlebar 标记为 true。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WindowTitleBar } from '../components/shell/WindowTitleBar';

function installShellRuntime(shell: Record<string, unknown> | undefined): void {
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    invoke: () => Promise.resolve(undefined),
  } as unknown as NonNullable<typeof window.__TAURI_INTERNALS__>;
  if (shell === undefined) {
    delete window.__AGENTBOARD_SHELL__;
  } else {
    window.__AGENTBOARD_SHELL__ = shell as typeof window.__AGENTBOARD_SHELL__;
  }
}

afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
  delete window.__AGENTBOARD_SHELL__;
});

describe('WindowTitleBar 平台分叉（B06）', () => {
  it('Windows / 旧壳（无 __AGENTBOARD_SHELL__）→ 渲染 ─□× 三键，data-native-titlebar=false', () => {
    installShellRuntime(undefined);
    render(<WindowTitleBar />);
    const bar = screen.getByTestId('window-titlebar');
    expect(bar).toHaveAttribute('data-native-titlebar', 'false');
    expect(screen.getByRole('button', { name: '最小化窗口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最大化窗口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
  });

  it('显式 nativeTitleBar=false → 与旧壳一致，三键仍在', () => {
    installShellRuntime({ platform: 'windows', nativeTitleBar: false });
    render(<WindowTitleBar />);
    expect(screen.getByTestId('window-titlebar')).toHaveAttribute('data-native-titlebar', 'false');
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('macOS（nativeTitleBar=true）→ 不渲染自绘三键，data-native-titlebar=true', () => {
    installShellRuntime({ platform: 'macos', nativeTitleBar: true });
    render(<WindowTitleBar />);
    const bar = screen.getByTestId('window-titlebar');
    expect(bar).toHaveAttribute('data-native-titlebar', 'true');
    expect(screen.queryByRole('button', { name: '最小化窗口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '最大化窗口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭窗口' })).not.toBeInTheDocument();
  });
});
