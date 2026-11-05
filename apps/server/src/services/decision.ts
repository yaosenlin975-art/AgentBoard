import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';
import {
  answerActiveDecision,
  findActiveDecision,
  getDecision,
  getDecisionDetail,
  insertAnswer,
  insertDecision,
  listOptions,
  markDecisionLocked,
  reviseDecisionAnswer,
  withdrawDecision as withdrawDecisionRow,
  type DecisionDetail,
  type DecisionOptionInput,
  type DecisionOptionRow,
  type DecisionOnExpire,
  type DecisionRow,
  type DecisionSource,
  type DecisionTrigger,
} from '../db/repos/decision.js';
import { ApiError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';

/** v3 定稿：默认宽限 180 秒，合法区间 0–600；0 是合法值（立即落锁分支） */
export const DECISION_GRACE_DEFAULT_SECONDS = 180;
export const DECISION_GRACE_MAX_SECONDS = 600;

const TRIGGERS: DecisionTrigger[] = ['blocked', 'scope_change', 'irreversible', 'missing_input'];
const ON_EXPIRE_VALUES: DecisionOnExpire[] = ['stay_locked', 'unlock_default'];

/** 显式 grace_seconds：必须是 0–600 的整数，否则 400 INVALID_GRACE（不做静默截断） */
export function assertValidGraceSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > DECISION_GRACE_MAX_SECONDS) {
    throw new ApiError(400, 'INVALID_GRACE', `宽限秒数不合法：需 0–${DECISION_GRACE_MAX_SECONDS} 的整数（收到 ${String(value)}）`);
  }
  return value;
}

/**
 * 生效宽限：显式值优先（校验拒绝非法值）；缺省读 workspace.decision_grace_seconds。
 * 存量库该列为 NULL 或历史脏值时不报错，按 180 兜底并 clamp 到 0–600（服务端兜底口径）。
 */
export function resolveGraceSeconds(db: Db, workspaceId: string, explicit?: number | null): number {
  if (explicit !== undefined && explicit !== null) return assertValidGraceSeconds(explicit);
  const row = db.prepare('SELECT decision_grace_seconds AS v FROM workspace WHERE id=?').get(workspaceId) as
    | { v: number | null }
    | undefined;
  const raw = row?.v;
  if (raw === null || raw === undefined) return DECISION_GRACE_DEFAULT_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value)) return DECISION_GRACE_DEFAULT_SECONDS;
  return Math.min(DECISION_GRACE_MAX_SECONDS, Math.max(0, value));
}

/** 工作区默认宽限写入（读写两侧都 clamp 0–600；非法值 400） */
export function setWorkspaceGraceSeconds(db: Db, workspaceId: string, value: number): number {
  const seconds = assertValidGraceSeconds(value);
  const changed = db.prepare('UPDATE workspace SET decision_grace_seconds=? WHERE id=?').run(seconds, workspaceId);
  if (changed.changes !== 1) throw new NotFoundError('工作区不存在');
  return seconds;
}

export interface CreateDecisionInput {
  workspace_id: string;
  issue_id: string;
  created_by: string;
  question: string;
  context_md?: string;
  trigger?: DecisionTrigger;
  /** 缺省取工作区默认（180）；显式传值必须 0–600 整数 */
  grace_seconds?: number | null;
  options: DecisionOptionInput[];
  checkpoint?: unknown;
  session_id?: string | null;
  turn_id?: string | null;
  created_fence?: number | null;
  expires_at?: number | null;
  on_expire?: DecisionOnExpire;
}

export interface CreateDecisionResult {
  decision: DecisionDetail;
  /** grace=0 分支返回 true（事务内已落锁、卡已释放） */
  locked: boolean;
}

/**
 * 提问建决策（单事务）：
 * - grace_seconds ≥ 1 → `grace`，卡保持「进行中」、占用不释放、fence 不变；
 * - grace_seconds = 0 → §4.3.1 独立分支：直接建 `open` 并复用落锁逻辑（释放占用 + bump fence + 系统评论）；
 * - 一卡同时最多一条在途决策（部分唯一索引；并发下由 SQLITE 约束兜底）。
 */
