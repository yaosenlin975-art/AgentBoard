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
 * D15：按平台切换窗口控制区形态（两分支都走 `.decorations(false)` 全自绘）：
 * - windows：右侧「— □ ×」三个方形按钮（原实现，逐像素不变）
 * - macos：左侧三圆点（关红 / 最小化黄 / 最大化绿），悬停该组才显示 × − +
 */
import { useCallback, useEffect, useState } from 'react';

interface TauriInternals {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  metadata?: { currentWindow?: { label?: string } };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    /** 壳注入的平台值（开发预览用；见 D16），取值 'macos' | 'windows' */
    __AB_PLATFORM_OVERRIDE__?: string;
  }
}

/** 标题栏高度（px）：与 App 顶部流式布局共用，改这里即可整体调整 */
export const WINDOW_TITLE_BAR_HEIGHT = 32;

export type TitleBarPlatform = 'macos' | 'windows';

function normalizePlatform(value: unknown): TitleBarPlatform | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'macos' || normalized === 'mac') return 'macos';
  if (normalized === 'windows' || normalized === 'win') return 'windows';
  return null;
}

/** `?platform=macos` 开发预览；只在 DEV 生效，正式构建直接跳过 */
let previewAnnounced = false;
function devPreviewPlatform(): TitleBarPlatform | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined' || typeof window.location?.search !== 'string') return null;
  const raw = new URLSearchParams(window.location.search).get('platform');
  const platform = normalizePlatform(raw);
  if (platform === null) return null;
  if (!previewAnnounced) {
    previewAnnounced = true;
    console.info(`[WindowTitleBar] 开发预览：按 ${platform} 形态渲染标题栏（?platform 仅在 DEV 生效）`);
  }
  return platform;
}

/**
 * 平台判定纯函数（不依赖 React、不新增运行时依赖）。优先级：
 * 1. `window.__AB_PLATFORM_OVERRIDE__`（壳注入）
 * 2. `?platform=` 开发预览（仅 `import.meta.env.DEV`；正式构建里这段被常量折叠掉）
 * 3. `navigator.userAgentData?.platform`
 * 4. `navigator.userAgent` 正则
 * 5. 兜底 'windows'（保持历史行为）
 */
export function detectPlatform(): TitleBarPlatform {
  if (typeof window === 'undefined') return 'windows';

  const override = normalizePlatform(window.__AB_PLATFORM_OVERRIDE__);
  if (override !== null) return override;

  const preview = devPreviewPlatform();
  if (preview !== null) return preview;

  const navigatorLike = typeof navigator === 'undefined' ? undefined : navigator;
  const dataPlatform = normalizePlatform(
    (navigatorLike as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData?.platform,
  );
  if (dataPlatform !== null) return dataPlatform;

  const ua = navigatorLike?.userAgent ?? '';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  return 'windows';
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
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

/** mac 圆点：12×12，符号默认透明，仅在悬停该组时出现 */
const MAC_DOT_BASE =
  'grid h-3 w-3 shrink-0 place-items-center rounded-full p-0 outline-none transition-colors duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none';
// 悬停整组才露出符号：卡面规定非悬停态不得有可见符号（与 mac 原生一致）
const MAC_DOT_SYMBOL =
  'opacity-0 transition-opacity duration-[120ms] group-hover/dots:opacity-100 motion-reduce:transition-none';

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

/** mac 圆点里的符号（× / − / +；悬停该组才显示，深色描边压在亮色圆点上） */
function MacGlyph({ kind }: { kind: 'close' | 'minimize' | 'maximize' }) {
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 12 12',
    className: `h-[7px] w-[7px] ${MAC_DOT_SYMBOL}`,
    fill: 'none',
    stroke: 'rgba(0,0,0,0.55)',
    strokeWidth: 1.5,
  } as const;
  if (kind === 'close') {
    return (
      <svg {...common} strokeLinecap="round">
        <path d="M3.4 3.4l5.2 5.2M8.6 3.4L3.4 8.6" />
      </svg>
    );
  }
  if (kind === 'minimize') {
    return (
      <svg {...common} strokeLinecap="round">
        <path d="M2.8 6h6.4" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeLinecap="round">
      <path d="M2.8 6h6.4M6 2.8v6.4" />
    </svg>
  );
}

/** 标题左侧的 A 图标 + 文字；两分支共用同一套视觉 */
function BrandMark() {
  return (
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
  );
}

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [tauri] = useState(isTauriRuntime);
  const [platform] = useState<TitleBarPlatform>(detectPlatform);

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

  const headerStyle = { height: WINDOW_TITLE_BAR_HEIGHT };
  const maximizeLabel = maximized ? '还原窗口' : '最大化窗口';

  if (platform === 'macos') {
    return (
      <header
        data-testid="window-titlebar"
        data-platform="macos"
        data-tauri-drag-region="deep"
        className="flex shrink-0 select-none items-center border-b border-hairline bg-surface-card text-ink"
        style={headerStyle}
      >
        {/* 左侧三圆点：mac 原生顺序 = 关 / 最小化 / 最大化；悬停整组才露出符号 */}
        <div className="group/dots flex shrink-0 items-center gap-2 pl-[13px]">
          <button
            type="button"
            aria-label="关闭窗口"
            title="关闭"
            className={`${MAC_DOT_BASE} bg-[#FF5F57] hover:bg-[#ff4d44]`}
            onClick={() => void windowInvoke('close')}
          >
            <MacGlyph kind="close" />
          </button>
          <button
            type="button"
            aria-label="最小化窗口"
            title="最小化"
            className={`${MAC_DOT_BASE} bg-[#FEBC2E] hover:bg-[#f2b01f]`}
            onClick={() => void windowInvoke('minimize')}
          >
            <MacGlyph kind="minimize" />
          </button>
          <button
            type="button"
            aria-label={maximizeLabel}
            title={maximized ? '还原' : '最大化'}
            className={`${MAC_DOT_BASE} bg-[#28C840] hover:bg-[#21b836]`}
            onClick={() => void windowInvoke('toggle_maximize')}
          >
            <MacGlyph kind="maximize" />
          </button>
        </div>
        <span className="ml-3 flex min-w-0 items-center">
          <BrandMark />
        </span>
        {/* 拖拽填充区：自身无内容，保证标题栏空档也能拖动 */}
        <span aria-hidden="true" className="h-full min-w-0 flex-1" />
      </header>
    );
  }

  return (
    <header
      data-testid="window-titlebar"
      data-platform="windows"
      data-tauri-drag-region="deep"
      className="flex shrink-0 select-none items-center border-b border-hairline bg-surface-card pl-3 text-ink"
      style={headerStyle}
    >
      <BrandMark />
      {/* 拖拽填充区：自身无内容，保证标题栏空档也能拖动 */}
      <span aria-hidden="true" className="h-full min-w-0 flex-1" />
      <div className="flex shrink-0 items-stretch">
        <button type="button" aria-label="最小化窗口" title="最小化" className={CONTROL_BASE} onClick={() => void windowInvoke('minimize')}>
          <MinimizeIcon />
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
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
    </header>
  );
}
