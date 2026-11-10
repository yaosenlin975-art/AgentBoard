/**
 * 中央四列看板（§7.3）：react-query 拉 issues/sessions，dnd-kit 跨列 + 列内排序。
 * 拖放经 resolveDrop 结算 → 乐观更新 → PATCH（跨列带 status，列内只带 sort_order）；
 * PATCH 失败（如 409 占用冲突）回滚缓存并提示。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
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
import { listIssues as listIssuesApi, patchIssue as patchIssueApi } from '../../api/endpoints';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { commitDrop, detectDropCollision, groupByColumn, resolveDrop } from '../../lib/dnd';
import { mapWithConcurrency } from '../../lib/promisePool';
import { buildIssueTreeFilter } from '../../lib/issueTree';
import { Column } from './Column';
import { IssueCardPreview } from './IssueCard';
import { IssueTreeView } from './IssueTreeView';
import { useNavStore } from '../../state/navStore';
import { LabelFilterBar } from './LabelFilterBar';
import { TopBar } from '../shell/TopBar';
import {
  readPlanningSort,
  sortPlanning,
  writePlanningSort,
  type PlanningSort,
} from '../../lib/planningSort';
import { PlanningSortButton } from './PlanningSortButton';
import { statusAccent, useWorkspaceStatuses } from '../../lib/workspaceStatuses';
import {
  readDisplayOptions,
  writeDisplayOptions,
  type DisplayOptions,
} from '../../lib/displayOptions';
import {
  idsInScope,
  issueInScope,
  pruneSelection,
  toggleColumnSelected,
  toggleSelectAll,
  toggleSelected,
  type SelectionScope,
} from '../../lib/selection';
import { SelectionBar } from './SelectionBar';
import { ErrorState } from '../ui/ErrorState';

// WEB-BUNDLE（3451075e）：弹窗只在用户点开时才需要，从首屏静态依赖里摘出去。
const NewIssueDialog = lazy(() =>
  import('../topbar/NewIssueDialog').then((m) => ({ default: m.NewIssueDialog })),
);
const ReleaseRunningDialog = lazy(() =>
  import('./ReleaseRunningDialog').then((m) => ({ default: m.ReleaseRunningDialog })),
);

type ActiveDrag = { issue: Issue; width?: number };

/** CR-4：批量改状态的并发上限（单测断言不超此值） */
const BATCH_PATCH_CONCURRENCY = 6;

