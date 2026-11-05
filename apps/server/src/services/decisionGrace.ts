/**
 * DEC-9：宽限计时器与停止信号通道（设计 v3 §3.2 / §4.3 / §4.3.1 / §7 DEC-9）。
 *
 * - ticker 每 2 秒扫描 `state='grace' AND grace_until <= now` 的决策，事务内复用
 *   DEC-1 的 `lockIssueForDecision`（grace→open、卡回待规划、清占用、bump fence、写系统评论）。
 * - 幂等：落锁后决策状态不再是 grace，后续 tick 不会再命中；并发回答先到则抛 Conflict 被跳过。
 * - 重启补算：启动时跑一次同样的扫描——`grace_until <= now` 立即落锁，`> now` 的原样留给 ticker，
 *   不提前、不消失（避免留下「永远宽限」的卡）。
 * - grace_seconds=0 不经过本模块（提问事务内已 open）。
 * - 停止信号只在落锁时写 `stop_requested_at`；心跳 / `GET /issues/:id/stop` / `kb stop-check`
 *   直接读 `getStopState`，2 秒级可读由 ticker 精度保证。
 */
import type { Db } from '../db/connection.js';
import type { ServerWsEvent } from '@agentboard/shared';
import { getDecision } from '../db/repos/decision.js';
import { getIssue } from '../db/repos/issue.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { lockIssueForDecision } from './decision.js';

/** 设计定稿：ticker 与 stop-check 均为 2 秒级 */
export const GRACE_TICK_INTERVAL_MS = 2000;
/** 单次 tick 上限，避免一次事务风暴；剩余的下个 tick 继续 */
export const GRACE_TICK_BATCH = 50;

export interface GraceSweepOptions {
  /** 判定时刻（默认 Date.now；测试可注入） */
  now?: number;
  /** WS 广播（缺省静默） */
  broadcast?: (event: ServerWsEvent) => void;
  limit?: number;
}

export interface GraceSweepResult {
  /** 本次真正发生 grace→open 的决策 id */
  locked: string[];
  /** 命中但被并发回答/删除等抢先，未产生锁副作用 */
  skipped: string[];
}

interface DueGraceRow {
  id: string;
  workspace_id: string;
  issue_id: string;
  grace_until: number;
}

function listDueGrace(db: Db, now: number, limit: number): DueGraceRow[] {
  return db
    .prepare(
      `SELECT id, workspace_id, issue_id, grace_until
         FROM issue_decision
        WHERE state='grace' AND grace_until <= ?
        ORDER BY grace_until ASC, id ASC
        LIMIT ?`,
    )
    .all(now, limit) as DueGraceRow[];
}

function emitIssueChanged(db: Db, issueId: string, broadcast?: (event: ServerWsEvent) => void): void {
  if (!broadcast) return;
  const issue = getIssue(db, issueId);
  if (issue) broadcast({ type: 'issue.changed', issue });
}

/**
 * 扫一轮到期 grace 决策并落锁。可重复调用（幂等）。
 * 事件名严格对齐 DEC-3 定稿：decision.expired + issue.stop_requested（+ 卡面刷新 issue.changed）。
 */
export function sweepGraceDecisions(db: Db, options: GraceSweepOptions = {}): GraceSweepResult {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? GRACE_TICK_BATCH;
  const locked: string[] = [];
  const skipped: string[] = [];
  for (const row of listDueGrace(db, now, limit)) {
    try {
      const result = lockIssueForDecision(db, row.id, { now, reason: 'grace_expired' });
      // 只有本次仍处于 open 且原本是 grace 的才算真正落锁；lock 内部并发抢占时状态可能已变
      const decision = getDecision(db, row.id);
      if (!decision || decision.state !== 'open') {
        skipped.push(row.id);
        continue;
      }
      locked.push(row.id);
      options.broadcast?.({
        type: 'decision.expired',
        workspace_id: row.workspace_id,
        issue_id: row.issue_id,
        decision_id: row.id,
        state: 'open',
        grace_until: result.decision.grace_until,
        reason: 'grace_expired',
      });
      options.broadcast?.({
        type: 'issue.stop_requested',
        workspace_id: row.workspace_id,
        issue_id: row.issue_id,
        decision_id: row.id,
        state: 'open',
        reason: 'grace_expired',
      });
      emitIssueChanged(db, row.issue_id, options.broadcast);
    } catch (error) {
      // 并发回答先到（answered）或卡被删（NotFound）：本次不产生锁副作用，留给下一轮/其它路径
      if (error instanceof ConflictError || error instanceof NotFoundError) {
        skipped.push(row.id);
        continue;
      }
      throw error;
    }
  }
  return { locked, skipped };
}

/**
 * 启动补算（设计 §4.3.1 / 风险 R4）：与 sweep 同一实现，语义上只在进程启动调用一次。
 * grace_until > now 的决策保持 grace，由随后的 ticker 按原截止时刻落锁。
 */
export function recoverGraceOnBoot(db: Db, options: Omit<GraceSweepOptions, 'now'> & { now?: number } = {}): GraceSweepResult {
  return sweepGraceDecisions(db, options);
}

export interface GraceTickerHandle {
  /** 立即跑一轮（测试/重启补算用） */
  tick: (now?: number) => GraceSweepResult;
  /** 停止计时器（幂等） */
  stop: () => void;
}

export interface GraceTickerOptions {
  intervalMs?: number;
  broadcast?: (event: ServerWsEvent) => void;
  limit?: number;
  /** 定时器注入（测试用；缺省全局 setInterval/clearInterval） */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** 单个 tick 抛错时的观察钩子（缺省 console.error，不吞掉但也不停表） */
  onError?: (error: unknown) => void;
}

/**
 * 启动 grace→open 计时器：先跑一次启动补算，再按 2 秒周期扫描。
 * 返回句柄供测试/进程退出时停表。
 */
export function startDecisionGraceTicker(db: Db, options: GraceTickerOptions = {}): GraceTickerHandle {
  const intervalMs = options.intervalMs ?? GRACE_TICK_INTERVAL_MS;
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const onError = options.onError ?? ((error: unknown) => console.error('[decision-grace] tick failed', error));
  const tick = (now?: number): GraceSweepResult => {
    try {
      return sweepGraceDecisions(db, { now, broadcast: options.broadcast, limit: options.limit });
    } catch (error) {
      onError(error);
      return { locked: [], skipped: [] };
    }
  };
  // 启动补算：grace_until <= now 立即落锁；> now 留给周期 tick
  tick();
  const handle = schedule(() => {
    tick();
  }, intervalMs);
  let stopped = false;
  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel(handle);
    },
  };
}
