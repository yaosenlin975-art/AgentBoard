/**
 * CR-9：API 端点注册表（issues 域先行，其余域渐进迁移）。
 * 所有 /api/issues* 路径只在这里拼接；组件只调函数，不再自拼路径。
 * URL 与查询参数与迁移前逐字一致（id 为服务端 UUID，encodeURIComponent 前后恒等）。
 */
import { api, type IssueAttachmentListPage } from './client';
import type { Issue, IssueComment, IssueTreePage, Priority } from '@agentboard/shared';
import type { DependencyView } from '../lib/dependency';

/** 智能创建草稿端点（smartDraft 用原生 fetch + 可注入 endpoint，故导出路径常量而非函数） */
export const ISSUE_DRAFT_PATH = '/api/issues/draft';

/** 创建任务入参：服务端 createIssueSchema 的字段裁剪版，未列字段按服务端默认 */
export interface CreateIssueInput {
  workspace_id: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  attachment_ids?: string[];
  parent_issue_id?: string | null;
}

/** 评论入参：content 必填；带附件时附 workspace_id + attachment_ids（服务端投递图片用） */
export interface IssueCommentInput {
  content: string;
  workspace_id?: string;
  attachment_ids?: string[];
}

/** 全量拉取 workspace 的 issue（不带分页参数 = 覆盖整个 workspace） */
export function listIssues(workspaceId: string | null | undefined): Promise<Issue[]> {
  return api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId ?? '')}`);
}

export function getIssue(issueId: string): Promise<Issue> {
  return api.get<Issue>(`/api/issues/${issueId}`);
}

export function createIssue(body: CreateIssueInput, options?: { idempotencyKey?: string }): Promise<Issue> {
  return api.post<Issue>(
    '/api/issues',
    body,
    options?.idempotencyKey !== undefined ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : undefined,
  );
}

/** 字段级 PATCH（CAS / 状态 / 排序 / 挂靠均走这里）；body 形状由服务端 patchIssueSchema 把关 */
export function patchIssue(issueId: string, body: Record<string, unknown>): Promise<Issue> {
  return api.patch<Issue>(`/api/issues/${issueId}`, body);
}

export function deleteIssue(issueId: string): Promise<void> {
  return api.del<void>(`/api/issues/${issueId}`);
}

/** 释放占用（响应体为 { ...issue, comment }，调用方自行剥离 comment） */
export function releaseIssue(issueId: string): Promise<Issue> {
  return api.post<Issue>(`/api/issues/${issueId}/release`);
}

/** 标记待验收（agent_id='user' 时服务端释放占用） */
export function markIssueDone(issueId: string, body: { agent_id: string }): Promise<Issue> {
  return api.post<Issue>(`/api/issues/${issueId}/done`, body);
}

/** 任务树分页拉取；query 为已组装好的 URLSearchParams（workspace/limit/parent_issue_id/cursor） */
export function listIssueTree(query: URLSearchParams): Promise<IssueTreePage> {
  return api.get<IssueTreePage>(`/api/issues/tree?${query.toString()}`);
}

/** PERF-4b：工作区状态计数聚合（响应类型组件私有，泛型透传） */
export function listIssueCounts<T>(workspaceIds: string[]): Promise<T> {
  return api.get<T>(`/api/issues/counts?workspace_ids=${encodeURIComponent(workspaceIds.join(','))}`);
}

/** 依赖视图；depth 传入时置于 workspace_id 之前（与既有契约顺序一致） */
export function getIssueDependencies(issueId: string, workspaceId: string, depth?: number): Promise<DependencyView> {
  const depthQuery = depth === undefined ? '' : `depth=${depth}&`;
  return api.get<DependencyView>(
    `/api/issues/${encodeURIComponent(issueId)}/dependencies?${depthQuery}workspace_id=${encodeURIComponent(workspaceId)}`,
  );
}

export function addIssueDependencies(
  issueId: string,
  body: { workspace_id: string; blocker_issue_id: string },
): Promise<DependencyView> {
  return api.post<DependencyView>(`/api/issues/${issueId}/dependencies`, body);
}

export function removeIssueDependency(issueId: string, blockerId: string, workspaceId: string): Promise<void> {
  return api.del<void>(
    `/api/issues/${issueId}/dependencies/${blockerId}?workspace_id=${encodeURIComponent(workspaceId)}`,
  );
}

export function listIssueComments(issueId: string): Promise<IssueComment[]> {
  return api.get<IssueComment[]>(`/api/issues/${issueId}/comments`);
}

export function addIssueComment(
  issueId: string,
  body: IssueCommentInput,
): Promise<{ comment: IssueComment; woke: boolean; warning?: string }> {
  return api.post<{ comment: IssueComment; woke: boolean; warning?: string }>(`/api/issues/${issueId}/comments`, body);
}

/** 该卡全部 attached 附件（评论/会话关联去重、新附件在前） */
export function listIssueAttachments(issueId: string, limit: number): Promise<IssueAttachmentListPage> {
  return api.get<IssueAttachmentListPage>(`/api/issues/${issueId}/attachments?limit=${limit}`);
}

/** 派发候选附件分页（响应类型组件私有，泛型透传） */
export function listIssuePendingAttachments<T>(issueId: string, limit: number, offset: number): Promise<T> {
  return api.get<T>(
    `/api/issues/${encodeURIComponent(issueId)}/pending-attachments?limit=${limit}&offset=${offset}`,
  );
}
