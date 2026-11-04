/** Task 9：REST 请求体 zod 校验 schema（Pinned Contracts REST 全表 + 契约修订项） */
import { z } from 'zod';
import { DRAFT_ADAPTERS } from '../services/smartCreateDraft.js';
import { MAX_DISPATCH_SELECTED_ID_COUNT } from '@agentboard/shared';
import { knowledgeSourceSchema, knowledgeEvidenceSchema } from '../services/knowledge.js';
import { normalizeLabels } from '../services/labelNormalize.js';
const offsetQuery = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const sizeQuery = z.coerce.number().int().min(1).max(40000).default(12000);
export const pageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: offsetQuery });
export const descriptionQuerySchema = z.object({ description_offset_chars: offsetQuery, description_max_chars: sizeQuery });
export const commentQuerySchema = z.object({ content_offset_chars: offsetQuery, content_max_chars: sizeQuery });

export const knowledgeScopeFields = { scope: z.enum(['workspace', 'common']), workspace_id: z.string().min(1).optional() };
const knowledgeContentFields = { title: z.string().trim().min(1).max(300), body_md: z.string().min(1).max(100000),
  sources: z.array(knowledgeSourceSchema).min(1).max(100), evidence: z.array(knowledgeEvidenceSchema).min(1).max(100),
  expires_at: z.number().int().nonnegative().nullable().optional(),
  // KB-MODEL：非法 category/landed 一律 400（zod enum）；缺省由 repo 归一到 legacy
  category: z.enum(['design', 'solved', 'pinned', 'open', 'legacy']).optional(),
  landed: z.enum(['landed', 'partial', 'proposed']).nullable().optional() };
const knowledgeAuditFields = { actor: z.string().trim().min(1).max(100), change_note: z.string().max(2000).optional() };
export const knowledgeCreateSchema = z.object({ ...knowledgeScopeFields, ...knowledgeContentFields, ...knowledgeAuditFields, slug: z.string().min(1).max(200) }).strict();
export const knowledgeReviseSchema = z.object({ ...knowledgeScopeFields, ...z.object(knowledgeContentFields).partial().shape, ...knowledgeAuditFields, expected_revision: z.number().int().positive() }).strict();
export const knowledgeActionSchema = z.object({ ...knowledgeScopeFields, actor: knowledgeAuditFields.actor, action: z.enum(['archive', 'restore', 'delete']), expected_revision: z.number().int().positive() }).strict();

export const prioritySchema = z.enum(['低', '中', '高']);
/**
 * CLI-LIST-GUARD：查询过滤用的状态名不再限定四值枚举（自定义状态 / 已废弃都要能筛），
 * 只校验「非空字符串」；是否属于该工作区由路由层查 workspace_status 判定（非法 → 400 并列出可用状态）。
 */
export const issueStatusSchema = z.string().trim().min(1, 'status 不能为空').max(50);
/**
 * STATUS-1：写入用的状态名。不再是枚举（每工作区可有自定义状态），合法性由服务层
 * `requireWorkspaceStatus` 按该工作区的 workspace_status 字典判定，未命中 → 400。
 */
export const statusNameSchema = z.string().trim().min(1, 'status 不能为空').max(50);
/** 截止日期 `YYYY-MM-DD` / 截止时间 `HH:mm`（24h）；null 表示清除 */
export const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date 需为 YYYY-MM-DD').nullable().optional();
export const dueTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'due_time 需为 HH:mm（24 小时制）').nullable().optional();
export const issueTreeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  parent_issue_id: z.string().trim().min(1).optional(),
  status: issueStatusSchema.optional(),
  cursor: z.string().min(1).max(4096).optional(),
});
export const reuseSessionSchema = z.enum(['last', 'new']);

// ---- 工作区变更日志（LOG01，设计 §6）----
export const changeLogTypeSchema = z.enum(['新增', '修复', '调整', '历史']);
const changeLogContentFields = {
  title: z.string().trim().min(1).max(200),
  body_md: z.string().min(1).max(100000),
  change_type: changeLogTypeSchema,
  occurred_at: z.number().int().nonnegative().optional(),
};
const changeLogActor = z.string().trim().min(1).max(100);
/** 普通新增/修改不接受 `历史`：该类型只由旧 CHANGELOG 导入服务写入 */
const editableType = changeLogTypeSchema.exclude(['历史']);
export const changeLogCreateSchema = z
  .object({ ...changeLogContentFields, change_type: editableType, actor: changeLogActor })
  .strict();
