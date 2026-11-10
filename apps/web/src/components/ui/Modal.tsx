import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeSidePanel } from '../../lib/drawerAnchor';
import { isTopOverlay, pushOverlay, removeOverlay } from '../../lib/overlayStack';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  scrollable?: boolean;
  /** 宽度档位：md=28rem（默认，既有调用方不变），lg=42rem（设置页账号管理这类多列内容） */
  size?: 'md' | 'lg';
  /**
   * S2c：modal（默认）= 原来的 portal 弹窗；inline = 不套遮罩/弹窗壳，直接把内容渲染进调用方的容器
   * （右侧滑出 drawer 用；抽屉自己提供标题、关闭按钮与滚动容器）。
   */
  variant?: 'modal' | 'inline';
  /**
   * 弹窗落位：center=居中（默认）；right=贴右侧整高抽屉（窄屏兜底）；
   * side=贴在锚定面板（设置抽屉）右缘并排，无深色遮罩；放不下时自动降级为 right。
   */
  placement?: 'center' | 'right' | 'side';
  /** placement="side" 时用来测量右缘的锚定元素选择器 */
  anchorSelector?: string;
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

/** dialog 内可 Tab 到达的元素（排除 disabled / tabindex=-1 / hidden input） */
const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
}

/** 已打开的浮层按打开顺序入共享栈（见 lib/overlayStack）：嵌套时只有最上层响应 Esc */
export function Modal({ open, title, onClose, children, scrollable = false, size = 'md', variant = 'modal', placement = 'center', anchorSelector }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 最新 onClose 放 ref：避免父级每次渲染换新函数时重跑 effect（会重新抢焦点）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // SETTINGS-LAYOUT：side 模式的落位（视口坐标）；null = 没有锚点或放不下 → 降级 right 覆盖抽屉
  const [sideLayout, setSideLayout] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || variant !== 'modal' || placement !== 'side') return;
    const measure = (): void => {
      const anchor = anchorSelector !== null && anchorSelector !== undefined
        ? document.querySelector(anchorSelector)
        : document.querySelector('[data-testid="drawer-panel"]');
      if (anchor === null) {
        setSideLayout(null);
        return;
      }
      const next = computeSidePanel(anchor.getBoundingClientRect().right, window.innerWidth);
      setSideLayout(next.mode === 'side' ? { left: next.left, width: next.width } : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, variant, placement, anchorSelector]);

  useEffect(() => {
    if (!open || variant !== 'modal') return;
    const token = Symbol('modal');
    pushOverlay(token);
    // 打开瞬间记住触发元素，关闭后归还（抽屉不持有触发按钮 ref 时同样成立）
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog !== null) {
      // 首字段优先：跳过头部「关闭」按钮，聚焦内容区第一个可 Tab 元素
      const items = tabbablesIn(dialog);
      const target = items.find((el) => !el.hasAttribute('data-modal-close')) ?? items[0];
      target?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 嵌套场景只让最上层关闭；下层弹窗/抽屉保持打开
        if (!isTopOverlay(token)) return;
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const items = tabbablesIn(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      // 焦点不在本层（例如内层 Modal 已接管）→ 不处理，避免把焦点抢回外层
      if (!(active instanceof HTMLElement) || !root.contains(active)) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      removeOverlay(token);
    };
  }, [open, variant]);

  // 关闭后焦点回到触发元素；触发元素已卸载则放弃，不做隐式转移
  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target !== null && document.contains(target) && target !== document.activeElement) target.focus();
  }, [open]);

  // S2c：inline 模式不 portal、不加遮罩，标题与关闭由抽屉负责（放在 hooks 之后，保证 hooks 顺序稳定）
  if (variant === 'inline') return <div data-testid="modal-inline">{children}</div>;
  if (!open) return null;

  // 挂到 document.body：祖先若有 transform/filter（如侧栏 #workspace-sidebar-content 的 translate-x-0），
  // 会成为 position:fixed 的包含块，导致弹窗偏到祖先左上角而不是视口中心。
  const isSide = placement === 'side' && sideLayout !== null;
  const isDrawer = placement === 'right' || (placement === 'side' && !isSide);
  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-base font-semibold">{title}</h2>
      <button
        type="button"
        aria-label="关闭"
        data-modal-close
        onClick={onClose}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        关闭
      </button>
    </div>
  );

  // SETTINGS-LAYOUT：并排模式——无深色遮罩（设置面板保持可见可读），贴在锚定面板右缘、
  // 垂直铺满、仅用 border-l hairline 分隔；层级与遮罩式抽屉相同（z-50，压在设置抽屉 z-40 之上的同层视觉带）。
  if (isSide) {
    return createPortal(
      <div
        data-testid="modal-side"
        className="fixed inset-y-0 z-50"
        style={{ left: sideLayout.left, width: sideLayout.width }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="h-full w-full overflow-y-auto overscroll-contain rounded-none border-l border-hairline bg-surface-card p-5 text-ink shadow-xl"
        >
          {header}
          {children}
        </div>
      </div>,
      document.body,
    );
  }

  const overlay = (
    <div
      className={`fixed inset-0 z-50 flex bg-black/40 ${isDrawer ? 'justify-end' : 'items-center justify-center p-4'}`}
      data-testid="modal-overlay"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={
          isDrawer
            ? 'h-full w-full max-w-[30rem] overflow-y-auto overscroll-contain rounded-none border-l border-hairline bg-surface-card p-5 text-ink shadow-xl'
            : `w-full ${SIZE_CLASS[size]} rounded-lg border border-hairline bg-surface-card p-5 text-ink shadow-xl${scrollable ? ' max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain' : ''}`
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        {header}
        {children}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

