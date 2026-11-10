import type { ReactNode } from 'react';

interface TopBarProps {
  /** 面包屑左侧的工作空间名；未选择时显示占位文案 */
  workspaceName?: string | null;
  /** 面包屑右侧的视图名（看板 / 任务树） */
  viewLabel: string;
  /** 右侧上下文控件：显示密度、分组方式、选择、（任务树）新建任务 */
  controls: ReactNode;
  /** 中段：搜索框 + 标签 chips */
  filters: ReactNode;
}

/**
 * 看板顶栏（TOPBAR-REDESIGN，2026-11-10）。
 *
 * 替换旧 `ViewToolbarShell` 的双层内边距外壳：46px 单行（py-2 + 30px 控件），
 * 左侧面包屑「工作空间 › 视图」，中段搜索 + 标签，右端显示控件；视觉只用现有
 * 令牌类（surface-card / hairline / ink-* / accent-soft），不新增色值。
 *
 * 窄屏（≤920px）：`filters` 容器降级为 `display: contents`，搜索框与标签成为
 * 同一行容器的直接子项 —— 第一行「面包屑 + 搜索 + 控件」，标签整行换行。
 * 标签容器保持 `min-w-0`、不横滚（LABEL-BAR：横滚会裁掉「更多」浮层）。
 */
export function TopBar({ workspaceName, viewLabel, controls, filters }: TopBarProps) {
  return (
    <header
      data-testid="view-toolbar-shell"
      className="flex shrink-0 flex-col border-b border-hairline bg-surface-card px-4 py-2"
    >
      <div
        data-testid="board-toolbar-row"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 max-[920px]:items-start"
      >
        <div data-testid="topbar-crumb" className="flex min-w-0 shrink-0 items-center gap-1.5">
          <span
            className="max-w-40 truncate text-[11.5px] text-ink-3"
            title={workspaceName ?? undefined}
          >
            {workspaceName ?? '未选择工作空间'}
          </span>
          <span aria-hidden="true" className="text-[11px] text-ink-3/70">
            ›
          </span>
          <span className="text-[12.5px] font-semibold text-ink">{viewLabel}</span>
        </div>
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
