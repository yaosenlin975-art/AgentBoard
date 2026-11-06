import type { Issue, IssueComment } from '@agentboard/shared';
import { CLAIM_LEASE_MS } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { decisionLockedError, findGraceDecisionId, findOpenDecisionId, getIssue, type IssuePatch } from '../db/repos/issue.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { ApiError } from '../errors.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';
import { updateIssueInHierarchy } from './taskHierarchy.js';
import { blockedClaimMessage, unresolvedBlockers } from './dependency.js';
import { dropIssueGitBaseline } from './gitBaseline.js';

export function requireIssueInWorkspace(db: Db, issueId: string, workspaceId: string): Issue {
  const issue = getIssue(db, issueId, workspaceId);
  if (!issue) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在');
  return issue;
}

/**
 * BORROW-0.3：fence 软校验。fence 缺席（undefined/null）= 软模式直接放行（旧调用方零改动）；
 * 传了就必须等于当前占用代次，旧 fence → 409 STALE_FENCE。
 * 调用点必须放在事务内、任何写 UPDATE 之前，保证零写入。
 */
export function assertFenceCurrent(db: Db, issueId: string, fence: number | null | undefined): void {
  if (fence === undefined || fence === null) return;
  if (!Number.isSafeInteger(fence) || fence < 0) throw new ValidationError('fence 不合法（需 ≥0 整数）');
  const row = db.prepare('SELECT claim_fence FROM issue WHERE id=?').get(issueId) as { claim_fence: number } | undefined;
  if (!row) throw new NotFoundError('任务不存在');
  if (row.claim_fence !== fence) {
    throw new ApiError(409, 'STALE_FENCE', `占用代次已过期（请求 fence=${fence}，当前=${row.claim_fence}）；重新 kb claim 获取新 fence 后再收尾`);
  }
}
export function updateIssueWithCAS(db: Db, issueId: string, workspaceId: string, expectedUpdatedAt: number, patch: IssuePatch): Issue {
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new ValidationError('expected_updated_at 不合法');
  return db.transaction(() => {
    const issue = requireIssueInWorkspace(db, issueId, workspaceId);
    if (issue.claimed_by && patch.status !== undefined) throw new ConflictError('占用中禁止修改状态');
    return updateIssueInHierarchy(db, issueId, patch, { workspaceId, expectedUpdatedAt });
  }).immediate();
}
/**
 * LEASE-GAP：租约过期被 `sweepExpiredLeases` 清空占用（claimed_by=NULL）后，原占用代次仍可用本地 fence 收尾。
 * 不加这条口子，卡会停在「进行中 + 无人占用」：claim 要求待规划、done/fail 要求有人占用，两边都进不去。
 * 安全性来自 fence 本身：抢占会自增 claim_fence，旧代次在任何写之前就落 STALE_FENCE；
 * 因此「fence 等于当前代次 + 无人占用 + 状态仍为进行中」只可能由该代次的原始持有者触发。
 * fence 缺席（undefined/null，软模式）不享受该口子。
 */
function isLeaseExpiredTakeover(issue: Issue, fence: number | null | undefined): boolean {
  return issue.claimed_by === null && issue.status === '进行中' && fence !== undefined && fence !== null;
}