export function createPendingDecision(db: Db, input: CreateDecisionInput): CreateDecisionResult {
  const question = input.question?.trim();
  if (!question) throw new ValidationError('问题不能为空');
  if (!input.created_by?.trim()) throw new ValidationError('created_by 不能为空');
  if (!Array.isArray(input.options)) throw new ValidationError('选项不能为空');
  const options = normalizeOptions(input.options);
  const trigger = input.trigger ?? 'blocked';
  if (!TRIGGERS.includes(trigger)) throw new ValidationError(`trigger 不合法（需 ${TRIGGERS.join('/')}）`);
  const onExpire = input.on_expire ?? 'stay_locked';
  if (!ON_EXPIRE_VALUES.includes(onExpire)) throw new ValidationError('on_expire 不合法（需 stay_locked/unlock_default）');
  if (input.expires_at !== undefined && input.expires_at !== null) {
    if (!Number.isSafeInteger(input.expires_at) || input.expires_at < 0) throw new ValidationError('expires_at 不合法');
  }
  const checkpointJson = normalizeCheckpoint(input.checkpoint);

  return db
    .transaction((): CreateDecisionResult => {
      const issue = getIssue(db, input.issue_id);
      if (!issue) throw new NotFoundError('任务不存在');
      if (issue.workspace_id !== input.workspace_id) throw new NotFoundError('任务不属于该工作区');
      const active = findActiveDecision(db, input.issue_id);
      if (active) {
        throw new ApiError(409, 'DECISION_ALREADY_OPEN', `该卡已有在途决策 ${active.id}（state=${active.state}），先回答或撤回`);
      }
      const graceSeconds = resolveGraceSeconds(db, input.workspace_id, input.grace_seconds);
      const now = Date.now();
      const graceUntil = now + graceSeconds * 1000;
      let decision: DecisionRow;
      try {
        decision = insertDecision(db, {
          workspace_id: input.workspace_id,
          issue_id: input.issue_id,
          question,
          context_md: input.context_md,
          trigger,
          state: graceSeconds === 0 ? 'open' : 'grace',
          created_by: input.created_by,
          created_session_id: input.session_id ?? null,
          created_turn_id: input.turn_id ?? null,
          created_fence: input.created_fence ?? null,
          grace_seconds: graceSeconds,
          grace_until: graceUntil,
          locked_at: graceSeconds === 0 ? now : null,
          stop_requested_at: graceSeconds === 0 ? now : null,
          checkpoint_json: checkpointJson,
          expires_at: input.expires_at ?? null,
          on_expire: onExpire,
          options,
          now,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, 'DECISION_ALREADY_OPEN', '该卡已有在途决策（并发提问仅允许一条）');
        }
        throw error;
      }

      if (checkpointJson) insertCheckpointComment(db, input.issue_id, decision.id, checkpointJson);

      if (graceSeconds === 0) {
        lockIssueForDecisionInTx(db, decision.id, { now, reason: 'grace_zero' });
      }
      return { decision: getDecisionDetail(db, decision.id, now)!, locked: graceSeconds === 0 };
    })
    .immediate();
}

function normalizeOptions(options: DecisionOptionInput[]): DecisionOptionInput[] {
  if (options.length < 2) throw new ValidationError('至少需要 2 个选项');
  const labels = new Set<string>();
  let defaults = 0;
  const normalized = options.map((option) => {
    const label = String(option?.label ?? '').trim();
    const consequence = String(option?.consequence ?? '').trim();
    if (!label) throw new ValidationError('选项 label 不能为空');
    if (!consequence) throw new ValidationError('选项 consequence 不能为空');
    if (labels.has(label)) throw new ValidationError(`选项 label 重复：${label}`);
    labels.add(label);
    if (option.is_default) defaults += 1;
    return { label, consequence, is_default: Boolean(option.is_default) };
  });
  if (defaults > 1) throw new ValidationError('最多只能有 1 个默认选项');
  // 未显式指定默认项时取第 1 项（与 CLI `--default <ord>` 缺省 1 一致）
  if (defaults === 0) {
    const first = normalized[0];
    if (first) first.is_default = true;
  }
  return normalized;
}

function normalizeCheckpoint(checkpoint: unknown): string | null {
  if (checkpoint === undefined || checkpoint === null) return null;
  if (typeof checkpoint === 'string') {
    const text = checkpoint.trim();
    if (!text) return null;
    try {
      JSON.parse(text);
    } catch {
      throw new ValidationError('checkpoint 不是合法 JSON');
    }
    return text;
  }
  if (typeof checkpoint !== 'object') throw new ValidationError('checkpoint 不合法（需 JSON 对象或字符串）');
  return JSON.stringify(checkpoint);
}

