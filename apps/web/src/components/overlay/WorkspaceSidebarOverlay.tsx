/**
 * 左浮窗：工作空间列表（PANEL-FLOAT）。
 * 由 TopBar「工作空间」按钮触发，**在该按钮正下方左上对齐**展开（由按钮外层 relative 容器定位）。
 * 外部点击 / Esc / 再点按钮关闭；关闭后焦点回到该按钮。
 * 绝对定位、不占主内容宽度 —— SIDEBAR01 的「侧栏让位」语义由浮窗模型取代。
 */
import { useEffect, useRef } from 'react';
import { useOverlayStore } from '../../state/overlayStore';
import { WorkspaceList } from '../workspace/WorkspaceList';
import { useDismissable } from './useDismissable';
import { panelMotionStyle, usePanelPresence, usePrefersReducedMotion } from './panelMotion';

export const LEFT_TRIGGER_ID = 'workspace-sidebar-trigger';
export const LEFT_PANEL_ID = 'workspace-sidebar';

export function WorkspaceSidebarOverlay({ triggerRef }: { triggerRef: React.RefObject<HTMLButtonElement | null> }) {
  const open = useOverlayStore((s) => s.left);
  const closeLeft = useOverlayStore((s) => s.closeLeft);
  const panelRef = useRef<HTMLElement | null>(null);
  useDismissable({ open, onClose: closeLeft, panelRef, triggerRef });
  // PANEL-MOTION-2：进场/出场过渡；关闭后保留挂载到出场动画结束（reduced-motion 时瞬时卸载）
  const reducedMotion = usePrefersReducedMotion();
  const { mounted, phase } = usePanelPresence(open, reducedMotion);

  // 打开时焦点进入浮窗（优先搜索框，其次首个可聚焦元素）
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    // querySelector 的选择器列表按文档顺序匹配，不能靠列表顺序表达优先级：先找搜索框
    const target = panel.querySelector<HTMLElement>('input') ?? panel.querySelector<HTMLElement>('button, [href], select, textarea, [tabindex]:not([tabindex="-1"])');
    target?.focus();
  }, [open, mounted]);

  if (!mounted) return null;

  return (
    <aside
      id={LEFT_PANEL_ID}
      ref={panelRef}
      data-testid="workspace-sidebar"
      data-panel-state={phase}
      aria-label="工作空间栏"
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      style={panelMotionStyle('drop', phase, reducedMotion)}
      className="absolute left-0 top-full z-30 mt-1 flex max-h-[calc(100dvh-5rem)] w-[260px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div data-testid="workspace-sidebar-content" className="min-h-0 flex-1 overflow-y-auto">
        <WorkspaceList />
      </div>
    </aside>
  );
}
