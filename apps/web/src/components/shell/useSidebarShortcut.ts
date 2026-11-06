/**
 * SIDEBAR-4：侧栏形态切换快捷键（`Ctrl / Cmd + B`）。
 *
 * 口径（DESIGN-NOTES §6）：
 * - 只在「非输入区」响应：input / textarea / select / contenteditable 内一律不劫持，也不 preventDefault；
 * - 与顶部切换按钮共用同一 `toggleSidebar`，不新增全局状态；
 * - 监听挂在组件内的 window 上，卸载即移除，避免重复绑定或泄漏；
 * - 忽略长按产生的自动重复（`event.repeat`），一次按键只切一次。
 */
import { useEffect } from 'react';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 快捷键是否成立：Ctrl 或 Cmd + B，且不带 Alt（Windows 的 ctrlKey / macOS 的 metaKey 都算） */
export function isSidebarToggleKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}): boolean {
  if (event.altKey === true || event.repeat === true) return false;
  if (event.ctrlKey !== true && event.metaKey !== true) return false;
  return event.key.toLowerCase() === 'b';
}

/** 事件目标是否位于可编辑区域（含 contenteditable 内部的子节点） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE_TAGS.has(target.tagName)) return true;
  const host = target.closest('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

/** 挂载期间监听 window keydown；`onToggle` 需保持引用稳定（store action 或 useCallback） */
export function useSidebarShortcut(onToggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSidebarToggleKey(event)) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggle]);
}
