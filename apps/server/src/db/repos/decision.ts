import { randomUUID } from 'node:crypto';
import type { Priority } from '@agentboard/shared';
import type { Db } from '../connection.js';

/**
 * DEC-1：待决策区数据访问层。
 *
 * 这里只做 SQL 与行映射，不写业务规则（校验、状态迁移条件、评论、广播都在 services/decision.ts）。
 * 「锁」= `issue_decision.state='open'` 的行；`grace` 行只是宽限计时，不构成锁。
 */

export type DecisionState = 'grace' | 'open' | 'answered' | 'withdrawn';
export type DecisionTrigger = 'blocked' | 'scope_change' | 'irreversible' | 'missing_input';
export type DecisionSource = 'web' | 'cli';
export type DecisionOnExpire = 'stay_locked' | 'unlock_default';

export interface DecisionRow {
  id: string;
  workspace_id: string;
  issue_id: string;
  question: string;
  context_md: string;
  trigger: DecisionTrigger;
  state: DecisionState;
  created_by: string;
  created_session_id: string | null;
  created_turn_id: string | null;
  created_fence: number | null;
  grace_seconds: number;
  grace_until: number;
  locked_at: number | null;
  stop_requested_at: number | null;
  stop_ack_at: number | null;
  checkpoint_json: string | null;
  current_answer_id: string | null;
  answer_revision: number;
  created_at: number;
  answered_at: number | null;
  withdrawn_at: number | null;
  withdrawn_by: string | null;
  withdrawn_reason: string | null;
  expires_at: number | null;
  on_expire: DecisionOnExpire;
  stale_level: number;
  last_notified_at: number | null;
  updated_at: number;
}

export interface DecisionOptionRow {
  id: string;
  decision_id: string;
  ord: number;
  label: string;
  consequence: string;
  is_default: number;
}

export interface DecisionAnswerRow {
  id: string;
  decision_id: string;
  revision: number;
  option_id: string | null;
  answer_text: string | null;
  answered_by: string;
  source: DecisionSource;
  created_at: number;
}

export interface DecisionOptionInput {
  label: string;
  consequence: string;
  is_default?: boolean;
}

export interface DecisionInsertInput {
  workspace_id: string;
  issue_id: string;
  question: string;
  context_md?: string;
  trigger?: DecisionTrigger;
  /** grace=0 时由调用方直接落 open（§4.3.1 独立分支），默认 grace */
  state?: DecisionState;
  created_by: string;
  created_session_id?: string | null;
  created_turn_id?: string | null;
  created_fence?: number | null;
  grace_seconds: number;
  grace_until: number;
  locked_at?: number | null;
  stop_requested_at?: number | null;
  checkpoint_json?: string | null;
  expires_at?: number | null;
  on_expire?: DecisionOnExpire;
  options: DecisionOptionInput[];
  now: number;
}

/** 详情：主行 + 选项 + 全部答案 revision + 派生倒计时字段 */
export interface DecisionDetail extends DecisionRow {
  options: DecisionOptionRow[];
  answers: DecisionAnswerRow[];
  remaining_grace_seconds: number | null;
  waiting_seconds: number | null;
}

export interface DecisionListItem extends DecisionRow {
  issue_title: string;
  issue_status: string;
  /** 由 issue join 派生（DEC-V4-API-LIST）：队列排序用 */
  issue_priority: Priority;
  option_count: number;
  /** 与 getDecisionDetail 的选项同形状，按 ord 升序；列表批量取，避免逐条拉详情 */
  options: DecisionOptionRow[];
  /** 该 issue 作为 blocker 的 blocks 边数量；无下游为 0 */
  blocked_downstream_count: number;
  remaining_grace_seconds: number | null;
  waiting_seconds: number | null;
}

export interface DecisionListFilter {
  workspace_id?: string;
  issue_id?: string;
  states?: DecisionState[];
  /** 仅返回 locked_at <= stale_before 的 open 决策（DEC-8 超时分组复用） */
  stale_before?: number;
  limit?: number;
}

