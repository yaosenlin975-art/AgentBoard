/**
 * 视图切换工具条外壳（TOPBAR-TABS）：平铺看板 / 任务树 / 知识库三视图共用同一层容器。
 *
 * 背景：视图切换按钮原先分别由 Board 与 KnowledgePanel 各自渲染，两侧容器内边距不同
 * （Board `px-3 py-1`，知识库在 `p-4` 的 section 里），导致切到知识库时 tab 组整体位移。
 * 统一外壳后，tab 组的水平起点与垂直位置由同一份 padding/border 决定，与视图内容无关。
 */
import type { ReactNode } from 'react';

export function ViewToolbarShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-hairline bg-surface-card px-4 py-2">
      {children}
    </div>
  );
}
