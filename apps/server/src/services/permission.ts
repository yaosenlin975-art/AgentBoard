/**
 * DEC-V4-PERM-SERVER：决策端点的身份解析与角色校验（方案见
 * `Docs/design-2026-11-06-workspace-permissions.md` §4/§5）。
 *
 * 身份口径（本卡按父会话要求收紧为「请求头优先且唯一」）：
 * - 只认 `X-AgentBoard-Actor` 请求头；没有头 → 缺省 `user`（单机行为零变化）；
 * - 头存在但为空 / 超长 / 含控制字符 → 401 `UNAUTHENTICATED`；
 * - **不再用 body 的 `by` / `answered_by` / `agent_id` 反推身份**：body 字段只保留原有的
 *   业务语义（撤回人、回答人、claim 的 agent），避免「没身份也当 user / 自报即授权」。
 *
 * agent 统一规范化为 `agent:<name>`（与 `kb` 的 `KB_AGENT` 对齐），`user` 保持原样。
 */
import type { Request } from 'express';
import type { DecisionCapabilities } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getRole, type WorkspaceRole } from '../db/repos/workspaceMember.js';
import { ApiError } from '../errors.js';

export const ACTOR_HEADER = 'X-AgentBoard-Actor';
export const DEFAULT_ACTOR = 'user';

/** 请求头身份上限（方案 §5） */
const MAX_ACTOR_LENGTH = 100;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, member: 2, owner: 3 };

/** `user` 原样；`agent:` 前缀保留；其余按 agent 规范化（方案 §5） */
export function normalizeActor(raw: string): string {
  const value = raw.trim();
  if (value === DEFAULT_ACTOR) return DEFAULT_ACTOR;
  if (value.startsWith('agent:')) return value;
  return `agent:${value}`;
}

/**
 * 解析调用者身份。没有身份头 → `user`（单机兼容）；头非法 → 401，绝不静默降级成 `user`。
 */
export function resolveActor(req: Request): string {
  const header = req.get(ACTOR_HEADER);
  if (header === undefined) return DEFAULT_ACTOR;
  const raw = header.trim();
  if (raw.length === 0 || raw.length > MAX_ACTOR_LENGTH || CONTROL_CHARS.test(raw)) {
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      `身份头 ${ACTOR_HEADER} 无效：需非空、不超过 ${MAX_ACTOR_LENGTH} 字符且不含控制字符`,
    );
  }
  const actor = normalizeActor(raw);
  if (actor === 'agent:') {
    throw new ApiError(401, 'UNAUTHENTICATED', `身份头 ${ACTOR_HEADER} 无效：agent 名不能为空`);
  }
  return actor;
}

/**
 * 角色校验：无成员记录 → 403 `WORKSPACE_FORBIDDEN`；角色不足 → 403 `ROLE_FORBIDDEN`。
 * 返回实际角色供调用方做 capability 投影。
 */
export function assertWorkspaceRole(
  db: Db,
  workspaceId: string,
  actorId: string,
  minRole: WorkspaceRole,
): WorkspaceRole {
  const role = getRole(db, workspaceId, actorId);
  if (role === null) {
    throw new ApiError(403, 'WORKSPACE_FORBIDDEN', `身份 ${actorId} 不是工作区 ${workspaceId} 的成员`);
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new ApiError(
      403,
      'ROLE_FORBIDDEN',
      `需要 ${minRole} 及以上角色，当前身份 ${actorId} 的角色是 ${role}`,
    );
  }
  return role;
}

/**
 * 按角色算出的「资格」投影（不区分具体决策）。
 * 多区查询的响应级 capabilities、以及没有决策上下文的调用方使用。
 */
export function roleCapabilities(role: WorkspaceRole | null): DecisionCapabilities {
  const rank = role === null ? 0 : ROLE_RANK[role];
  const writable = rank >= ROLE_RANK.member;
  return {
    can_answer: writable,
    can_revise: writable,
    can_undo: writable,
    can_withdraw: role === 'owner',
    can_extend: writable,
  };
}

/**
 * 单条决策的能力投影（服务端唯一权威）：
 * - 回答 / 延长：member 及以上；
 * - 修订 / 撤销回答：member 限本人答案，owner 可管理他人答案；
 * - 撤回：仅 owner；
 * - 未回答的决策没有「修订 / 撤销」对象，故两项为 false。
 *
 * `can_undo` 只表示有资格，实际还受 6 秒窗口与 `expected_revision` 约束。
 */
export function decisionCapabilities(
  role: WorkspaceRole | null,
  actorId: string,
  decision: { state: string; current_answer_by: string | null },
): DecisionCapabilities {
  const base = roleCapabilities(role);
  const answered = decision.state === 'answered';
  const ownsCurrent = decision.current_answer_by !== null && decision.current_answer_by === actorId;
  const canManageAnswers = role === 'owner' || ownsCurrent;
  return {
    ...base,
    can_revise: base.can_revise && answered && canManageAnswers,
    can_undo: base.can_undo && answered && canManageAnswers,
  };
}