export interface DecisionCounts {
  grace: number;
  open: number;
  stale_open: number;
  answered_recent: number;
}

const OPEN_STATES: DecisionState[] = ['grace', 'open'];

export function insertDecision(db: Db, input: DecisionInsertInput): DecisionRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO issue_decision (id, workspace_id, issue_id, question, context_md, trigger, state,
       created_by, created_session_id, created_turn_id, created_fence, grace_seconds, grace_until,
       locked_at, stop_requested_at, checkpoint_json, current_answer_id, answer_revision,
       created_at, expires_at, on_expire, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.issue_id,
    input.question,
    input.context_md ?? '',
    input.trigger ?? 'blocked',
    input.state ?? 'grace',
    input.created_by,
    input.created_session_id ?? null,
    input.created_turn_id ?? null,
    input.created_fence ?? null,
    input.grace_seconds,
    input.grace_until,
    input.locked_at ?? null,
    input.stop_requested_at ?? null,
    input.checkpoint_json ?? null,
    input.now,
    input.expires_at ?? null,
    input.on_expire ?? 'stay_locked',
    input.now,
  );
  const optionStmt = db.prepare(
    'INSERT INTO issue_decision_option (id, decision_id, ord, label, consequence, is_default) VALUES (?, ?, ?, ?, ?, ?)',
  );
  input.options.forEach((option, index) => {
    optionStmt.run(randomUUID(), id, index + 1, option.label, option.consequence, option.is_default ? 1 : 0);
  });
  return getDecision(db, id)!;
}

export function getDecision(db: Db, id: string): DecisionRow | null {
  return (db.prepare('SELECT * FROM issue_decision WHERE id=?').get(id) as DecisionRow | undefined) ?? null;
}

export function listOptions(db: Db, decisionId: string): DecisionOptionRow[] {
  return db
    .prepare('SELECT * FROM issue_decision_option WHERE decision_id=? ORDER BY ord, id')
    .all(decisionId) as DecisionOptionRow[];
}

export function listAnswers(db: Db, decisionId: string): DecisionAnswerRow[] {
  return db
    .prepare('SELECT * FROM issue_decision_answer WHERE decision_id=? ORDER BY revision, created_at')
    .all(decisionId) as DecisionAnswerRow[];
}

/** 当前 open/grace 决策（部分唯一索引保证最多一条） */
export function findActiveDecision(db: Db, issueId: string): DecisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM issue_decision WHERE issue_id=? AND state IN ('grace','open') ORDER BY created_at DESC LIMIT 1")
      .get(issueId) as DecisionRow | undefined) ?? null
  );
}

/** 当前锁（仅 open；grace 不算锁） */
export function findOpenDecision(db: Db, issueId: string): DecisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM issue_decision WHERE issue_id=? AND state='open' ORDER BY locked_at DESC, created_at DESC LIMIT 1")
      .get(issueId) as DecisionRow | undefined) ?? null
  );
}

export function getDecisionDetail(db: Db, id: string, now: number = Date.now()): DecisionDetail | null {
  const row = getDecision(db, id);
  if (!row) return null;
  return {
    ...row,
    options: listOptions(db, id),
    answers: listAnswers(db, id),
    remaining_grace_seconds: remainingGraceSeconds(row, now),
    waiting_seconds: waitingSeconds(row, now),
  };
}

function remainingGraceSeconds(row: DecisionRow, now: number): number | null {
  if (row.state !== 'grace') return null;
  return Math.max(0, Math.ceil((row.grace_until - now) / 1000));
}

function waitingSeconds(row: DecisionRow, now: number): number | null {
  if (row.state !== 'open' || row.locked_at === null) return null;
  return Math.max(0, Math.floor((now - row.locked_at) / 1000));
}