export const changeLogPatchSchema = z
  .object({
    title: changeLogContentFields.title.optional(),
    body_md: changeLogContentFields.body_md.optional(),
    change_type: editableType.optional(),
    occurred_at: changeLogContentFields.occurred_at,
    expected_revision: z.number().int().positive(),
    actor: changeLogActor,
  })
  .strict()
  .refine((value) => ['title', 'body_md', 'change_type', 'occurred_at'].some((key) => key in value), {
    message: '至少一个可编辑字段',
  });
export const changeLogDeleteSchema = z.object({ expected_revision: z.number().int().positive(), actor: changeLogActor }).strict();

// ---- 旧 CHANGELOG 导入（LOG02；设计 §6 未列此端点，属实现新增）----
const importSourcePath = z.string().trim().min(1).max(4096);
export const changelogImportPreviewSchema = z.object({ source_path: importSourcePath, actor: changeLogActor }).strict();
export const changelogImportApplySchema = z
  .object({
    source_path: importSourcePath,
    preview_sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'SHA-256 必须为 64 位十六进制'),
    actor: changeLogActor,
  })
  .strict();
export const changelogImportVerifySchema = z.object({ source_path: importSourcePath }).strict();
export const changeLogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: offsetQuery,
    change_type: changeLogTypeSchema.optional(),
    q: z.string().max(200).optional(),
  })
  .strict();


/**
 * POST /api/workspaces：name 允许空串（空 → 服务端从 path basename 兜底）；
 * name 键仍必填（缺键 → 400）。
 */
export const createWorkspaceSchema = z.object({
  name: z.string().trim(),
  path: z.string().trim().min(1, 'path 不能为空'),
});

/** WS-REORDER：批量重排，ordered_ids 必须是当前全部工作区 id 的一个排列（重复/未知 id 由路由拒绝） */
export const reorderWorkspacesSchema = z.object({
  ordered_ids: z.array(z.string().uuid()).min(1).max(500),
}).strict().refine(value => new Set(value.ordered_ids).size === value.ordered_ids.length, 'ordered_ids 不能重复');

/**
 * SMART-CREATE：草稿生成请求（不落库）。adapter 只允许本机已装的三家；requirement 上限 4000 字，
 * 原文不进审计（只记 adapter/耗时/成败/warning 数）。
 */
export const draftRequestSchema = z.object({
  workspace_id: z.string().min(1),
  requirement: z.string().trim().min(1, 'requirement 不能为空').max(4000),
  // SMART-CREATE-CB：枚举从 DRAFT_ADAPTERS 派生（单一来源，避免以后再漏 codebuddy）
  adapter: z.enum(DRAFT_ADAPTERS),
  priority: prioritySchema.optional(),
}).strict();

export const createIssueSchema = z
  .object({
    workspace_id: z.string().min(1),
    title: z.string().trim().min(1, 'title 不能为空'),
    description: z.string().optional(),
    priority: prioritySchema.optional(),
    // TAG-CLEANUP-EXEC：请求边界统一规范化（拆空格/全角逗号、trim、去重），与 CLI parseLabels 同规则
  labels: z.array(z.string()).transform(normalizeLabels).optional(),
    parent_issue_id: z.string().min(1).nullable().optional(),
    due_date: dueDateSchema,
    due_time: dueTimeSchema,
    // 新建任务附图（NEW-ISSUE-IMAGE）：只接受已 staged 的附件 id，创建事务内绑定，最多 5 张
    attachment_ids: z.array(z.string().uuid()).max(5).optional(),
  })
  .refine((value) => new Set(value.attachment_ids ?? []).size === (value.attachment_ids ?? []).length, {
    message: 'attachment_ids 不能重复',
  });

export const patchIssueSchema = z
  .object({
    title: z.string().trim().min(1, 'title 不能为空').optional(),
    description: z.string().optional(),
    priority: prioritySchema.optional(),
    // TAG-CLEANUP-EXEC：请求边界统一规范化（拆空格/全角逗号、trim、去重），与 CLI parseLabels 同规则
  labels: z.array(z.string()).transform(normalizeLabels).optional(),
    status: statusNameSchema.optional(),
    sort_order: z.number().int().optional(),
    parent_issue_id: z.string().min(1).nullable().optional(),
    due_date: dueDateSchema,
    due_time: dueTimeSchema,
    workspace_id: z.string().min(1).optional(),
    expected_updated_at: z.number().int().nonnegative().optional(),
  })
  .refine((v) => ['title','description','priority','labels','status','sort_order','parent_issue_id','due_date','due_time'].some(k => Object.hasOwn(v, k)), { message: '至少提供一个更新字段' });

