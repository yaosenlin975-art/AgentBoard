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
} from '../db/repos/decision.js';
import {
  answerPendingDecision,
  createPendingDecision,
  withdrawPendingDecision,
  type CreateDecisionInput,
} from '../services/decision.js';
import { assertFenceCurrent } from '../services/claim.js';
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
 *   GET  /issues/:id/stop                DEC-9 停止信号只读窗口（agent 2 秒级轮询）
 *   POST /issues/:id/stop-ack            agent 确认已停在检查点
 *   GET  /workspaces/:workspaceId/decisions/count
 *
 * 状态码口径：400 参数非法 / 404 不存在 / 409 冲突（DECISION_ALREADY_OPEN、DECISION_LOCKED、STALE_FENCE、
 * DECISION_ALREADY_ANSWERED、DECISION_REVISION_CONFLICT、DECISION_WITHDRAWN）/ 403 非提问者撤回。
 * 请求 schema 暂时落在本文件，待 routes.ts/schemas.ts 的他人未提交改动释放后迁入 schemas.ts。
 */

export interface DecisionRouterDeps {
  db: Db;
  /** WS 广播；缺省时静默（单测可注入 spy） */
  broadcast?: (event: ServerWsEvent) => void;
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

const listQuerySchema = z.object({
  workspace_id: z.string().optional(),
  issue_id: z.string().optional(),
  state: z.enum(['grace', 'open', 'answered', 'withdrawn']).optional(),
  stale: z.enum(['true', 'false']).optional(),
  limit: z.string().optional(),
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

/** 卡面锁标识走既有 issue.changed（§5.3）：读最新投影后原样广播，前端无需新事件名 */
function emitIssueChanged(deps: DecisionRouterDeps, issueId: string): void {
  const issue = getIssue(deps.db, issueId);
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
  extra: Partial<Pick<DecisionEvent, 'revision' | 'grace_until' | 'reason'>> = {},
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

  router.post('/issues/:id/ask', (req, res) => {
    const issueId = String(req.params.id);
    const body = zodInput(askSchema, req.body);
    const issue = requireAskOwnership(deps.db, issueId, body.agent_id, body.fence);
    assertAskOptions(body.options);
    assertAskRateLimit(deps.db, issue.workspace_id, body.agent_id);
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
    const result = createPendingDecision(deps.db, input);
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
    emitIssueChanged(deps, issueId);
    res.status(201).json({ decision: result.decision });
  });

  router.get('/decisions', (req, res) => {
    const query = zodInput(listQuerySchema, req.query);
    if (!query.workspace_id) throw new ValidationError('workspace_id 必填');
    const states = query.state === undefined ? undefined : [query.state];
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new ValidationError('limit 不合法');
    const items = listDecisions(deps.db, {
      workspace_id: query.workspace_id,
      ...(query.issue_id === undefined ? {} : { issue_id: query.issue_id }),
      ...(states === undefined ? {} : { states }),
      ...(query.stale === 'true' ? { stale_before: Date.now() - 72 * 3600 * 1000 } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
    res.json({ decisions: items, counts: countDecisions(deps.db, query.workspace_id) });
  });

  router.get('/decisions/:id', (req, res) => {
    const decision = getDecisionDetail(deps.db, String(req.params.id));
    if (!decision) throw new NotFoundError('决策不存在');
    res.json({ decision });
  });

  router.post('/decisions/:id/answer', (req, res) => {
    const body = zodInput(answerSchema, req.body);
    const decision = answerPendingDecision(deps.db, {
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
    emitIssueChanged(deps, decision.issue_id);
    res.json({ decision });
  });

  router.post('/decisions/:id/withdraw', (req, res) => {
    const body = zodInput(withdrawSchema, req.body);
    const decision = withdrawPendingDecision(deps.db, {
      decision_id: String(req.params.id),
      by: body.by ?? 'user',
      reason: body.reason,
    });
    emit(deps, decisionEvent('decision.withdrawn', decision, { grace_until: null }));
    emitIssueChanged(deps, decision.issue_id);
    res.json({ decision });
  });

  router.get('/issues/:id/stop', (req, res) => {
    const issueId = String(req.params.id);
    if (!getIssue(deps.db, issueId)) throw new NotFoundError('任务不存在');
    res.json({ issue_id: issueId, ...getStopState(deps.db, issueId) });
  });

  router.post('/issues/:id/stop-ack', (req, res) => {
    const issueId = String(req.params.id);
    if (!getIssue(deps.db, issueId)) throw new NotFoundError('任务不存在');
    // §5.2：stop-ack 仅观测（写 stop_ack_at），不影响锁，也不额外发明事件名
    ackStop(deps.db, issueId, Date.now());
    res.json({ issue_id: issueId, ...getStopState(deps.db, issueId) });
  });

  router.get('/workspaces/:workspaceId/decisions/count', (req, res) => {
    res.json(countDecisions(deps.db, String(req.params.workspaceId)));
  });

  return router;
}
