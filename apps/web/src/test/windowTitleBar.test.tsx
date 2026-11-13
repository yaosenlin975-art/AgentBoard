/**
 * D15：桌面顶栏平台自适应。
 *
 * 覆盖两件事：
 * 1. `detectPlatform()` 的优先级（override → userAgentData → UA → 兜底 windows）与 DEV-only 预览；
 * 2. 两分支的窗口控制顺序 —— mac 左起 close/minimize/maximize，windows 仍是 minimize/maximize/close。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WindowTitleBar, detectPlatform } from '../components/shell/WindowTitleBar';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type GlobalWithPlatform = {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
  __AB_PLATFORM_OVERRIDE__?: string;
};

const globals = window as unknown as GlobalWithPlatform;

function setTauriRuntime(on: boolean): void {
  if (on) {
    globals.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
  } else {
    delete globals.__TAURI_INTERNALS__;
  }
}

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua });
}

function setUserAgentData(platform: string | null): void {
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: platform === null ? undefined : { platform },
  });
}

function setOverride(value: string | null): void {
  if (value === null) {
    delete globals.__AB_PLATFORM_OVERRIDE__;
  } else {
    globals.__AB_PLATFORM_OVERRIDE__ = value;
  }
}

function setSearch(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
}

/** 顶栏内按钮的无障碍名序列：既是顺序断言，也是两分支形态的区分点 */
function controlLabels(): string[] {
  const header = screen.getByTestId('window-titlebar');
  return Array.from(header.querySelectorAll('button')).map((node) => node.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
  cleanup();
  setTauriRuntime(true);
  setOverride(null);
  setUserAgentData(null);
  setUserAgent(WINDOWS_UA);
  setSearch('');
});

afterEach(() => {
  cleanup();
  setTauriRuntime(false);
  setOverride(null);
  setUserAgentData(null);
  setSearch('');
  vi.unstubAllEnvs();
});

describe('detectPlatform()', () => {
  it('override 优先于 UA 与 userAgentData', () => {
    setUserAgent(MAC_UA);
    setUserAgentData('Windows');
    setOverride('windows');
    expect(detectPlatform()).toBe('windows');

    setUserAgent(WINDOWS_UA);
    setUserAgentData('macOS');
    setOverride('macos');
    expect(detectPlatform()).toBe('macos');
  });

  it('override 非法值被忽略，继续走后续判定', () => {
    setUserAgent(MAC_UA);
    setOverride('linux');
    expect(detectPlatform()).toBe('macos');
  });

  it('override 优先于 ?platform 预览参数', () => {
    setSearch('?platform=macos');
    setOverride('windows');
    expect(detectPlatform()).toBe('windows');
  });

  it('无 override 时用 userAgentData.platform', () => {
    setUserAgent(WINDOWS_UA);
    setUserAgentData('macOS');
    expect(detectPlatform()).toBe('macos');
  });

  it('userAgentData 缺失或无法识别时回落到 UA 正则', () => {
    setUserAgentData('');
    setUserAgent(MAC_UA);
    expect(detectPlatform()).toBe('macos');

    setUserAgent(WINDOWS_UA);
    expect(detectPlatform()).toBe('windows');
  });

  it('未知平台兜底 windows', () => {
    setUserAgent(LINUX_UA);
    setUserAgentData('Linux');
    expect(detectPlatform()).toBe('windows');
  });

  it('?platform=macos 只在 DEV 生效', () => {
    setSearch('?platform=macos');
    expect(detectPlatform()).toBe('macos');

    vi.stubEnv('DEV', false);
    expect(detectPlatform()).toBe('windows');
  });
});

/** 点击产生的窗口控制命令（排除挂载时同步最大化状态用的 is_maximized） */
function controlCommands(): string[] {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> } })
    .__TAURI_INTERNALS__;
  return (internals?.invoke.mock.calls ?? [])
    .map((call) => call[0] as string)
    .filter((command) => command !== 'plugin:window|is_maximized');
}

describe('WindowTitleBar 平台分支', () => {
  it('macOS：左侧三圆点，顺序 close → minimize → maximize', () => {
    setUserAgent(MAC_UA);
    render(<WindowTitleBar />);

    expect(controlLabels()).toEqual(['关闭窗口', '最小化窗口', '最大化窗口']);
    // 圆点容器在标题之前（视觉上左侧）
    const header = screen.getByTestId('window-titlebar');
    expect(header.firstElementChild?.querySelectorAll('button')).toHaveLength(3);
    expect(header.textContent).toContain('AgentBoard');
  });

  it('Windows：右侧三键，顺序 minimize → maximize → close（无 mac 圆点组）', () => {
    setUserAgent(WINDOWS_UA);
    render(<WindowTitleBar />);

    expect(controlLabels()).toEqual(['最小化窗口', '最大化窗口', '关闭窗口']);
    const header = screen.getByTestId('window-titlebar');
    // 左侧首个子节点是标题（A 图标 + 文字），不是控制按钮
    expect(header.firstElementChild?.querySelectorAll('button')).toHaveLength(0);
  });

  it('macOS：圆点符号默认不可见，悬停该组才出现', () => {
    setUserAgent(MAC_UA);
    render(<WindowTitleBar />);
    const dots = screen.getByTestId('window-titlebar').firstElementChild as HTMLElement;
    expect(dots.className).toContain('group/dots');
    for (const svg of Array.from(dots.querySelectorAll('svg'))) {
      expect(svg.getAttribute('class')).toContain('opacity-0');
      expect(svg.getAttribute('class')).toContain('group-hover/dots:opacity-100');
    }
  });

  it('macOS：点击三圆点分别走 close / minimize / toggle_maximize', () => {
    setUserAgent(MAC_UA);
    render(<WindowTitleBar />);
    for (const label of ['关闭窗口', '最小化窗口', '最大化窗口']) {
      fireEvent.click(screen.getByLabelText(label));
    }
    expect(controlCommands()).toEqual(['plugin:window|close', 'plugin:window|minimize', 'plugin:window|toggle_maximize']);
  });

  it('Windows：点击三键仍是 minimize / toggle_maximize / close', () => {
    setUserAgent(WINDOWS_UA);
    render(<WindowTitleBar />);
    for (const label of ['最小化窗口', '最大化窗口', '关闭窗口']) {
      fireEvent.click(screen.getByLabelText(label));
    }
    expect(controlCommands()).toEqual(['plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close']);
  });

  it('拖拽区在标题与控制区之间，且控制按钮不参与拖拽区', () => {
    setUserAgent(MAC_UA);
    render(<WindowTitleBar />);
    const header = screen.getByTestId('window-titlebar');
    expect(header).toHaveAttribute('data-tauri-drag-region', 'deep');
    const dragFill = header.querySelector('[aria-hidden="true"].flex-1');
    expect(dragFill).not.toBeNull();
  });
});
