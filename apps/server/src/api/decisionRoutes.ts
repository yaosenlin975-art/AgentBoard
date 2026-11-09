import { Router } from 'express';
import { z } from 'zod';
import type { DecisionEvent, ServerWsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import {
  ackStop,
  countDecisions,
  getDecisionDetail,
  getStopState,
  listDecisions,
  type DecisionCounts,
} from '../db/repos/decision.js';
import {
  answerPendingDecision,
  createPendingDecision,
  undoDecision,
  withdrawPendingDecision,
  type CreateDecisionInput,
} from '../services/decision.js';
import { extendDecisionGrace } from '../services/decisionGrace.js';
import { assertFenceCurrent } from '../services/claim.js';
import { getRole, listWorkspacesForActor, type WorkspaceRole } from '../db/repos/workspaceMember.js';
import {
  assertWorkspaceRole,
  decisionCapabilities,
  resolveActor,
  roleCapabilities,
} from '../services/permission.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';

/**
 * DEC-3：决策 REST（设计 v3 §5.2）。
 *
 * 路径（挂到 /api 下）：
 *   POST /issues/:id/ask                 agent 提问（必须持有效 claim + fence）
 *   GET  /decisions                      列表（按 workspace_id/issue_id/state 过滤）+ 计数
 *   GET  /decisions/:id                  详情（选项 + 全部答案 revision + 剩余宽限）
 *   POST /decisions/:id/answer           人类回答（可带 expected_revision 修订）
 *   POST /decisions/:id/withdraw         人类/提问者撤回
 *   POST /decisions/:id/undo             6 秒内撤销回答（DEC-V4-UNDO-SERVER，服务端真回滚）
 *   POST /decisions/:id/extend           延长宽限（DEC-V4-API-EXTEND）
 *   GET  /issues/:id/stop                DEC-9 停止信号只读窗口（agent 2 秒级轮询）
 *   POST /issues/:id/stop-ack            agent 确认已停在检查点
 *   GET  /workspaces/:workspaceId/decisions/count
 *
 * 状态码口径：400 参数非法 / 404 不存在 / 409 冲突（DECISION_ALREADY_OPEN、DECISION_LOCKED、STALE_FENCE、
 * DECISION_ALREADY_ANSWERED、DECISION_REVISION_CONFLICT、DECISION_WITHDRAWN、DECISION_NOT_GRACE、
 * EXTEND_LIMIT_EXCEEDED、UNDO_WINDOW_EXPIRED、UNDO_NOT_ANSWERED、UNDO_CLAIMED_AFTER_LOCK、
 * UNDO_FORBIDDEN_ACTOR）/ 403 非提问者撤回、跨区延长。
 * 请求 schema 暂时落在本文件，待 routes.ts/schemas.ts 的他人未提交改动释放后迁入 schemas.ts。
 */

export interface DecisionRouterDeps {
  db: Db;
  /** WS 广播；缺省时静默（单测可注入 spy） */
  broadcast?: (event: ServerWsEvent) => void;
  /**
   * CR2-1：决策数据已随区下沉到工作区库，业务读写必须走「该工作区实际所在的库」。
   * 三个解析器缺省时回中心库（单测最小装配 / 未下沉区行为不变）。
   * 注意：权限（workspace_member / 角色）始终读中心库，不随此解析器漂移。
   */
  dbForWorkspace?: (workspaceId: string) => Db;
  locateIssueDb?: (issueId: string) => Db | null;
  locateDecisionDb?: (decisionId: string) => Db | null;
}

/** 频率限制（设计 v3 §3.3 手段 2/3）：同 agent 同工作区在途 ≤3、每小时新建 ≤6 */
const RATE_IN_FLIGHT_MAX = 3;
const RATE_PER_HOUR_MAX = 6;
const RATE_WINDOW_MS = 3600 * 1000;

const TRIGGERS = ['blocked', 'scope_change', 'irreversible', 'missing_input'] as const;
const ON_EXPIRE = ['stay_locked', 'unlock_default'] as const;

const askSchema = z.object({
  agent_id: z.string().min(1),
  // 与 BORROW-0.3 一致：缺省=软模式放行；传了就必须等于当前 claim_fence
  fence: z.number().int().optional(),
  question: z.string().min(1),
  context_md: z.string().optional(),
  trigger: z.enum(TRIGGERS).optional(),
  // 区间校验在服务层做：越界必须返回 400 INVALID_GRACE（zod 原生报错码不同）
  grace_seconds: z.number().optional(),
  options: z.array(
    z.object({
      label: z.string().min(1),
      consequence: z.string().min(1),
      is_default: z.boolean().optional(),
    }),
  ),
  checkpoint: z.unknown().optional(),
  expires_at: z.number().optional(),
  on_expire: z.enum(ON_EXPIRE).optional(),
});

const answerSchema = z.object({
  option_id: z.string().optional(),
  option_ord: z.number().int().optional(),
  answer_text: z.string().optional(),
  expected_revision: z.number().int().optional(),
  answered_by: z.string().optional(),
  source: z.enum(['web', 'cli']).optional(),
});

const withdrawSchema = z.object({
  by: z.string().min(1).optional(),
  reason: z.string().min(1),
});

/** DEC-V4-API-EXTEND：seconds 的整数/区间校验在服务层（错误码必须是 INVALID_SECONDS） */
const extendSchema = z.object({
  seconds: z.unknown().optional(),
  by: z.string().min(1).optional(),
  fence: z.number().int().optional(),
  workspace_id: z.string().min(1).optional(),
});

/** DEC-V4-UNDO-SERVER：by / expected_revision 的合法性在服务层（错误码必须是 VALIDATION_ERROR） */
const undoSchema = z.object({
  by: z.unknown().optional(),
  expected_revision: z.unknown().optional(),
});

const listQuerySchema = z.object({
  workspace_id: z.string().optional(),
  /** PERM-2：`scope=accessible` 返回调用者有成员关系的全部工作区 */
  scope: z.enum(['accessible']).optional(),
  /** PERM-2：逗号分隔的多区查询；逐区校验，无权限的区直接跳过 */
  workspace_ids: z.string().optional(),
  issue_id: z.string().optional(),
  state: z.enum(['grace', 'open', 'answered', 'withdrawn']).optional(),
  /** DEC-8 卡面口径 `stale=1`；兼容 DEC-3/CLI 已有的 `stale=true` */
  stale: z.enum(['true', 'false', '1', '0']).optional(),
  limit: z.string().optional(),
});

const statsQuerySchema = z.object({
  days: z.string().optional(),
});

function zodInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ValidationError(`参数不合法：${first?.path.join('.') || '(body)'} ${first?.message ?? ''}`.trim());
  }
  return result.data;
}

