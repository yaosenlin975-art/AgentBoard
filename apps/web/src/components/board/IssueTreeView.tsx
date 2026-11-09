import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus, IssueTreeItem } from '@agentboard/shared';
import { ApiError } from '../../api/client';
import { createIssue, listIssueTree, patchIssue } from '../../api/endpoints';
import { getIssueAncestors, getIssueDescendantIds, buildIssueTreeFilter, filterTreeItemsWithChildren, readTreeHideLeaf, writeTreeHideLeaf, type IssueTreeFilter } from '../../lib/issueTree';
import { byCreatedAtThenId } from '../../lib/planningSort';
import { countSubtreeOpenBlockers, openBlockerCount } from '../../lib/dependency';
import {
  invalidateIssueStatusCaches,
  manualStatusBlockedReason,
  patchIssueStatus,
} from '../../lib/issueStatus';
import { useWorkspaceStatuses } from '../../lib/workspaceStatuses';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { IconLock } from '../ui/Icon';
import { ErrorState } from '../ui/ErrorState';

const PAGE_SIZE = 50;
const emptyIds: ReadonlySet<string> = new Set();

type MoveEditorState = {
  issueId: string;
  title: string;
  expectedUpdatedAt: number;
  originalParentId: string | null;
  selectedParentId: string;
  selectedParentTitle: string;
  saving: boolean;
  conflict: boolean;
  error: string | null;
};

export function IssueTreeView({
  workspaceId,
  issues,
  runningSessionIds = emptyIds,
  query,
}: {
  workspaceId: string;
  issues: Issue[];
  runningSessionIds?: ReadonlySet<string>;
  /** 搜索关键词：由顶栏统一持有，平铺看板与任务树共享同一条件 */
  query: string;
}) {
  const queryClient = useQueryClient();
  // SYS2：状态筛选读工作区状态字典（含「已废弃」与自定义状态），不再走写死的四值列表
  const { names: statusNames } = useWorkspaceStatuses(workspaceId);
  const [status, setStatus] = useState<string>('all');
  // TREE-HIDE-LEAF：勾选后只显示有直接子节点的任务；持久化到 localStorage，存储不可用时回落 false
  const [hideLeaf, setHideLeaf] = useState<boolean>(readTreeHideLeaf);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [moveEditor, setMoveEditor] = useState<MoveEditorState | null>(null);
  // 标签筛选（多选 OR）与平铺看板共用同一份选择：按工作空间隔离
  const selectedLabels = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId] ?? NO_SELECTED_LABELS);
  const filter = useMemo(
    () => buildIssueTreeFilter(issues, status as IssueStatus | 'all', query, selectedLabels),
    [issues, status, query, selectedLabels],
  );
  const openDetail = usePanelStore((state) => state.openDetail);

  useEffect(() => {
    setExpandedIds(new Set());
    setCollapsedIds(new Set());
  }, [status, query, selectedLabels]);

  const toggle = (id: string, currentlyExpanded: boolean): void => {
    if (filter.autoExpandedIds.has(id)) {
      setCollapsedIds((old) => {
        const next = new Set(old);
        if (currentlyExpanded) next.add(id);
        else next.delete(id);
        return next;
      });
      return;
    }
    setExpandedIds((old) => {
      const next = new Set(old);
      if (currentlyExpanded) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openMoveEditor = (item: IssueTreeItem): void => {
    const parent = item.parent_issue_id === null ? null : issues.find((issue) => issue.id === item.parent_issue_id);
    setMoveEditor({
      issueId: item.id,
      title: item.title,
      expectedUpdatedAt: item.updated_at,
      originalParentId: item.parent_issue_id,
      selectedParentId: item.parent_issue_id ?? '',
      selectedParentTitle: parent?.title ?? '根任务',
      saving: false,
      conflict: false,
      error: null,
    });
  };

  const selectMoveParent = (parentId: string): void => {
    const parent = parentId === '' ? null : issues.find((issue) => issue.id === parentId);
    setMoveEditor((current) => current === null ? null : {
      ...current,
      selectedParentId: parentId,
      selectedParentTitle: parent?.title ?? (parentId === '' ? '根任务' : current.selectedParentTitle),
      error: null,
    });
  };

  const submitMove = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const editor = moveEditor;
    if (editor === null || editor.saving || editor.conflict || editor.selectedParentId === (editor.originalParentId ?? '')) return;
    setMoveEditor({ ...editor, saving: true, error: null });
    try {
      await patchIssue(editor.issueId, {
        workspace_id: workspaceId,
        expected_updated_at: editor.expectedUpdatedAt,
        parent_issue_id: editor.selectedParentId === '' ? null : editor.selectedParentId,
      });
      setMoveEditor((current) => current?.issueId === editor.issueId ? null : current);
      await queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] });
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      setMoveEditor((current) => current?.issueId === editor.issueId ? {
        ...current,
        saving: false,
        conflict,
        error: error instanceof Error ? error.message : '未知错误',
      } : current);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="issue-tree-view">
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-hairline bg-surface-card px-3 py-2">
        <label className="min-w-0 text-xs text-ink-2">
          <span className="mb-1 block">按状态筛选</span>
          <select
            aria-label="按状态筛选"
            value={status}
            onChange={(event) => setStatus(event.target.value as string)}
            className="max-w-full rounded border border-hairline bg-surface-card px-2 py-1 text-sm"
          >
            <option value="all">全部状态</option>
            {statusNames.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 pb-1 text-xs text-ink-2">
          <input
            type="checkbox"
            aria-label="隐藏无子任务"
            checked={hideLeaf}
            onChange={(event) => {
              const next = event.target.checked;
              setHideLeaf(next);
              writeTreeHideLeaf(next);
            }}
            className="size-3.5 accent-[var(--ab-accent)]"
          />
          隐藏无子任务
        </label>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-2 sm:p-3">
        <TaskTreeChildren
          workspaceId={workspaceId}
          parentId={null}
          issues={issues}
          filter={filter}
          hideLeaf={hideLeaf}
          expandedIds={expandedIds}
          collapsedIds={collapsedIds}
          moveEditor={moveEditor}
          onToggle={toggle}
          onOpenMove={openMoveEditor}
          onSelectMoveParent={selectMoveParent}
          onSubmitMove={submitMove}
          onCloseMove={() => setMoveEditor(null)}
          runningSessionIds={runningSessionIds}
          onOpenDetail={openDetail}
          depth={0}
        />
      </div>
    </div>
  );
}