function scopedFinish(db: Db, issueId: string, workspaceId: string, actorId: string, action: 'done' | 'fail' | 'release', detail?: string, fence?: number): ClaimActionResult {
  if (!actorId?.trim()) throw new ValidationError('agent_id 不能为空');
  if (action === 'fail' && !detail?.trim()) throw new ValidationError('失败原因不能为空');
  return db.transaction(() => {
    const issue = requireIssueInWorkspace(db, issueId, workspaceId);
    // REL-1：fence 校验先于占用者校验 —— 批量退回后占用已清空，旧代次必须直接落 STALE_FENCE
    // （否则会被「非占用者」抢先报错，掩盖真正的过期原因）
    assertFenceCurrent(db, issueId, fence);
    const leaseExpiredTakeover = isLeaseExpiredTakeover(issue, fence);
    if (issue.claimed_by !== actorId && !leaseExpiredTakeover) throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可执行此操作');
    const nextStatus = action === 'done' ? '待验收' : '待规划';
    const result = leaseExpiredTakeover
      ? db.prepare(`UPDATE issue SET status=?,claimed_by=NULL,claimed_at=NULL,claim_lease_until=NULL,last_heartbeat_at=NULL,session_id=NULL,last_seen_comment_id=NULL,updated_at=MAX(?,updated_at+1) WHERE id=? AND workspace_id=? AND claimed_by IS NULL AND status='进行中'`)
        .run(nextStatus, Date.now(), issueId, workspaceId)
      : db.prepare(`UPDATE issue SET status=?,claimed_by=NULL,claimed_at=NULL,claim_lease_until=NULL,last_heartbeat_at=NULL,session_id=NULL,last_seen_comment_id=NULL,updated_at=MAX(?,updated_at+1) WHERE id=? AND workspace_id=? AND claimed_by=?`)
        .run(nextStatus, Date.now(), issueId, workspaceId, actorId);
    if (result.changes !== 1) throw new ApiError(409, 'NOT_TASK_OWNER', '任务占用已改变');
    if (leaseExpiredTakeover) {
      insertCommentRow(db, {
        issue_id: issueId,
        author: 'system',
        content: `占用租约已过期（占用被系统释放，fence=${fence}），原占用代次仍以该 fence 完成 ${action}（LEASE-GAP）`,
      });
    }
    const content = action === 'release' ? '占用者释放任务' : detail?.trim();
    const comment = content ? insertCommentRow(db, { issue_id: issueId, author: `agent:${actorId}`, content }) : null;
    return { issue: getIssue(db, issueId)!, comment };
  }).immediate();
}
export function releaseClaimedIssue(db: Db, issueId: string, workspaceId: string, actorId: string, fence?: number): ClaimActionResult {
  return scopedFinish(db, issueId, workspaceId, actorId, 'release', undefined, fence);
}
export function finishClaimedIssue(db: Db, issueId: string, workspaceId: string, actorId: string, action: 'done' | 'fail', detail?: string, fence?: number): ClaimActionResult {
  return scopedFinish(db, issueId, workspaceId, actorId, action, detail, fence);
}

/** done/fail/release 返回：流转后的 issue + 本次自动评论（done 无 notes 时 comment 为 null） */
export interface ClaimActionResult {
  issue: Issue;
  comment: IssueComment | null;
}

/**
 * 原子领取：并发领取仅一个成功；允许从"进行中"领取（覆盖用户手动拖到进行中后再派发）。
 * sessionId 传 null 即 REST/kb 的纯占用登记（不绑会话，评论不触发唤醒）。
 * 留言游标同步置为领取前最新评论；有未验证图片时停在首条图片评论之前，保持图片及其后续评论待读。
 * DEP-1 依赖门禁：前置未解除 → 409（守卫在同一个 IMMEDIATE 事务内，与占用更新原子）；`done`/`fail`/`release` 不受依赖影响。
 * BORROW-0.3：事务内读回新 fence，随返回值透出（调用方持久化后供收尾写入口校验）。
 */
