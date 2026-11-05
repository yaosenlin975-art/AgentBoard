/**
 * DEC-2：锁与流程门禁接线。
 *
 * 覆盖卡面验收：
 * - open 决策 → claim 409 DECISION_LOCKED（文案含决策 id 与卡标题）；grace 不算锁；
 * - 租约清扫跳过 grace 卡（占用/租约原样），普通过期卡仍被清扫；
 * - 批量退回（含 mode=all / 指定 issue_ids）不触碰 grace/open 卡，状态/占用/fence 均不变；
 * - updateIssueInHierarchy 统一门禁：锁卡改 status 一律 409，改标题/描述/标签/截止放行；
 * - Issue 投影：grace → locked=false + grace_until 非空；open → locked=true + waiting_seconds；
 * - recoverOnBoot 只清占用，不碰决策行（锁保持）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue, listIssues } from '../src/db/repos/issue.js';
import { claimIssue, sweepExpiredLeases } from '../src/services/claim.js';
import { releaseRunning } from '../src/services/releaseRunning.js';
import { updateIssueInHierarchy } from '../src/services/taskHierarchy.js';
import { createPendingDecision } from '../src/services/decision.js';
import { recoverOnBoot } from '../src/services/sessionManager.js';
import { ApiError } from '../src/errors.js';

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
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停止执行' },
];

function seedClaimed(title: string, agent = 'agent-1'): Issue {
  const issue = createIssue(t.db, { workspace_id: wsId, title });
  return claimIssue(t.db, issue.id, agent, null);
}

function row(id: string): { status: string; claimed_by: string | null; claim_fence: number; claim_lease_until: number | null } {
  return t.db
    .prepare('SELECT status,claimed_by,claim_fence,claim_lease_until FROM issue WHERE id=?')
    .get(id) as { status: string; claimed_by: string | null; claim_fence: number; claim_lease_until: number | null };
}

function ask(issue: Issue, agent = 'agent-1', grace?: number): string {
  const created = createPendingDecision(t.db, {
    workspace_id: wsId,
    issue_id: issue.id,
    created_by: agent,
    question: '继续还是停止？',
    options: OPTIONS,
    ...(grace === undefined ? {} : { grace_seconds: grace }),
  });
  return created.decision.id;
}

function expectApi(fn: () => unknown, status: number, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ status, code }) as ApiError);
}

describe('claim 门禁', () => {
  it('open 决策 → claim 409 DECISION_LOCKED，文案含决策 id 与卡标题', () => {
    const issue = seedClaimed('被锁定的卡');
    const decisionId = ask(issue, 'agent-1', 0);
    const error = (() => {
      try {
        claimIssue(t.db, issue.id, 'agent-2', null);
      } catch (caught) {
        return caught;
      }
      return null;
    })() as ApiError | null;
    expect(error).toMatchObject({ status: 409, code: 'DECISION_LOCKED' });
    expect(error?.message).toContain(decisionId);
    expect(error?.message).toContain('被锁定的卡');
  });

  it('grace 不是锁：宽限内的卡仍可被抢占领取，决策行不受影响', () => {
    const issue = seedClaimed('宽限中的卡', 'agent-1');
    const decisionId = ask(issue, 'agent-1');
    // 让旧占用租约过期，模拟 agent-2 抢占
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1000, issue.id);
    const taken = claimIssue(t.db, issue.id, 'agent-2', null);
    expect(taken.claimed_by).toBe('agent-2');
    expect(taken.decision_locked).toBe(false);
    expect(taken.open_decision_id).toBe(decisionId);
    const decision = t.db.prepare('SELECT state FROM issue_decision WHERE id=?').get(decisionId) as { state: string };
    expect(decision.state).toBe('grace');
  });
});

describe('租约清扫', () => {
  it('grace 卡不被清扫（占用与租约保持）；无决策的过期卡照常清扫', () => {
    const graceIssue = seedClaimed('宽限卡', 'agent-1');
    const decisionId = ask(graceIssue, 'agent-1');
    const plainIssue = seedClaimed('普通卡', 'agent-2');
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id IN (?,?)').run(Date.now() - 1000, graceIssue.id, plainIssue.id);
    const swept = sweepExpiredLeases(t.db);
    expect(swept).toBe(1);
    expect(row(graceIssue.id)).toMatchObject({ claimed_by: 'agent-1' });
    expect(row(graceIssue.id).claim_lease_until).toBeGreaterThan(0);
    expect(row(plainIssue.id).claimed_by).toBeNull();
    const decision = t.db.prepare('SELECT state FROM issue_decision WHERE id=?').get(decisionId) as { state: string };
    expect(decision.state).toBe('grace');
  });
});

describe('批量退回', () => {
  it('mode=all 不触碰 grace 卡（状态/占用/fence 不变），跳过原因 DECISION_GRACE', () => {
    const issue = seedClaimed('宽限卡', 'agent-1');
    const decisionId = ask(issue, 'agent-1');
    const before = row(issue.id);
    const result = releaseRunning(t.db, wsId, { mode: 'all' });
    expect(result.released).toHaveLength(0);
    expect(result.skipped).toEqual([{ id: issue.id, reason: 'DECISION_GRACE' }]);
    expect(row(issue.id)).toEqual(before);
    const decision = t.db.prepare('SELECT state FROM issue_decision WHERE id=?').get(decisionId) as { state: string };
    expect(decision.state).toBe('grace');
  });

  it('mode=expired + 指定 issue_ids 同样不回退 grace 卡；普通卡正常退回且 fence+1', () => {
    const graceIssue = seedClaimed('宽限卡', 'agent-1');
    ask(graceIssue, 'agent-1');
    const plainIssue = seedClaimed('普通卡', 'agent-2');
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1000, plainIssue.id);
    const plainFence = row(plainIssue.id).claim_fence;
    const result = releaseRunning(t.db, wsId, { mode: 'expired', issue_ids: [graceIssue.id, plainIssue.id] });
    expect(result.skipped).toEqual([{ id: graceIssue.id, reason: 'DECISION_GRACE' }]);
    expect(result.released.map((item) => item.id)).toEqual([plainIssue.id]);
    expect(row(plainIssue.id)).toMatchObject({ status: '待规划', claimed_by: null, claim_fence: plainFence + 1 });
    expect(row(graceIssue.id).claimed_by).toBe('agent-1');
  });
});

describe('状态流转门禁', () => {
  it('锁卡改 status 一律 409；改标题/描述/标签/截止成功', () => {
    const issue = seedClaimed('锁卡');
    const decisionId = ask(issue, 'agent-1', 0);
    expectApi(() => updateIssueInHierarchy(t.db, issue.id, { status: '待验收' }), 409, 'DECISION_LOCKED');
    expectApi(() => updateIssueInHierarchy(t.db, issue.id, { status: '待规划' }), 409, 'DECISION_LOCKED');
    const titled = updateIssueInHierarchy(t.db, issue.id, {
      title: '改名不改状态',
      description: '补充说明',
      labels: ['x'],
      due_date: '2026-11-30',
    });
    expect(titled.title).toBe('改名不改状态');
    expect(titled.description).toBe('补充说明');
    expect(titled.labels).toEqual(['x']);
    expect(titled.due_date).toBe('2026-11-30');
    // 锁仍在，状态未变
    expect(row(issue.id).status).toBe('待规划');
    expect(getIssue(t.db, issue.id)?.decision_locked).toBe(true);
    // 回答后解锁，状态可改
    t.db.prepare("UPDATE issue_decision SET state='answered' WHERE id=?").run(decisionId);
    const updated = updateIssueInHierarchy(t.db, issue.id, { status: '进行中' });
    expect(updated.status).toBe('进行中');
  });

  it('grace 卡可正常改状态（宽限不算锁）', () => {
    const issue = seedClaimed('宽限卡');
    ask(issue, 'agent-1');
    const updated = updateIssueInHierarchy(t.db, issue.id, { status: '待验收' });
    expect(updated.status).toBe('待验收');
  });
});

describe('Issue 投影', () => {
  it('grace：decision_locked=false、open_decision_id 非空、decision_grace_until 非空', () => {
    const issue = seedClaimed('投影卡');
    const decisionId = ask(issue);
    const projected = getIssue(t.db, issue.id)!;
    expect(projected.decision_locked).toBe(false);
    expect(projected.open_decision_id).toBe(decisionId);
    expect(projected.decision_grace_until).toBeTypeOf('number');
    expect(projected.decision_waiting_seconds).toBeNull();
  });

  it('open：decision_locked=true、waiting_seconds 非空、grace_until 归零', () => {
    const issue = seedClaimed('投影卡');
    const decisionId = ask(issue, 'agent-1', 0);
    const projected = getIssue(t.db, issue.id)!;
    expect(projected.decision_locked).toBe(true);
    expect(projected.open_decision_id).toBe(decisionId);
    expect(projected.decision_grace_until).toBeNull();
    expect(projected.decision_waiting_seconds).toBeTypeOf('number');
    const listed = listIssues(t.db, wsId).find((item) => item.id === issue.id)!;
    expect(listed.decision_locked).toBe(true);
  });

  it('无决策：投影全空/假值', () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '普通卡' });
    const projected = getIssue(t.db, issue.id)!;
    expect(projected.decision_locked).toBe(false);
    expect(projected.open_decision_id).toBeNull();
    expect(projected.decision_grace_until).toBeNull();
    expect(projected.decision_waiting_seconds).toBeNull();
  });
});

describe('启动恢复', () => {
  it('recoverOnBoot 不碰决策行：open 锁保持、只是占用被清', async () => {
    const issue = seedClaimed('重启卡');
    const decisionId = ask(issue, 'agent-1', 0);
    // 绑定会话再触发启动恢复，走「清占用」分支
    t.db.prepare("UPDATE issue SET session_id='sess-1' WHERE id=?").run(issue.id);
    t.db
      .prepare("INSERT INTO session (id, workspace_id, issue_id, cli, status, created_at) VALUES ('sess-1', ?, ?, 'cli', '运行中', ?)")
      .run(wsId, issue.id, Date.now());
    await recoverOnBoot(t.db);
    expect(row(issue.id).claimed_by).toBeNull();
    const decision = t.db.prepare('SELECT state, locked_at, stop_requested_at FROM issue_decision WHERE id=?').get(decisionId) as
      | { state: string; locked_at: number | null; stop_requested_at: number | null }
      | undefined;
    expect(decision).toMatchObject({ state: 'open' });
    expect(decision?.locked_at).toBeTypeOf('number');
    expect(decision?.stop_requested_at).toBeTypeOf('number');
  });
});