/** 断点落库同时渲染成一条卡评论（§3.2.3：kb show 可见） */
function insertCheckpointComment(db: Db, issueId: string, decisionId: string, checkpointJson: string): void {
  const summary = checkpointSummary(checkpointJson);
  insertCommentRow(db, {
    issue_id: issueId,
    author: 'system',
    content: `【决策断点】decision=${decisionId}${summary ? `；${summary}` : ''}`,
  });
}

function checkpointSummary(checkpointJson: string): string {
  try {
    const parsed = JSON.parse(checkpointJson) as Record<string, unknown>;
    const parts: string[] = [];
    const nextStep = parsed.next_step ?? parsed.nextStep;
    const stash = parsed.stash_sha ?? parsed.stashSha ?? parsed.stash;
    const pid = parsed.background_pid ?? parsed.backgroundPid;
    if (typeof nextStep === 'string' && nextStep.trim()) parts.push(`next_step=${nextStep.trim()}`);
    if (typeof stash === 'string' && stash.trim()) parts.push(`stash=${stash.trim()}`);
    if (pid !== undefined && pid !== null) parts.push(`后台PID=${String(pid)}`);
    return parts.join('；');
  } catch {
    return '';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error);
  return text.includes('ux_decision_active') || text.includes('UNIQUE constraint failed');
}

export type LockReason = 'grace_expired' | 'grace_zero';

export interface LockResult {
  decision: DecisionDetail;
  issue: ReturnType<typeof getIssue>;
}

/**
 * grace→open 落锁（DEC-9 ticker 与 grace=0 分支共用同一实现）。
 * 事务内完成：决策转 open + 写 locked_at/stop_requested_at、bump claim_fence、
 * 卡 status=待规划、清空占用字段、写系统评论。
 * 幂等：已是 open 且非 grace_zero 调用时直接返回，不重复 bump / 评论。
 */
export function lockIssueForDecision(
  db: Db,
  decisionId: string,
  options: { now?: number; reason?: LockReason } = {},
): LockResult {
  return db.transaction(() => lockIssueForDecisionInTx(db, decisionId, options)).immediate();
}

export function lockIssueForDecisionInTx(
  db: Db,
  decisionId: string,
  options: { now?: number; reason?: LockReason } = {},
): LockResult {
  const now = options.now ?? Date.now();
  const reason = options.reason ?? 'grace_expired';
  const decision = getDecision(db, decisionId);
  if (!decision) throw new NotFoundError('决策不存在');
  if (decision.state === 'answered' || decision.state === 'withdrawn') {
    throw new ConflictError(`决策已结束（state=${decision.state}），不能落锁`);
  }
  // ticker 幂等：已经是 open 就不重复释放/评论；grace_zero 是创建事务内的首次落锁
  if (decision.state === 'open' && reason === 'grace_expired') {
    return { decision: getDecisionDetail(db, decisionId, now)!, issue: getIssue(db, decision.issue_id) };
  }
  const transitioned = decision.state === 'grace' ? markDecisionLocked(db, decisionId, now) : true;
  if (!transitioned) {
    // 并发回答先到：状态已不是 grace，本次不产生任何锁副作用
    return { decision: getDecisionDetail(db, decisionId, now)!, issue: getIssue(db, decision.issue_id) };
  }

  // 只释放「提问者自己的」占用：若在宽限末尾 agent 已 done/fail（claimed_by 已空），
  // 不把「待验收」改回待规划，避免吞掉一次完成；决策仍照常上锁。
  const released = db
    .prepare(
      `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL,
         last_heartbeat_at=NULL, session_id=NULL, last_seen_comment_id=NULL,
         claim_fence=COALESCE(claim_fence,0)+1, updated_at=MAX(?,updated_at+1)
       WHERE id=? AND claimed_by=?`,
    )
    .run(now, decision.issue_id, decision.created_by);

  if (released.changes === 1) {
    insertCommentRow(db, {
      issue_id: decision.issue_id,
      author: 'system',
      content:
        reason === 'grace_zero'
          ? `已立即上锁（--grace 0），agent 停止执行；决策 ${decisionId} 等待回答（旧 agent 收尾会 409 STALE_FENCE）`
          : `宽限 ${decision.grace_seconds} 秒到期未回答，已上锁并释放占用；决策 ${decisionId} 等待回答（旧 agent 收尾会 409 STALE_FENCE）`,
    });
  }
  return { decision: getDecisionDetail(db, decisionId, now)!, issue: getIssue(db, decision.issue_id) };
}

