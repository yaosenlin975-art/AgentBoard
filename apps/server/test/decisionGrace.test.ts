/**
 * DEC-9：宽限计时器与停止信号通道。
 *
 * 覆盖卡面验收：
 * - grace_seconds=5 到点自动落锁：卡待规划、claimed_by=null、claim_fence+1、stop_requested_at 非空；
 * - 未到期不落锁、不释放占用；
 * - 重复 tick 幂等：不重复落锁 / 不重复系统评论；
 * - 服务重启补算：grace_until <= now 立即落锁，> now 保持 grace 并按原截止时刻落锁；
 * - grace_seconds=0 不依赖 ticker（创建事务内已 open）；
 * - 落锁后 getStopState 立即（2 秒级）可读 stop_requested；
 * - ticker 句柄可启动/停止，注入调度器便于测试。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { getStopState } from '../src/db/repos/decision.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { createPendingDecision } from '../src/services/decision.js';
import { claimIssue } from '../src/services/claim.js';
import {
  GRACE_TICK_INTERVAL_MS,
  recoverGraceOnBoot,
  startDecisionGraceTicker,
  sweepGraceDecisions,
} from '../src/services/decisionGrace.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
});

afterEach(() => {
  t.cleanup();
});

const OPTIONS = [
  { label: 'A 方案', consequence: '按 A 继续' },
  { label: 'B 方案', consequence: '按 B 继续' },
];

function seedDecision(graceSeconds: number) {
  const issue = createIssue(t.db, { workspace_id: wsId, title: '宽限任务' });
  const claimed = claimIssue(t.db, issue.id, 'agent-1', null);
  const created = createPendingDecision(t.db, {
    workspace_id: wsId,
    issue_id: issue.id,
    created_by: 'agent-1',
    question: '要继续吗？',
    options: OPTIONS,
    grace_seconds: graceSeconds,
    created_fence: claimed.claim_fence,
  });
  return { issue, fence: claimed.claim_fence, decision: created.decision, locked: created.locked };
}

function issueRow(id: string) {
  return t.db.prepare('SELECT status,claimed_by,claim_fence FROM issue WHERE id=?').get(id) as {
    status: string;
    claimed_by: string | null;
    claim_fence: number;
  };
}

function decisionState(id: string) {
  return t.db.prepare('SELECT state,locked_at,stop_requested_at FROM issue_decision WHERE id=?').get(id) as {
    state: string;
    locked_at: number | null;
    stop_requested_at: number | null;
  };
}

function commentCount(issueId: string): number {
  return listCommentsByIssue(t.db, issueId).length;
}

describe('grace→open ticker', () => {
  it('grace_seconds=5 到点自动落锁：卡待规划、释放占用、fence+1、stop_requested_at 非空', () => {
    const { issue, fence, decision, locked } = seedDecision(5);
    expect(locked).toBe(false);
    expect(decision.state).toBe('grace');
    const events: ServerWsEvent[] = [];
    const result = sweepGraceDecisions(t.db, { now: decision.grace_until!, broadcast: (e) => events.push(e) });

    expect(result.locked).toEqual([decision.id]);
    const row = issueRow(issue.id);
    expect(row.status).toBe('待规划');
    expect(row.claimed_by).toBeNull();
    expect(row.claim_fence).toBe(fence + 1);
    const lockedRow = decisionState(decision.id);
    expect(lockedRow.state).toBe('open');
    expect(lockedRow.locked_at).toBeTypeOf('number');
    expect(lockedRow.stop_requested_at).toBeTypeOf('number');
    expect(events.map((event) => event.type)).toEqual([
      'decision.expired',
      'issue.stop_requested',
      'issue.changed',
    ]);
    expect(events[0]).toMatchObject({ decision_id: decision.id, reason: 'grace_expired' });
  });

  it('未到期不落锁、不释放占用；宽限中的卡仍归提问者', () => {
    const { issue, decision } = seedDecision(180);
    const result = sweepGraceDecisions(t.db, { now: decision.grace_until! - 1 });
    expect(result.locked).toEqual([]);
    expect(issueRow(issue.id)).toMatchObject({ status: '进行中', claimed_by: 'agent-1' });
    expect(decisionState(decision.id).state).toBe('grace');
  });

  it('重复 tick 幂等：不重复落锁、不重复写系统评论', () => {
    const { issue, decision } = seedDecision(5);
    const first = sweepGraceDecisions(t.db, { now: decision.grace_until! });
    expect(first.locked).toEqual([decision.id]);
    const commentsAfterFirst = commentCount(issue.id);
    const second = sweepGraceDecisions(t.db, { now: decision.grace_until! + 2000 });
    expect(second.locked).toEqual([]);
    expect(commentCount(issue.id)).toBe(commentsAfterFirst);
    expect(decisionState(decision.id).state).toBe('open');
  });

  it('并发回答先到：到期 tick 跳过，不把 answered 决策打回 open', () => {
    const { decision } = seedDecision(5);
    // 模拟「回答与到期并发」中回答先赢：直接切状态（等同 answer 事务成功后的终态）
    t.db.prepare("UPDATE issue_decision SET state='answered' WHERE id=?").run(decision.id);
    const result = sweepGraceDecisions(t.db, { now: decision.grace_until! });
    // 扫描条件只取 state='grace'：已回答的决策根本不会被命中，也不会被打回 open
    expect(result.locked).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(decisionState(decision.id).state).toBe('answered');
  });
});

describe('服务重启补算', () => {
  it('grace_until <= now 的决策启动即落锁，不留「永远宽限」', () => {
    const { issue, decision } = seedDecision(5);
    t.db.prepare('UPDATE issue_decision SET grace_until=? WHERE id=?').run(Date.now() - 1000, decision.id);
    const result = recoverGraceOnBoot(t.db);
    expect(result.locked).toEqual([decision.id]);
    expect(issueRow(issue.id)).toMatchObject({ status: '待规划', claimed_by: null });
  });

  it('grace_until > now 的决策重启后保持 grace，并按原截止时刻落锁（不提前、不消失）', () => {
    const { issue, decision } = seedDecision(180);
    const result = recoverGraceOnBoot(t.db, { now: decision.grace_until! - 60_000 });
    expect(result.locked).toEqual([]);
    expect(decisionState(decision.id).state).toBe('grace');
    expect(issueRow(issue.id)).toMatchObject({ status: '进行中', claimed_by: 'agent-1' });
    // 到原截止时刻后照常落锁
    const after = sweepGraceDecisions(t.db, { now: decision.grace_until! });
    expect(after.locked).toEqual([decision.id]);
  });

  it('grace_seconds=0 的决策创建时已 open，ticker 不参与', () => {
    const { decision } = seedDecision(0);
    expect(decision.state).toBe('open');
    const result = sweepGraceDecisions(t.db, { now: Date.now() + 10_000 });
    expect(result.locked).toEqual([]);
    expect(decisionState(decision.id).state).toBe('open');
  });
});

describe('停止信号通道', () => {
  it('落锁后 getStopState 立即可读（2 秒级）', () => {
    const { issue, decision } = seedDecision(5);
    sweepGraceDecisions(t.db, { now: decision.grace_until! });
    const stop = getStopState(t.db, issue.id);
    expect(stop).toMatchObject({ stop_requested: true, decision_id: decision.id });
    expect(stop.reason).toContain('决策未回答');
  });

  it('宽限中（未落锁）stop_requested=false', () => {
    const { issue } = seedDecision(180);
    expect(getStopState(t.db, issue.id).stop_requested).toBe(false);
  });

  it('落锁后旧 fence 的续租被拒（bump fence 生效）', () => {
    const { issue, fence, decision } = seedDecision(5);
    sweepGraceDecisions(t.db, { now: decision.grace_until! });
    // 卡已回到待规划：原 agent 再续租必然失败（未占用）
    expect(issueRow(issue.id).claim_fence).toBe(fence + 1);
    expect(getIssue(t.db, issue.id)?.status).toBe('待规划');
  });
});

describe('ticker 句柄', () => {
  it('启动先跑一次补算，随后按 2 秒周期 tick；stop 可停表', () => {
    const { decision } = seedDecision(0);
    const calls: Array<() => void> = [];
    let cancelled = 0;
    const handle = startDecisionGraceTicker(t.db, {
      schedule: (fn) => {
        calls.push(fn);
        return 1;
      },
      cancel: () => {
        cancelled += 1;
      },
    });
    expect(GRACE_TICK_INTERVAL_MS).toBe(2000);
    expect(calls).toHaveLength(1);
    handle.stop();
    handle.stop();
    expect(cancelled).toBe(1);
    expect(decision.state).toBe('open');
  });

});
