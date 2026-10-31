/** Task 9：REST 请求体 zod 校验 schema（Pinned Contracts REST 全表 + 契约修订项） */
import { z } from 'zod';

export const prioritySchema = z.enum(['低', '中', '高']);
export const issueStatusSchema = z.enum(['待规划', '进行中', '待验收', '已关闭']);
export const reuseSessionSchema = z.enum(['last', 'new']);

/**
 * POST /api/workspaces：name 允许空串（空 → 服务端从 path basename 兜底）；
 * name 键仍必填（缺键 → 400）。
 */
export const createWorkspaceSchema = z.object({
  name: z.string().trim(),
  path: z.string().trim().min(1, 'path 不能为空'),
});

export const createIssueSchema = z.object({
  workspace_id: z.string().min(1),
  title: z.string().trim().min(1, 'title 不能为空'),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string()).optional(),
});

export const patchIssueSchema = z
  .object({
    title: z.string().trim().min(1, 'title 不能为空').optional(),
    description: z.string().optional(),
    priority: prioritySchema.optional(),
    labels: z.array(z.string()).optional(),
    status: issueStatusSchema.optional(),
    sort_order: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个更新字段' });

export const addCommentSchema = z.object({
  content: z.string().min(1, 'content 不能为空'),
  /** agent 经 kb comment 写评论时声明身份：有 → author='agent:<agent_id>'，无 → 'user' */
  agent_id: z.string().trim().min(1).optional(),
});

export const claimSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
});

export const doneSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  notes: z.string().optional(),
});

export const failSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  reason: z.string().min(1, 'reason 不能为空'),
});

/**
 * POST /api/sessions（契约修订）：issue_id 为空时 workspace_id 必填（自由会话归属工作空间）。
 */
export const createSessionSchema = z
  .object({
    cli: z.string().trim().min(1, 'cli 不能为空'),
    model: z.string().nullable().optional(),
    issue_id: z.string().optional(),
    workspace_id: z.string().optional(),
    prompt: z.string().optional(),
    reuse_session: reuseSessionSchema.optional(),
  })
  .refine((v) => Boolean(v.issue_id) || Boolean(v.workspace_id), {
    message: 'issue_id 为空时必须提供 workspace_id',
  });

export const sendMessageSchema = z.object({
  text: z.string().min(1, 'text 不能为空'),
});

/**
 * PATCH /api/sessions/:id：只改 model 字段（Task 14 聊天视图"修改模型，下一轮生效"）。
 * model 必填（字符串或 null 清空）；缺键 → 400。
 */
export const patchSessionSchema = z.object({
  model: z.string().trim().min(1, 'model 不能为空').nullable(),
});
