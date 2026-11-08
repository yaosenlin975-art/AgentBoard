/**
 * 左浮窗内容：工作空间列表（260px），空态引导 + 新增弹窗 + 拖拽排序（WS-REORDER）+ 搜索/置顶（WS-DRAWER-01）。
 * 排序：本地立即乐观重排 → POST /api/workspaces/reorder（带 Idempotency-Key）→ 用响应整体覆盖；
 * 失败回滚并提示；集合冲突（409 WORKSPACE_SET_CHANGED）只提示刷新，不重试；顺序冲突是 LWW，不报「他人已修改」。
 * 搜索：按名称 + 路径大小写不敏感过滤视图，不改服务端排序。
 * 置顶：复用同一条 reorder 提交路径（置顶→首位；取消置顶→还原置顶前位置），按下态与原始位置记在 localStorage。
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { listIssueCounts } from '../../api/endpoints';
import {
  commitWorkspaceOrder,
  moveWorkspace,
  pinnedOrder,
  readPinned,
  sortWorkspaces,
  WORKSPACES_KEY,
  writePinned,
  type PinnedEntry,
} from '../../lib/workspaceReorder';
import { WorkspaceCard } from './WorkspaceCard';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

/** counts 端点单次 workspace_ids 上限（服务端 MAX_COUNT_WORKSPACES = 50） */
const COUNT_BATCH_SIZE = 50;

interface WorkspaceIssueCounts {
  workspace_id: string;
  total: number;
  counts: Record<string, number>;
}

/** PERF-4b：按 50 个一批拉 counts，合并为 workspace_id → (status → count) */
async function fetchIssueCounts(ids: string[]): Promise<Record<string, Record<string, number>>> {
  const merged: Record<string, Record<string, number>> = {};
  for (let index = 0; index < ids.length; index += COUNT_BATCH_SIZE) {
    const chunk = ids.slice(index, index + COUNT_BATCH_SIZE);
    const page = await listIssueCounts<{ items: WorkspaceIssueCounts[] }>(chunk);
    for (const item of page.items) merged[item.workspace_id] = item.counts;
  }
  return merged;
}

export function WorkspaceList() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pinnedEntries, setPinnedEntries] = useState<PinnedEntry[]>(() => readPinned());
  const queryClient = useQueryClient();
  /** 同一次拖拽/移动重试复用同一个幂等键 */
  const idempotencyRef = useRef<string | null>(null);

  const { data: workspaces, isLoading } = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const list = sortWorkspaces(workspaces ?? []);
  const needle = query.trim().toLowerCase();
  const entries = list
    .map((workspace, index) => ({ workspace, index }))
    .filter(
      ({ workspace }) =>
        needle === '' ||
        workspace.name.toLowerCase().includes(needle) ||
        workspace.path.toLowerCase().includes(needle),
    );
  /**
   * PERF-4b：可见工作区的状态计数一次聚合拉取，替代每卡一次全量 `GET /api/issues`。
   * 服务端单次上限 50 个 workspace_id，超出按 50 分批（仍是 O(n/50) 次，不是 N+1）。
   * 失败（404 / 网络）时 `isError` → 卡片回落旧全量路径。
   */
  const visibleIds = entries.map(({ workspace }) => workspace.id);
  const countsQuery = useQuery({
    queryKey: ['issues', 'counts', visibleIds],
    queryFn: () => fetchIssueCounts(visibleIds),
    enabled: visibleIds.length > 0,
    retry: false,
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const submit = async (ordered: Workspace[]): Promise<boolean> => {
    if (idempotencyRef.current === null) idempotencyRef.current = crypto.randomUUID();
    const key = idempotencyRef.current;
    const outcome = await commitWorkspaceOrder(queryClient, ordered, key);
    if (outcome.ok) {
      idempotencyRef.current = null;
      setNotice(null);
      return true;
    }
    setNotice(outcome.message);
    return false;
  };

  const onDragEnd = (event: DragEndEvent): void => {
    idempotencyRef.current = null; // 新的拖拽 = 新操作 = 新幂等键
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = list.findIndex((item) => item.id === active.id);
    const to = list.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    void submit(moveWorkspace(list, from, to));
  };

  const moveBy = (index: number, delta: number): void => {
    idempotencyRef.current = null;
    void submit(moveWorkspace(list, index, index + delta));
  };

  const togglePin = (id: string): void => {
    idempotencyRef.current = null;
    const from = list.findIndex((workspace) => workspace.id === id);
    if (from < 0) return;
    const pinning = !pinnedEntries.some((entry) => entry.id === id);
    const previous = pinnedEntries;
    const nextPinned = pinning
      ? [...previous, { id, originIndex: from }]
      : previous.filter((entry) => entry.id !== id);
    setPinnedEntries(nextPinned);
    writePinned(nextPinned);
    void submit(pinnedOrder(list, id, pinning, previous)).then((ok) => {
      if (ok) return;
      // 顺序提交失败：按下态跟着回滚，避免与权威顺序不一致
      setPinnedEntries(previous);
      writePinned(previous);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between px-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
          工作空间
        </h2>
        <button
          type="button"
          aria-label="新增工作空间"
          onClick={() => setDialogOpen(true)}
          className="rounded px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
        >
          + 新增
        </button>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <input
          type="search"
          data-testid="workspace-search"
          aria-label="搜索工作空间"
          placeholder="搜索名称或路径…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded border border-hairline bg-surface-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
      </div>

      {notice !== null && (
        <p role="alert" data-testid="workspace-order-notice" className="mx-2 mb-1 rounded border border-hairline bg-accent-soft px-2 py-1 text-xs text-accent">
          {notice}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2" role="list" aria-label="工作空间列表">
        {isLoading && <Skeleton testId="workspace-list-loading" rows={2} className="mt-4" />}
        {!isLoading && list.length === 0 && (
          <EmptyState className="mt-8" title="还没有工作空间" hint="点击右上角「+ 新增」创建第一个工作空间" />
        )}
        {!isLoading && list.length > 0 && entries.length === 0 && (
          <EmptyState testId="workspace-search-empty" compact className="mt-4" title="没有匹配的工作空间" hint="换个关键词，或清空搜索框" />
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={entries.map(({ workspace }) => workspace.id)} strategy={verticalListSortingStrategy}>
            {entries.map(({ workspace, index }) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                canMoveUp={index > 0}
                canMoveDown={index < list.length - 1}
                pinned={pinnedEntries.some((entry) => entry.id === workspace.id)}
                onMoveUp={() => moveBy(index, -1)}
                onMoveDown={() => moveBy(index, 1)}
                onTogglePin={() => togglePin(workspace.id)}
                statusCounts={
                  countsQuery.isError
                    ? null
                    : countsQuery.data === undefined
                      ? undefined
                      : countsQuery.data[workspace.id] ?? {}
                }
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <NewWorkspaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