export function claimIssue(db: Db, issueId: string, agentId: string, sessionId: string | null): Issue & { claim_fence: number } {
  return db.transaction(() => {
    const blockers = unresolvedBlockers(db, issueId);
    if (blockers.length > 0) throw new ConflictError(blockedClaimMessage(blockers));
    const now = Date.now();
    const firstImage = db.prepare(`SELECT c.id,c.ts FROM issue_comment c
      JOIN comment_attachment ca ON ca.comment_id=c.id
      WHERE c.issue_id=? ORDER BY c.ts,c.id LIMIT 1`).get(issueId) as { id: string; ts: number } | undefined;
    let lastSeenCommentId: string | null;
    if (firstImage) {
      const previous = db.prepare(`SELECT id FROM issue_comment
        WHERE issue_id=? AND (ts<? OR (ts=? AND id<?)) ORDER BY ts DESC,id DESC LIMIT 1`)
        .get(issueId, firstImage.ts, firstImage.ts, firstImage.id) as { id: string } | undefined;
      lastSeenCommentId = previous?.id ?? null;
    } else {
      const latest = db.prepare('SELECT id FROM issue_comment WHERE issue_id=? ORDER BY ts DESC,id DESC LIMIT 1')
        .get(issueId) as { id: string } | undefined;
      lastSeenCommentId = latest?.id ?? null;
    }
    const leaseUntil = now + CLAIM_LEASE_MS;
    // BORROW-0.2：租约抢占——占用者的 claim_lease_until 已过期视同无主，可直接抢占；
    // 租约 NULL（存量占用/老版本写入）无法判定新旧，保守不抢（交给 sweep/zombie 流程）。
    // fence 每次领取（含抢占）自增，代次供 B03 校验；last_heartbeat_at 与领取时刻同值起算。
    const row = db.prepare(
      `UPDATE issue SET claimed_by=?, claimed_at=?, claim_lease_until=?, claim_fence=COALESCE(claim_fence,0)+1,
         last_heartbeat_at=?, session_id=?, status='进行中', last_seen_comment_id=?, updated_at=?
       WHERE id=? AND status IN ('待规划','进行中')
         AND (claimed_by IS NULL OR (claim_lease_until IS NOT NULL AND claim_lease_until < ?))
         AND NOT EXISTS (SELECT 1 FROM issue_decision d WHERE d.issue_id=issue.id AND d.state='open')`
    ).run(agentId, now, leaseUntil, now, sessionId, lastSeenCommentId, now, issueId, now);
    if (row.changes !== 1) {
      // CLAIM-MSG：占用冲突与「状态不可领取」是两件事，文案必须分开（同报「已被占用」会让执行者误以为撞卡而放弃）
      const current = db.prepare('SELECT status, claimed_by FROM issue WHERE id=?').get(issueId) as
        { status: string; claimed_by: string | null } | undefined;
      if (!current) throw new NotFoundError('任务不存在');
      // DEC-2：锁优先判定——卡可能已无人占用（被落锁时释放），此时不能误报「状态不可领取」
      const lockedDecisionId = findOpenDecisionId(db, issueId);
      if (lockedDecisionId) throw decisionLockedError(db, issueId, lockedDecisionId, '领取');
      if (current.claimed_by !== null) {
        throw new ApiError(409, 'ISSUE_CLAIMED', `已被 ${current.claimed_by} 占用；先 release 或换卡，勿重复 claim`);
      }
      throw new ApiError(409, 'ISSUE_STATUS_NOT_CLAIMABLE',
        `状态不可领取（当前=${current.status}，需=待规划 或 进行中）；无人占用，待验收卡由 owner 验收或由父代理退回待规划`);
    }
    const fenceRow = db.prepare('SELECT claim_fence FROM issue WHERE id=?').get(issueId) as { claim_fence: number };
    return { ...getIssue(db, issueId)!, claim_fence: fenceRow.claim_fence };
  }).immediate();
}

/** heartbeat 续租返回的租约快照 */
export interface ClaimLeaseInfo {
  claimed_by: string;
  claim_fence: number;
  claim_lease_until: number;
  last_heartbeat_at: number;
}

/**
 * BORROW-0.2：占用续租。只有当前占用者可续；不 bump 任务内容（不触发 CAS 冲突面），
 * updated_at 由 issue_monotonic_time 触发器兜底推进。
 * BORROW-0.3：fence 软校验——旧代次持有者的心跳不得覆盖新占用者的租约（0.2 已知缺口在此闭合）。
 */
export function heartbeatClaim(db: Db, issueId: string, agentId: string, fence?: number): ClaimLeaseInfo {
  if (!agentId?.trim()) throw new ValidationError('agent_id 不能为空');
  return db.transaction(() => {
    const row = db.prepare('SELECT claimed_by, claim_fence, claim_lease_until FROM issue WHERE id=?')
      .get(issueId) as { claimed_by: string | null; claim_fence: number; claim_lease_until: number | null } | undefined;
    if (!row) throw new NotFoundError('任务不存在');
    if (row.claimed_by === null) throw new ConflictError('未被占用，无需续租');
    if (row.claimed_by !== agentId) throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可续租');
    assertFenceCurrent(db, issueId, fence);
    const now = Date.now();
    const leaseUntil = now + CLAIM_LEASE_MS;
    db.prepare('UPDATE issue SET claim_lease_until=?, last_heartbeat_at=? WHERE id=?')
      .run(leaseUntil, now, issueId);
    return { claimed_by: agentId, claim_fence: row.claim_fence, claim_lease_until: leaseUntil, last_heartbeat_at: now };
  }).immediate();
}

/**
 * BORROW-0.2：启动清扫过期占用租约。只清占用（claimed_by/claimed_at/租约/心跳/会话/游标），
 * 任务状态原样保留（领取即「进行中」，清扫不动状态=保留「进行中」）；写 system 评论留痕；
 * 基线（GIT-ON-DONE）随之作废。租约 NULL 的占用不在清扫范围（无法判定新旧）。
 * 返回清扫数（启动日志与用例断言用）。
 */