export const addCommentSchema = z.object({
  content: z.string(),
  attachment_ids: z.array(z.string().uuid()).max(5).optional(),
  workspace_id: z.string().min(1).optional(),
  /** agent 经 kb comment 写评论时声明身份：有 → author='agent:<agent_id>'，无 → 'user' */
  agent_id: z.string().trim().min(1).optional(),
}).refine((value) => value.content.trim() !== '' || (value.attachment_ids?.length ?? 0) > 0, { message: '评论文字与图片不能同时为空' })
  .refine((value) => new Set(value.attachment_ids ?? []).size === (value.attachment_ids ?? []).length, { message: 'attachment_ids 不能重复' });

export const claimSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  knowledge_enabled: z.boolean().optional(),
  knowledge_query: z.string().trim().min(1).max(500).optional(),
});

export const doneSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  notes: z.string().optional(),
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；有并行占用时只提交声明范围内的改动 */
  scope_paths: z.array(z.string().trim().min(1).max(1000)).max(200).optional(),
});

/** CLI-CLOSE：reopen 的目标状态（缺省待规划；合法性由工作区状态字典判定） */
export const reopenSchema = z.object({
  status: z.string().trim().min(1).max(50).optional(),
  workspace_id: z.string().trim().min(1).optional(),
  /** CLI 会带 = 审计身份；与 PATCH/claim 同款，不参与流转判定 */
  agent_id: z.string().trim().min(1).optional(),
});

export const failSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  reason: z.string().min(1, 'reason 不能为空'),
});

/**
 * DEP-1 依赖写通道：POST 走 body，DELETE 走 query；`workspace_id` 都必填（设计 §17-B1），
 * 服务端用 `requireIssueInWorkspace` 校验，不按 issue 自身工作区放行。
 */
export const addDependencySchema = z.object({
  workspace_id: z.string().trim().min(1, '缺少 workspace_id'),
  blocker_issue_id: z.string().trim().min(1, 'blocker_issue_id 不能为空'),
});

export const dependencyQuerySchema = z.object({
  workspace_id: z.string().trim().min(1, '缺少 workspace_id'),
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
    knowledge_enabled: z.boolean().optional(),
    knowledge_query: z.string().trim().min(1).max(500).optional(),
    retry_unknown_images: z.boolean().optional(),
    selected_attachment_ids: z.array(z.string().uuid()).max(MAX_DISPATCH_SELECTED_ID_COUNT).optional()
      .refine((ids) => ids === undefined || new Set(ids).size === ids.length, { message: 'selected_attachment_ids 不能重复' }),
  })
  .refine((v) => Boolean(v.issue_id) || Boolean(v.workspace_id), {
    message: 'issue_id 为空时必须提供 workspace_id',
  })
  .refine((v) => v.selected_attachment_ids === undefined || Boolean(v.issue_id), {
    message: 'selected_attachment_ids 必须绑定 issue_id',
    path: ['selected_attachment_ids'],
  });

/** CHAT-IMG-DELIVERY：聊天发消息可携带附件（与 addCommentSchema 同款校验；文字与图片至少一项非空） */
export const sendMessageSchema = z.object({
  text: z.string().default(''),
  attachment_ids: z.array(z.string().uuid()).max(5, 'attachment_ids 最多 5 张').optional(),
}).refine((value) => value.text.trim() !== '' || (value.attachment_ids?.length ?? 0) > 0, { message: '消息文字与图片不能同时为空' })
  .refine((value) => new Set(value.attachment_ids ?? []).size === (value.attachment_ids ?? []).length, { message: 'attachment_ids 不能重复' });

/**
 * PATCH /api/sessions/:id：只改 model 字段（Task 14 聊天视图"修改模型，下一轮生效"）。
 * model 必填（字符串或 null 清空）；缺键 → 400。
 */
export const patchSessionSchema = z.object({
  model: z.string().trim().min(1, 'model 不能为空').nullable(),
});

/**
 * PATCH /api/settings：端口 / DB 路径 / 并发上限全可选，至少提供一个；
 * 未知键跟随项目 schema 惯例忽略（zod 默认 strip）。
 */
export const patchSettingsSchema = z
  .object({
    port: z
      .number()
      .int('端口必须为 1-65535 的整数')
      .min(1, '端口必须为 1-65535 的整数')
      .max(65535, '端口必须为 1-65535 的整数')
      .optional(),
    dbPath: z.string().trim().min(1, 'dbPath 不能为空').optional(),
    // DB-1：对外规范名 db_path（与 dbPath 等价；两个都传且不一致 → 400，避免静默取一个）
    db_path: z.string().trim().min(1, 'db_path 不能为空').optional(),
    maxConcurrentTurns: z.number().int('并发上限必须为 ≥1 的整数').min(1, '并发上限必须为 ≥1 的整数').optional(),
    attachmentQuotaBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    attachmentStagedTtlMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    attachmentCleanupIntervalMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个更新字段' });
