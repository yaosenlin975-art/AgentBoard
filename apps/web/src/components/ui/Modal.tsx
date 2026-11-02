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
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

export function Modal({ open, title, onClose, children, scrollable = false, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
        className={`w-full ${SIZE_CLASS[size]} rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900${scrollable ? ' max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain' : ''}`}
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

