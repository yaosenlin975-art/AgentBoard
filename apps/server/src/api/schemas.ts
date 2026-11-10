/** Task 9：REST 请求体 zod 校验 schema（Pinned Contracts REST 全表 + 契约修订项） */
import { z } from 'zod';
import { KNOWLEDGE_BODY_MAX_CHARS } from '../services/knowledge.js';
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
const knowledgeContentFields = { title: z.string().trim().min(1).max(300), body_md: z.string().min(1).max(KNOWLEDGE_BODY_MAX_CHARS),
  sources: z.array(knowledgeSourceSchema).min(1).max(100), evidence: z.array(knowledgeEvidenceSchema).min(1).max(100),
  expires_at: z.number().int().nonnegative().nullable().optional(),
  // KB-MODEL：非法 category/landed 一律 400（zod enum）；缺省由 repo 归一到 legacy
  category: z.enum(['design', 'solved', 'pinned', 'open', 'legacy']).optional(),
  landed: z.enum(['landed', 'partial', 'proposed']).nullable().optional(),
  // KB-PAGE-3：域词表校验放服务层（此处只收字符串，便于后续扩词表不重建 schema）
  // KB-CR-1：null 一并放行给服务层判（创建=缺省即 400，修订=显式清空），避免 zod 先报通用类型错
  domain: z.string().nullish() };
const knowledgeAuditFields = { actor: z.string().trim().min(1).max(100), change_note: z.string().max(2000).optional() };
/**
 * KBIMP-1：知识页文本导入。`content` 就是文件原文（前端读文件后原样上传）；
 * 单次 ≤1MB 由服务层按 UTF-8 字节判（zod 这里只挡明显超限的 2MB，避免把大字符串搬来搬去）。
 */
export const knowledgeImportSchema = z.object({
  scope: z.enum(['workspace', 'common']),
  workspace_id: z.string().min(1).optional(),
  format: z.enum(['md', 'txt', 'json']),
  // IMPORT-LIMIT-S：与 index.ts 的导入 parser 上限一致（12MB）；单文件 10MB 的语义在 services/knowledgeImport.ts 校验
  content: z.string().max(12 * 1024 * 1024),
  filename: z.string().max(300).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  slug: z.string().min(1).max(200).optional(),
  category: z.enum(['design', 'solved', 'pinned', 'open', 'legacy']).optional(),
  landed: z.enum(['landed', 'partial', 'proposed']).nullable().optional(),
  // KB-CR-1：导入即建页，domain 必填；词表校验在服务层（requireKnowledgeDomain）
  domain: z.string().nullish(),
  labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  actor: z.string().trim().min(1).max(100).optional(),
  change_note: z.string().max(2000).optional(),
}).strict();
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
  .object({
    ...changeLogContentFields,
    change_type: editableType,
    actor: changeLogActor,
    /** SK-05：可选归属卡；done 门禁据此识别「本卡已有 changelog」 */
    issue_id: z.string().uuid('issue_id 需为任务 UUID').optional(),
  })
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

/**
 * CARD-FACE：描述「空」的唯一权威判定。
 * 空 = 去掉 markdown 标题、模板段名（目标 / 范围 / 验收 / 验收标准 / 边界 …）、空列表项与空白后无实质内容；
 * 描述很短但有正文不算空，不做长度阈值。
 */
export function isBlankIssueDescription(text: string | undefined): boolean {
  if (text === undefined) return true;
  const stripped = text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*(目标|范围|验收|验收标准|边界)\s*[:：]?\s*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .trim();
  return stripped === '';
}

export const createIssueSchema = z
  .object({
    workspace_id: z.string().min(1),
    // KB-CLI-1：标题 200 字上限（API 直调同样受限；CLI 本地先行报错）
    title: z.string().trim().min(1, 'title 不能为空').max(200, '标题超长：上限 200 字'),
    description: z.string().optional(),
    // CARD-FACE：空描述逃生口（批量建卡 / 纯父卡）；用了它即跳过服务端空面校验
    allow_empty: z.boolean().optional(),
    // CREATE-STATUS：建卡只允许停在「待规划」或「待验收」，不开放进行中/已关闭
    status: z.enum(['待规划', '待验收'], { error: 'status 仅支持「待规划」和「待验收」' }).optional(),
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
  })
  .refine((value) => value.allow_empty === true || !isBlankIssueDescription(value.description), {
    message: '描述不能为空：请写清正文与验收标准（最小模板：目标 / 范围 / 验收 / 边界）；批量建卡或纯父卡可传 allow_empty=true 跳过校验',
    path: ['description'],
  })
  .refine((value) => value.status !== '待验收' || !isBlankIssueDescription(value.description), {
    message: '初始状态为「待验收」时必须同时填写验收标准（写在描述里，含验收口径）',
    path: ['status'],
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
    // BORROW-0.3：占用代次软校验（缺席放行）；不参与「至少一个更新字段」判定
    fence: z.number().int().min(0).optional(),
  })
  .refine((v) => ['title','description','priority','labels','status','sort_order','parent_issue_id','due_date','due_time'].some(k => Object.hasOwn(v, k)), { message: '至少提供一个更新字段' });