export function Board() {
  const workspaceId = useAppStore((s) => s.workspaceId);
  const selectedLabels = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId ?? ''] ?? NO_SELECTED_LABELS);
  const clearLabels = useAppStore((s) => s.clearLabels);
  // DEC-JUMP-WS：待决策跳过来的定位目标（瞬态；消费后清空）
  const boardFocus = useNavStore((s) => s.boardFocus);
  const clearBoardFocus = useNavStore((s) => s.clearBoardFocus);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // FIX-2：视图（平铺看板 / 任务树）由 navStore（左栏五入口）单一决定，工具条不再有 ViewSwitcher
  const treeMode = useNavStore((s) => s.view === 'tree');
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  // 新建任务弹窗（NEW-ISSUE-PLUS）：入口只在待规划列头 / 任务树工具条，不再放顶栏
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  // REL-2：进行中列头救火键 → 预览弹窗；退回后用「本次退回 id 集」做即时过滤入口
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releasedBatch, setReleasedBatch] = useState<{ ids: ReadonlySet<string>; count: number } | null>(null);
  const [onlyReleased, setOnlyReleased] = useState(false);
  const [releaseToast, setReleaseToast] = useState<string | null>(null);
  // 待规划列排序方式（SORT-PLAN）：本地存储，不落库
  const [planningSort, setPlanningSort] = useState<PlanningSort>(() => readPlanningSort());
  // BORROW-1.1：显示偏好（密度/分组）本地持久化；两段式选择状态
  const [displayOptions, setDisplayOptions] = useState<DisplayOptions>(() => readDisplayOptions());
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectionScope, setSelectionScope] = useState<SelectionScope | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 列字典（STATUS-3-UI）：接口派生，失败时回落五条内置
  const statuses = useWorkspaceStatuses(workspaceId);
  const columns = statuses.names;

  const enabled = workspaceId !== null;
  // PERF-9：区分「加载中」与「真的没任务」——isPending 期间列内渲染骨架，不用 `[]` 冒充空态；
  // 切工作空间用 keepPreviousData 保留上一屏，配 placeholder 标记说明这是上一空间数据。
  const {
    data: issues,
    isPending: issuesPending,
    isPlaceholderData: issuesPlaceholder,
  } = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => listIssuesApi(workspaceId),
    enabled,
    placeholderData: keepPreviousData,
  });
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (releaseToast === null) return;
    const timer = setTimeout(() => setReleaseToast(null), 5000);
    return () => clearTimeout(timer);
  }, [releaseToast]);

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
    const base = filter.active ? all.filter((issue) => filter.matchingIds.has(issue.id)) : all;
    if (!onlyReleased || releasedBatch === null) return base;
    return base.filter((issue) => releasedBatch.ids.has(issue.id));
  }, [issues, filter, onlyReleased, releasedBatch]);
  // CR2-6：分组结果按引用缓存，无关状态变化（弹窗、选择态等）不再重建各列数组
  const grouped = useMemo(() => groupByColumn(visibleIssues, columns), [visibleIssues, columns]);
  // 「待规划」列排序（SORT-PLAN）：纯函数排序 + 本地存储；其它列保持 sort_order 顺序
  const planningIssues = useMemo(
    () => sortPlanning(grouped['待规划'] ?? [], planningSort),
    [grouped, planningSort],
  );
  const changePlanningSort = useCallback((next: PlanningSort): void => {
    setPlanningSort(next);
    writePlanningSort(next);
  }, []);
  // CR2-6：列头排序控件 / 运行中会话集按引用缓存，否则每次渲染都生成新 props 打穿 Column memo
  const planningSortControl = useMemo(
    () => <PlanningSortButton sort={planningSort} onChange={changePlanningSort} />,
    [planningSort, changePlanningSort],
  );
  const runningSessionIds = useMemo(
    () => new Set((sessions ?? []).filter((s) => s.status === '运行中').map((s) => s.id)),
    [sessions],
  );
  const openNewIssue = useCallback(() => setNewIssueOpen(true), []);
  const openReleaseRunning = useCallback(() => setReleaseOpen(true), []);
  // BORROW-1.1：显示偏好即时生效并写 localStorage（刷新后保持）
  const changeDisplayOptions = (next: DisplayOptions): void => {
    setDisplayOptions(next);
    writeDisplayOptions(next);
  };
  const startSelection = (): void => {
    setSelectionActive(true);
    setSelectionScope(null);
    setSelectedIds(new Set());
  };
  const exitSelection = (): void => {
    setSelectionActive(false);
    setSelectionScope(null);
    setSelectedIds(new Set());
  };
  const pickSelectionScope = (scope: SelectionScope): void => {
    setSelectionScope(scope);
    setSelectedIds(new Set());
  };
  // 两段式第二段：只有范围内卡片可勾选
  const toggleCardSelection = useCallback(
    (id: string): void => {
      const issue = (issues ?? []).find((item) => item.id === id);
      setSelectedIds((prev) => toggleSelected(prev, id, issue !== undefined && issueInScope(selectionScope, issue)));
    },
    [issues, selectionScope],
  );
  const scopeIds = idsInScope(visibleIssues, selectionScope);
  /**
   * BOARD-SEL-1：列头整列 toggle。
   * 只增删本列 id，其它列的已选卡片原样保留；范围放大为「整个看板」，
   * 否则列头 toggle 选中的卡片会因不在当前范围而没有勾选框。
   */
  const toggleColumnSelection = useCallback((ids: readonly string[]): void => {
    setSelectionScope((prev) => (prev?.kind === 'board' ? prev : { kind: 'board' }));
    setSelectedIds((prev) => toggleColumnSelected(prev, ids));
  }, []);
  // 数据刷新后剔除已删除卡片，避免批量 PATCH 打到幽灵 id
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = pruneSelection(prev, issues ?? []);
      return next.size === prev.size ? prev : next;
    });
  }, [issues]);
  /**
   * DEC-JUMP-WS：待决策「卡详情」跳转后的看板定位。
   * 先清掉会隐藏目标卡的本地筛选（搜索词 / 标签 / 仅看本次退回），等本工作区数据就绪后
   * 把卡滚进视口；高亮由入口同时打开的详情浮窗（IssueCard 的 detailOpen 态）承担。
   * 数据就绪但找不到该卡（已删除 / 不属于本工作区）也清空焦点，不留下次误跳。
   */
  useEffect(() => {
    if (boardFocus === null || workspaceId === null) return;
    if (query !== '') setSearchState({ workspaceId, query: '' });
    if (selectedLabels.length > 0) clearLabels(workspaceId);
    if (onlyReleased) setOnlyReleased(false);
    if (issues === undefined || issuesPending || issuesPlaceholder) return;
    if (issues.some((issue) => issue.id === boardFocus)) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-testid="issue-card-${boardFocus}"]`)
          ?.scrollIntoView?.({ block: 'center' });
      });
    }
    clearBoardFocus();
  }, [
    boardFocus,
    workspaceId,
    issues,
    issuesPending,
    issuesPlaceholder,
    query,
    selectedLabels,
    onlyReleased,
    clearLabels,
    clearBoardFocus,
  ]);
  // CR-4：批量改状态有限并发（≤6），避免选 N 张就并发 N 个写请求放大 SQLite 写锁排队
  const applyBatchStatus = async (status: string): Promise<void> => {
    if (workspaceId === null || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    setBatchBusy(true);
    try {
      const results = await mapWithConcurrency(ids, BATCH_PATCH_CONCURRENCY, (id) =>
        patchIssueApi(id, { status }),
      );
      // 无论成败统一失效刷新：已成功写入的卡立刻反映到界面，不依赖 WS 帧
      await queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] });
      const failures = results
        .map((result, index) => ({ id: ids[index], result }))
        .filter((entry): entry is { id: string; result: PromiseRejectedResult } => entry.result.status === 'rejected');
      if (failures.length === 0) {
        setSelectedIds(new Set());
        return;
      }
      // 部分失败：失败 id 保留在选中态（重试只重打失败卡，不重复 PATCH 已成功卡），逐条列出原因
      setSelectedIds(new Set(failures.map((failure) => failure.id)));
      const titles = new Map((issues ?? []).map((issue) => [issue.id, issue.title]));
      const detail = failures
        .map(({ id, result }) => {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          return `${titles.get(id) ?? id}：${reason}`;
        })
        .join('；');
      setError(`批量移动完成：成功 ${ids.length - failures.length} 张，失败 ${failures.length} 张 —— ${detail}`);
    } finally {
      setBatchBusy(false);
    }
  };

  /**
   * REL-2：退回成功后把响应里的 issue **就地写回列表缓存**（与 DetailPanel 的 refreshIssue 同一口径），
   * 卡片立刻离开「进行中」、占用徽标立刻消失，不依赖随后的 WS 帧；同时记录本次 id 集供「仅看本次退回」。
   */
  const handleReleased = (released: Issue[]): void => {
    if (workspaceId === null || released.length === 0) return;
    queryClient.setQueryData<Issue[]>(['issues', workspaceId], (list) =>
      list === undefined ? list : list.map((item) => released.find((r) => r.id === item.id) ?? item),
    );
    setReleasedBatch({ ids: new Set(released.map((issue) => issue.id)), count: released.length });
    setOnlyReleased(true);
    setReleaseToast(`已退回 ${released.length} 张到待规划`);
  };

  if (workspaceId === null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-sm text-ink-3">
          <p className="text-base font-medium text-ink-3">看板</p>
          <p className="mt-1">请先在左侧选择或创建工作空间</p>
        </div>
      </div>
    );
  }

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
      patchIssue: (id, patch) => patchIssueApi(id, patch),
      onError: (err) => setError(err instanceof Error ? err.message : '移动失败，请重试'),
    });
  };

  return (
    <div className="flex h-full flex-col">
      {error !== null && (
        <ErrorState error={error} onDismiss={() => setError(null)} className="rounded-none border-x-0 border-t-0 px-3 py-1.5 text-sm" />
      )}
      {/* REL-2：退回结果条 —— toast 文案 + 「仅看本次退回」入口（组件态记住本次 id 集） */}
      {(releaseToast !== null || releasedBatch !== null) && (
        <div
          data-testid="release-banner"
          className="flex items-center gap-3 border-b border-hairline px-3 py-1.5 text-xs"
        >
          {releaseToast !== null && (
            <span className="text-ink-2" data-testid="release-toast">{releaseToast}</span>
          )}
          {releasedBatch !== null && (
            <button
              type="button"
              data-testid="release-only-toggle"
              aria-pressed={onlyReleased}
              onClick={() => setOnlyReleased((value) => !value)}
              className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-surface-raised hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {onlyReleased ? '显示全部任务' : `仅看本次退回（${releasedBatch.count}）`}
            </button>
          )}
        </div>
      )}
      {/* TOPBAR-REDESIGN：46px 单行顶栏（搜索 + 标签 + 右端显示控件），替换旧双行外壳。
          TOPBAR-02：左侧面包屑已删除（当前工作区/视图由左栏 SideBar 承担）。
          ≤920px：搜索/控件一行，标签整行换行（LABEL-BAR：不横滚，避免裁掉「更多」浮层）。
          任务树没有列概念：在同一顶栏右端给同等新建入口（同一弹窗、同样落「待规划」）。 */}
      <TopBar
        controls={
          <>
            {/* BORROW-1.1：显示偏好（本地持久化） */}
            <select
              aria-label="显示密度"
              data-testid="display-density"
              value={displayOptions.density}
              onChange={(event) => changeDisplayOptions({ ...displayOptions, density: event.target.value === 'compact' ? 'compact' : 'comfortable' })}
              className="h-[30px] shrink-0 rounded-lg border border-hairline bg-transparent px-1.5 text-xs text-ink-2 transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none"
            >
              <option value="comfortable">舒适密度</option>
              <option value="compact">紧凑密度</option>
            </select>
            <select
              aria-label="分组方式"
              data-testid="display-grouping"
              title={displayOptions.grouping === 'label' ? '按标签分组显示时禁用拖拽排序' : undefined}
              value={displayOptions.grouping}
              onChange={(event) => changeDisplayOptions({ ...displayOptions, grouping: event.target.value === 'label' ? 'label' : 'none' })}
              className="h-[30px] shrink-0 rounded-lg border border-hairline bg-transparent px-1.5 text-xs text-ink-2 transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none"
            >
              <option value="none">不分组</option>
              <option value="label">按标签分组</option>
            </select>
            <button
              type="button"
              data-testid="board-select-toggle"
              aria-pressed={selectionActive}
              onClick={() => (selectionActive ? exitSelection() : startSelection())}
              className="h-[30px] shrink-0 rounded-lg border border-hairline px-2 text-xs text-ink-2 transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none"
            >
              选择
            </button>
            {treeMode && (
              <button
                type="button"
                data-testid="tree-create-issue"
                aria-label="新建任务"
                title="新建任务（待规划）"
                disabled={workspaceId === null}
                onClick={() => setNewIssueOpen(true)}
                // A2：点击反馈只走颜色过渡（≤150ms），reduced-motion 下即时
                className="h-[30px] shrink-0 rounded-lg border border-accent bg-accent-soft px-2 text-xs font-medium text-accent transition-colors duration-150 hover:bg-accent hover:text-accent-ink active:bg-accent active:text-accent-ink motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                + 新建任务
              </button>
            )}
          </>
        }
        filters={
          <>
            <div className="flex h-[30px] w-36 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-surface-page px-2 transition-colors duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft motion-reduce:transition-none max-[920px]:order-2 max-[920px]:w-auto max-[920px]:min-w-32 max-[920px]:flex-1">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                className="h-3.5 w-3.5 shrink-0 text-ink-3"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="M16 16l4 4" />
              </svg>
              <input
                aria-label="搜索任务"
                data-testid="board-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题/描述/标签"
                className="h-full w-full min-w-0 shrink-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
              />
            </div>
            {/* LABEL-BAR：容器不再 overflow-x-auto —— 会裁掉标签「更多」浮层（绝对定位子元素） */}
            <div
              data-testid="board-toolbar-chips"
              className="flex min-w-0 flex-1 items-center gap-1 max-[920px]:order-4 max-[920px]:basis-full"
            >
              <LabelFilterBar workspaceId={workspaceId} />
            </div>
          </>
        }
      />
      {/* PERF-9：加载 / 切空间提示 —— 切空间时上一屏保留，但必须显式标明「不是已加载完成的数据」 */}
      {(issuesPending || issuesPlaceholder) && (
        <div
          data-testid="board-loading-note"
          role="status"
          className="flex items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-ink-3"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          />
          {issuesPending ? '正在载入任务…' : '正在切换工作空间，当前显示上一工作空间的数据'}
        </div>
      )}
      {selectionActive && !treeMode && (
        <SelectionBar
          columns={columns}
          scope={selectionScope}
          scopeCount={scopeIds.length}
          selectedCount={selectedIds.size}
          statusNames={columns}
          busy={batchBusy}
          onPickScope={pickSelectionScope}
          onSelectAll={() => setSelectedIds((prev) => toggleSelectAll(prev, scopeIds))}
          onClearSelection={() => setSelectedIds(new Set())}
          onBatchStatus={(status) => void applyBatchStatus(status)}
          onClose={exitSelection}
        />
      )}
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
          {/* 列容器（BOARD-COLS / AUDIT-BOARD I-05）：grid 自适应，列数取当前列数组长度（不写死 4）。
              每列 minmax(240px, 1fr)：1440 宽下五列不横向滚动；列少时 1fr 撑满容器、右侧不留白；
              列多时保底 240px 并横向滚动。
              auto-rows-fr（COL-SCROLL）：把隐式行高钉成 minmax(0, 1fr)，否则默认 auto 行会按内容
              max-content 撑到上万像素——列内 overflow-y-auto 就永远没有可滚动溢出，而外层
              overflow-y-hidden 又把超长内容裁掉，表现为「列内滚轮失效」。 */}
          <div
            data-testid="board-columns"
            data-loading={issuesPending ? 'true' : undefined}
            data-placeholder={issuesPlaceholder ? 'true' : undefined}
            aria-busy={issuesPending || issuesPlaceholder}
            className={`grid min-h-0 flex-1 auto-rows-fr gap-3 overflow-x-auto overflow-y-hidden p-4 ${
              issuesPlaceholder ? 'opacity-60 ab-transition motion-reduce:transition-none' : ''
            }`}
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))` }}
          >
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                issues={status === '待规划' ? planningIssues : (grouped[status] ?? [])}
                loading={issuesPending}
                accent={statusAccent(statuses.byName.get(status)?.kind)}
                runningSessionIds={runningSessionIds}
                density={displayOptions.density}
                grouping={displayOptions.grouping}
                selectionActive={selectionActive}
                selectionScope={selectionScope}
                selectedIds={selectedIds}
                onToggleSelect={toggleCardSelection}
                onToggleSelectColumn={toggleColumnSelection}
                {...(status === '待规划' ? { onCreateIssue: openNewIssue } : {})}
                {...(status === '进行中' ? { onReleaseRunning: openReleaseRunning } : {})}
                {...(status === '待规划'
                  ? { sortControl: planningSortControl }
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
        <Suspense fallback={null}>
          <NewIssueDialog open={newIssueOpen} workspaceId={workspaceId} onClose={() => setNewIssueOpen(false)} />
        </Suspense>
      )}
      {/* REL-2：预览弹窗（dry_run 清单 → 勾选 → 提交） */}
      {workspaceId !== null && (
        <Suspense fallback={null}>
          <ReleaseRunningDialog
            open={releaseOpen}
            workspaceId={workspaceId}
            issues={issues ?? []}
            onClose={() => setReleaseOpen(false)}
            onReleased={handleReleased}
          />
        </Suspense>
      )}
    </div>
  );
}



