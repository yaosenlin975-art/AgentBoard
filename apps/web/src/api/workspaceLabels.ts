/**
 * 工作空间标签集合（UI-FILTER01）：顶栏标签筛选的数据源。
 * 硬约束：标签必须覆盖整个 workspace —— 这里请求不带 limit/offset，
 * 服务端 GET /api/issues 会返回该 workspace 的全部 issue（含所有状态），再本地聚合去重，
 * 避免「当前页 / 当前状态」截断导致标签缺失。
 * queryKey 挂在 ['issues', workspaceId] 前缀下：issue.changed 失效时标签集合同步刷新。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { api } from './client';

export function workspaceLabelsQueryKey(workspaceId: string): readonly unknown[] {
  return ['issues', workspaceId, 'labels'];
}

/** 全量拉取该 workspace 的 issue（不带分页参数 = 覆盖整个 workspace） */
export function fetchWorkspaceIssues(workspaceId: string): Promise<Issue[]> {
  return api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId)}`);
}

/** 从全量 issue 聚合去重排序后的标签集合 */
export function collectWorkspaceLabels(issues: Issue[]): string[] {
  const labels = new Set<string>();
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      const trimmed = label.trim();
      if (trimmed !== '') labels.add(trimmed);
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 标签集合（react-query 缓存，重复渲染不会重复请求） */
export function useWorkspaceLabels(workspaceId: string | null): string[] {
  const { data } = useQuery({
    queryKey: workspaceLabelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchWorkspaceIssues(workspaceId as string),
    enabled: workspaceId !== null,
    staleTime: 30_000,
  });
  return useMemo(() => collectWorkspaceLabels(data ?? []), [data]);
}
