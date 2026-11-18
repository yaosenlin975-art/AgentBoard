import { z } from 'zod/v4';

/** Shared field schemas keep tools/list compact; operation-specific fields stay local. */
export const workspaceField = {
  workspace_id: z.string().trim().min(1).optional()
    .describe('Workspace UUID; omit when bound by AGENTBOARD_WORKSPACE_ID.'),
};

export const requestIdField = {
  request_id: z.string({ error: 'request_id is required; use a UUID idempotency key such as 00000000-0000-4000-8000-000000000000 and reuse it only for the identical retry.' }).uuid()
    .describe('UUID idempotency key; replay the same key only for the same call.'),
};

export const fenceField = {
  fence: z.number().int().min(0).optional()
    .describe('Claim fence from start_task/claim_task; stale values fail with STALE_FENCE.'),
};

export const taskIdField = {
  task_id: z.string().trim().min(1)
    .describe('Task UUID or unique id prefix (at least 8 characters).'),
};

export const taskStatusField = z.string().trim().min(1)
  .describe('Status name from this workspace dictionary; unknown values fail with VALIDATION_ERROR.');

export const priorityField = z.enum(['低', '中', '高'])
  .describe('Priority: 低 / 中 / 高.');

export const changeTypeField = z.enum(['新增', '修复', '调整'])
  .describe('Change type: 新增 / 修复 / 调整.');

export const pageFields = {
  limit: z.number().int().min(1).max(100).default(50).describe('Page size, 1-100 (default 50).'),
  offset: z.number().int().min(0).default(0).describe('Zero-based row offset (default 0).'),
};

/** Agent 高频读取字段；正文与评论由专用工具按需获取。 */
export const TASK_PREVIEW_FIELDS = [
  'id', 'workspace_id', 'title', 'priority', 'labels', 'status', 'parent_issue_id',
  'claimed_by', 'claimed_at', 'comment_count', 'blocked_by_count', 'blocked_by_open_count',
  'decision_locked', 'open_decision_id', 'updated_at',
].join(',');

export function compactTask(task: object): Record<string, unknown> {
  const source = task as Record<string, unknown>;
  return Object.fromEntries(TASK_PREVIEW_FIELDS.split(',').map((key) => [key, source[key]]));
}
