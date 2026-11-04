/**
 * 视图切换工具条外壳（TOPBAR-TABS）：平铺看板 / 任务树 / 知识库三视图共用同一层容器。
 *
 * 背景：视图切换按钮原先分别由 Board 与 KnowledgePanel 各自渲染，两侧容器内边距不同
 * （Board `px-3 py-1`，知识库在 `p-4` 的 section 里），导致切到知识库时 tab 组整体位移。
 * 统一外壳后，tab 组的水平起点与垂直位置由同一份 padding/border 决定，与视图内容无关。
 *
 * TOOLBAR-BLANK：FIX-2 删掉 `ViewSwitcher` 之后，知识库与日志的壳里已没有任何可见控件，
 * 却仍渲染 `px-4 py-2 + border-b + bg-surface-card` → 页顶出现约 40px 空白带（下边框 + 浅底色）。
 * 因此壳在**没有可见内容时返回 null**：一处判断、两处收敛，看板（壳内有搜索框 / 标签 / 「+ 新建」）
 * 自动保留原样式。
 */
import { Children, isValidElement, type ReactNode } from 'react';

/** 子节点是否「可见」：非空文本，或内部仍有非空文本 / 自带 HTML 的内容 */
function isVisible(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return false;
  if (typeof node === 'string') return node.trim() !== '';
  if (typeof node === 'number') return true;
  if (Array.isArray(node)) return node.some(isVisible);
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; dangerouslySetInnerHTML?: { __html?: string } };
    if (props.dangerouslySetInnerHTML?.__html !== undefined) return true;
    // 自闭合的可见控件（搜索框 / 下拉 / 图片 / 图标）没有 children 但确实是内容
    const tag = typeof node.type === 'string' ? node.type : '';
    if (['input', 'textarea', 'select', 'img', 'svg', 'button', 'hr'].includes(tag)) return true;
    return isVisible(props.children);
  }
  return true;
}

export function ViewToolbarShell({ children }: { children: ReactNode }) {
  const hasContent = Children.toArray(children).some(isVisible);
  if (!hasContent) return null;
  return (
    <div
      data-testid="view-toolbar-shell"
      className="flex shrink-0 flex-col gap-2 border-b border-hairline bg-surface-card px-4 py-2"
    >
      {children}
    </div>
  );
}
