import type { Issue, IssueStatus, IssueTreePage } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { createIssue, getIssue, listIssueTreePage, updateIssue, type CreateIssueInput, type IssuePatch } from '../db/repos/issue.js';
import { addComment } from '../db/repos/comment.js';
import { bindAttachmentsToComment } from '../db/repos/attachment.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';

/** 新建任务附图：staged 附件在创建事务内绑定到该任务的「附件评论」，失败整体回滚 */
export interface CreateIssueWithAttachmentsInput extends CreateIssueInput {
  attachment_ids?: string[];
}

export function createIssueInHierarchy(db: Db, input: CreateIssueWithAttachmentsInput): Issue {
  const { attachment_ids: attachmentIds, ...issueInput } = input;
  return db.transaction(() => {
    if (issueInput.parent_issue_id) requireParentInWorkspace(db, issueInput.parent_issue_id, issueInput.workspace_id);
    const issue = createIssue(db, issueInput);
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      // 复用评论附件通道：附件只属于该 workspace/该任务，成功后 status=attached，可经 /api/issues/:id/attachments/:aid 私有下载
      const comment = addComment(db, { issue_id: issue.id, author: 'user', content: '' });
      bindAttachmentsToComment(db, issue.workspace_id, comment.id, attachmentIds, Date.now());
      return getIssue(db, issue.id)!;
    }
    return issue;
  }).immediate();
}

export function updateIssueInHierarchy(
  db: Db,
  issueId: string,
  patch: IssuePatch,
  guard?: { workspaceId: string; expectedUpdatedAt: number },
): Issue {
  return db.transaction(() => {
    const current = getIssue(db, issueId, guard?.workspaceId);
    if (!current) throw new NotFoundError('任务不存在');
    if (guard && current.updated_at !== guard.expectedUpdatedAt) {
      throw new ApiError(409, 'TASK_REVISION_CONFLICT', '任务已更新，请重新读取', { current_updated_at: current.updated_at });
    }
    if (patch.parent_issue_id !== undefined && patch.parent_issue_id !== null) {
      requireParentInWorkspace(db, patch.parent_issue_id, current.workspace_id);
      if (patch.parent_issue_id === issueId || isDescendant(db, issueId, patch.parent_issue_id)) {
        throw new ValidationError('父任务不能是自身或其后代');
      }
    }
    return updateIssue(db, issueId, patch, guard);
  }).immediate();
}

export function getIssueTreeChildren(db: Db, input: {
  workspace_id: string;
  parent_issue_id: string | null;
  limit: number;
  status?: IssueStatus;
  cursor?: string;
}): IssueTreePage {
  return listIssueTreePage(db, input);
}

function requireParentInWorkspace(db: Db, parentId: string, workspaceId: string): Issue {
  const parent = getIssue(db, parentId);
  if (!parent) throw new NotFoundError('父任务不存在');
  if (parent.workspace_id !== workspaceId) throw new ValidationError('父任务必须属于同一工作空间');
  return parent;
}

function isDescendant(db: Db, issueId: string, candidateId: string): boolean {
  const row = db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM issue WHERE parent_issue_id=?
      UNION
      SELECT child.id FROM issue child JOIN descendants parent ON child.parent_issue_id=parent.id
    )
    SELECT EXISTS(SELECT 1 FROM descendants WHERE id=?) AS found`).get(issueId, candidateId) as { found: number };
  return row.found !== 0;
}
