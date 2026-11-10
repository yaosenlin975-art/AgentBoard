import type { ReactNode } from 'react';

interface TopBarProps {
  /** 右侧上下文控件：显示密度、分组方式、选择、（任务树）新建任务 */
  controls: ReactNode;
  /** 中段：搜索框 + 标签 chips */
  filters: ReactNode;
}

/**
 * 看板顶栏（TOPBAR-REDESIGN，2026-11-10；TOPBAR-02 去掉左侧面包屑）。
 *
 * 替换旧 `ViewToolbarShell` 的双层内边距外壳：46px 单行（py-2 + 30px 控件），
 * 中段搜索 + 标签，右端显示控件；视觉只用现有令牌类（surface-card / hairline /
 * ink-* / accent-soft），不新增色值。
 *
 * TOPBAR-02：左侧「工作空间 › 视图」面包屑整段删除 —— 当前工作区与视图由左栏
 * SideBar 承担（工作区名 + 路径 + `aria-current` 高亮），顶栏不再重复。删后
 * 搜索框从行首开始、右端控件靠右，不留占位与分隔线。
 *
 * 窄屏（≤920px）：`filters` 容器降级为 `display: contents`，搜索框与标签成为
 * 同一行容器的直接子项 —— 第一行「搜索 + 控件」，标签整行换行。
 * 标签容器保持 `min-w-0`、不横滚（LABEL-BAR：横滚会裁掉「更多」浮层）。
 */
export function TopBar({ controls, filters }: TopBarProps) {
  return (
    <header
      data-testid="view-toolbar-shell"
      className="flex shrink-0 flex-col border-b border-hairline bg-surface-card px-4 py-2"
    >
      <div
        data-testid="board-toolbar-row"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 max-[920px]:items-start"
      >
        <div
          data-testid="board-toolbar-controls"
          className="order-3 ml-auto flex shrink-0 flex-wrap items-center gap-1.5"
        >
          {controls}
        </div>
        <div
          data-testid="board-toolbar-filters"
          className="order-2 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-[920px]:contents"
        >
          {filters}
        </div>
      </div>
    </header>
  );
}
