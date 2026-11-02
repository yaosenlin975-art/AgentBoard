/**
 * 浮窗关闭与焦点回收（PANEL-FLOAT），左右浮窗共用。
 * - 外部 pointerdown（落点在浮窗与触发按钮之外，且不在 Modal 内）→ 关闭；
 * - Esc → 关闭（有 Modal 打开时不关，让 Modal 先处理）；
 * - 关闭后焦点回到触发按钮（键盘可达性）。
 */
import { useEffect, type RefObject } from 'react';

export function useDismissable(options: {
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
}): void {
  const { open, onClose, panelRef, triggerRef } = options;

  useEffect(() => {
    if (!open) return;
    const isInsideModal = (target: Node): boolean => {
      const element = target instanceof Element ? target : null;
      return element !== null && element.closest('[role="dialog"]') !== null;
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      if (isInsideModal(target)) return; // Modal 打开时点击其遮罩不应连带关浮窗
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, panelRef, triggerRef]);

  // 关闭时焦点回到触发按钮
  useEffect(() => {
    if (open) return;
    const trigger = triggerRef.current;
    if (trigger !== null && document.activeElement !== trigger && trigger.isConnected) trigger.focus();
  }, [open, triggerRef]);
}
