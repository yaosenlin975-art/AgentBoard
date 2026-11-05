/**
 * DEC-8：提醒档位与超时升级。
 *
 * 覆盖卡面验收：
 * - locked_at 4h 前 → stale_level=1 且只提醒一次，再次扫描不重复；
 * - 24h / 72h 逐级升档，只前进不重复；
 * - 服务重启按 locked_at 补算，已发档位不重复；
 * - stale 查询只返回超时 open（grace / answered / withdrawn 不出现）；
 * - 统计端点字段齐全且数值与库一致；
 * - 提醒不改 state、不解除锁。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import { createPendingDecision } from '../src/services/decision.js';
import { createDecisionRouter } from '../src/api/decisionRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import {
  REMINDER_TICK_INTERVAL_MS,
  reminderLevelFor,
  startDecisionReminderTicker,
  sweepDecisionReminders,
} from '../src/services/decisionReminder.js';

const HOUR = 3600 * 1000;

let t: TestDb;
let wsId: string;
let app: express.Express;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
  app = express();
  app.use(express.json());
  app.use('/api', createDecisionRouter({ db: t.db }));
  app.use(errorHandler);
});

afterEach(() => {
  t.cleanup();
});

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

function seedDecision(graceSeconds = 0) {
  const issue = createIssue(t.db, { workspace_id: wsId, title: '提醒任务' });
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
  return { issue, decision: created.decision, locked: created.locked };
}

function reminderRow(id: string) {
  return t.db
    .prepare('SELECT state, stale_level, last_notified_at, locked_at FROM issue_decision WHERE id=?')
    .get(id) as { state: string; stale_level: number; last_notified_at: number | null; locked_at: number | null };
}

/** 把锁生效时间与创建时间挪到过去，模拟已停留 N 小时 */
function backdate(id: string, hours: number, now = Date.now()) {
  t.db
    .prepare('UPDATE issue_decision SET locked_at=?, created_at=? WHERE id=?')
    .run(now - hours * HOUR, now - hours * HOUR, id);
}

describe('reminderLevelFor', () => {
  const base = 1_800_000_000_000;

  it('按 4h / 24h / 72h 取最大已到档位', () => {
    expect(reminderLevelFor(base, base + 4 * HOUR - 1)).toBe(0);
    expect(reminderLevelFor(base, base + 4 * HOUR)).toBe(1);
    expect(reminderLevelFor(base, base + 23 * HOUR)).toBe(1);
    expect(reminderLevelFor(base, base + 24 * HOUR)).toBe(2);
    expect(reminderLevelFor(base, base + 72 * HOUR)).toBe(3);
    expect(reminderLevelFor(base, base + 500 * HOUR)).toBe(3);
  });
});

describe('sweepDecisionReminders', () => {
  it('4h 前落锁：只提醒一次，档位落库且不改 state', () => {
    const { decision } = seedDecision();
    const now = Date.now();
    backdate(decision.id, 4);

    const first = sweepDecisionReminders(t.db, { now });
    expect(first.reminded).toHaveLength(1);
    expect(first.reminded[0]).toMatchObject({ decision_id: decision.id, from_level: 0, to_level: 1, label: '4h' });
    const row = reminderRow(decision.id);
    expect(row).toMatchObject({ state: 'open', stale_level: 1 });
    expect(row.last_notified_at).not.toBeNull();
    expect(row.locked_at).toBe(now - 4 * HOUR);

    const second = sweepDecisionReminders(t.db, { now });
    expect(second.reminded).toHaveLength(0);
  });

  it('24h / 72h 逐级升档，只前进不重复', () => {
    const { decision } = seedDecision();
    const now = Date.now();
    backdate(decision.id, 4);
    expect(sweepDecisionReminders(t.db, { now }).reminded[0]?.to_level).toBe(1);

    backdate(decision.id, 25, now);
    const up = sweepDecisionReminders(t.db, { now });
    expect(up.reminded).toHaveLength(1);
    expect(up.reminded[0]).toMatchObject({ from_level: 1, to_level: 2, label: '24h' });
    expect(sweepDecisionReminders(t.db, { now }).reminded).toHaveLength(0);

    backdate(decision.id, 73, now);
    const top = sweepDecisionReminders(t.db, { now });
    expect(top.reminded[0]).toMatchObject({ from_level: 2, to_level: 3, label: '72h' });
    expect(sweepDecisionReminders(t.db, { now }).reminded).toHaveLength(0);
    expect(reminderRow(decision.id)).toMatchObject({ state: 'open', stale_level: 3 });
  });

  it('重启补算：停机跨档只补一次最高档，已发档位不重复', () => {
    const { decision } = seedDecision();
    const now = Date.now();
    backdate(decision.id, 30);
    // 模拟停机后首次启动补算：直接落在 24h 档
    const boot = sweepDecisionReminders(t.db, { now });
    expect(boot.reminded.map(item => item.to_level)).toEqual([2]);
    // 同一时刻再次补算（重启两次）不重复
    expect(sweepDecisionReminders(t.db, { now }).reminded).toHaveLength(0);
  });

  it('未到 4h、宽限中、已回答、已撤回都不提醒', () => {
    const fresh = seedDecision(); // grace=0 → 立即 open，locked_at=now
    const grace = seedDecision(180);
    const answered = seedDecision();
    const withdrawn = seedDecision();
    const now = Date.now();

    t.db.prepare("UPDATE issue_decision SET state='answered', answered_at=? WHERE id=?").run(now, answered.decision.id);
    t.db.prepare("UPDATE issue_decision SET state='withdrawn', withdrawn_at=? WHERE id=?").run(now, withdrawn.decision.id);
    backdate(answered.decision.id, 5);
    backdate(withdrawn.decision.id, 5);

    const result = sweepDecisionReminders(t.db, { now });
    expect(result.reminded).toHaveLength(0);
    expect(reminderRow(fresh.decision.id).stale_level).toBe(0);
    expect(reminderRow(grace.decision.id).locked_at).toBeNull();
    expect(reminderRow(answered.decision.id).stale_level).toBe(0);
    expect(reminderRow(withdrawn.decision.id).stale_level).toBe(0);
  });

  it('每发一档广播一次既有 issue.changed，并回调结构化提醒', () => {
    const { issue, decision } = seedDecision();
    const now = Date.now();
    backdate(decision.id, 4);
    const events: ServerWsEvent[] = [];
    const seen: number[] = [];
    const result = sweepDecisionReminders(t.db, {
      now,
      broadcast: event => events.push(event),
      onRemind: entry => seen.push(entry.to_level),
    });
    expect(result.reminded).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'issue.changed', issue: { id: issue.id } });
  });
});