function TaskTreeChildren({
  workspaceId,
  parentId,
  issues,
  filter,
  hideLeaf,
  expandedIds,
  collapsedIds,
  moveEditor,
  onToggle,
  onOpenMove,
  onSelectMoveParent,
  onSubmitMove,
  onCloseMove,
  runningSessionIds,
  onOpenDetail,
  depth,
}: {
  workspaceId: string;
  parentId: string | null;
  issues: Issue[];
  filter: IssueTreeFilter;
  hideLeaf: boolean;
  expandedIds: ReadonlySet<string>;
  collapsedIds: ReadonlySet<string>;
  moveEditor: MoveEditorState | null;
  onToggle: (id: string, currentlyExpanded: boolean) => void;
  onOpenMove: (item: IssueTreeItem) => void;
  onSelectMoveParent: (parentId: string) => void;
  onSubmitMove: (event: FormEvent) => Promise<void>;
  onCloseMove: () => void;
  runningSessionIds: ReadonlySet<string>;
  onOpenDetail: (id: string) => void;
  depth: number;
}) {
  const queryKey = ['issues', workspaceId, 'tree', parentId === null ? ['root'] : ['parent', parentId]] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ workspace: workspaceId, limit: String(PAGE_SIZE) });
      if (parentId !== null) params.set('parent_issue_id', parentId);
      if (pageParam !== null) params.set('cursor', pageParam);
      return listIssueTree(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
  const pageItems = query.data?.pages.flatMap((page) => page.items) ?? [];
  const visibleChildren = filter.active ? filter.visibleChildrenByParent.get(parentId) ?? emptyIds : null;
  const visibleItems = visibleChildren === null ? pageItems : pageItems.filter((item) => visibleChildren.has(item.id));
  const orderedItems = [...visibleItems].sort(byCreatedAtThenId);
  // TREE-HIDE-LEAF：勾选后只保留有直接子节点的任务（与状态筛选正交，判定用真实 child_count）
  const displayItems = hideLeaf ? filterTreeItemsWithChildren(orderedItems) : orderedItems;
  const autoPageTargetsLoaded = visibleChildren === null || [...visibleChildren].every((id) => pageItems.some((item) => item.id === id));

  useEffect(() => {
    if (!filter.active || autoPageTargetsLoaded || !query.hasNextPage || query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [filter.active, autoPageTargetsLoaded, query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  if (query.isPending) {
    return <p className="px-2 py-3 text-sm text-ink-3" role="status">{depth === 0 ? '加载任务树…' : '加载子任务…'}</p>;
  }
  if (query.isError) {
    return <ErrorState error={query.error} prefix={depth === 0 ? '加载任务树失败' : '加载子任务失败'} className="mx-2 my-3 text-sm" />;
  }
  if (displayItems.length === 0 && query.isFetchingNextPage) {
    return <p className="px-2 py-3 text-sm text-ink-3" role="status">正在查找匹配任务…</p>;
  }
  if (displayItems.length === 0 && (!filter.active || autoPageTargetsLoaded)) {
    const emptyText = hideLeaf
      ? (depth === 0 ? '已隐藏无子任务的任务' : '子任务均无下级任务（已隐藏）')
      : (depth === 0 ? (filter.active ? '没有匹配的任务' : '暂无任务') : '没有可显示的子任务');
    return <p className="px-2 py-3 text-sm text-ink-3">{emptyText}</p>;
  }

  return (
    <ul aria-label={parentId === null ? '根任务' : `子任务：${issues.find((issue) => issue.id === parentId)?.title ?? ''}`} className="space-y-1">
      {displayItems.map((item) => {
        const defaultExpanded = filter.autoExpandedIds.has(item.id) && !collapsedIds.has(item.id);
        const expanded = expandedIds.has(item.id) || defaultExpanded;
        const visibleChildIds = filter.visibleChildrenByParent.get(item.id);
        const canExpand = filter.active ? (visibleChildIds?.size ?? 0) > 0 : item.child_count > 0;
        return (
          <li key={item.id} className="min-w-0">
            <TaskTreeRow
              item={item}
              workspaceId={workspaceId}
              issues={issues}
              filter={filter}
              expanded={expanded}
              canExpand={canExpand}
              moveEditor={moveEditor}
              onToggle={() => onToggle(item.id, expanded)}
              onOpenMove={() => onOpenMove(item)}
              onSelectMoveParent={onSelectMoveParent}
              onSubmitMove={onSubmitMove}
              onCloseMove={onCloseMove}
              runningSession={runningSessionIds.has(item.session_id ?? '')}
              onOpenDetail={() => onOpenDetail(item.id)}
            />
            {expanded && canExpand && (
              <div className="ml-3 min-w-0 border-l border-hairline pl-2 sm:ml-5 sm:pl-3">
                <TaskTreeChildren
                  workspaceId={workspaceId}
                  parentId={item.id}
                  issues={issues}
                  filter={filter}
                  hideLeaf={hideLeaf}
                  expandedIds={expandedIds}
                  collapsedIds={collapsedIds}
                  moveEditor={moveEditor}
                  onToggle={onToggle}
                  onOpenMove={onOpenMove}
                  onSelectMoveParent={onSelectMoveParent}
                  onSubmitMove={onSubmitMove}
                  onCloseMove={onCloseMove}
                  runningSessionIds={runningSessionIds}
                  onOpenDetail={onOpenDetail}
                  depth={depth + 1}
                />
              </div>
            )}
          </li>
        );
      })}
      {query.hasNextPage && !filter.active && (
        <li>
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            aria-label={parentId === null ? '加载更多根任务' : `加载更多子任务：${issues.find((issue) => issue.id === parentId)?.title ?? ''}`}
            className="my-1 rounded px-2 py-1 text-xs text-accent hover:bg-accent-soft disabled:opacity-50"
          >
            {query.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        </li>
      )}
    </ul>
  );
}

function TaskTreeRow({
  item,
  workspaceId,
  issues,
  filter,
  expanded,
  canExpand,
  moveEditor,
  onToggle,
  onOpenMove,
  onSelectMoveParent,
  onSubmitMove,
  onCloseMove,
  runningSession,
  onOpenDetail,
}: {
  item: IssueTreeItem;
  workspaceId: string;
  issues: Issue[];
  filter: IssueTreeFilter;
  expanded: boolean;
  canExpand: boolean;
  moveEditor: MoveEditorState | null;
  onToggle: () => void;
  onOpenMove: () => void;
  onSelectMoveParent: (parentId: string) => void;
  onSubmitMove: (event: FormEvent) => Promise<void>;
  onCloseMove: () => void;
  runningSession: boolean;
  onOpenDetail: () => void;
}) {
  const queryClient = useQueryClient();
  const { names: statusOptions } = useWorkspaceStatuses(workspaceId);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [savingCreate, setSavingCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const ancestors = getIssueAncestors(issues, item.id);
  const descendantIds = useMemo(() => getIssueDescendantIds(issues, item.id), [issues, item.id]);
  // 依赖锁标与子树汇总只用服务端投影（blocked_by_open_count），不按状态本地推断
  const openBlockerTotal = openBlockerCount(item);
  const subtreeOpenBlockers = useMemo(() => countSubtreeOpenBlockers(issues, item.id), [issues, item.id]);
  const blockedClose = item.status !== '已关闭' && item.descendant_count > item.descendants_closed_count;
  const statusBlockedReason = manualStatusBlockedReason(item);
  const visibleChildren = filter.visibleChildrenByParent.get(item.id);
  const moveOpen = moveEditor?.issueId === item.id;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] });
  };

  const createChild = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const title = newTitle.trim();
    if (title === '' || savingCreate) return;
    setSavingCreate(true);
    setCreateError(null);
    try {
      await createIssue({ workspace_id: workspaceId, title, parent_issue_id: item.id });
      setNewTitle('');
      setCreateOpen(false);
      await refresh();
    } catch (error) {
      setCreateError(error instanceof Error ? `创建“${title}”为“${item.title}”的子任务失败：${error.message}` : `创建“${item.title}”的子任务失败`);
    } finally {
      setSavingCreate(false);
    }
  };

  const changeStatus = async (nextStatus: IssueStatus): Promise<void> => {
    if (nextStatus === item.status) return;
    if (statusBlockedReason !== null) return;
    setStatusError(null);
    try {
      await patchIssueStatus({
        issueId: item.id,
        workspaceId,
        expectedUpdatedAt: item.updated_at,
        status: nextStatus,
      });
      invalidateIssueStatusCaches(queryClient, { workspaceId });
      await refresh();
    } catch (error) {
      setStatusError(error instanceof Error ? `更新“${item.title}”状态失败：${error.message}` : `更新“${item.title}”状态失败`);
    }
  };

  const parentChoices = issues.filter((candidate) => candidate.id !== item.id && !descendantIds.has(candidate.id));
  const hasChildren = filter.active ? (visibleChildren?.size ?? 0) > 0 : item.child_count > 0;

  return (
    <article
      data-testid={`tree-node-${item.id}`}
      className="min-w-0 rounded-md border border-hairline bg-surface-card p-2 shadow-sm sm:p-2.5"
    >
      <div className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-2 sm:flex sm:flex-wrap">
        <button
          type="button"
          aria-label={`${expanded ? '折叠' : '展开'}子任务：${item.title}`}
          aria-expanded={expanded}
          disabled={!canExpand}
          onClick={onToggle}
          className="mt-0.5 h-7 w-7 shrink-0 rounded text-sm text-ink-2 hover:bg-surface-raised disabled:cursor-default disabled:opacity-30"
        >
          {canExpand ? (expanded ? '−' : '+') : '·'}
        </button>
        <div className="min-w-0 sm:flex-1">
          <button type="button" onClick={onOpenDetail} className="block max-w-full truncate text-left text-sm font-medium text-ink hover:text-accent" title={item.title}>
            {openBlockerTotal > 0 && (
              <span
                data-testid={`tree-lock-${item.id}`}
                title={`存在 ${openBlockerTotal} 项未解除的前置任务`}
                aria-label="存在未解除前置"
                className="mr-1 inline-flex align-[-2px] text-accent"
              >
                <IconLock />
              </span>
            )}
            {item.title}
          </button>
          {ancestors.length > 0 && (
            <p aria-label={`祖先路径：${item.title}`} className="mt-0.5 truncate text-xs text-ink-3">
              {ancestors.map((ancestor) => ancestor.title).join(' › ')}
            </p>
          )}
          {item.descendant_count > 0 && (
            <p className={`mt-1 text-xs ${blockedClose ? 'text-amber-700 dark:text-amber-300' : 'text-ink-3 '}`}>
              后代进度：{item.descendants_closed_count}/{item.descendant_count} 已关闭
              {blockedClose ? `；仍有 ${item.descendant_count - item.descendants_closed_count} 项未关闭` : ''}
            </p>
          )}
          {subtreeOpenBlockers > 0 && (
            <p data-testid={`tree-subtree-deps-${item.id}`} className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              子树待解除依赖 {subtreeOpenBlockers} 项
            </p>
          )}
        </div>
        <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-auto sm:col-auto">
          {item.claimed_by !== null && (
            <span data-testid={`tree-claim-${item.id}`} className={`rounded px-1.5 py-0.5 text-xs ${runningSession ? 'bg-accent-soft text-accent  ' : 'bg-surface-raised text-ink-2  '}`}>
              {item.claimed_by.replace(/^agent:/, '')}{runningSession ? ' · 运行中' : ' · 占用中'}
            </span>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {/* V-04：状态徽标与下拉合并为一个可编辑胶囊，同一行状态只出现一次 */}
            <select
              id={`tree-status-${item.id}`}
              aria-label={`状态：${item.title}`}
              value={item.status}
              disabled={statusBlockedReason !== null}
              title={statusBlockedReason ?? `状态：${item.status}`}
              onChange={(event) => void changeStatus(event.target.value as IssueStatus)}
              className="max-w-full rounded-full border border-hairline bg-surface-raised px-2 py-0.5 text-xs text-ink-2 disabled:opacity-50"
            >
              {!statusOptions.includes(item.status) && <option value={item.status}>{item.status}</option>}
              {statusOptions.map((value) => (
                <option key={value} value={value} disabled={value === '已关闭' && blockedClose}>{value}</option>
              ))}
            </select>
            <button type="button" aria-label={`新建子任务：${item.title}`} onClick={() => { setCreateOpen((open) => !open); setCreateError(null); }} className="rounded px-2 py-1 text-xs text-accent hover:bg-accent-soft">
              + 子任务
            </button>
            <button
              type="button"
              aria-label={`移动：${item.title}`}
              disabled={item.claimed_by !== null || (moveEditor?.saving ?? false)}
              title={item.claimed_by !== null ? '占用中不能移动父级' : '更改父级'}
              onClick={() => moveOpen ? onCloseMove() : onOpenMove()}
              className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              移动
            </button>
          </div>
        </div>
      </div>

      {blockedClose && (
        <p className="ml-9 mt-1 text-xs text-amber-700 dark:text-amber-300">关闭前需先关闭全部后代任务。</p>
      )}
      {statusError && <p role="alert" className="ml-9 mt-1 text-xs text-red-600 dark:text-red-400">{statusError}</p>}

      {createOpen && (
        <form onSubmit={(event) => void createChild(event)} className="ml-9 mt-2 flex min-w-0 flex-wrap gap-2">
          <label className="min-w-0 flex-1 text-xs">
            <span className="sr-only">子任务标题：{item.title}</span>
            <input aria-label={`子任务标题：${item.title}`} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="子任务标题" required className="w-full rounded border border-hairline px-2 py-1.5 text-sm" />
          </label>
          <button type="submit" disabled={savingCreate || newTitle.trim() === ''} className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40">创建子任务</button>
          <button type="button" onClick={() => setCreateOpen(false)} className="rounded px-2 py-1.5 text-xs text-ink-3 hover:bg-surface-raised">取消</button>
          {createError && <p role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">{createError}</p>}
        </form>
      )}

      {moveOpen && (
        <form onSubmit={(event) => void onSubmitMove(event)} className="ml-9 mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink-2">
            <span className="sr-only">新父任务：{item.title}</span>
            <select
              aria-label={`新父任务：${item.title}`}
              value={moveEditor.selectedParentId}
              disabled={moveEditor.conflict}
              onChange={(event) => onSelectMoveParent(event.target.value)}
              className="w-full rounded border border-hairline bg-surface-card px-2 py-1.5 text-sm disabled:opacity-60"
            >
              <option value="">移至根任务</option>
              {moveEditor.selectedParentId !== '' && !parentChoices.some((candidate) => candidate.id === moveEditor.selectedParentId) && (
                <option value={moveEditor.selectedParentId}>{moveEditor.selectedParentTitle}（当前不可选）</option>
              )}
              {parentChoices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
          </label>
          <button type="submit" disabled={moveEditor.saving || moveEditor.conflict || moveEditor.selectedParentId === (moveEditor.originalParentId ?? '')} className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40">保存父级</button>
          <button type="button" disabled={moveEditor.saving} onClick={onCloseMove} className="rounded px-2 py-1.5 text-xs text-ink-3 hover:bg-surface-raised disabled:opacity-40">取消</button>
          {moveEditor.error !== null && (
            <p role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">
              {moveEditor.conflict
                ? `移动“${item.title}”发生版本冲突：打开表单时版本 ${moveEditor.expectedUpdatedAt}，当前版本 ${item.updated_at}。目标“${moveEditor.selectedParentTitle}”已保留，请取消并重新打开后重试。服务器提示：${moveEditor.error}`
                : `移动“${item.title}”失败：${moveEditor.error}`}
            </p>
          )}
        </form>
      )}
    </article>
  );
}
