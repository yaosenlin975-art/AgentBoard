import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

export function Modal({ open, title, onClose, children, scrollable = false, size = 'md', variant = 'modal' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // S2c：inline 模式不 portal、不加遮罩，标题与关闭由抽屉负责（放在 hooks 之后，保证 hooks 顺序稳定）
  if (variant === 'inline') return <div data-testid="modal-inline">{children}</div>;
  if (!open) return null;

  // 挂到 document.body：祖先若有 transform/filter（如侧栏 #workspace-sidebar-content 的 translate-x-0），
  // 会成为 position:fixed 的包含块，导致弹窗偏到祖先左上角而不是视口中心。
  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="modal-overlay"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${SIZE_CLASS[size]} rounded-lg border border-hairline bg-surface-card p-5 text-ink shadow-xl${scrollable ? ' max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

