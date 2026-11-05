/**
 * REL-1：工作区级「批量退回待规划」。
 *
 * 契约：POST /api/workspaces/:workspaceId/release-running
 * body：`{ mode: 'expired' | 'all', issue_ids?: string[], dry_run?: boolean }`
 *
 * 语义（与卡面验收一一对应）：
 * - workspace 只从路径参数取；路由层先做存在性校验（404）。
 * - mode='expired'（默认）：无主卡 + 租约已过期的卡纳入；新鲜租约 → LEASE_ACTIVE；
 *   有主但无租约（无法判定）→ UNDETERMINED；老库无租约列 → 用
 *   `now - COALESCE(last_heartbeat_at, claimed_at) >= CLAIM_LEASE_MS` 退化判定。
 * - mode='all'：忽略上述过滤，本区全部「进行中」都退回。
 * - 写回与单卡强制释放同语义：回「待规划」、清空占用/会话/游标；额外 bump claim_fence，
 *   使旧代次的 done/release/heartbeat 立刻失效（否则旧 fence 与当前代次相等，校验形同虚设）。
 * - 单事务 IMMEDIATE：选卡与写回同一事务，任一失败整批回滚。
 * - dry_run 零写入（不落评论、不动行、不删基线）。
 */
import type { Issue } from '@agentboard/shared';
import { CLAIM_LEASE_MS } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { addComment } from '../db/repos/comment.js';
import { ConflictError } from '../errors.js';
import { dropIssueGitBaseline } from './gitBaseline.js';

export type ReleaseSkipReason = 'LEASE_ACTIVE' | 'UNDETERMINED' | 'NOT_IN_WORKSPACE' | 'NOT_RUNNING';

export interface ReleaseRunningInput {
  mode?: 'expired' | 'all';
  issue_ids?: string[];
  dry_run?: boolean;
}

export interface ReleaseRunningResult {
  released: Issue[];
  skipped: Array<{ id: string; reason: ReleaseSkipReason }>;
}

interface RunningRow {
  id: string;
  claimed_by: string | null;
  claimed_at: number | null;
  claim_lease_until: number | null;
  last_heartbeat_at: number | null;
  claim_fence: number | null;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** 静默分钟 = 距最近一次心跳（无心跳则领取时刻）的分钟数；无法判定写 0 */
function silentMinutes(row: RunningRow, now: number): number {
  const anchor = row.last_heartbeat_at ?? row.claimed_at ?? now;
  return Math.max(0, Math.round((now - anchor) / 60000));
}

function auditLine(row: RunningRow, mode: string, now: number): string {
  const holder = row.claimed_by ?? '无';
  const silent = row.claimed_by === null ? 0 : silentMinutes(row, now);
  return `批量退回待规划（操作者=user，原占用者=${holder}，静默=${silent}分钟，mode=${mode}）`;
}

/**
 * 判定单卡是否在 mode='expired' 下可退：
 * 返回 null=可退；否则返回跳过原因。
 */
function expiredSkipReason(
  row: RunningRow,
  now: number,
  leaseColumn: boolean,
  heartbeatColumn: boolean,
): ReleaseSkipReason | null {
  if (row.claimed_by === null) return null;
  if (leaseColumn && row.claim_lease_until !== null) {
    return row.claim_lease_until < now ? null : 'LEASE_ACTIVE';
  }
  // 老库 / 租约列为空：无法判定新旧 → 退化用「静默时长」阈值；仍无心跳列时保守跳过
  if (!heartbeatColumn) return 'UNDETERMINED';
  const anchor = row.last_heartbeat_at ?? row.claimed_at;
  if (anchor === null) return 'UNDETERMINED';
  return now - anchor >= CLAIM_LEASE_MS ? null : 'UNDETERMINED';
}

export function releaseRunning(
  db: Db,
  workspaceId: string,
  input: ReleaseRunningInput = {},
): ReleaseRunningResult {
  const mode = input.mode ?? 'expired';
  const dryRun = input.dry_run === true;
  const now = Date.now();
  const leaseColumn = hasColumn(db, 'issue', 'claim_lease_until');
  const heartbeatColumn = hasColumn(db, 'issue', 'last_heartbeat_at');
  const selectSql = `SELECT id, claimed_by, claimed_at, claim_lease_until, last_heartbeat_at, claim_fence
    FROM issue WHERE workspace_id=? AND status='进行中' ORDER BY created_at, id`;

  return db.transaction((): ReleaseRunningResult => {
    const running = db.prepare(selectSql).all(workspaceId) as RunningRow[];
    const runningIds = new Set(running.map((row) => row.id));
    const skipped: Array<{ id: string; reason: ReleaseSkipReason }> = [];

    const requested = input.issue_ids;
    if (requested !== undefined) {
      for (const id of requested) {
        if (runningIds.has(id)) continue;
        const row = db.prepare('SELECT workspace_id FROM issue WHERE id=?').get(id) as
          | { workspace_id: string }
          | undefined;
        skipped.push({ id, reason: row === undefined || row.workspace_id !== workspaceId ? 'NOT_IN_WORKSPACE' : 'NOT_RUNNING' });
      }
    }

    const released: Issue[] = [];
    for (const row of running) {
      if (requested !== undefined && !requested.includes(row.id)) continue;
      if (mode === 'expired') {
        const reason = expiredSkipReason(row, now, leaseColumn, heartbeatColumn);
        if (reason !== null) {
          skipped.push({ id: row.id, reason });
          continue;
        }
      }
      if (!dryRun) {
        const setLease = leaseColumn ? 'claim_lease_until=NULL, ' : '';
        const setHeartbeat = heartbeatColumn ? 'last_heartbeat_at=NULL, ' : '';
        const fenceSet = hasColumn(db, 'issue', 'claim_fence') ? 'claim_fence=COALESCE(claim_fence,0)+1, ' : '';
        // 条件 UPDATE 带 status/claimed_by/租约值：并发续租或已被别人释放时 changes=0 → 整批回滚
        const changed = db.prepare(
          `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, ${setLease}${setHeartbeat}
             session_id=NULL, last_seen_comment_id=NULL, ${fenceSet}updated_at=MAX(?,updated_at+1)
           WHERE id=? AND workspace_id=? AND status='进行中'`,
        ).run(now, row.id, workspaceId);
        if (changed.changes !== 1) throw new ConflictError(`批量退回冲突：任务 ${row.id} 状态已变化，整批回滚`);
        addComment(db, { issue_id: row.id, author: 'system', content: auditLine(row, mode, now) });
        dropIssueGitBaseline(db, row.id);
      }
      released.push(getIssue(db, row.id)!);
    }

    return { released, skipped };
  }).immediate();
}
