/**
 * 任务状态的手动更新契约（DETAIL-STATUS01 / DETAIL-FLOW）：详情面板、任务树节点、看板拖动共用同一套判定与请求。
 * - 手动改状态一律走 PATCH /api/issues/<id>，带 workspace_id + expected_updated_at（CAS），不复制第二套逻辑；
 * - 未占用卡允许手动改状态（含「进行中」，服务端 updateIssueGuarded 对未占用卡放行 status）；
 * - 已占用任务的状态由 agent 流程维护，服务端也会以 409「占用中禁止修改状态」兜底；
 * - 看板拖动只冻结占用卡（statusChangeBlocked）；未占用卡可拖动改位置与状态（DRAG-FIX，2026-11-17 用户口径）。
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { patchIssue } from '../api/endpoints';
import { BUILTIN_STATUS_NAMES } from './workspaceStatuses';

/**
 * SYS2：状态名唯一来源是工作区状态字典（`workspaceStatuses.ts` 的 `BUILTIN_STATUS_NAMES`）。
 * 这里只保留兼容导出（旧调用点仍可 import），不再维护独立列表。
 */
export const ISSUE_STATUSES: readonly string[] = BUILTIN_STATUS_NAMES;

/**
 * 手动状态入口是否禁用（详情面板、任务树共用）。
 * 返回 null 表示可手动修改；否则为禁用原因（同时用于 title 提示）。
 */
export function manualStatusBlockedReason(
  issue: Pick<Issue, 'status' | 'claimed_by'>,
): string | null {
  if (issue.claimed_by !== null) return '占用中：状态由 agent 流程维护，请先释放任务再改状态';
  return null;
}

/**
 * 看板拖动是否允许改变状态（列内排序不改变状态，放行）。
 * DRAG-FIX：仅占用卡冻结；未占用卡全部放行（含从「进行中」拖到其他列）。
 */
export function statusChangeBlocked(issue: Pick<Issue, 'claimed_by'>): boolean {
  return issue.claimed_by !== null;
}

export interface ManualStatusUpdate {
  issueId: string;
  workspaceId: string;
  expectedUpdatedAt: number;
  status: IssueStatus;
}

/** 手动状态更新：与看板拖动、树节点下拉同一契约（workspace_id + expected_updated_at CAS） */
export function patchIssueStatus(input: ManualStatusUpdate): Promise<Issue> {
  return patchIssue(input.issueId, {
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