export const addCommentSchema = z.object({
  content: z.string(),
  attachment_ids: z.array(z.string().uuid()).max(5).optional(),
  workspace_id: z.string().min(1).optional(),
  /** agent 经 kb comment 写评论时声明身份：有 → author='agent:<agent_id>'，无 → 'user' */
  agent_id: z.string().trim().min(1).optional(),
  // BORROW-0.3：占用代次软校验（缺席放行）
  fence: z.number().int().min(0).optional(),
}).refine((value) => value.content.trim() !== '' || (value.attachment_ids?.length ?? 0) > 0, { message: '评论文字与图片不能同时为空' })
  .refine((value) => new Set(value.attachment_ids ?? []).size === (value.attachment_ids ?? []).length, { message: 'attachment_ids 不能重复' });

export const claimSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  knowledge_enabled: z.boolean().optional(),
  knowledge_query: z.string().trim().min(1).max(500).optional(),
  // BORROW-0.3：占用代次（软模式：缺席放行；旧 fence → 409 STALE_FENCE）；也可走 x-claim-fence 头
  fence: z.number().int().min(0).optional(),
});

export const doneSchema = z.object({
  agent_id: z.string().trim().min(1, 'agent_id 不能为空'),
  notes: z.string().optional(),
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；未声明时服务端不提交任何文件（NO_SCOPE） */
  scope_paths: z.array(z.string().trim().min(1).max(1000)).max(200).optional(),
  /**
   * SK-05 / MCP-09 变更日志门禁：只有 agent 入口（CLI/MCP）带 client 时才校验，
   * REST 直调（无 client）保持兼容。放行条件（任一）：changelog_ack=true（已写或显式无变更）、
   * changelog_id 指向本工作区一条活动日志、库中已存在 issue_id=本卡且 claim 之后创建的日志。
   */
  client: z.enum(['cli', 'mcp']).optional(),
  changelog_ack: z.boolean().optional(),
  /** SK-05：显式指定本次收尾对应的变更日志（须属本工作区） */
  changelog_id: z.string().uuid('changelog_id 需为变更日志 UUID').optional(),
  /** N3-10：纯看板任务显式声明「没有文件改动」，跳过 GIT-ON-DONE（不再 NO_SCOPE + exit 1） */
  board_only: z.boolean().optional(),
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

/** REL-1：工作区批量退回待规划；workspace 只认路径参数，body 里的 workspace_id 被忽略 */
export const releaseRunningSchema = z.object({
  mode: z.enum(['expired', 'all']).optional(),
  issue_ids: z.array(z.string().uuid()).max(500).optional(),
  dry_run: z.boolean().optional(),
});

/**
 * DEP-1 依赖写通道：POST 走 body，DELETE 走 query；`workspace_id` 都必填（设计 §17-B1），
 * 服务端用 `requireIssueInWorkspace` 校验，不按 issue 自身工作区放行。
 */
export const addDependencySchema = z.object({
  workspace_id: z.string().trim().min(1, '缺少 workspace_id'),
  blocker_issue_id: z.string().trim().min(1, 'blocker_issue_id 不能为空'),
  // BORROW-2.1：依赖边类型；缺省 blocks（原 DEP-1 语义不变）；related/duplicate 不参与环检测
  relation: z.enum(['blocks', 'related', 'duplicate']).optional(),
  // DEC-V4-API-DEP：被挡原因（可选，≤200 字；空白由服务层归一为 NULL）
  reason: z.string().trim().max(200, '原因不能超过 200 字').optional(),
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
  .strict() // API-CONTRACT（bd3ca35d）：未知字段 400 不再静默 strip（反例：promptTemplate 拼错字段名不生效也不报错）
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
 * P1-C：会话工具管控策略（packages/adapters 契约 SessionToolPolicy 的请求形状）。
 * allow/deny 为工具名清单；approval_mode 的映射与探测在 adapters 侧。
 */
export const sessionToolPolicySchema = z.object({
  approval_mode: z.enum(['inherit', 'plan', 'acceptEdits', 'bypass']),
  allow: z.array(z.string().trim().min(1)).max(200),
  deny: z.array(z.string().trim().min(1)).max(200),
});

/**
 * PATCH /api/sessions/:id：改 model（Task 14「修改模型，下一轮生效」）、会话级 title（重命名）
 * 或 archived（CHAT-SB1 归档/恢复），BORROW-4.3 追加 paused（暂停/恢复），
 * P1-C 追加 persona 注入四字段（persona_id / tool_policy / skill_policy / persona_injection）。
 * - 字段都缺 → 400；至少提供一个。
 * - model：字符串或 null 清空。
 * - title：1–50 字符（首尾空白 trim 后判空）；null 清空自定义标题、回到派生标题。
 * - archived：true=归档（运行中由路由层 409 拒绝），false=恢复。
 * - paused：true=暂停（不 kill 在途工具/子进程，轮次结束后不再起新轮），false=恢复（消费暂停期队列）。
 *   paused 是独立互斥动作，不与其它字段同批提交，避免「先归档再暂停」这类中间态。
 * - persona_id：persona 行 id 或 null 解绑；tool_policy：SessionToolPolicy 对象或 null 清空
 *   （落库存 JSON 字符串）；skill_policy：自由对象或 null（P2 起才有消费方，本阶段只存取）；
 * - persona_injection：auto（缺省语义）/ flag（flag 注入）/ file（服务端标记块注入）/ off（全关）；null 回到 auto。
 */
export const patchSessionSchema = z
  .object({
    model: z.string().trim().min(1, 'model 不能为空').nullable().optional(),
    title: z
      .string()
      .trim()
      .min(1, 'title 不能为空')
      .max(50, 'title 不能超过 50 字')
      .nullable()
      .optional(),
    archived: z.boolean().optional(),
    paused: z.boolean().optional(),
    persona_id: z.string().trim().min(1, 'persona_id 不能为空').nullable().optional(),
    tool_policy: sessionToolPolicySchema.nullable().optional(),
    skill_policy: z.record(z.string(), z.unknown()).nullable().optional(),
    persona_injection: z.enum(['auto', 'flag', 'file', 'off']).nullable().optional(),
  })
  .refine(
    (value) =>
      value.model !== undefined
      || value.title !== undefined
      || value.archived !== undefined
      || value.paused !== undefined
      || value.persona_id !== undefined
      || value.tool_policy !== undefined
      || value.skill_policy !== undefined
      || value.persona_injection !== undefined,
    { message: '至少提供 model / title / archived / paused / persona_id / tool_policy / skill_policy / persona_injection' },
  )
  .refine(
    (value) =>
      value.paused === undefined
      || (value.model === undefined
        && value.title === undefined
        && value.archived === undefined
        && value.persona_id === undefined
        && value.tool_policy === undefined
        && value.skill_policy === undefined
        && value.persona_injection === undefined),
    { message: 'paused 不能与 model / title / archived / persona 注入字段同时提交' },
  );

/** P1-C：persona 正文上限（系统提示词体量级，与知识页 2M 口径不同——persona 是单条注入文本） */
export const PERSONA_BODY_MAX_CHARS = 100_000;

/** POST /api/personas：name / description / body_md 必填（description 允许空串） */
export const createPersonaSchema = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(100, 'name 不能超过 100 字'),
  description: z.string().max(2000, 'description 不能超过 2000 字').default(''),
  body_md: z.string().min(1, 'body_md 不能为空').max(PERSONA_BODY_MAX_CHARS, `body_md 不能超过 ${PERSONA_BODY_MAX_CHARS} 字`),
});

/** PATCH /api/personas/:id：三个字段全可选，至少提供一个 */
export const patchPersonaSchema = z
  .object({
    name: z.string().trim().min(1, 'name 不能为空').max(100, 'name 不能超过 100 字').optional(),
    description: z.string().max(2000, 'description 不能超过 2000 字').optional(),
    body_md: z.string().min(1, 'body_md 不能为空').max(PERSONA_BODY_MAX_CHARS, `body_md 不能超过 ${PERSONA_BODY_MAX_CHARS} 字`).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.body_md !== undefined, {
    message: '至少提供 name / description / body_md',
  });

/**
 * POST /api/sessions/:id/fork：从某条消息（缺省=最后一条）分叉出新会话。
 * - from_message_id：必须是源会话内的消息 id（服务端再校验归属）；
 * - title：可选改名（1–50 字，trim 后判空），缺省继承源会话标题。
 */
export const forkSessionSchema = z.object({
  from_message_id: z.string().uuid('from_message_id 必须是消息 uuid').optional(),
  title: z.string().trim().min(1, 'title 不能为空').max(50, 'title 不能超过 50 字').optional(),
});

/**
 * POST /api/sessions/:id/turns/:turnId/answer：回答 awaiting_input 轮次。
 * `option_id` / `text` 至少给一个（两者都给时由调用方语义决定，服务端只做参数校验）。
 */
export const answerTurnSchema = z
  .object({
    option_id: z.string().trim().min(1, 'option_id 不能为空').optional(),
    text: z.string().trim().min(1, 'text 不能为空').optional(),
  })
  .refine((value) => value.option_id !== undefined || value.text !== undefined, {
    message: '至少提供 option_id 或 text',
  });

/**
 * POST /api/sessions/:id/turns/:turnId/approvals/:requestId：三档确认的审批决策。
 * `decision` 只允许 allow/deny；`scope` 为三档（`once` 不落规则）。
 */
export const approvalDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'task', 'workspace']),
});

