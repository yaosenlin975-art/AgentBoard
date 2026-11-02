/**
 * 任务状态的手动更新契约（DETAIL-STATUS01）：详情面板、任务树节点、看板拖动共用同一套判定与请求。
 * - 手动改状态一律走 PATCH /api/issues/<id>，带 workspace_id + expected_updated_at（CAS），不复制第二套逻辑；
 * - 「进行中」不接受手动改状态（含未占用）：只能由 claim / done / fail 流转；
 * - 已占用任务的状态由 agent 流程维护，服务端也会以 409「占用中禁止修改状态」兜底。
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { api } from '../api/client';

export const ISSUE_STATUSES: readonly IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

/** 只有 agent 流程能离开的状态 */
const FLOW_ONLY_STATUS: IssueStatus = '进行中';

/**
 * 手动状态入口是否禁用。
 * 返回 null 表示可手动修改；否则为禁用原因（同时用于 title 提示）。
 */
export function manualStatusBlockedReason(
  issue: Pick<Issue, 'status' | 'claimed_by'>,
): string | null {
  if (issue.claimed_by !== null) return '占用中：状态由 agent 流程维护';
  if (issue.status === FLOW_ONLY_STATUS) return '进行中：状态由 claim / done / fail 流转，不能手动修改';
  return null;
}

/** 看板拖动是否允许改变状态（列内排序不改变状态，放行） */
export function statusChangeBlocked(
  issue: Pick<Issue, 'status' | 'claimed_by'>,
  targetStatus: IssueStatus,
): boolean {
  if (issue.claimed_by !== null) return true;
  return issue.status === FLOW_ONLY_STATUS && targetStatus !== FLOW_ONLY_STATUS;
}

export interface ManualStatusUpdate {
  issueId: string;
  workspaceId: string;
  expectedUpdatedAt: number;
  status: IssueStatus;
}

/** 手动状态更新：与看板拖动、树节点下拉同一契约（workspace_id + expected_updated_at CAS） */
export function patchIssueStatus(input: ManualStatusUpdate): Promise<Issue> {
  return api.patch<Issue>(`/api/issues/${input.issueId}`, {
    workspace_id: input.workspaceId,
    expected_updated_at: input.expectedUpdatedAt,
    status: input.status,
  });
}

/** 状态变更后统一失效：看板/树列表（['issues', ws] 前缀，含树的分页 key） */
export function invalidateIssueStatusCaches(
  queryClient: QueryClient,
  input: { workspaceId: string },
): void {
  void queryClient.invalidateQueries({ queryKey: ['issues', input.workspaceId] });
}