function emit(deps: DecisionRouterDeps, event: DecisionEvent): void {
  deps.broadcast?.(event);
}

/** DEC-8 统计：中位数（空集返回 null；偶数取中间两值均值并取整秒） */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** PERM-2：多区查询的 counts = 逐区之和（与单区 `?workspace_id=` 同源） */
function sumCounts(items: DecisionCounts[]): DecisionCounts {
  return items.reduce<DecisionCounts>(
    (acc, item) => ({
      grace: acc.grace + item.grace,
      open: acc.open + item.open,
      stale_open: acc.stale_open + item.stale_open,
      answered_recent: acc.answered_recent + item.answered_recent,
    }),
    { grace: 0, open: 0, stale_open: 0, answered_recent: 0 },
  );
}

/** PERM-2：多区响应的能力投影取调用者在这些区里的最高角色，避免低估 */
function highestRole(db: Db, workspaceIds: string[], actorId: string): WorkspaceRole | null {
  const rank: Record<WorkspaceRole, number> = { viewer: 1, member: 2, owner: 3 };
  let best: WorkspaceRole | null = null;
  for (const workspaceId of workspaceIds) {
    const role = getRole(db, workspaceId, actorId);
    if (role !== null && (best === null || rank[role] > rank[best])) best = role;
  }
  return best;
}

/** PERM-2：当前答案的回答者（未回答 / 已撤销 → null），能力投影用 */
function currentAnswerBy(decision: {
  current_answer_id: string | null;
  answers?: Array<{ id: string; answered_by: string }>;
  current_answer_by?: string | null;
}): string | null {
  if (decision.answers !== undefined) {
    return decision.answers.find((answer) => answer.id === decision.current_answer_id)?.answered_by ?? null;
  }
  return decision.current_answer_by ?? null;
}

/** 卡面锁标识走既有 issue.changed（§5.3）：读最新投影后原样广播，前端无需新事件名 */
function emitIssueChanged(deps: DecisionRouterDeps, issueId: string, db: Db = deps.db): void {
  const issue = getIssue(db, issueId);
  if (issue) deps.broadcast?.({ type: 'issue.changed', issue });
}