export interface AnswerDecisionInput {
  decision_id: string;
  option_id?: string | null;
  option_ord?: number | null;
  answer_text?: string | null;
  answered_by?: string;
  source?: DecisionSource;
  /** 修订专用：state='answered' 且 CAS 匹配才允许追加 revision */
  expected_revision?: number | null;
}

/**
 * 回答（单事务）：
 * - state='grace' → answered，卡保持「进行中」+ 占用（宽限内直接放行）；
 * - state='open' → answered，卡已待规划即解锁（需重新 claim）；
 * - state='answered' + expected_revision → 追加 revision（CAS，旧版本 409 DECISION_REVISION_CONFLICT）；
 * - 并发：条件 UPDATE 先到者赢，第二个 409 DECISION_ALREADY_ANSWERED。
 */
export function answerPendingDecision(db: Db, input: AnswerDecisionInput): DecisionDetail {
  const answeredBy = input.answered_by ?? 'user';
  if (answeredBy !== 'user') throw new ForbiddenError('当前仅人类可回答决策（answered_by=user）');
  const source: DecisionSource = input.source ?? 'web';
  if (source !== 'web' && source !== 'cli') throw new ValidationError('source 不合法（需 web/cli）');
  if (input.expected_revision !== undefined && input.expected_revision !== null) {
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
      throw new ValidationError('expected_revision 不合法（需 ≥0 整数）');
    }
  }

  return db
    .transaction((): DecisionDetail => {
      const decision = getDecision(db, input.decision_id);
      if (!decision) throw new NotFoundError('决策不存在');
      if (decision.state === 'withdrawn') {
        throw new ApiError(409, 'DECISION_WITHDRAWN', `决策已撤回（${decision.withdrawn_reason ?? '无理由'}），不能再回答`);
      }
      const now = Date.now();
      const expected = input.expected_revision ?? null;

      if (decision.state === 'answered') {
        if (expected === null) {
          throw new ApiError(
            409,
            'DECISION_ALREADY_ANSWERED',
            `决策已回答（revision=${decision.answer_revision}）；修订请带 expected_revision`,
          );
        }
        if (expected !== decision.answer_revision) {
          throw new ApiError(
            409,
            'DECISION_REVISION_CONFLICT',
            `答案版本冲突（期望 revision=${expected}，当前=${decision.answer_revision}），请重新读取后再改`,
          );
        }
        const option = resolveOption(db, decision.id, input);
        const text = normalizeAnswerText(input.answer_text);
        if (!option && !text) throw new ValidationError('必须选择选项或填写文本');
        const nextRevision = expected + 1;
        const answer = insertAnswer(db, {
          decision_id: decision.id,
          revision: nextRevision,
          option_id: option?.id ?? null,
          answer_text: text,
          answered_by: answeredBy,
          source,
          created_at: now,
        });
        if (
          !reviseDecisionAnswer(db, {
            id: decision.id,
            answer_id: answer.id,
            expected_revision: expected,
            next_revision: nextRevision,
            now,
          })
        ) {
          throw new ApiError(
            409,
            'DECISION_REVISION_CONFLICT',
            `答案已被他处修订（期望 revision=${expected}，当前=${decision.answer_revision}），请重新读取后再改`,
          );
        }
        insertCommentRow(db, {
          issue_id: decision.issue_id,
          author: 'system',
          content: `决策答案已修订为第 ${nextRevision} 版（decision=${decision.id}${option ? `，选项「${option.label}」` : ''}${text ? `；补充：${text}` : ''}）`,
        });
        return getDecisionDetail(db, decision.id, now)!;
      }

      // 首次回答：grace / open
      if (expected !== null && expected !== decision.answer_revision) {
        throw new ApiError(409, 'DECISION_REVISION_CONFLICT', `期望 revision=${expected}，当前=${decision.answer_revision}`);
      }
      const option = resolveOption(db, decision.id, input);
      const text = normalizeAnswerText(input.answer_text);
      if (!option && !text) throw new ValidationError('必须选择选项或填写文本');
      const revision = decision.answer_revision + 1;
      const answer = insertAnswer(db, {
        decision_id: decision.id,
        revision,
        option_id: option?.id ?? null,
        answer_text: text,
        answered_by: answeredBy,
        source,
        created_at: now,
      });
      if (!answerActiveDecision(db, { id: decision.id, answer_id: answer.id, revision, now })) {
        throw new ApiError(409, 'DECISION_ALREADY_ANSWERED', '决策已被并发回答或撤回，本次未产生写入');
      }
      const wasGrace = decision.state === 'grace';
      insertCommentRow(db, {
        issue_id: decision.issue_id,
        author: 'system',
        content: wasGrace
          ? `决策已在宽限内回答（decision=${decision.id}，第 ${revision} 版${option ? `，选项「${option.label}」` : ''}）：卡保持占用，agent 直接继续`
          : `决策已回答并解锁（decision=${decision.id}，第 ${revision} 版${option ? `，选项「${option.label}」` : ''}）：卡保持待规划，需重新 claim 续跑`,
      });
      return getDecisionDetail(db, decision.id, now)!;
    })
    .immediate();
}