describe('startDecisionReminderTicker', () => {
  it('启动即补算一次，按分钟级周期调度，stop 只取消一次', () => {
    const { decision } = seedDecision();
    backdate(decision.id, 25);
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const cancelled: unknown[] = [];
    const handle = startDecisionReminderTicker(t.db, {
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 'timer-1';
      },
      cancel: timer => cancelled.push(timer),
    });

    expect(reminderRow(decision.id).stale_level).toBe(2);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(REMINDER_TICK_INTERVAL_MS);
    expect(REMINDER_TICK_INTERVAL_MS).toBe(60 * 1000);

    handle.stop();
    handle.stop();
    expect(cancelled).toEqual(['timer-1']);
  });
});

describe('stale 查询与统计端点', () => {
  it('GET /decisions?stale=1 只返回超过 72h 的 open 决策', async () => {
    const stale = seedDecision();
    const fresh = seedDecision();
    const grace = seedDecision(180);
    const answered = seedDecision();
    backdate(stale.decision.id, 80);
    t.db.prepare("UPDATE issue_decision SET state='answered', answered_at=? WHERE id=?").run(Date.now(), answered.decision.id);
    backdate(answered.decision.id, 80);

    const res = await request(app).get(`/api/decisions?workspace_id=${wsId}&stale=1`);
    expect(res.status).toBe(200);
    const ids = (res.body.decisions as Array<{ id: string }>).map(item => item.id);
    expect(ids).toEqual([stale.decision.id]);
    expect(ids).not.toContain(fresh.decision.id);
    expect(ids).not.toContain(grace.decision.id);
    expect(ids).not.toContain(answered.decision.id);
    expect(res.body.counts.open).toBeGreaterThanOrEqual(2);
  });

  it('统计端点字段齐全且与库一致，窗口外不计入', async () => {
    const first = seedDecision();
    const second = seedDecision();
    const third = seedDecision();
    const outside = seedDecision();
    const now = Date.now();
    backdate(outside.decision.id, 24 * 10, now);

    const answered = await request(app)
      .post(`/api/decisions/${first.decision.id}/answer`)
      .send({ source: 'web', option_ord: 1, answered_by: 'user' });
    expect(answered.status).toBe(200);

    const res = await request(app).get(`/api/workspaces/${wsId}/decisions/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspace_id: wsId,
      window_days: 7,
      created: 3,
      answered: 1,
      answer_rate: 0.333,
    });
    expect(typeof res.body.median_wait_seconds).toBe('number');
    expect(Array.isArray(res.body.by_agent)).toBe(true);
    expect(res.body.by_agent[0]).toMatchObject({ agent_id: 'agent-1', created: 3, answered: 1 });
    expect(Array.isArray(res.body.by_trigger)).toBe(true);
    // 快照不受窗口影响：4 条中 1 条已答，其余 3 条（含窗口外那条）仍是 open
    expect(res.body.open).toMatchObject({ open: 3 });
    expect(second.decision.id).not.toBe(third.decision.id);
  });

  it('统计端点 days 越界返回 400', async () => {
    const res = await request(app).get(`/api/workspaces/${wsId}/decisions/stats?days=0`);
    expect(res.status).toBe(400);
  });
});