/** 列表（自然按创建时间倒序）；states 缺省为在途 grace/open */
export function listDecisions(db: Db, filter: DecisionListFilter = {}): DecisionListItem[] {
  const states = filter.states ?? OPEN_STATES;
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.workspace_id !== undefined) {
    where.push('d.workspace_id=?');
    params.push(filter.workspace_id);
  }
  if (filter.issue_id !== undefined) {
    where.push('d.issue_id=?');
    params.push(filter.issue_id);
  }
  if (states.length > 0) {
    where.push(`d.state IN (${states.map(() => '?').join(',')})`);
    params.push(...states);
  }
  if (filter.stale_before !== undefined) {
    where.push("d.state='open' AND d.locked_at IS NOT NULL AND d.locked_at <= ?");
    params.push(filter.stale_before);
  }
  const limit = Number.isSafeInteger(filter.limit) && filter.limit! > 0 ? filter.limit! : 200;
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT d.*, i.title AS issue_title, i.status AS issue_status, i.priority AS issue_priority,
         (SELECT COUNT(*) FROM issue_decision_option o WHERE o.decision_id=d.id) AS option_count,
         (SELECT COUNT(*) FROM issue_dependency dep
           WHERE dep.blocker_issue_id=d.issue_id AND dep.relation='blocks') AS blocked_downstream_count
       FROM issue_decision d JOIN issue i ON i.id=d.issue_id
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    )
    .all(...params) as Array<
    DecisionRow & {
      issue_title: string;
      issue_status: string;
      issue_priority: Priority;
      option_count: number;
      blocked_downstream_count: number;
    }
  >;
  // DEC-V4-API-LIST：选项一次批量取（IN decisionIds），不做逐条 N+1
  const optionsByDecision = new Map<string, DecisionOptionRow[]>();
  if (rows.length > 0) {
    const optionRows = db
      .prepare(
        `SELECT * FROM issue_decision_option
          WHERE decision_id IN (${rows.map(() => '?').join(',')})
          ORDER BY decision_id, ord, id`,
      )
      .all(...rows.map((row) => row.id)) as DecisionOptionRow[];
    for (const option of optionRows) {
      const list = optionsByDecision.get(option.decision_id);
      if (list === undefined) optionsByDecision.set(option.decision_id, [option]);
      else list.push(option);
    }
  }
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    options: optionsByDecision.get(row.id) ?? [],
    remaining_grace_seconds: remainingGraceSeconds(row, now),
    waiting_seconds: waitingSeconds(row, now),
  }));
}

/** 徽标与 stale 分组：grace + open + 超时 open（lock 后 ≥72h）+ 近 24h 已回答 */
export function countDecisions(db: Db, workspaceId: string, now: number = Date.now()): DecisionCounts {
  const staleBefore = now - 72 * 3600 * 1000;
  const recentAfter = now - 24 * 3600 * 1000;
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state='grace' THEN 1 ELSE 0 END) AS grace,
         SUM(CASE WHEN state='open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN state='open' AND locked_at IS NOT NULL AND locked_at <= ? THEN 1 ELSE 0 END) AS stale_open,
         SUM(CASE WHEN state='answered' AND answered_at IS NOT NULL AND answered_at >= ? THEN 1 ELSE 0 END) AS answered_recent
       FROM issue_decision WHERE workspace_id=?`,
    )
    .get(staleBefore, recentAfter, workspaceId) as {
    grace: number | null;
    open: number | null;
    stale_open: number | null;
    answered_recent: number | null;
  };
  return {
    grace: row.grace ?? 0,
    open: row.open ?? 0,
    stale_open: row.stale_open ?? 0,
    answered_recent: row.answered_recent ?? 0,
  };
}

/**
 * grace→open 的状态位迁移（CAS）。返回是否由本调用完成迁移（false = 已被回答/撤回或已 open）。
 * 只动决策行，卡侧释放由 services/decision.ts 在同一个事务里完成。
 */
export function markDecisionLocked(db: Db, id: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE issue_decision SET state='open', locked_at=?, stop_requested_at=?, updated_at=?
         WHERE id=? AND state='grace'`,
      )
      .run(now, now, now, id).changes === 1
  );
}