export function sweepExpiredLeases(db: Db, now: number = Date.now()): number {
  // DEC-2：宽限期内的占用不得被清扫——agent 正在等人类回答，清掉占用会让它无法收尾/续跑。
  // open（已落锁）的卡占用本已被落锁流程清空，这里只显式排除 grace。
  const expired = db.prepare(
    `SELECT id, claimed_by, claim_lease_until FROM issue
     WHERE claimed_by IS NOT NULL AND claim_lease_until IS NOT NULL AND claim_lease_until < ?
       AND NOT EXISTS (SELECT 1 FROM issue_decision d WHERE d.issue_id=issue.id AND d.state='grace')`,
  ).all(now) as Array<{ id: string; claimed_by: string; claim_lease_until: number }>;
  if (expired.length === 0) return 0;
  const leaseMinutes = Math.round(CLAIM_LEASE_MS / 60000);
  return db.transaction(() => {
    let swept = 0;
    for (const row of expired) {
      // DEC-2 二次防线：扫描后、写回前若刚建了 grace 决策，也跳过（同一 IMMEDIATE 事务内）
      if (findGraceDecisionId(db, row.id)) continue;
      // 条件带 claimed_by + 旧租约值：并发续租/释放后本行不重复清
      const changed = db.prepare(
        `UPDATE issue SET claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL,
           session_id=NULL, last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
         WHERE id=? AND claimed_by=? AND claim_lease_until=?`,
      ).run(now, row.id, row.claimed_by, row.claim_lease_until);
      if (changed.changes !== 1) continue;
      insertCommentRow(db, {
        issue_id: row.id,
        author: 'system',
        content: `占用租约过期（超过 ${leaseMinutes} 分钟无心跳），系统自动释放占用；任务保留「进行中」，可直接重新领取`,
      });
      dropIssueGitBaseline(db, row.id);
      swept += 1;
    }
    return swept;
  }).immediate();
}

/**
 * 完成：待验收 + 释放占用；notes 非空时经 comments.addComment 落评论(author=agent:<id>)。
 * agent/system 作者不触发唤醒，且 addComment 的 DB 段同步完成、可嵌套在外层事务内，
 * 因此"状态流转 + 评论"仍在同一事务提交；返回的 promise 在事务提交后 await。
 */
export async function doneIssue(
  db: Db,
  issueId: string,
  agentId: string,
  notes?: string,
  fence?: number,
): Promise<ClaimActionResult> {
  // CLAIM-RACE：读与写在**同一个 IMMEDIATE 事务**内完成（不再先读后写），
  // 条件 UPDATE 的 changes!==1 已是并发下的唯一真相；评论也用同步 insertCommentRow 落库，
  // 因此事务里没有任何 await（agent/system 作者不触发唤醒，无需 addComment 的异步段）。
  const now = Date.now();
  const writeNote = notes !== undefined && notes.trim() !== '';
  const result = db.transaction(() => {
    const issue = getIssue(db, issueId);
    if (!issue) throw new NotFoundError('任务不存在');
    // REL-1：fence 校验先于占用状态校验 —— 批量退回会 bump 代次，旧 fence 必须落 STALE_FENCE
    assertFenceCurrent(db, issueId, fence);
    // LEASE-GAP：租约过期被 sweep 清空占用后，原代次仍可收尾（fence 已校验匹配；抢占会自增 fence）
    const leaseExpiredTakeover = isLeaseExpiredTakeover(issue, fence) && agentId !== 'user';
    if (issue.claimed_by === null && !leaseExpiredTakeover) throw new ConflictError('未被占用');
    if (agentId !== 'user' && issue.claimed_by !== agentId && !leaseExpiredTakeover) {
      throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可完成任务');
    }
    const changed = leaseExpiredTakeover
      ? db.prepare(
        `UPDATE issue SET status='待验收', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL, session_id=NULL,
           last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
         WHERE id=? AND claimed_by IS NULL AND status='进行中'`,
      ).run(now, issueId)
      : db.prepare(
        `UPDATE issue SET status='待验收', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL, session_id=NULL,
           last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
         WHERE id=? AND claimed_by=?`,
      ).run(now, issueId, agentId === 'user' ? issue.claimed_by : agentId);
    if (changed.changes !== 1) throw new ConflictError('占用已改变（并发完成/释放），未产生任何写入');
    if (leaseExpiredTakeover) {
      insertCommentRow(db, {
        issue_id: issueId,
        author: 'system',
        content: `占用租约已过期（占用被系统释放，fence=${fence}），原占用代次仍以该 fence 完成 done（LEASE-GAP）`,
      });
    }
    const comment = writeNote ? insertCommentRow(db, { issue_id: issueId, author: `agent:${agentId}`, content: notes!.trim() }) : null;
    return { issue: getIssue(db, issueId)!, comment };
  }).immediate();
  return result;
}

