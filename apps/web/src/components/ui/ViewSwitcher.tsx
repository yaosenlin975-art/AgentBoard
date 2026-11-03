/**
 * 视图切换（TOPBAR-CLEAN / LOG-VIEW）：平铺看板 / 任务树 / 知识库 / 日志。
 * Board、KnowledgePanel 与 ChangelogPanel（日志视图）各渲染一份，样式统一 —— 知识库与日志按钮不能只存在于一处，
 * 否则切过去之后无法返回。四个视图互斥，由调用方的 on* 回调保证（App 持有 knowledgeOpen / logOpen）。
 */

export type BoardLayout = 'board' | 'tree';
const ACTIVE = 'bg-accent-soft font-medium text-accent dark:bg-accent-soft';
const IDLE = 'text-ink-2 hover:bg-surface-raised';
const BASE = 'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs';

export interface ViewSwitcherProps {
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
  knowledgeOpen: boolean;
  onToggleKnowledge: () => void;
  logOpen?: boolean;
  onToggleLog?: () => void;
}

export function ViewSwitcher({
  layout,
  onLayout,
  knowledgeOpen,
  onToggleKnowledge,
  logOpen = false,
  onToggleLog,
}: ViewSwitcherProps) {
  const active = (hit: boolean): string => `${BASE} ${hit ? ACTIVE : IDLE}`;
  return (
    <div data-testid="view-switcher" className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        data-testid="view-board"
        aria-pressed={!knowledgeOpen && !logOpen && layout === 'board'}
        onClick={() => {
          if (knowledgeOpen) onToggleKnowledge();
          if (logOpen) onToggleLog?.();
          onLayout('board');
        }}
        className={active(!knowledgeOpen && !logOpen && layout === 'board')}
      >
        平铺看板
      </button>
      <button
        type="button"
        data-testid="view-tree"
        aria-pressed={!knowledgeOpen && !logOpen && layout === 'tree'}
        onClick={() => {
          if (knowledgeOpen) onToggleKnowledge();
          if (logOpen) onToggleLog?.();
          onLayout('tree');
        }}
        className={active(!knowledgeOpen && !logOpen && layout === 'tree')}
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
      {onToggleLog !== undefined && (
        <button
          type="button"
          data-testid="view-log"
          aria-pressed={logOpen}
          onClick={onToggleLog}
          className={active(logOpen)}
        >
          日志
        </button>
      )}
    </div>
  );
}