/** 落一条答案 revision 行（不改变决策状态，状态迁移由下面两个 CAS 负责） */
export function insertAnswer(
  db: Db,
  input: {
    decision_id: string;
    revision: number;
    option_id?: string | null;
    answer_text?: string | null;
    answered_by: string;
    source: DecisionSource;
    created_at: number;
  },
): DecisionAnswerRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO issue_decision_answer (id, decision_id, revision, option_id, answer_text, answered_by, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.decision_id,
    input.revision,
    input.option_id ?? null,
    input.answer_text ?? null,
    input.answered_by,
    input.source,
    input.created_at,
  );
  return db.prepare('SELECT * FROM issue_decision_answer WHERE id=?').get(id) as DecisionAnswerRow;
}

/** 首次回答：grace/open → answered（先到者赢；changes=0 表示并发已被回答/撤回） */
export function answerActiveDecision(
  db: Db,
  input: { id: string; answer_id: string; revision: number; now: number },
): boolean {
  return (
    db
      .prepare(
        `UPDATE issue_decision SET state='answered', current_answer_id=?, answer_revision=?,
           answered_at=?, updated_at=?
         WHERE id=? AND state IN ('grace','open')`,
      )
      .run(input.answer_id, input.revision, input.now, input.now, input.id).changes === 1
  );
}

/** 修订：answered + expected_revision 的 CAS（旧 revision → 409） */
export function reviseDecisionAnswer(
  db: Db,
  input: { id: string; answer_id: string; expected_revision: number; next_revision: number; now: number },
): boolean {
  return (
    db
      .prepare(
        `UPDATE issue_decision SET current_answer_id=?, answer_revision=?, updated_at=?
         WHERE id=? AND state='answered' AND answer_revision=?`,
      )
      .run(input.answer_id, input.next_revision, input.now, input.id, input.expected_revision).changes === 1
  );
}

/** 撤回：grace/open → withdrawn（grace 内撤回不释放占用） */
export function withdrawDecision(
  db: Db,
  input: { id: string; by: string; reason: string; now: number },
): boolean {
  return (
    db
      .prepare(
        `UPDATE issue_decision SET state='withdrawn', withdrawn_at=?, withdrawn_by=?, withdrawn_reason=?, updated_at=?
         WHERE id=? AND state IN ('grace','open')`,
      )
      .run(input.now, input.by, input.reason, input.now, input.id).changes === 1
  );
}

export interface StopState {
  stop_requested: boolean;
  decision_id: string | null;
  reason: string | null;
  stop_ack_at: number | null;
}

/** DEC-9：agent 停止检查点读窗口（只读；2 秒级可读由调用方保证） */
export function getStopState(db: Db, issueId: string): StopState {
  const row = findOpenDecision(db, issueId);
  if (!row || row.stop_requested_at === null) {
    return { stop_requested: false, decision_id: null, reason: null, stop_ack_at: null };
  }
  return {
    stop_requested: true,
    decision_id: row.id,
    reason: `决策未回答：${row.question}`,
    stop_ack_at: row.stop_ack_at,
  };
}

/** DEC-9：仅观测，不影响锁 */
export function ackStop(db: Db, issueId: string, now: number): DecisionRow | null {
  const row = findOpenDecision(db, issueId);
  if (!row) return null;
  db.prepare('UPDATE issue_decision SET stop_ack_at=COALESCE(stop_ack_at, ?) WHERE id=?').run(now, row.id);
  return getDecision(db, row.id);
}

/** DEC-8：提醒档位去重写入口（不改状态、不自动解锁） */
export function setDecisionReminder(db: Db, id: string, input: { stale_level: number; now: number }): void {
  db.prepare('UPDATE issue_decision SET stale_level=?, last_notified_at=? WHERE id=?').run(
    input.stale_level,
    input.now,
    id,
  );
}