function decisionEvent(
  type: DecisionEvent['type'],
  decision: {
    id: string;
    workspace_id: string;
    issue_id: string;
    state: DecisionEvent['state'];
    grace_until: number | null;
  },
  extra: Partial<
    Pick<
      DecisionEvent,
      | 'revision'
      | 'grace_until'
      | 'reason'
      | 'extended_seconds'
      | 'extension_count'
      | 'reverted_to'
      | 'last_undone_revision'
      | 'undo_deadline_at'
    >
  > = {},
): DecisionEvent {
  return {
    type,
    workspace_id: decision.workspace_id,
    issue_id: decision.issue_id,
    decision_id: decision.id,
    state: decision.state,
    ...extra,
  };
}

/**
 * 提问前置（设计 v3 §3.3 手段 2：先判占用者+fence，再判状态）：
 * - 未占用 / 他人占用 → 409 NOT_TASK_OWNER
 * - 状态非进行中 → 409 ISSUE_STATUS_NOT_RUNNING
 * - 旧 fence → 409 STALE_FENCE（统一走 claim.ts 的 fence 校验）
 */
function requireAskOwnership(db: Db, issueId: string, agentId: string, fence: number | undefined) {
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (!issue.claimed_by) {
    throw new ApiError(409, 'NOT_TASK_OWNER', `任务「${issue.title}」当前未被占用，不能提问：先 claim 再 ask`);
  }
  if (issue.claimed_by !== agentId) {
    throw new ApiError(409, 'NOT_TASK_OWNER', `任务「${issue.title}」由 ${issue.claimed_by} 占用，${agentId} 不能提问`);
  }
  if (issue.status !== '进行中') {
    throw new ApiError(409, 'ISSUE_STATUS_NOT_RUNNING', `任务「${issue.title}」状态为「${issue.status}」，仅进行中可提问`);
  }
  assertFenceCurrent(db, issueId, fence);
  return issue;
}

/** 选项结构（§3.3 手段 2 #3）：≥2、label/consequence 非空、label 不重复；拒绝码 ASK_TOO_FEW_OPTIONS */
function assertAskOptions(options: Array<{ label: string; consequence: string }>): void {
  if (options.length < 2) {
    throw new ApiError(400, 'ASK_TOO_FEW_OPTIONS', `至少需要 2 个选项（收到 ${options.length} 个）`);
  }
  const labels = new Set<string>();
  for (const option of options) {
    const label = option.label.trim();
    const consequence = option.consequence.trim();
    if (!label || !consequence) {
      throw new ApiError(400, 'ASK_TOO_FEW_OPTIONS', '每个选项必须有非空 label 与 consequence');
    }
    if (labels.has(label)) {
      throw new ApiError(400, 'ASK_TOO_FEW_OPTIONS', `选项 label 重复：${label}`);
    }
    labels.add(label);
  }
}

/**
 * 频率限制（§3.3 手段 2 #5）。预检在本路由、建决策在 services/decision.ts（本卡禁改，见卡评论）：
 * 并发窗口内可能多放一条，属于可接受的窄竞态。
 */
