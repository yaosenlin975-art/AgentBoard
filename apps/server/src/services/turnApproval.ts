import { randomUUID } from 'node:crypto';
import type {
  ApprovalRule,
  ApprovalScope,
  ServerWsEvent,
  SessionTurn,
  TurnApprovalInfo,
  TurnPlanStep,
} from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { getSession } from '../db/repos/session.js';
import { getTurn, updateTurn } from '../db/repos/sessionTurn.js';
import { getIssue } from '../db/repos/issue.js';
import {
  createApprovalRule,
  findActiveTaskRule,
  findActiveWorkspaceRule,
} from '../db/repos/approvalRule.js';
import { isClosedStatusName } from './workspaceStatus.js';
import { markTurnAwaiting } from './turnAwaiting.js';

/**
 * CHAT-APP1（契约 #9/#14/#20）：三档确认的规则解析 + 请求 + 决策。
 *
 * 与 CHAT-AWAIT1 的分工：暂停通道（`markTurnAwaiting`）与心跳/超时完全复用；
 * 本模块只增量「规则表 + scope 解析 + 决策后的状态收口」。
 */

/** 首版工作区档只对只读工具开放；写类工具必须走 `task` 或 `once` */
export const APPROVAL_READ_ONLY_TOOLS = ['Read', 'Grep', 'List'] as const;

export function isReadOnlyApprovalTool(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  return APPROVAL_READ_ONLY_TOOLS.some((item) => item.toLowerCase() === normalized);
}

/** 规则匹配键：工具名与目标都做稳定化（工具小写），避免大小写差异导致规则不命中 */
export function approvalMatchKey(tool: string, target: string): string {
  return `${tool.trim().toLowerCase()}::${target.trim()}`;
}

export interface ResolveApprovalRuleInput {
  workspace_id: string;
  issue_id: string | null;
  tool_name: string;
  match_key: string;
}

/**
 * 精确匹配顺序：`task`（且 issue 仍存活）优先；其次 `workspace`（仅只读工具）。
 * 任务结束（关闭类状态）后 task 规则自动失效——不依赖定时清理，读取时判定。
 */
export function resolveApprovalRule(db: Db, input: ResolveApprovalRuleInput): ApprovalRule | null {
  if (input.issue_id) {
    const taskRule = findActiveTaskRule(db, {
      workspace_id: input.workspace_id,
      issue_id: input.issue_id,
      tool_name: input.tool_name,
      match_key: input.match_key,
    });
    if (taskRule) {
      const issue = getIssue(db, input.issue_id, input.workspace_id);
      if (issue && !isClosedStatusName(db, input.workspace_id, issue.status)) return taskRule;
    }
  }
  if (!isReadOnlyApprovalTool(input.tool_name)) return null;
  return findActiveWorkspaceRule(db, {
    workspace_id: input.workspace_id,
    tool_name: input.tool_name,
    match_key: input.match_key,
  });
}

export interface ApprovalRequestInput {
  tool: string;
  target: string;
  risk: string;
  /** 可选：请求方给出的稳定匹配键；缺省按 `tool::target` 推导 */
  match_key?: string;
}

export interface ApprovalRequestResult {
  /** 命中已有规则：直接放行，轮次保持 running，不落 awaiting、不推审批事件 */
  auto_allowed: boolean;
  rule: ApprovalRule | null;
  turn: SessionTurn;
  /** 未命中时生成的请求 id；auto_allowed 时为 null */
  request_id: string | null;
}

export interface ApprovalDeps {
  broadcast: (event: ServerWsEvent) => void;
}

/**
 * 危险工具请求入口：命中规则 → 自动放行；未命中 → 进入 `awaiting_approval` 并推 `session.approval_request`。
 * 轮次必须存在且属于该会话（否则 404），且当前处于 running（否则 409）——避免对已阻塞/已收口的轮次重复弹审批。
 */
export function requestTurnApproval(
  db: Db,
  deps: ApprovalDeps,
  sessionId: string,
  turnId: string,
  input: ApprovalRequestInput,
): ApprovalRequestResult {
  const session = getSession(db, sessionId);
  if (!session) throw new NotFoundError('会话不存在');
  const turn = getTurn(db, turnId);
  if (!turn || turn.session_id !== sessionId) throw new NotFoundError('轮次不存在');
  if (turn.state !== 'running') throw new ConflictError('轮次当前不处于执行中，不能发起审批');

  const toolName = input.tool.trim().toLowerCase();
  const matchKey = input.match_key ?? approvalMatchKey(input.tool, input.target);
  const rule = resolveApprovalRule(db, {
    workspace_id: session.workspace_id,
    issue_id: session.issue_id,
    tool_name: toolName,
    match_key: matchKey,
  });
  if (rule) return { auto_allowed: true, rule, turn, request_id: null };

  const requestId = randomUUID();
  const approval: TurnApprovalInfo = {
    request_id: requestId,
    tool: input.tool,
    target: input.target,
    risk: input.risk,
    match_key: matchKey,
  };
  const awaiting = markTurnAwaiting(db, sessionId, turnId, {
    state: 'awaiting_approval',
    reason: 'approval_required',
    message: `${input.tool} 需要确认`,
    approval,
  });
  deps.broadcast({
    type: 'session.approval_request',
    session_id: sessionId,
    turn_id: turnId,
    request_id: requestId,
    tool: input.tool,
    target: input.target,
    risk: input.risk,
  });
  return { auto_allowed: false, rule: null, turn: awaiting, request_id: requestId };
}

