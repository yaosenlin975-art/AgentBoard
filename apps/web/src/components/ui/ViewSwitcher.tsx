/**
 * 视图切换（TOPBAR-CLEAN）：平铺看板 / 任务树 / 知识库。
 * Board 与 KnowledgePanel 各渲染一份，样式统一 —— 知识库按钮不能只存在于 Board，否则切到知识库后无法返回。
 */

export type BoardLayout = 'board' | 'tree';
const ACTIVE = 'bg-blue-100 font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200';
const IDLE = 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800';
const BASE = 'shrink-0 whitespace-nowrap rounded px-2.5 py-1 text-xs';

export interface ViewSwitcherProps {
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
  knowledgeOpen: boolean;
  onToggleKnowledge: () => void;
}

export function ViewSwitcher({ layout, onLayout, knowledgeOpen, onToggleKnowledge }: ViewSwitcherProps) {
  const active = (hit: boolean): string => `${BASE} ${hit ? ACTIVE : IDLE}`;
  return (
    <div data-testid="view-switcher" className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        data-testid="view-board"
        aria-pressed={!knowledgeOpen && layout === 'board'}
        onClick={() => {
          if (knowledgeOpen) onToggleKnowledge();
          onLayout('board');
        }}
        className={active(!knowledgeOpen && layout === 'board')}
      >
        平铺看板
      </button>
      <button
        type="button"
        data-testid="view-tree"
        aria-pressed={!knowledgeOpen && layout === 'tree'}
        onClick={() => {
          if (knowledgeOpen) onToggleKnowledge();
          onLayout('tree');
        }}
        className={active(!knowledgeOpen && layout === 'tree')}
      >
        任务树
      </button>
      <button
        type="button"
        data-testid="view-knowledge"
        aria-pressed={knowledgeOpen}
        onClick={onToggleKnowledge}
        className={active(knowledgeOpen)}
      >
        知识库
      </button>
    </div>
  );
}

