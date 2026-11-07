/**
 * 工作空间标签集合（UI-FILTER01）：顶栏标签筛选的数据源。
 * 硬约束：标签必须覆盖整个 workspace —— 这里请求不带 limit/offset，
 * 服务端 GET /api/issues 会返回该 workspace 的全部 issue（含所有状态），再本地聚合去重，
 * 避免「当前页 / 当前状态」截断导致标签缺失。
 *
 * PERF-6：queryKey 与看板主查询（components/board/Board.tsx）取同一个 `['issues', workspaceId]`，
 * 标签条只是该查询的第二个 observer —— React Query 按 key 去重，首屏不再重复拉一次全量列表；
 * issue.changed / issue.deleted 失效同一 key 时，标签集合同步刷新。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { api } from './client';

/** 与看板主查询共用同一 key（详见文件头 PERF-6 说明），不再自建独立缓存槽位 */
export function workspaceLabelsQueryKey(workspaceId: string): readonly unknown[] {
  return ['issues', workspaceId];
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

/** 标签出现频次（全量 issue 聚合，用于 LABEL-BAR 的「常用标签」排序） */
export function collectWorkspaceLabelCounts(issues: Issue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      const trimmed = label.trim();
      if (trimmed !== '') counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }
  return counts;
}

/** 标签集合（与看板主查询共用缓存，重复渲染 / 同屏挂载都不会重复请求） */
export function useWorkspaceLabels(workspaceId: string | null): string[] {
  const { data } = useQuery({
    queryKey: workspaceLabelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchWorkspaceIssues(workspaceId as string),
    enabled: workspaceId !== null,
  });
  return useMemo(() => collectWorkspaceLabels(data ?? []), [data]);
}

/** 标签频次（与 useWorkspaceLabels 共用同一 queryKey 缓存，不会额外发请求） */
export function useWorkspaceLabelCounts(workspaceId: string | null): Map<string, number> {
  const { data } = useQuery({
    queryKey: workspaceLabelsQueryKey(workspaceId ?? ''),
    queryFn: () => fetchWorkspaceIssues(workspaceId as string),
    enabled: workspaceId !== null,
  });
  return useMemo(() => collectWorkspaceLabelCounts(data ?? []), [data]);
}
