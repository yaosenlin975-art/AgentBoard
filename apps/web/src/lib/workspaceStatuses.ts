/**
 * 工作区状态字典（STATUS-3-UI）：看板列、详情状态下拉、设置里的状态管理都从这里取。
 *
 * - 数据源：`GET /api/workspaces/:id/statuses`（内置 5 条 + 自定义，按 sort_order）；
 * - 静态兜底：接口失败或未选工作区时用五条内置名（`BUILTIN_STATUS_NAMES`），保证看板永远画得出来；
 * - 状态变化无 WS 事件（STATUS-2 未推），增删后由调用方 `invalidateStatuses` 显式失效。
 */
import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { WorkspaceStatus, WorkspaceStatusKind } from '@agentboard/shared';
import { api } from '../api/client';

/** 接口不可用时的列兜底：五条内置状态（顺序与种子一致） */
export const BUILTIN_STATUS_NAMES: readonly string[] = ['待规划', '进行中', '待验收', '已关闭', '已废弃'];

const BUILTIN_KINDS: readonly WorkspaceStatusKind[] = ['open', 'started', 'review', 'done', 'deprecated'];

export const statusesKey = (workspaceId: string | null): readonly unknown[] => ['workspace-statuses', workspaceId ?? 'none'];

/** 兜底的伪状态对象（id 只为满足类型，前端不会拿它做写操作） */
export function fallbackStatuses(workspaceId: string | null): WorkspaceStatus[] {
  return BUILTIN_STATUS_NAMES.map((name, index) => ({
    id: `fallback-${name}`,
    workspace_id: workspaceId ?? '',
    name,
    kind: BUILTIN_KINDS[index] ?? 'open',
    sort_order: index * 10,
    is_builtin: 1,
  }));
}

/** 列名（按 sort_order）；空数组也兜底成内置五列 */
export function statusNames(statuses: readonly WorkspaceStatus[]): string[] {
  const sorted = [...statuses].sort((left, right) => left.sort_order - right.sort_order);
  const names = sorted.map((status) => status.name);
  return names.length > 0 ? names : [...BUILTIN_STATUS_NAMES];
}

/** 列头强调色：已废弃与已关闭要能一眼区分 */
export function statusAccent(kind: WorkspaceStatusKind | undefined): string {
  // UNSLOP：chrome 里只有一个强调色（琥珀）。状态用暖石墨台阶 + 琥珀区分「需要我处理」，
  // 不再给每个状态一个人造色相（紫/蓝/绿）。
  switch (kind) {
    case 'review':
      // 待验收＝需要人处理 → 唯一使用强调色的地方
      return 'text-accent';
    case 'started':
      return 'text-ink';
    case 'deprecated':
      // 已废弃要与已关闭区分：给一档更实的石墨，不再借用琥珀（琥珀只留给待验收）
      return 'text-ink-2';
    case 'done':
      return 'text-ink-3';
    default:
      return 'text-ink-2';
  }
}

export interface WorkspaceStatusDictionary {
  statuses: WorkspaceStatus[];
  names: string[];
  byName: Map<string, WorkspaceStatus>;
  isLoading: boolean;
  /** 接口是否成功（false 表示当前用的是兜底列表） */
  fromServer: boolean;
}

export function useWorkspaceStatuses(workspaceId: string | null): WorkspaceStatusDictionary {
  const query = useQuery({
    queryKey: statusesKey(workspaceId),
    enabled: workspaceId !== null,
    queryFn: () => api.get<WorkspaceStatus[]>(`/api/workspaces/${encodeURIComponent(workspaceId ?? '')}/statuses`),
  });
  const fromServer = Array.isArray(query.data) && query.data.length > 0;
  // CR2-6：names/byName 按数据引用缓存 —— 每次渲染都新建数组会让下游 useMemo / memo 全部失效
  const statuses = useMemo(
    () => (fromServer ? query.data! : fallbackStatuses(workspaceId)),
    [fromServer, query.data, workspaceId],
  );
  const names = useMemo(() => statusNames(statuses), [statuses]);
  const byName = useMemo(() => new Map(statuses.map((status) => [status.name, status])), [statuses]);
  return {
    statuses,
    names,
    byName,
    isLoading: query.isPending && workspaceId !== null,
    fromServer,
  };
}

export interface StatusOption {
  name: string;
  disabled: boolean;
}

/**
 * 详情状态下拉的选项（STATUS-3-UI）：字典顺序 + 「关闭项在有未关闭后代时禁用」。
 * 抽成纯函数便于单测；DetailPanel 只负责渲染。
 */
export function statusOptions(statuses: readonly WorkspaceStatus[], closeBlocked: boolean): StatusOption[] {
  return statusNames(statuses).map((name) => {
    const kind = statuses.find((status) => status.name === name)?.kind;
    // 兜底字典里没有 kind 时按名字判「已关闭」，保持既有语义
    const isDone = kind === undefined ? name === '已关闭' : kind === 'done';
    return { name, disabled: isDone && closeBlocked };
  });
}

/** 增删状态后统一失效：状态字典 + 该工作区的任务列表（列与卡数都要重算） */
export async function invalidateStatuses(queryClient: QueryClient, workspaceId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: statusesKey(workspaceId) }),
    queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] }),
  ]);
}
