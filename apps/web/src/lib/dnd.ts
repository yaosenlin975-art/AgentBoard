/**
 * 看板拖拽结算：纯函数 + 提交器。
 * sort_order 策略：目标索引处取前后相邻 sort_order 中值（floor）；边界补/借 1000；空列取 0。
 */
import type { QueryClient } from '@tanstack/react-query';
import { closestCorners, pointerWithin, type CollisionDetection } from '@dnd-kit/core';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { statusChangeBlocked } from './issueStatus';

/** 兜底列（接口不可用时用五条内置；STATUS-3-UI 之后真实列由 workspace_status 派生） */
export const BOARD_COLUMNS: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

/** UI 列兜底（STATUS-3-UI）：接口不可用时连「已废弃」一起画出来 */
export const BOARD_COLUMN_FALLBACK: readonly string[] = [...BOARD_COLUMNS, '已废弃'];

const COLUMN_PREFIX = 'column:';

/** 列容器 droppable id（区别于卡片 id） */
export function columnDroppableId(status: string): string {
  return COLUMN_PREFIX + status;
}

const isColumnDroppableId = (id: string): boolean => id.startsWith(COLUMN_PREFIX);

/**
 * 看板碰撞检测（DND-SEARCH-BUG）。
 *
 * 只用 `closestCorners` 时，它按「droppable 四角到拖拽浮层的距离平均值」打分：检索态下列被过滤空，
 * 「已关闭」列的 droppable 仍是整列高（168→838），远端两个角各 ~600px 把均分拉到 ~300，
 * 于是它输给源列里很近的一张卡（~278），`resolveDrop` 得到 `targetStatus === active.status`，
 * 只提交 `sort_order`、不改状态 —— 表现为「卡拖不过去、回弹原位」。非检索态该列有卡片，
 * 指针下的卡按同列语义正常命中，所以只有检索态复现。
 *
 * 修法：指针落在哪个可投放区内就以它为准（`pointerWithin`），指针不可用（键盘拖拽）时回落原策略。
 * 指针同时落在卡片与其所在列上时卡片优先，保留列内排序语义。
 */
export const detectDropCollision: CollisionDetection = (args) => {
  // 被拖拽卡片自身的 droppable 也随指针移动，必须先排除，否则 over 永远是自己
  const byPointer = pointerWithin(args).filter((collision) => collision.id !== args.active.id);
  if (byPointer.length === 0) return closestCorners(args);
  return [...byPointer].sort(
    (a, b) => Number(isColumnDroppableId(String(a.id))) - Number(isColumnDroppableId(String(b.id))),
  );
};

function isKnownStatus(value: string, columns: readonly string[]): boolean {
  return columns.includes(value);
}

export interface DropPatch {
  id: string;
  patch: { status?: string; sort_order: number };
}

/**
 * 结算一次拖放。
 * - 跨列：patch 带 status；列内：只带 sort_order。
 * - 源卡片占用中（claimed_by 非空）禁止拖出 → null。
 * - 「进行中」不可手动改状态（含未占用）：拖到其他列 → null；列内排序放行。
 * - 无变化（原地放下）→ null。
 */
export function resolveDrop(
  issues: Issue[],
  activeId: string,
  overId: string,
  columns: readonly string[] = BOARD_COLUMNS,
): DropPatch | null {
  const active = issues.find((i) => i.id === activeId);
  if (!active) return null;
  if (active.claimed_by !== null) return null;
  if (activeId === overId) return null;

  let targetStatus: string;
  /** 插入到该卡片之前；null 表示追加到列尾 */
  let beforeId: string | null;
  if (overId.startsWith(COLUMN_PREFIX)) {
    const status = overId.slice(COLUMN_PREFIX.length);
    if (!isKnownStatus(status, columns)) return null;
    targetStatus = status;
    beforeId = null;
  } else {
    const over = issues.find((i) => i.id === overId);
    if (!over) return null;
    targetStatus = over.status;
    beforeId = overId;
  }

  if (statusChangeBlocked(active, targetStatus as IssueStatus)) return null;

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
    old?.map((i) => (i.id === drop.id ? ({ ...i, ...drop.patch } as Issue) : i)) ?? old,
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

/**
 * 按 status 分组并在组内按 sort_order 升序（渲染用，容忍缓存数组乱序）。
 *
 * STATUS-1 之后 `issue.status` 不再受四值枚举约束（数据层已允许 `已废弃` 与后续自定义状态），
 * 所以分组键必须**按 BOARD_COLUMNS 动态生成**，并对不在列里的状态兜底建桶：
 * 之前写死 4 个键时，一张 `已废弃` 卡会让 `grouped[status].push` 直接抛 TypeError。
 * 兜底建桶只保证「不崩、不丢数据」，多出来的状态不会渲染成列（列仍由 BOARD_COLUMNS 决定）。
 */
export function groupByColumn(issues: Issue[], columns: readonly string[] = BOARD_COLUMNS): Record<string, Issue[]> {
  const buckets: Record<string, Issue[]> = Object.fromEntries(columns.map((status) => [status, [] as Issue[]]));
  const grouped = buckets;
  for (const issue of issues) {
    const key = issue.status as string;
    buckets[key] ??= [];
    buckets[key]!.push(issue);
  }
  for (const list of Object.values(buckets)) list.sort((a, b) => a.sort_order - b.sort_order);
  return grouped;
}
