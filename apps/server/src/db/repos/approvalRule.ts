import { randomUUID } from 'node:crypto';
import type { ApprovalRule, ApprovalRuleScope } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ConflictError, NotFoundError } from '../../errors.js';

/**
 * CHAT-APP1（契约 #9/#16/#17）：`approval_rule` 行读写。
 *
 * - 唯一约束（未撤销规则的 scope + 归属 + tool + match_key）由迁移里的部分唯一索引兜底；
 *   这里把 SQLite 约束异常翻成 409，避免冒泡成 500。
 * - 撤销是软撤销：只写 `revoked_at`，行保留作审计；重复撤销按「不存在」处理（404）。
 */

export interface CreateApprovalRuleInput {
  workspace_id: string;
  issue_id?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  tool_name: string;
  match_key: string;
  scope: ApprovalRuleScope;
  created_by: string;
  created_at?: number;
}

export interface FindApprovalRuleInput {
  workspace_id: string;
  tool_name: string;
  match_key: string;
}

interface RuleRow {
  id: string; workspace_id: string; issue_id: string | null; session_id: string | null;
  turn_id: string | null; tool_name: string; match_key: string; scope: string;
  created_at: number; created_by: string; revoked_at: number | null;
}

const RULE_SCOPES: readonly string[] = ['task', 'workspace'];

function toRule(row: RuleRow): ApprovalRule {
  const scope = (RULE_SCOPES as string[]).includes(row.scope) ? (row.scope as ApprovalRuleScope) : 'task';
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    issue_id: row.issue_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    tool_name: row.tool_name,
    match_key: row.match_key,
    scope,
    created_at: row.created_at,
    created_by: row.created_by,
    revoked_at: row.revoked_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = (error as { message?: string } | null)?.message ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') && /UNIQUE/i.test(message);
}

export function createApprovalRule(db: Db, input: CreateApprovalRuleInput): ApprovalRule {
  const id = randomUUID();
  const created_at = input.created_at ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO approval_rule
       (id, workspace_id, issue_id, session_id, turn_id, tool_name, match_key, scope, created_at, created_by, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.workspace_id,
      input.issue_id ?? null,
      input.session_id ?? null,
      input.turn_id ?? null,
      input.tool_name,
      input.match_key,
      input.scope,
      created_at,
      input.created_by,
    );
  } catch (error) {
    if (isUniqueConstraint(error)) throw new ConflictError('同键的审批规则已存在');
    throw error;
  }
  return getApprovalRule(db, id)!;
}

export function getApprovalRule(db: Db, id: string): ApprovalRule | null {
  const row = db.prepare('SELECT * FROM approval_rule WHERE id = ?').get(id) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/** 当前生效规则（撤销入口数据源）：只列 `revoked_at IS NULL` */
export function listActiveApprovalRules(db: Db, workspaceId: string): ApprovalRule[] {
  const rows = db
    .prepare(
      `SELECT * FROM approval_rule
       WHERE workspace_id = ? AND revoked_at IS NULL
       ORDER BY created_at, id`,
    )
    .all(workspaceId) as RuleRow[];
  return rows.map(toRule);
}

/** 软撤销：行保留；不存在/跨工作区/已撤销一律 404（重复删除不会二次写时间戳） */
export function revokeApprovalRule(db: Db, workspaceId: string, ruleId: string, now: number = Date.now()): ApprovalRule {
  const row = db
    .prepare('SELECT * FROM approval_rule WHERE id = ? AND workspace_id = ?')
    .get(ruleId, workspaceId) as RuleRow | undefined;
  if (!row || row.revoked_at !== null) throw new NotFoundError('审批规则不存在');
  db.prepare('UPDATE approval_rule SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, ruleId);
  return getApprovalRule(db, ruleId)!;
}

/** `task` 档精确匹配：同工作区 + 同 issue + 同工具 + 同 match_key 的未撤销规则 */
export function findActiveTaskRule(db: Db, input: FindApprovalRuleInput & { issue_id: string }): ApprovalRule | null {
  const row = db
    .prepare(
      `SELECT * FROM approval_rule
       WHERE scope = 'task' AND workspace_id = ? AND issue_id = ? AND tool_name = ? AND match_key = ?
         AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(input.workspace_id, input.issue_id, input.tool_name, input.match_key) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/** `workspace` 档精确匹配：同工作区 + 未撤销（issue_id 恒 NULL） */
export function findActiveWorkspaceRule(db: Db, input: FindApprovalRuleInput): ApprovalRule | null {
  const row = db
    .prepare(
      `SELECT * FROM approval_rule
       WHERE scope = 'workspace' AND workspace_id = ? AND issue_id IS NULL AND tool_name = ? AND match_key = ?
         AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(input.workspace_id, input.tool_name, input.match_key) as RuleRow | undefined;
  return row ? toRule(row) : null;
}