export interface ApprovalDecisionInput {
  decision: 'allow' | 'deny';
  scope: ApprovalScope;
  created_by?: string;
}

export interface ApprovalDecisionResult {
  turn: SessionTurn;
  rule: ApprovalRule | null;
  request_id: string;
}

/** allow 时把阻塞步骤恢复为 running；deny 时记为 failed（轮次另行置 stopped） */
function settleAwaitingStep(turn: SessionTurn, state: TurnPlanStep['state']): TurnPlanStep[] | null {
  if (!turn.plan_json) return null;
  const plan = turn.plan_json.map((step) => ({ ...step }));
  let index = plan.findIndex((step) => step.state === 'awaiting');
  if (index < 0 && turn.current_index >= 0 && turn.current_index < plan.length) index = turn.current_index;
  if (index >= 0 && plan[index]) plan[index] = { ...plan[index]!, state };
  return plan;
}

/**
 * 审批决策（契约 #14）：
 * - 轮次非 `awaiting_approval` → 409（重复决策天然幂等：第二次就是冲突）；
 * - `awaiting_json.approval` 缺失或 `request_id` 不匹配 → 404（防旧请求被重放）；
 * - `allow + workspace` 且工具非只读 → 403（首版写类工具必须走 task/once）；
 * - `allow + task` 但会话未绑定任务 → 400；
 * - 规则重复（同键未撤销）→ 409，事务回滚后轮次仍停在 awaiting_approval，可换档重试。
 */
export function decideTurnApproval(
  db: Db,
  sessionId: string,
  turnId: string,
  requestId: string,
  input: ApprovalDecisionInput,
): ApprovalDecisionResult {
  const session = getSession(db, sessionId);
  if (!session) throw new NotFoundError('会话不存在');
  const turn = getTurn(db, turnId);
  if (!turn || turn.session_id !== sessionId) throw new NotFoundError('轮次不存在');
  if (turn.state !== 'awaiting_approval') throw new ConflictError('轮次当前不在等待审批状态');

  const approval = turn.awaiting_json?.approval ?? null;
  if (!approval || approval.request_id !== requestId) throw new NotFoundError('审批请求不存在');

  const now = Date.now();
  const createdBy = input.created_by ?? 'user';
  const toolName = approval.tool.trim().toLowerCase();

  if (input.decision === 'deny') {
    const updated = db.transaction(() =>
      updateTurn(db, turnId, {
        state: 'stopped',
        plan_json: settleAwaitingStep(turn, 'failed'),
        awaiting_json: { reason: 'approval_denied', message: '用户拒绝执行', at: now },
        awaiting_heartbeat_at: null,
        ended_at: now,
      }),
    )();
    return { turn: updated!, rule: null, request_id: requestId };
  }

  // 允许的前置校验放在事务前：无效档位不应产生任何写入
  if (input.scope === 'workspace' && !isReadOnlyApprovalTool(approval.tool)) {
    throw new ForbiddenError(
      `写类工具暂不支持工作区档（${approval.tool}）：需先提供撤销入口`,
    );
  }
  if (input.scope === 'task' && !session.issue_id) {
    throw new ValidationError('任务档需要会话绑定任务');
  }

  let rule: ApprovalRule | null = null;
  const updated = db.transaction(() => {
    if (input.scope === 'task') {
      rule = createApprovalRule(db, {
        workspace_id: session.workspace_id,
        issue_id: session.issue_id,
        session_id: sessionId,
        turn_id: turnId,
        tool_name: toolName,
        match_key: approval.match_key,
        scope: 'task',
        created_by: createdBy,
        created_at: now,
      });
    } else if (input.scope === 'workspace') {
      rule = createApprovalRule(db, {
        workspace_id: session.workspace_id,
        issue_id: null,
        session_id: sessionId,
        turn_id: turnId,
        tool_name: toolName,
        match_key: approval.match_key,
        scope: 'workspace',
        created_by: createdBy,
        created_at: now,
      });
    }
    return updateTurn(db, turnId, {
      state: 'running',
      plan_json: settleAwaitingStep(turn, 'running'),
      awaiting_json: null,
      awaiting_heartbeat_at: null,
      ended_at: null,
    });
  })();

  return { turn: updated!, rule, request_id: requestId };
}
