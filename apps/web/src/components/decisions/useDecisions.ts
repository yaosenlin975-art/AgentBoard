/**
 * DEC-6：待决策数据源（REST + WS 失效）。
 *
 * - 徽标：`GET /api/workspaces/:id/decisions/count`（轻量，不拉列表）；
 * - 列表：在途（grace+open，默认口径）与已回答（answered，24h 内展示）两次查询；
 * - WS：`decision.*` / `issue.stop_requested` 事件经 wsBus 触发失效重取。
 *   事件到查询键的映射刻意留在本模块（`api/ws.ts` 的穷尽 switch 属 DEC-3 文件集，不在本卡改动范围）。
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerWsEvent } from '@agentboard/shared';
import { api } from '../../api/client';
import { useWsEvent } from '../../api/wsBus';
import type { DecisionCounts, DecisionDetailDto, DecisionListResponse } from './types';

export const DECISION_LIST_LIMIT = 50;

export function decisionsCountKey(workspaceId: string) {
  return ['decisions-count', workspaceId] as const;
}

export function decisionsListKey(workspaceId: string, scope: 'active' | 'answered' | `issue-${string}`) {
  return ['decisions', workspaceId, scope] as const;
}

export function decisionDetailKey(decisionId: string) {
  return ['decision', decisionId] as const;
}

/** 当前工作区在途决策数（grace + open；徽标用） */
export function useDecisionsCount(workspaceId: string | null): number {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: decisionsCountKey(workspaceId ?? ''),
    queryFn: () => api.get<DecisionCounts>(`/api/workspaces/${encodeURIComponent(workspaceId ?? '')}/decisions/count`),
    enabled: workspaceId !== null,
  });
  useDecisionInvalidation(queryClient);
  return (data?.grace ?? 0) + (data?.open ?? 0);
}

/** 当前工作区在途（grace + open）与已回答列表 */
export function useDecisionLists(workspaceId: string | null) {
  const queryClient = useQueryClient();
  const active = useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', 'active'),
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&limit=${DECISION_LIST_LIMIT}`,
      ),
    enabled: workspaceId !== null,
  });
  const answered = useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', 'answered'),
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&state=answered&limit=${DECISION_LIST_LIMIT}`,
      ),
    enabled: workspaceId !== null,
  });
  useDecisionInvalidation(queryClient);
  return {
    active: active.data?.decisions ?? [],
    answered: answered.data?.decisions ?? [],
    counts: active.data?.counts ?? null,
    loading: active.isLoading || answered.isLoading,
  };
}

/**
 * 某张卡当前的决策（在途优先，否则最近一条已回答）+ 详情（选项 / 全部答案 revision / checkpoint）。
 * 详情面板用：一张卡同时最多一条在途决策，所以「最新一条」即当前要展示的决策。
 */
export function useIssueDecision(workspaceId: string | null, issueId: string | null) {
  const queryClient = useQueryClient();
  const filter = `issue_id=${encodeURIComponent(issueId ?? '')}&limit=1`;
  const active = useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', `issue-${issueId ?? ''}`),
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&${filter}`,
      ),
    enabled: workspaceId !== null && issueId !== null,
  });
  const answered = useQuery({
    queryKey: ['decisions', workspaceId ?? '', `answered-issue-${issueId ?? ''}`],
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&${filter}&state=answered`,
      ),
    enabled: workspaceId !== null && issueId !== null,
  });
  const latest = active.data?.decisions[0] ?? answered.data?.decisions[0] ?? null;
  const detail = useQuery({
    queryKey: decisionDetailKey(latest?.id ?? ''),
    queryFn: () => api.get<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(latest!.id)}`),
    enabled: latest !== null,
  });
  useDecisionInvalidation(queryClient);
  return {
    summary: latest,
    detail: detail.data?.decision ?? null,
    loading: active.isLoading || answered.isLoading,
  };
}

const DECISION_EVENT_TYPES = new Set<ServerWsEvent['type']>([
  'decision.grace_started',
  'decision.answered',
  'decision.expired',
  'decision.revised',
  'decision.withdrawn',
  'decision.extended',
  'issue.stop_requested',
]);

/** 订阅决策事件 → 失效列表 / 徽标 / 详情 / 卡面（卡面走既有 issue.changed，服务端已广播） */
export function useDecisionInvalidation(queryClient: QueryClient): void {
  useWsEvent((event) => {
    if (!DECISION_EVENT_TYPES.has(event.type)) return;
    void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
    void queryClient.invalidateQueries({ queryKey: ['decision'] });
  });
}
