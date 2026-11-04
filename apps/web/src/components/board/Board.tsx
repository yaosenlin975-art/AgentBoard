/**
 * 中央四列看板（§7.3）：react-query 拉 issues/sessions，dnd-kit 跨列 + 列内排序。
 * 拖放经 resolveDrop 结算 → 乐观更新 → PATCH（跨列带 status，列内只带 sort_order）；
 * PATCH 失败（如 409 占用冲突）回滚缓存并提示。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Issue, Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { commitDrop, detectDropCollision, groupByColumn, resolveDrop } from '../../lib/dnd';
import { buildIssueTreeFilter } from '../../lib/issueTree';
import { Column } from './Column';
import { IssueCardPreview } from './IssueCard';
import { IssueTreeView } from './IssueTreeView';
import { useNavStore } from '../../state/navStore';
import { LabelFilterBar } from './LabelFilterBar';
import { ViewToolbarShell } from '../ui/ViewToolbarShell';
import { NewIssueDialog } from '../topbar/NewIssueDialog';
import {
  readPlanningSort,
  sortPlanning,
  writePlanningSort,
  type PlanningSort,
} from '../../lib/planningSort';
import { PlanningSortButton } from './PlanningSortButton';
import { statusAccent, useWorkspaceStatuses } from '../../lib/workspaceStatuses';

type ActiveDrag = { issue: Issue; width?: number };

export function Board({

}: {
  /** 受控时由 App 提供；未传则组件内部自持（单独渲染 Board 的场景） */

} = {}) {
  const workspaceId = useAppStore((s) => s.workspaceId);
  const selectedLabels = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId ?? ''] ?? NO_SELECTED_LABELS);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // FIX-2：视图（平铺看板 / 任务树）由 navStore（左栏五入口）单一决定，工具条不再有 ViewSwitcher
  const treeMode = useNavStore((s) => s.view === 'tree');
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  // 新建任务弹窗（NEW-ISSUE-PLUS）：入口只在待规划列头 / 任务树工具条，不再放顶栏
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  // 待规划列排序方式（SORT-PLAN）：本地存储，不落库
  const [planningSort, setPlanningSort] = useState<PlanningSort>(() => readPlanningSort());
  // 列字典（STATUS-3-UI）：接口派生，失败时回落五条内置
  const statuses = useWorkspaceStatuses(workspaceId);
  const columns = statuses.names;

  const enabled = workspaceId !== null;
  const { data: issues } = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled,
  });
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled,
  });

  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 标签筛选（多选 OR）+ 搜索：未选任何标签且查询为空 = 显示全部。
  // 查询随工作空间隔离：切换工作空间后不残留上一空间的查询（用记录 workspaceId 的 state 派生，避免先渲染旧值）。
  const [searchState, setSearchState] = useState<{ workspaceId: string | null; query: string }>({
    workspaceId,
    query: '',
  });
  const query = searchState.workspaceId === workspaceId ? searchState.query : '';
  const setQuery = (value: string): void => setSearchState({ workspaceId, query: value });
  // 注意：所有 hook 必须位于「未选工作空间」提前 return 之前，否则切换工作空间时
  // 渲染分支的 hook 数量会变化，React 抛 “Rendered more hooks than during the previous render”。
  const filter = useMemo(
    () => buildIssueTreeFilter(issues ?? [], 'all', query, selectedLabels),
    [issues, query, selectedLabels],
  );
  // 平铺用 matchingIds（不含祖先）；树视图用同一 filter 的 visibleIds，保证同语义
  const visibleIssues = useMemo(() => {
    const all = issues ?? [];
    return filter.active ? all.filter((issue) => filter.matchingIds.has(issue.id)) : all;
  }, [issues, filter]);
  const grouped = groupByColumn(visibleIssues, columns);
  // 「待规划」列排序（SORT-PLAN）：纯函数排序 + 本地存储；其它列保持 sort_order 顺序
  const planningIssues = useMemo(
    () => sortPlanning(grouped['待规划'] ?? [], planningSort),
    [grouped, planningSort],
  );
  const changePlanningSort = (next: PlanningSort): void => {
    setPlanningSort(next);
    writePlanningSort(next);
  };

  if (workspaceId === null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-sm text-neutral-400 dark:text-neutral-500">
          <p className="text-base font-medium text-neutral-500 dark:text-neutral-400">看板</p>
          <p className="mt-1">请先在左侧选择或创建工作空间</p>
        </div>
      </div>
    );
  }

  const runningSessionIds = new Set(
    (sessions ?? []).filter((s) => s.status === '运行中').map((s) => s.id),
  );

  const handleDragStart = (event: DragStartEvent): void => {
    const issue = (issues ?? []).find((item) => item.id === String(event.active.id));
    if (!issue) return;
    const width = event.active.rect.current.initial?.width;
    setActiveDrag({ issue, ...(width && width > 0 ? { width } : {}) });
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over || !issues) return;
    const drop = resolveDrop(issues, String(active.id), String(over.id));
    if (!drop) return;
    commitDrop({
      queryClient,
      queryKey: ['issues', workspaceId],
      drop,
      patchIssue: (id, patch) => api.patch<Issue>(`/api/issues/${id}`, patch),
      onError: (err) => setError(err instanceof Error ? err.message : '移动失败，请重试'),
    });
  };

  return (
    <div className="flex h-full flex-col">
      {error !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="px-1 text-red-500" aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {/* TOPBAR-INLINE：视图切换（平铺看板/任务树/知识库/日志）+ 搜索框 + 标签 chips 同在一行。
          tab 组 `shrink-0` 不被压缩；搜索框 `shrink-0`；chips 容器 `min-w-0 flex-1 overflow-x-auto`
          空间不足时优先压缩/横滚 chips；≤900 允许 chips 换第二行（wrap），但 tab 与搜索框仍在同一行。
          外壳与知识库视图共用 ViewToolbarShell，保证三视图下 tab 组位置恒定（TOPBAR-TABS）。 */}
      <ViewToolbarShell>
        <div data-testid="board-toolbar-row" className="flex min-w-0 flex-wrap items-center gap-2 max-[900px]:items-start">
          <div data-testid="board-toolbar-controls" className="flex shrink-0 flex-wrap items-center gap-1">
          </div>
          <div data-testid="board-toolbar-filters" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <input
              aria-label="搜索任务"
              data-testid="board-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题/描述/标签"
              className="h-8 w-40 shrink-0 rounded-lg border border-hairline bg-surface-raised px-2.5 text-xs text-ink outline-none focus:border-accent sm:w-56"
            />
            <div data-testid="board-toolbar-chips" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto max-[900px]:basis-full">
              <LabelFilterBar workspaceId={workspaceId} />
            </div>
            {/* 任务树没有列概念：在工具条右侧给同等的新建入口（同一弹窗、同样落「待规划」） */}
            {treeMode && (
              <button
                type="button"
                data-testid="tree-create-issue"
                aria-label="新建任务"
                title="新建任务（待规划）"
                disabled={workspaceId === null}
                onClick={() => setNewIssueOpen(true)}
                className="shrink-0 rounded-md border border-accent bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                + 新建
              </button>
            )}
          </div>
        </div>
      </ViewToolbarShell>
      {treeMode ? (
        <IssueTreeView
          workspaceId={workspaceId}
          issues={issues ?? []}
          runningSessionIds={runningSessionIds}
          query={query}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={detectDropCollision}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          {/* 列容器（BOARD-COLS / design §6）：grid 自适应，列数取当前列数组长度（不写死 4）。
              每列 minmax(280px, 1fr)：列少时 1fr 撑满容器、右侧不留白；列多时保底 280px 并横向滚动。
              auto-rows-fr（COL-SCROLL）：把隐式行高钉成 minmax(0, 1fr)，否则默认 auto 行会按内容
              max-content 撑到上万像素——列内 overflow-y-auto 就永远没有可滚动溢出，而外层
              overflow-y-hidden 又把超长内容裁掉，表现为「列内滚轮失效」。 */}
          <div
            data-testid="board-columns"
            className="grid min-h-0 flex-1 auto-rows-fr gap-3 overflow-x-auto overflow-y-hidden p-4"
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(280px, 1fr))` }}
          >
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                issues={status === '待规划' ? planningIssues : (grouped[status] ?? [])}
                accent={statusAccent(statuses.byName.get(status)?.kind)}
                runningSessionIds={runningSessionIds}
                {...(status === '待规划' ? { onCreateIssue: () => setNewIssueOpen(true) } : {})}
                {...(status === '待规划'
                  ? { sortControl: <PlanningSortButton sort={planningSort} onChange={changePlanningSort} /> }
                  : {})}
              />
            ))}
          </div>
          {createPortal(
            <DragOverlay zIndex={50} dropAnimation={null}>
              {activeDrag !== null && (
                <IssueCardPreview
                  issue={activeDrag.issue}
                  sessionRunning={runningSessionIds.has(activeDrag.issue.session_id ?? '')}
                  width={activeDrag.width}
                />
              )}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
      )}
      {/* 新建任务入口（NEW-ISSUE-PLUS）：平铺看板在「待规划」列头，任务树在工具条（树没有列） */}
      {workspaceId !== null && (
        <NewIssueDialog open={newIssueOpen} workspaceId={workspaceId} onClose={() => setNewIssueOpen(false)} />
      )}
    </div>
  );
}