/** 失败回报：回待规划 + 释放占用；reason 必填，经 comments.addComment 落评论(author=agent:<id>) */
export async function failIssue(
  db: Db,
  issueId: string,
  agentId: string,
  reason: string,
  expectedSessionId?: string,
  fence?: number,
): Promise<ClaimActionResult> {
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new ValidationError('失败原因不能为空');
  }
  // CLAIM-RACE：同 doneIssue——读与写同事务、条件 UPDATE + changes 校验、评论同步落库、事务内无 await
  const now = Date.now();
  return db.transaction(() => {
    const issue = getIssue(db, issueId);
    if (!issue) throw new NotFoundError('任务不存在');
    // LEASE-GAP：租约过期被 sweep 清空占用后，原代次仍可回报失败（fence 校验在下方仍是权威判定）
    const leaseExpiredTakeover = isLeaseExpiredTakeover(issue, fence) && agentId !== 'user';
    if (issue.claimed_by === null && !leaseExpiredTakeover) throw new ConflictError('未被占用');
    const boundSessionFailure = expectedSessionId !== undefined && issue.session_id === expectedSessionId;
    if (agentId !== 'user' && issue.claimed_by !== agentId && !leaseExpiredTakeover && !boundSessionFailure) {
      throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可回报失败');
    }
    assertFenceCurrent(db, issueId, fence);
    const changed = leaseExpiredTakeover
      ? db.prepare(
        `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL, session_id=NULL,
           last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
         WHERE id=? AND claimed_by IS NULL AND status='进行中'`,
      ).run(now, issueId)
      : db.prepare(
        `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL, session_id=NULL,
           last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
         WHERE id=? AND claimed_by=? AND session_id IS ?`,
      ).run(now, issueId, issue.claimed_by, issue.session_id);
    if (changed.changes !== 1) throw new ConflictError('占用已改变（并发完成/释放），未产生任何写入');
    if (leaseExpiredTakeover) {
      insertCommentRow(db, {
        issue_id: issueId,
        author: 'system',
        content: `占用租约已过期（占用被系统释放，fence=${fence}），原占用代次仍以该 fence 完成 fail（LEASE-GAP）`,
      });
    }
    const comment = insertCommentRow(db, { issue_id: issueId, author: `agent:${agentId}`, content: reason.trim() });
    return { issue: getIssue(db, issueId)!, comment };
  }).immediate();
}

/** 用户强制释放：回待规划 + 清空占用 + 经 comments.addComment 落 system 评论 */
export async function releaseIssue(db: Db, issueId: string, fence?: number): Promise<ClaimActionResult> {
  // CLAIM-RACE：单事务内「存在性校验 + 条件 UPDATE(changes) + system 评论」；用户强制释放不要求占用者匹配
  const now = Date.now();
  return db.transaction(() => {
    assertFenceCurrent(db, issueId, fence);
    const changed = db.prepare(
      `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, claim_lease_until=NULL, last_heartbeat_at=NULL, session_id=NULL,
         last_seen_comment_id=NULL, updated_at=MAX(?,updated_at+1)
       WHERE id=?`,
    ).run(now, issueId);
    if (changed.changes !== 1) throw new NotFoundError('任务不存在');
    const comment = insertCommentRow(db, { issue_id: issueId, author: 'system', content: '用户强制释放' });
    return { issue: getIssue(db, issueId)!, comment };
  }).immediate();
}

/** 服务层守卫：占用中的 issue 拒绝 status 变更，其余字段放行；BORROW-0.3 增 fence 软校验（写前断言，零写入） */
export function updateIssueGuarded(db: Db, id: string, patch: IssuePatch, fence?: number): Issue {
  return db.transaction(() => {
    const issue = getIssue(db, id);
    if (!issue) throw new NotFoundError('任务不存在');
    if (issue.claimed_by !== null && patch.status !== undefined) {
      throw new ConflictError('占用中禁止修改状态');
    }
    assertFenceCurrent(db, id, fence);
    return updateIssueInHierarchy(db, id, patch);
  }).immediate();
}