/**
 * PATCH /api/settings：端口 / DB 路径 / 并发上限全可选，至少提供一个；
 * 未知键跟随项目 schema 惯例忽略（zod 默认 strip）。
 */
/**
 * DB-2B：迁移编排请求体。
 * target_db_path 是目标库文件全路径（目录不存在会创建）；overwrite 覆盖同名目标库。
 */
export const dbMigrateSchema = z
  .object({
    target_db_path: z.string().trim().min(1, 'target_db_path 不能为空'),
    overwrite: z.boolean().optional(),
  })
  .strict();

/** STORE-2a/3a：工作区库下沉（localize）请求体；字段名与 packages/shared 的 WorkspaceLocalizeRequest 同源 */
export const workspaceLocalizeSchema = z
  .object({
    dryRun: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    /** STORE-3a：从 localize.json 记录的阶段续跑（dryRun=true 时忽略；resume=true 时忽略 overwrite） */
    resume: z.boolean().optional(),
  })
  .strict();

/** STORE-3a：cleanup / revert 请求体（当前无参数；保留 strict 空对象以便后续扩展不破坏契约） */
export const workspaceDbOpSchema = z.object({}).strict();

/** STORE-5：快照导出开关（STORE-6 增补 includeAttachments） */
export const workspaceSnapshotExportSchema = z
  .object({ includeMessages: z.boolean().optional(), includeAttachments: z.boolean().optional() })
  .strict();

/** STORE-5：快照导入（dir 缺省 <ws>/.agentboard/snapshot；replace 先 VACUUM INTO 备份） */
export const workspaceSnapshotImportSchema = z
  .object({ dir: z.string().min(1).optional(), replace: z.boolean().optional() })
  .strict();

/** BORROW-4.3：任务交接（当前占用者 → 另一个 agent；成功后 bump fence，旧 fence 立即失效） */
export const transferIssueSchema = z
  .object({
    from_agent: z.string().min(1).max(100),
    to_agent: z.string().min(1).max(100),
    reason: z.string().max(2000).optional(),
    fence: z.number().int().min(0).optional(),
    /** 跨区守卫：缺省走已解析的工作区上下文（与 claim/done 同口径） */
    workspace_id: z.string().min(1).optional(),
  })
  .strict();

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

/** SKILLS-SYNC：只收目标 id 与覆盖策略，路径一律由服务端枚举（杜绝任意路径写入） */
export const skillsSyncSchema = z
  .object({
    target_ids: z.array(z.string().trim().min(1)).min(1, '至少选择一个目标目录').max(16),
    conflict: z.enum(['overwrite', 'skip', 'backup']).optional(),
    workspace_id: z.string().min(1).optional(),
  })
  .strict();
