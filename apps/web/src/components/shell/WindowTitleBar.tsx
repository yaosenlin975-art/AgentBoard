/**
 * WINTITLE-01：桌面壳（Tauri v2）自绘窗口标题栏。
 *
 * 只在 Tauri 运行时渲染（浏览器里返回 null，正式页/测试页零影响）。
 * 拖拽与双击最大化交给 Tauri 内置 drag.js：`data-tauri-drag-region="deep"` 的元素上
 * mousedown 会 start_dragging，detail === 2 会 internal_toggle_maximize；
 * 按钮是 BUTTON（clickable），drag.js 会自动排除，**不要**再加 dblclick 处理器，否则会二次切换。
 *
 * 关闭沿用壳的语义：Rust 侧拦截 CloseRequested → 隐藏到托盘，不退出进程。
 *
 * 平台（B06）：壳注入 `window.__AGENTBOARD_SHELL__.nativeTitleBar`。macOS 为 true（原生红绿灯 overlay），
 * 此时只留拖拽区与标题、不渲染自绘三键；Windows 为 false（无边框），保持 ─□×。
 */
import { useCallback, useEffect, useState } from 'react';

interface TauriInternals {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  metadata?: { currentWindow?: { label?: string } };
}

/** 壳注入的运行时信息（B06）：macOS 走原生红绿灯时页面隐藏自绘三键。 */
interface ShellInfo {
  platform?: string;
  nativeTitleBar?: boolean;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    __AGENTBOARD_SHELL__?: ShellInfo;
  }
}

/** 标题栏高度（px）：与 App 顶部流式布局共用，改这里即可整体调整 */
export const WINDOW_TITLE_BAR_HEIGHT = 32;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * 读取壳注入的窗口外观信息。旧壳 / 浏览器里为 undefined，
 * 调用方按「Windows 自绘三键」处理，保证升级前后行为连续。
 */
export function shellChrome(): ShellInfo | undefined {
  return typeof window === 'undefined' ? undefined : window.__AGENTBOARD_SHELL__;
}

/** 调 Tauri window 插件命令；浏览器内是无副作用的 undefined（组件已在浏览器里提前返回） */
function windowInvoke<T>(command: string): Promise<T | undefined> {
  const internals = window.__TAURI_INTERNALS__;
  if (internals === undefined) return Promise.resolve(undefined);
  const label = internals.metadata?.currentWindow?.label ?? 'main';
  return internals.invoke<T>(`plugin:window|${command}`, { label }).catch(() => undefined);
}

const CONTROL_BASE =
  'grid h-8 w-11 place-items-center text-ink-2 outline-none transition-colors duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none';

function MinimizeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 5h7" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="2" width="6" height="6" rx="0.6" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3.4 3.4h4.2v4.2" />
      <rect x="2" y="2" width="4.2" height="4.2" rx="0.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" strokeLinecap="round" />
    </svg>
  );
}

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [tauri] = useState(isTauriRuntime);
  const [chrome] = useState(shellChrome);

  const syncMaximized = useCallback(() => {
    void windowInvoke<boolean>('is_maximized').then((value) => {
      if (typeof value === 'boolean') setMaximized(value);
    });
  }, []);

  useEffect(() => {
    if (!tauri) return;
    syncMaximized();
    // 最大化/还原会改变 webview 视口尺寸 → resize 事件是拿状态最稳的信号（不依赖额外插件权限）
    window.addEventListener('resize', syncMaximized);
    return () => window.removeEventListener('resize', syncMaximized);
  }, [tauri, syncMaximized]);

  if (!tauri) return null;

  // B06：macOS 壳用原生红绿灯（overlay），页面不再画 ─□×；左侧留出 84px 给红绿灯，
  // Windows（及旧壳无该字段）保持三键与 12px 左内距。
  const nativeTitleBar = chrome?.nativeTitleBar === true;

  return (
    <header
      data-testid="window-titlebar"
      data-native-titlebar={nativeTitleBar ? 'true' : 'false'}
      data-tauri-drag-region="deep"
      className={`flex shrink-0 select-none items-center border-b border-hairline bg-surface-card text-ink ${
        nativeTitleBar ? 'pl-[84px]' : 'pl-3'
      }`}
      style={{ height: WINDOW_TITLE_BAR_HEIGHT }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] bg-accent text-[9px] font-bold leading-none text-accent-ink"
        >
          A
        </span>
        <span className="truncate text-[11.5px] font-medium tracking-wide text-ink-2 max-[560px]:hidden">
          AgentBoard
        </span>
      </span>
      {/* 拖拽填充区：自身无内容，保证标题栏空档也能拖动 */}
      <span aria-hidden="true" className="h-full min-w-0 flex-1" />
      {nativeTitleBar ? null : (
        <div className="flex shrink-0 items-stretch">
          <button type="button" aria-label="最小化窗口" title="最小化" className={CONTROL_BASE} onClick={() => void windowInvoke('minimize')}>
            <MinimizeIcon />
          </button>
          <button
            type="button"
            aria-label={maximized ? '还原窗口' : '最大化窗口'}
            title={maximized ? '还原' : '最大化'}
            className={CONTROL_BASE}
            onClick={() => void windowInvoke('toggle_maximize')}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          {/* 关闭 hover 用深红：亮/暗主题下白图标都够对比（--ab-del 在暗色是浅红，白字对比不足） */}
          <button
            type="button"
            aria-label="关闭窗口"
            title="关闭"
            className={`${CONTROL_BASE} hover:bg-[#c0362c] hover:text-white`}
            onClick={() => void windowInvoke('close')}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </header>
  );
}