function assertAskRateLimit(db: Db, workspaceId: string, agentId: string): void {
  const inFlight = db
    .prepare(
      `SELECT COUNT(*) AS n FROM issue_decision
       WHERE workspace_id=? AND created_by=? AND state IN ('grace','open')`,
    )
    .get(workspaceId, agentId) as { n: number };
  if (inFlight.n >= RATE_IN_FLIGHT_MAX) {
    throw new ApiError(
      429,
      'ASK_RATE_LIMITED',
      `同一 agent 同工作区最多 ${RATE_IN_FLIGHT_MAX} 条在途决策，当前已有 ${inFlight.n} 条；先回答或撤回再提问`,
    );
  }
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM issue_decision
       WHERE workspace_id=? AND created_by=? AND created_at > ?`,
    )
    .get(workspaceId, agentId, Date.now() - RATE_WINDOW_MS) as { n: number };
  if (recent.n >= RATE_PER_HOUR_MAX) {
    throw new ApiError(
      429,
      'ASK_RATE_LIMITED',
      `同一 agent 每小时最多 ${RATE_PER_HOUR_MAX} 条新决策（当前 1 小时内 ${recent.n} 条），请冷却后再提问`,
    );
  }
}

export function createDecisionRouter(deps: DecisionRouterDeps): Router {
  const router = Router();

  /** CR2-1：业务库解析（决策/轮次/审批规则随工作区下沉；权限判定仍用 deps.db 中心库） */
  const dbOfWorkspace = (workspaceId: string): Db => deps.dbForWorkspace?.(workspaceId) ?? deps.db;
  const dbOfIssue = (issueId: string): Db | null => {
    if (deps.locateIssueDb !== undefined) return deps.locateIssueDb(issueId);
    return getIssue(deps.db, issueId) === null ? null : deps.db;
  };
  const findDecision = (decisionId: string): { db: Db; decision: NonNullable<ReturnType<typeof getDecisionDetail>> } | null => {
    if (deps.locateDecisionDb !== undefined) {
      const hit = deps.locateDecisionDb(decisionId);
      if (hit === null) return null;
      const decision = getDecisionDetail(hit, decisionId);
      return decision === null ? null : { db: hit, decision };
    }
    const decision = getDecisionDetail(deps.db, decisionId);
    return decision === null ? null : { db: deps.db, decision };
  };

  router.post('/issues/:id/ask', (req, res) => {
    const issueId = String(req.params.id);
    const body = zodInput(askSchema, req.body);
    const actor = resolveActor(req);
    // CR2-1：任务/决策/审批规则读写走任务所在库；成员角色仍读中心库
    const businessDb = dbOfIssue(issueId);
    const target = businessDb === null ? null : getIssue(businessDb, issueId);
    if (businessDb === null || target === null) throw new NotFoundError('任务不存在');
    // PERM-2：提问者（身份头）必须是目标工作区 member/owner；claim/fence 校验仍按 body.agent_id
    assertWorkspaceRole(deps.db, target.workspace_id, actor, 'member');
    const issue = requireAskOwnership(businessDb, issueId, body.agent_id, body.fence);
    assertAskOptions(body.options);
    assertAskRateLimit(businessDb, issue.workspace_id, body.agent_id);
    const input: CreateDecisionInput = {
      workspace_id: issue.workspace_id,
      issue_id: issueId,
      created_by: body.agent_id,
      question: body.question,
      created_fence: body.fence,
      options: body.options,
      ...(body.context_md === undefined ? {} : { context_md: body.context_md }),
      ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
      ...(body.grace_seconds === undefined ? {} : { grace_seconds: body.grace_seconds }),
      ...(body.checkpoint === undefined ? {} : { checkpoint: body.checkpoint }),
      ...(body.expires_at === undefined ? {} : { expires_at: body.expires_at }),
      ...(body.on_expire === undefined ? {} : { on_expire: body.on_expire }),
    };
    const result = createPendingDecision(businessDb, input);
    if (result.locked) {
      // §4.3.1：grace=0 立即落锁 → decision.expired + issue.stop_requested（与宽限到期同一套事件）
      emit(deps, decisionEvent('decision.expired', result.decision, { grace_until: null, reason: 'grace_zero' }));
      emit(
        deps,
        decisionEvent('issue.stop_requested', result.decision, { grace_until: null, reason: 'grace_zero' }),
      );
    } else {
      emit(
        deps,
        decisionEvent('decision.grace_started', result.decision, { grace_until: result.decision.grace_until }),
      );
    }
    emitIssueChanged(deps, issueId, businessDb);
    res.status(201).json({ decision: result.decision });
  });

  router.get('/decisions', (req, res) => {
    const query = zodInput(listQuerySchema, req.query);
    const actor = resolveActor(req);
    const states = query.state === undefined ? undefined : [query.state];
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new ValidationError('limit 不合法');

    // PERM-2：单区（兼容旧 Web/CLI）→ 需 viewer；scope=accessible → 只聚合有成员关系的区；
    // workspace_ids=a,b → 逐区校验并跳过无权限区（不整体 403，避免一个区拖垮整页）。
    let workspaceIds: string[];
    if (query.workspace_id !== undefined) {
      assertWorkspaceRole(deps.db, query.workspace_id, actor, 'viewer');
      workspaceIds = [query.workspace_id];
    } else if (query.scope === 'accessible') {
      const accessible = listWorkspacesForActor(deps.db, actor);
      if (accessible.length === 0) {
        throw new ApiError(403, 'WORKSPACE_FORBIDDEN', `身份 ${actor} 没有任何可访问的工作区`);
      }
      workspaceIds = accessible.map((workspace) => workspace.id);
    } else if (query.workspace_ids !== undefined) {
      const requested = [
        ...new Set(
          query.workspace_ids
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        ),
      ];
      if (requested.length === 0) {
        throw new ValidationError('workspace_ids 不合法（需逗号分隔的工作区 id）');
      }
      workspaceIds = requested.filter((id) => getRole(deps.db, id, actor) !== null);
    } else {
      throw new ValidationError('workspace_id 必填（或用 scope=accessible / workspace_ids）');
    }

    // CR2-1：决策随区下沉 → 逐区到各自库取数后合并，再按「全局最近 limit 条」截断
    const staleBefore =
      query.stale === 'true' || query.stale === '1' ? Date.now() - 72 * 3600 * 1000 : undefined;
    const perWorkspace = workspaceIds.map((workspaceId) => {
      const rdb = dbOfWorkspace(workspaceId);
      return {
        items: listDecisions(rdb, {
          workspace_ids: [workspaceId],
          ...(query.issue_id === undefined ? {} : { issue_id: query.issue_id }),
          ...(states === undefined ? {} : { states }),
          ...(staleBefore === undefined ? {} : { stale_before: staleBefore }),
          ...(limit === undefined ? {} : { limit }),
        }),
        counts: countDecisions(rdb, workspaceId),
      };
    });
    const merged = perWorkspace
      .flatMap((entry) => entry.items)
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    const items = limit === undefined ? merged : merged.slice(0, limit);
    const roleByWorkspace = new Map<string, WorkspaceRole | null>();
    for (const workspaceId of workspaceIds) roleByWorkspace.set(workspaceId, getRole(deps.db, workspaceId, actor));
    res.json({
      decisions: items.map((item) => ({
        ...item,
        capabilities: decisionCapabilities(roleByWorkspace.get(item.workspace_id) ?? null, actor, {
          state: item.state,
          current_answer_by: currentAnswerBy(item),
        }),
      })),
      counts: sumCounts(perWorkspace.map((entry) => entry.counts)),
      capabilities: roleCapabilities(highestRole(deps.db, workspaceIds, actor)),
    });
  });

  router.get('/decisions/:id', (req, res) => {
    const actor = resolveActor(req);
    const hit = findDecision(String(req.params.id));
    if (hit === null) throw new NotFoundError('决策不存在');
    const decision = hit.decision;
    const role = assertWorkspaceRole(deps.db, decision.workspace_id, actor, 'viewer');
    res.json({
      decision: {
        ...decision,
        capabilities: decisionCapabilities(role, actor, {
          state: decision.state,
          current_answer_by: currentAnswerBy(decision),
        }),
      },
    });
  });

  router.post('/decisions/:id/answer', (req, res) => {
    const body = zodInput(answerSchema, req.body);
    const actor = resolveActor(req);
    const existingHit = findDecision(String(req.params.id));
    if (existingHit === null) throw new NotFoundError('决策不存在');
    const existing = existingHit.decision;
    // PERM-2：回答/修订要求 member+；member 只能修订本人答案，owner 可管理他人答案
    const role = assertWorkspaceRole(deps.db, existing.workspace_id, actor, 'member');
    if (existing.state === 'answered' && body.expected_revision !== undefined && role !== 'owner') {
      if (currentAnswerBy(existing) !== actor) {
        throw new ApiError(403, 'ROLE_FORBIDDEN', `当前身份 ${actor} 只能修订本人答案（角色 ${role}）`);
      }
    }
    const decision = answerPendingDecision(existingHit.db, {
      decision_id: String(req.params.id),
      source: body.source ?? 'web',
      ...(body.option_id === undefined ? {} : { option_id: body.option_id }),
      ...(body.option_ord === undefined ? {} : { option_ord: body.option_ord }),
      ...(body.answer_text === undefined ? {} : { answer_text: body.answer_text }),
      ...(body.expected_revision === undefined ? {} : { expected_revision: body.expected_revision }),
      ...(body.answered_by === undefined ? {} : { answered_by: body.answered_by }),
    });
    emit(
      deps,
      decisionEvent(decision.answer_revision > 1 ? 'decision.revised' : 'decision.answered', decision, {
        revision: decision.answer_revision,
        grace_until: null,
      }),
    );
    emitIssueChanged(deps, decision.issue_id, existingHit.db);
    res.json({ decision });
  });

  router.post('/decisions/:id/withdraw', (req, res) => {
    const body = zodInput(withdrawSchema, req.body);
    const actor = resolveActor(req);
    const existingHit = findDecision(String(req.params.id));
    if (existingHit === null) throw new NotFoundError('决策不存在');
    // PERM-2：撤回决策仅 owner（member / viewer 一律 ROLE_FORBIDDEN）
    assertWorkspaceRole(deps.db, existingHit.decision.workspace_id, actor, 'owner');
    const decision = withdrawPendingDecision(existingHit.db, {
      decision_id: String(req.params.id),
      by: body.by ?? 'user',
      reason: body.reason,
    });
    emit(deps, decisionEvent('decision.withdrawn', decision, { grace_until: null }));
    emitIssueChanged(deps, decision.issue_id, existingHit.db);
    res.json({ decision });
  });

  router.post('/decisions/:id/undo', (req, res) => {
    const body = zodInput(undoSchema, req.body);
    const actor = resolveActor(req);
    const existingHit = findDecision(String(req.params.id));
    if (existingHit === null) throw new ApiError(404, 'DECISION_NOT_FOUND', '决策不存在');
    const existing = existingHit.decision;
    // PERM-2：撤销回答要求 member+；member 只能撤销本人答案，owner 可管理他人答案。
    // 6 秒窗口 / expected_revision / UNDO_CLAIMED_AFTER_LOCK 仍由服务层状态校验。
    const role = assertWorkspaceRole(deps.db, existing.workspace_id, actor, 'member');
    if (existing.state === 'answered' && role !== 'owner' && currentAnswerBy(existing) !== actor) {
      throw new ApiError(403, 'ROLE_FORBIDDEN', `当前身份 ${actor} 只能撤销本人答案（角色 ${role}）`);
    }
    const result = undoDecision(existingHit.db, {
      decision_id: String(req.params.id),
      by: typeof body.by === 'string' ? body.by : '',
      expected_revision: typeof body.expected_revision === 'number' ? body.expected_revision : Number.NaN,
    });
    // 幂等重放：不重复广播（网络重试安全）
    if (!result.already_undone) {
      emit(
        deps,
        decisionEvent('decision.undone', result.decision, {
          reverted_to: result.reverted_to,
          last_undone_revision: result.decision.last_undone_revision ?? undefined,
          ...(result.decision.undo_until === null ? {} : { undo_deadline_at: result.decision.undo_until }),
        }),
      );
      emitIssueChanged(deps, result.decision.issue_id, existingHit.db);
    }
    res.json({
      decision: result.decision,
      reverted_to: result.reverted_to,
      undo_window_ms: result.undo_window_ms,
      already_undone: result.already_undone,
    });
  });

  router.post('/decisions/:id/extend', (req, res) => {
    const body = zodInput(extendSchema, req.body);
    const actor = resolveActor(req);
    const existingHit = findDecision(String(req.params.id));
    if (existingHit === null) throw new ApiError(404, 'DECISION_NOT_FOUND', '决策不存在');
    // PERM-2：延长宽限要求 member+（viewer / 匿名 403）；跨区 workspace_id 守卫仍在服务层
    assertWorkspaceRole(deps.db, existingHit.decision.workspace_id, actor, 'member');
    const result = extendDecisionGrace(existingHit.db, {
      decision_id: String(req.params.id),
      seconds: body.seconds,
      ...(body.by === undefined ? {} : { by: body.by }),
      ...(body.fence === undefined ? {} : { fence: body.fence }),
      ...(body.workspace_id === undefined ? {} : { workspace_id: body.workspace_id }),
    });
    emit(
      deps,
      decisionEvent('decision.extended', result.decision, {
        grace_until: result.grace_until,
        extended_seconds: result.extended_seconds,
        extension_count: result.extension_count,
      }),
    );
    emitIssueChanged(deps, result.decision.issue_id, existingHit.db);
    res.json({
      decision_id: result.decision.id,
      state: result.decision.state,
      grace_until: result.grace_until,
      remaining_grace_seconds: result.remaining_grace_seconds,
      extended_seconds: result.extended_seconds,
      extension_count: result.extension_count,
      max_extend_seconds: result.max_extend_seconds,
    });
  });

  router.get('/issues/:id/stop', (req, res) => {
    const issueId = String(req.params.id);
    const rdb = dbOfIssue(issueId);
    if (rdb === null || !getIssue(rdb, issueId)) throw new NotFoundError('任务不存在');
    res.json({ issue_id: issueId, ...getStopState(rdb, issueId) });
  });

  router.post('/issues/:id/stop-ack', (req, res) => {
    const issueId = String(req.params.id);
    const rdb = dbOfIssue(issueId);
    if (rdb === null || !getIssue(rdb, issueId)) throw new NotFoundError('任务不存在');
    // §5.2：stop-ack 仅观测（写 stop_ack_at），不影响锁，也不额外发明事件名
    ackStop(rdb, issueId, Date.now());
    res.json({ issue_id: issueId, ...getStopState(rdb, issueId) });
  });

  router.get('/workspaces/:workspaceId/decisions/count', (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    res.json(countDecisions(dbOfWorkspace(workspaceId), workspaceId));
  });

  /**
   * DEC-8：统计端点（设计 §3.3 手段 4）。口径：
   * - 窗口 `days`（默认 7，1–365）按 `created_at` 截取；
   * - 回答率 = 窗口内新建中 state='answered' 的比例（撤回/未回答都算未回答）；
   * - 中位等待 = 窗口内已回答决策的 `answered_at - created_at`（秒），空集为 null；
   * - 分布按 `created_by`（agent）与 `trigger`；
   * - 额外给当前快照（grace/open/stale_open/answered_recent），数值与 `/decisions/count` 同源。
   * 供后续 `kb decisions --stats` 消费（本卡目标文件集不含 packages/cli，CLI 侧留给后续卡）。
   */
  router.get('/workspaces/:workspaceId/decisions/stats', (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const query = zodInput(statsQuerySchema, req.query);
    const days = query.days === undefined ? 7 : Number(query.days);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new ValidationError('days 需为 1–365 的整数');
    const now = Date.now();
    const since = now - days * 24 * 3600 * 1000;
    // CR2-1：统计口径与决策数据同库（随区下沉）
    const statsDb = dbOfWorkspace(workspaceId);
    const created = (statsDb
      .prepare('SELECT COUNT(*) AS n FROM issue_decision WHERE workspace_id=? AND created_at>=?')
      .get(workspaceId, since) as { n: number }).n;
    const answered = (statsDb
      .prepare(
        `SELECT COUNT(*) AS n FROM issue_decision
          WHERE workspace_id=? AND created_at>=? AND state='answered' AND answered_at IS NOT NULL`,
      )
      .get(workspaceId, since) as { n: number }).n;
    const waits = (statsDb
      .prepare(
        `SELECT (answered_at - created_at) AS wait_ms FROM issue_decision
          WHERE workspace_id=? AND created_at>=? AND state='answered' AND answered_at IS NOT NULL`,
      )
      .all(workspaceId, since) as Array<{ wait_ms: number }>).map((row) => row.wait_ms);
    const byAgent = (statsDb
      .prepare(
        `SELECT created_by AS agent_id,
                COUNT(*) AS created,
                SUM(CASE WHEN state='answered' THEN 1 ELSE 0 END) AS answered
           FROM issue_decision WHERE workspace_id=? AND created_at>=?
          GROUP BY created_by ORDER BY created DESC, agent_id ASC`,
      )
      .all(workspaceId, since) as Array<{ agent_id: string; created: number; answered: number | null }>);
    const byTrigger = (statsDb
      .prepare(
        `SELECT trigger, COUNT(*) AS count FROM issue_decision
          WHERE workspace_id=? AND created_at>=?
          GROUP BY trigger ORDER BY count DESC, trigger ASC`,
      )
      .all(workspaceId, since) as Array<{ trigger: string; count: number }>);
    res.json({
      workspace_id: workspaceId,
      window_days: days,
      since,
      created,
      answered,
      answer_rate: created === 0 ? null : Number((answered / created).toFixed(3)),
      median_wait_seconds: median(waits) === null ? null : Math.round((median(waits) as number) / 1000),
      by_agent: byAgent.map((row) => ({ agent_id: row.agent_id, created: row.created, answered: row.answered ?? 0 })),
      by_trigger: byTrigger,
      open: countDecisions(statsDb, workspaceId, now),
    });
  });

  return router;
}
