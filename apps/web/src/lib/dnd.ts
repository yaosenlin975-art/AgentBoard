/**
 * 看板拖拽结算：纯函数 + 提交器。
 * sort_order 策略：目标索引处取前后相邻 sort_order 中值（floor）；边界补/借 1000；空列取 0。
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus } from '@agentboard/shared';

export const BOARD_COLUMNS: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

const COLUMN_PREFIX = 'column:';

/** 列容器 droppable id（区别于卡片 id） */
export function columnDroppableId(status: IssueStatus): string {
  return COLUMN_PREFIX + status;
}

function isIssueStatus(value: string): value is IssueStatus {
  return (BOARD_COLUMNS as string[]).includes(value);
}

export interface DropPatch {
  id: string;
  patch: { status?: IssueStatus; sort_order: number };
}

/**
 * 结算一次拖放。
 * - 跨列：patch 带 status；列内：只带 sort_order。
 * - 源卡片占用中（claimed_by 非空）禁止拖出 → null。
 * - 无变化（原地放下）→ null。
 */
export function resolveDrop(issues: Issue[], activeId: string, overId: string): DropPatch | null {
  const active = issues.find((i) => i.id === activeId);
  if (!active) return null;
  if (active.claimed_by !== null) return null;
  if (activeId === overId) return null;

  let targetStatus: IssueStatus;
  /** 插入到该卡片之前；null 表示追加到列尾 */
  let beforeId: string | null;
  if (overId.startsWith(COLUMN_PREFIX)) {
    const status = overId.slice(COLUMN_PREFIX.length);
    if (!isIssueStatus(status)) return null;
    targetStatus = status;
    beforeId = null;
  } else {
    const over = issues.find((i) => i.id === overId);
    if (!over) return null;
    targetStatus = over.status;
    beforeId = overId;
  }

  const columnAll = issues
    .filter((i) => i.status === targetStatus)
    .sort((a, b) => a.sort_order - b.sort_order);
  const columnWithoutActive = columnAll.filter((i) => i.id !== activeId);

  // 目标插入索引（columnWithoutActive 下标）。
  // 同列向下拖：落在 over 卡片之后（与 arrayMove 语义一致）；向上/跨列：落在 over 之前。
  let targetIndex: number;
  if (beforeId === null) {
    targetIndex = columnWithoutActive.length;
  } else {
    const overIdxAll = columnAll.findIndex((i) => i.id === beforeId);
    if (overIdxAll === -1) {
      targetIndex = columnWithoutActive.length;
    } else if (targetStatus === active.status && columnAll.findIndex((i) => i.id === activeId) < overIdxAll) {
      targetIndex = overIdxAll;
    } else {
      targetIndex = columnWithoutActive.findIndex((i) => i.id === beforeId);
      if (targetIndex === -1) targetIndex = columnWithoutActive.length;
    }
  }

  const before = columnWithoutActive[targetIndex - 1] ?? null;
  const after = columnWithoutActive[targetIndex] ?? null;

  let sortOrder: number;
  if (before !== null && after !== null) sortOrder = Math.floor((before.sort_order + after.sort_order) / 2);
  else if (before !== null) sortOrder = before.sort_order + 1000;
  else if (after !== null) sortOrder = after.sort_order - 1000;
  else sortOrder = 0; // 空列首张

  const patch: DropPatch['patch'] = { sort_order: sortOrder };
  if (targetStatus !== active.status) patch.status = targetStatus;
  if (patch.status === undefined && sortOrder === active.sort_order) return null; // 原地无变化
  return { id: activeId, patch };
}

export interface CommitDropOptions {
  queryClient: QueryClient;
  queryKey: unknown[];
  drop: DropPatch;
  patchIssue: (id: string, patch: DropPatch['patch']) => Promise<Issue>;
  onError?: (error: unknown) => void;
}

/** 乐观更新缓存 → PATCH；成功用服务端响应覆盖，失败回滚 + invalidate */
export function commitDrop({ queryClient, queryKey, drop, patchIssue, onError }: CommitDropOptions): void {
  const previous = queryClient.getQueryData<Issue[]>(queryKey);
  queryClient.setQueryData<Issue[]>(queryKey, (old) =>
    old?.map((i) => (i.id === drop.id ? { ...i, ...drop.patch } : i)) ?? old,
  );
  patchIssue(drop.id, drop.patch)
    .then((updated) => {
      queryClient.setQueryData<Issue[]>(queryKey, (old) =>
        old?.map((i) => (i.id === updated.id ? updated : i)) ?? old,
      );
    })
    .catch((error) => {
      queryClient.setQueryData(queryKey, previous);
      void queryClient.invalidateQueries({ queryKey });
      onError?.(error);
    });
}

/** 按 status 分组并在组内按 sort_order 升序（渲染用，容忍缓存数组乱序） */
export function groupByColumn(issues: Issue[]): Record<IssueStatus, Issue[]> {
  const grouped: Record<IssueStatus, Issue[]> = {
    待规划: [],
    进行中: [],
    待验收: [],
    已关闭: [],
  };
  for (const issue of issues) grouped[issue.status].push(issue);
  for (const list of Object.values(grouped)) list.sort((a, b) => a.sort_order - b.sort_order);
  return grouped;
}