function normalizeAnswerText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function resolveOption(db: Db, decisionId: string, input: AnswerDecisionInput): DecisionOptionRow | null {
  const options = listOptions(db, decisionId);
  if (input.option_id !== undefined && input.option_id !== null) {
    const found = options.find((option) => option.id === input.option_id);
    if (!found) throw new ValidationError(`选项不存在：${input.option_id}`);
    return found;
  }
  if (input.option_ord !== undefined && input.option_ord !== null) {
    if (!Number.isSafeInteger(input.option_ord)) throw new ValidationError('option_ord 需为整数');
    const found = options.find((option) => option.ord === input.option_ord);
    if (!found) throw new ValidationError(`选项序号不存在：${input.option_ord}`);
    return found;
  }
  return null;
}

/** 撤回（单事务）：grace 内撤回=取消宽限、卡保持占用；open 后撤回=解锁（卡本就在待规划） */
export function withdrawPendingDecision(
  db: Db,
  input: { decision_id: string; by: string; reason: string },
): DecisionDetail {
  const by = input.by?.trim();
  const reason = input.reason?.trim();
  if (!by) throw new ValidationError('撤回人不能为空');
  if (!reason) throw new ValidationError('撤回理由不能为空');
  return db
    .transaction((): DecisionDetail => {
      const decision = getDecision(db, input.decision_id);
      if (!decision) throw new NotFoundError('决策不存在');
      if (decision.state !== 'grace' && decision.state !== 'open') {
        throw new ApiError(409, 'DECISION_NOT_ACTIVE', `决策已结束（state=${decision.state}），不能撤回`);
      }
      if (by !== 'user' && by !== decision.created_by) {
        throw new ForbiddenError('只有人类用户或本决策提问者可以撤回');
      }
      const now = Date.now();
      if (!withdrawDecisionRow(db, { id: decision.id, by, reason, now })) {
        throw new ApiError(409, 'DECISION_NOT_ACTIVE', '决策已被并发回答/撤回，本次未产生写入');
      }
      insertCommentRow(db, {
        issue_id: decision.issue_id,
        author: 'system',
        content:
          decision.state === 'grace'
            ? `决策已撤回（宽限取消，卡保持占用；decision=${decision.id}）：${reason}`
            : `决策已撤回并解锁（卡保持待规划，需手动派工；decision=${decision.id}）：${reason}`,
      });
      return getDecisionDetail(db, decision.id, now)!;
    })
    .immediate();
}

/** 供 DEC-9/DEC-3 复用的「是否存在 in-flight 决策」查询 */
export function hasActiveDecision(db: Db, issueId: string): boolean {
  return findActiveDecision(db, issueId) !== null;
}

/** 供 DEC-2 投影复用：一卡当前锁/宽限状态 */
export interface IssueDecisionProjection {
  decision_locked: boolean;
  open_decision_id: string | null;
  decision_grace_until: number | null;
}

export function issueDecisionProjection(db: Db, issueId: string): IssueDecisionProjection {
  const active = findActiveDecision(db, issueId);
  if (!active) return { decision_locked: false, open_decision_id: null, decision_grace_until: null };
  return {
    decision_locked: active.state === 'open',
    open_decision_id: active.id,
    decision_grace_until: active.state === 'grace' ? active.grace_until : null,
  };
}

