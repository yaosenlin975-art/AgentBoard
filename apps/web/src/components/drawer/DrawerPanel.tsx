/**
 * S2c：滑出面板（drawer）。
 *
 * 三态（DRAWER-ANCHOR）：
 * - **贴左栏（anchored，≥920px）**：抽屉紧贴左侧导航栏右边缘出现（`left = sidebarRight + gap`），
 *   垂直铺满内容区；宽度按内容区自适应（`clamp(400, min(720, 内容区宽度 - 24))`），不再钉在视口最右边；
 * - **挤压（squeeze，768–919px）**：drawer 是主区的 flex 兄弟，宽度固定 400，主内容区被压缩；
 * - **覆盖（overlay，<768px）**：drawer 绝对定位盖住主区，带半透明遮罩，**锁 body 滚动**。
 *
 * 与 `navStore.drawer`（`accounts | settings | null`）对接：开合只走 store（`openDrawer`/`closeDrawer`），
 * 刷新不自动弹出（store 里 drawer 不持久化，`merge` 口径见 navStore 注释）。
 *
 * 动效只走 `transform`/`opacity`，160ms `cubic-bezier(0.2,0,0,1)`，尊重 `prefers-reduced-motion`。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavStore, type NavDrawer } from '../../state/navStore';
import { AccountsPanel } from '../settings/AccountsPanel';
import { SettingsDialog } from '../topbar/SettingsDialog';
import { computeDrawerAnchor, type DrawerAnchor } from '../../lib/drawerAnchor';

/** 挤压态的最小视口宽度（窄于此改为覆盖态） */
export const DRAWER_SQUEEZE_MIN_WIDTH = 768;
/** drawer 固定宽度（挤压态占位、覆盖态面板宽度） */
export const DRAWER_WIDTH_PX = 400;

const QUERY = `(min-width: ${DRAWER_SQUEEZE_MIN_WIDTH}px)`;

function subscribeMedia(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

function readSqueeze(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(QUERY).matches;
}

/** 命中文案：drawer 标题与无障碍标签 */
const TITLE: Record<NavDrawer, string> = { accounts: '账号管理', settings: '设置' };

export function DrawerPanel() {
  const drawer = useNavStore((state) => state.drawer);
  const closeDrawer = useNavStore((state) => state.closeDrawer);
  const squeeze = useSyncExternalStore(subscribeMedia, readSqueeze, () => true);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const open = drawer !== null;
  const mode = squeeze ? 'squeeze' : 'overlay';
  // DRAWER-ANCHOR：≥920px 时抽屉贴左栏右边缘（左 = sidebarRight + 8，宽度按内容区自适应）；
  // <920px 维持既有 squeeze / overlay 两态。
  const [anchor, setAnchor] = useState<DrawerAnchor | null>(null);
  const recomputeAnchor = useCallback(() => {
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect() ?? null;
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    // 没有左栏（独立渲染/测试）时以定位容器左缘为锚点，等价于「紧贴内容区左缘」
    const sidebarRight = sidebar?.getBoundingClientRect().right ?? parentRect?.left ?? 0;
    const next = computeDrawerAnchor(sidebarRight, window.innerWidth);
    if (next.mode === 'legacy') {
      setAnchor(next);
      return;
    }
    // 视口坐标 → 定位容器坐标（抽屉的 offsetParent 就是 App 里的 relative 布局壳）
    setAnchor({ ...next, left: next.left - (parentRect?.left ?? 0) });
  }, []);

  useLayoutEffect(() => {
    recomputeAnchor();
    const onResize = (): void => recomputeAnchor();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [recomputeAnchor]);
  // 覆盖态遮罩淡入用；关闭瞬间保留一帧避免闪断
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) setRendered(true);
    else {
      const timer = setTimeout(() => setRendered(false), 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // 覆盖态锁 body 滚动；关闭或切到挤压态立即解锁
  useEffect(() => {
    if (!open || mode !== 'overlay' || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, mode]);

  // 打开时把焦点移到面板（键盘用户不会被留在被遮住的内容区）；Escape 关闭
  // S4：打开瞬间记住触发元素，关闭后把焦点还回去（抽屉不持有触发按钮 ref，记 activeElement 对任何触发点都成立）
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeDrawer();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeDrawer]);

  // S4：关闭后焦点回到触发元素（元素已卸载则放弃，不做隐式转移）
  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target !== null && document.contains(target)) target.focus();
  }, [open]);

  const hidden = !open;
  const anchored = anchor?.mode === 'anchored' ? anchor : null;
  const layoutMode = anchored !== null ? 'anchored' : mode;
  // 宽度只在 style 里定（DRAWER_WIDTH_PX 单点）：挤压态关闭时归零，主区右侧不留空槽；覆盖态不超过视口。
  // 动画仍只走 transform/opacity，这行不参与过渡。
  const widthClass = squeeze
    ? `${open ? 'shrink-0' : 'w-0'} overflow-hidden`
    : 'absolute inset-y-0 right-0 z-40 shadow-xl';
  // DRAWER-ANCHOR：贴左栏时改成绝对定位（垂直铺满内容区），关闭时向左滑出。
  const positionClass = anchored !== null ? 'absolute inset-y-0 z-40 shadow-xl' : widthClass;
  return (
    <>
      {anchored === null && !squeeze && rendered && (
        <div
          data-testid="drawer-backdrop"
          data-state={open ? 'open' : 'closed'}
          onClick={closeDrawer}
          aria-hidden="true"
          className={`absolute inset-0 z-30 bg-black/30 ab-transition transition-opacity duration-200 motion-reduce:transition-none ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        />
      )}
      <aside
        ref={panelRef}
        tabIndex={-1}
        role={squeeze ? 'region' : 'dialog'}
        aria-modal={squeeze ? undefined : true}
        aria-label={drawer === null ? '滑出面板' : TITLE[drawer]}
        aria-hidden={hidden}
        data-testid="drawer-panel"
        data-drawer={drawer ?? 'none'}
        data-mode={layoutMode}
        data-state={open ? 'open' : 'closed'}
        style={
          anchored !== null
            ? { width: anchored.width, left: anchored.left }
            : { width: squeeze ? (open ? DRAWER_WIDTH_PX : 0) : DRAWER_WIDTH_PX, maxWidth: squeeze ? undefined : '100vw' }
        }
        className={`${positionClass} flex min-h-0 flex-col overflow-hidden border-l border-hairline bg-surface-card transition-[transform,opacity] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none focus:outline-none ${
          open ? 'translate-x-0 opacity-100' : anchored !== null ? '-translate-x-full opacity-0' : 'translate-x-full opacity-0'
        } ${hidden ? 'pointer-events-none' : ''}`}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <h2 data-testid="drawer-title" className="text-sm font-semibold text-ink">
            {drawer === null ? '' : TITLE[drawer]}
          </h2>
          <button
            type="button"
            data-testid="drawer-close"
            aria-label="关闭面板"
            onClick={closeDrawer}
            className="rounded px-2 py-1 text-sm text-ink-3 hover:bg-surface-raised"
          >
            关闭
          </button>
        </header>
        <div data-testid="drawer-body" className="min-h-0 flex-1 overflow-auto p-3">
          {/* 只在打开时挂载内容：避免面板关闭后仍跑查询/轮询 */}
          {open && drawer === 'accounts' && <AccountsPanel />}
          {open && drawer === 'settings' && <SettingsDialog open onClose={closeDrawer} variant="inline" />}
        </div>
      </aside>
    </>
  );
}
