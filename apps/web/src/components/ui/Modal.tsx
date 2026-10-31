import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ open, title, onClose, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="modal-overlay"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900"
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
}
