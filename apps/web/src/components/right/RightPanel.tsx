/**
 * 右侧面板单实例容器（§7.4/§7.5）：
 * - view===null 渲染收起窄条（固定"聊天"，点击进入聊天视图，保证首屏可达）；
 * - 收起（rightOpen=false）渲染窄条，展开按钮恢复原视图；
 * - 展开时顶部条（视图标题 + 收起按钮），左缘拖拽调宽（320–720px，localStorage 持久）；
 * - view==='detail' 渲染 DetailPanel（T13），view==='ref' 渲染软链接浮窗 RefPanel（MD-LINKS：知识页 / 日志详情）。
 *   S2b：聊天已整屏化（`navStore.view === 'chat'` 时由 App 整屏渲染 ChatPanel），这里不再有 chat 分支。
 * 视图组件各持 react-query 缓存，收起/展开与往返切换不丢数据。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { usePanelStore, type PanelView } from '../../state/panelStore';
import { useNavStore } from '../../state/navStore';
import { useOverlayStore } from '../../state/overlayStore';
import { useDismissable } from '../overlay/useDismissable';
import { panelMotionStyle, usePanelPresence, usePrefersReducedMotion } from '../overlay/panelMotion';
import { DetailPanel } from '../detail/DetailPanel';
import { RefPanel } from './RefPanel';
import { computeDetailAnchor, type DetailAnchor } from '../../lib/detailAnchor';

const WIDTH_KEY = 'agentboard.right-panel-width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
}

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_WIDTH;
}

export function RightPanel() {
  const view = usePanelStore((s) => s.view);
  const closeRight = usePanelStore((s) => s.closeRight);
  const clearView = usePanelStore((s) => s.clearView);
  const refPanel = usePanelStore((s) => s.refPanel);
  const detailIssueId = usePanelStore((s) => s.issueId);

  const [width, setWidth] = useState(loadWidth);
  const [resizing, setResizing] = useState(false);
  // ANCHOR-DETAIL：详情浮窗贴列定位（null=沿用右侧固定抽屉；narrow/无列信息时也是 drawer）
  const [anchor, setAnchor] = useState<DetailAnchor | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  // 单一真源（PANEL-VIEW-BUG）：可见性只看 overlayStore.right；视图只看 panelStore.view。
  // view 为 null 表示「没有要显示的视图」→ 不渲染，绝不回退成聊天（否则点任务会偶发显示聊天）。
  const overlayRight = useOverlayStore((s) => s.right);
  const openRightOverlay = useOverlayStore((s) => s.openRight);
  const closeRightOverlay = useOverlayStore((s) => s.closeRight);
  const activeView: PanelView = view ?? 'detail';
  const isOpen = view !== null && overlayRight;
  const asideRef = useRef<HTMLElement>(null);
  /** 打开前的焦点元素（任务卡 / 顶栏「聊天」按钮），关闭后焦点回它（PANEL-ENTRY2：不再有 rail 入口） */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelBodyRefs = useRef<Partial<Record<PanelView, HTMLDivElement | null>>>({ detail: null, ref: null });
  const lastFocusByView = useRef<Partial<Record<PanelView, HTMLElement | null>>>({ detail: null, ref: null });
  // PANEL-MOTION-2：进场/出场过渡（transform+opacity，两个浮窗同一 token）；关闭后保留挂载到出场结束
  const reducedMotion = usePrefersReducedMotion();
  const { mounted, phase } = usePanelPresence(isOpen, reducedMotion);
  const previousView = useRef({ isOpen, view: activeView, mounted });

  // 视图存在即可见：openDetail/openRef 设置 view 后浮窗自动出现；view 为 null 时强制关闭
  // （S2b：openChat 不再设置 view —— 它只切 navStore 并清空面板，见 panelStore.openChat）
  useEffect(() => {
    if (view !== null && !overlayRight) openRightOverlay();
    else if (view === null && overlayRight) closeRightOverlay();
  }, [view, overlayRight, openRightOverlay, closeRightOverlay]);

  // SYS1（I-02/I-09）：详情浮窗属于看板/任务树主区，切到知识库/日志/会话时统一收起，
  // 不再以 420px 覆盖层常驻遮挡主区；收起后 view 归零，回看板不会强行重开。
  // 反向场景（知识页里的任务软链接）：详情在非看板视图里被点开时把主区切回看板，浮窗跟随详情，
  // 避免「刚开就被收起」的死链。
  const navView = useNavStore((s) => s.view);
  const setNavView = useNavStore((s) => s.setView);
  const previousNavView = useRef(navView);
  useEffect(() => {
    const previous = previousNavView.current;
    previousNavView.current = navView;
    if (view !== 'detail') return;
    if (navView === 'board' || navView === 'tree') return;
    if (previous === navView) setNavView('board');
    else clearView();
  }, [navView, view, setNavView, clearView]);

  // 外部点击 / Esc / 头部关闭：视图意图一并清空（否则同步 effect 会因 view 仍在而重新打开浮窗）
  const dismiss = useCallback(() => {
    closeRightOverlay();
    closeRight();
    clearView();
  }, [closeRightOverlay, closeRight, clearView]);
  useDismissable({ open: isOpen, onClose: dismiss, panelRef: asideRef, triggerRef: returnFocusRef });

  useLayoutEffect(() => {
    const previous = previousView.current;
    if (previous.isOpen !== isOpen) {
      if (isOpen) {
        // 记录触发元素（任务卡 / 顶栏「聊天」），关闭后焦点回它
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const target = lastFocusByView.current[activeView] ?? null;
        if (target !== null && panelBodyRefs.current[activeView]?.contains(target)) target.focus();
        else headingRef.current?.focus();
      } else {
        const back = returnFocusRef.current;
        if (back !== null && back.isConnected) back.focus();
      }
    } else if (isOpen && previous.view !== activeView) {
      const target = lastFocusByView.current[activeView] ?? null;
      if (target !== null && panelBodyRefs.current[activeView]?.contains(target)) target.focus();
      else headingRef.current?.focus();
    } else if (isOpen && mounted && !previous.mounted) {
      // 进场：presence 挂载完成后补一次焦点（打开那一刻 heading 还不存在）
      const target = lastFocusByView.current[activeView] ?? null;
      if (target !== null && panelBodyRefs.current[activeView]?.contains(target)) target.focus();
      else headingRef.current?.focus();
    }
    previousView.current = { isOpen, view: activeView, mounted };
  }, [activeView, isOpen, mounted]);

  /**
   * ANCHOR-DETAIL：重算详情浮窗位置（打开、切换卡片、resize、看板横向滚动）。
   * 触发元素取 returnFocusRef；若当前焦点已落在另一列的任务卡上（面板打开时换卡），
   * 则把触发元素更新为那张卡，保证跟着新列走、关闭后焦点也回到它。
   */
  const recomputeAnchor = useCallback((): void => {
    if (activeView !== 'detail') {
      setAnchor(null);
      return;
    }
    // 关闭过程中保留上一位置，避免出场动画里面板跳回右侧
    if (!isOpen || !mounted) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('[data-testid^="column-"]') !== null) {
      returnFocusRef.current = focused;
    }
    const trigger = returnFocusRef.current;
    const columnEl = trigger !== null && trigger.isConnected ? trigger.closest('[data-testid^="column-"]') : null;
    if (columnEl === null) {
      setAnchor({ mode: 'drawer' });
      return;
    }
    const rect = columnEl.getBoundingClientRect();
    const next = computeDetailAnchor(
      { left: rect.left, right: rect.right, top: rect.top, height: rect.height },
      window.innerWidth,
    );
    if (next.mode === 'drawer' || asideRef.current === null) {
      setAnchor(next);
      return;
    }
    // 视口坐标 → 定位容器坐标（aside 的 offsetParent 就是 App 里的 relative 布局壳）
    const containerRect = (asideRef.current.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? null;
    setAnchor({
      ...next,
      left: next.left - (containerRect?.left ?? 0),
      top: next.top - (containerRect?.top ?? 0),
    });
  }, [activeView, isOpen, mounted]);

  useLayoutEffect(() => {
    recomputeAnchor();
    if (activeView !== 'detail' || !isOpen) return undefined;
    window.addEventListener('resize', recomputeAnchor);
    // capture 阶段监听 scroll：横向滚动容器（board-columns）的 scroll 不会冒泡到 window
    window.addEventListener('scroll', recomputeAnchor, true);
    return () => {
      window.removeEventListener('resize', recomputeAnchor);
      window.removeEventListener('scroll', recomputeAnchor, true);
    };
  }, [recomputeAnchor, activeView, isOpen, detailIssueId]);


  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: PointerEvent): void => {
      setWidth(clampWidth(startWidth + (startX - ev.clientX)));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setWidth((w) => {
        const c = clampWidth(w);
        localStorage.setItem(WIDTH_KEY, String(c));
        return c;
      });
      setResizing(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowLeft' ? 10 : e.key === 'ArrowRight' ? -10 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const nextWidth = clampWidth(widthRef.current + delta);
    widthRef.current = nextWidth;
    setWidth(nextWidth);
    localStorage.setItem(WIDTH_KEY, String(nextWidth));
  };

  // PANEL-ENTRY2：取消「收起成小方块」状态；未打开且出场动画结束后整块不渲染，入口在任务卡与顶栏「聊天」
  if (!mounted) return null;

  const anchored = activeView === 'detail' && anchor?.mode === 'anchored' ? anchor : null;
  const panelWidth = anchored?.width ?? width;

  return (
    <aside
      ref={asideRef}
      data-testid="right-panel"
      data-panel-state={phase}
      data-anchor-side={anchored?.side ?? 'fixed'}
      data-anchored={anchored !== null ? 'true' : 'false'}
      aria-label="右侧面板"
      id="right-panel-shell"
      aria-hidden={isOpen ? undefined : true}
      inert={isOpen ? undefined : true}
      style={{
        width: `${panelWidth}px`,
        maxWidth: anchored !== null ? 'none' : 'calc(100vw - 1rem)',
        // ANCHOR-DETAIL：贴列时顶对齐列顶部、与列同高；否则沿用整宽抽屉高度
        height: anchored !== null ? `${anchored.height}px` : 'calc(100dvh - 5rem)',
        ...(anchored !== null ? { left: `${anchored.left}px`, top: `${anchored.top}px` } : {}),
        // 宽度只作为静态尺寸：不用 width 过渡，避免主内容随面板动画重排（PANEL-FLOAT 语义）
        ...panelMotionStyle('slide-right', phase, reducedMotion),
      }}
      className={`absolute z-30 overflow-hidden rounded-lg border border-hairline bg-surface-card ${
        anchored !== null
          ? `shadow-xl ${anchored.side === 'fallback' ? 'ring-1 ring-hairline shadow-2xl' : ''}`
          : 'right-2 top-2 shadow-xl'
      }`}
    >
      <div
        id="right-panel-content"
        data-testid="right-panel-content"
        aria-hidden={!isOpen}
        inert={!isOpen}
        style={{ width: '100%', maxWidth: anchored !== null ? 'none' : 'calc(100vw - 1rem)' }}
        className={`absolute inset-y-0 right-0 flex flex-col transition-transform duration-200 motion-reduce:transition-none ${isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
      >
        <div
          data-testid="right-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title="拖拽调整宽度"
          onPointerDown={onHandlePointerDown}
          onKeyDown={onHandleKeyDown}
          hidden={!isOpen || anchored !== null}
          // top-10 = 头部 h-10：手柄只在内容区，不再压住标题带（原先 inset-y-0 会盖掉头部左缘 6px 与 border）
          className="absolute bottom-0 left-0 top-10 z-10 w-1.5 cursor-col-resize hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
        />
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-3">
          {/* D1：detail 视图不再渲染可见的「任务详情」文案（任务标题顶替其位置），
              aria-label 保留语义与焦点兜底；h-10 头部高度契约不变。 */}
          <h2
            ref={headingRef}
            tabIndex={-1}
            aria-label={activeView === 'detail' ? '任务详情' : undefined}
            className="text-sm font-semibold"
          >
            {activeView === 'detail' ? null : refPanel?.kind === 'log' ? '日志' : '知识'}
          </h2>
          <button
            type="button"
            data-testid="right-panel-close"
            aria-label="关闭右侧面板"
            title="关闭右侧面板"
            onClick={dismiss}
            className="rounded px-2 py-0.5 text-sm text-ink-3 hover:bg-surface-raised"
          >
            ×
          </button>
        </header>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* DETAIL-VIEW-BUG2：**同一时刻只挂载一个视图**（按 view 条件渲染）。
              历史两次修法都是「三个 body 全挂载 + inline transform 遮蔽」，一旦 transform/样式类失效
              或过渡被打断，后渲染的聊天体就会压住详情体（标题是「任务详情」，内容却是聊天）。
              条件渲染从结构上排除这种可能：detail 视图下 chat 子树根本不存在。
              过渡改成挂载时的淡入（key 变化触发），不再依赖两视图互相平移。 */}
          <div key={activeView} className="absolute inset-0 overflow-hidden">
            {activeView === 'detail' && (
              <div
                ref={(node) => { panelBodyRefs.current.detail = node; }}
                data-testid="detail-panel-view"
                onFocusCapture={(event: ReactFocusEvent<HTMLDivElement>) => {
                  if (event.target instanceof HTMLElement) lastFocusByView.current.detail = event.target;
                }}
                className="h-full overflow-hidden"
              >
                <DetailPanel />
              </div>
            )}
            {activeView === 'ref' && (
              <div
                ref={(node) => { panelBodyRefs.current.ref = node; }}
                data-testid="ref-panel-view"
                onFocusCapture={(event: ReactFocusEvent<HTMLDivElement>) => {
                  if (event.target instanceof HTMLElement) lastFocusByView.current.ref = event.target;
                }}
                className="h-full overflow-hidden p-3"
              >
                <RefPanel />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}






