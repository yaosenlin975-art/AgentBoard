/**
 * DEC-1：待决策区数据模型与生命周期。
 *
 * 覆盖卡面验收：
 * - 建表/索引幂等，workspace.decision_grace_seconds 纯 ADD COLUMN（新库 + 存量库）；
 * - grace/open 一卡一条（部分唯一索引 + 服务层 409）；
 * - grace_seconds 默认 180、显式仅接受 0–600 整数（非法 400 INVALID_GRACE）；
 * - 状态机：grace→answered（卡不动）/ grace→open 落锁 / open→answered 解锁 / withdraw 两分支 / 修订 CAS；
 * - grace_seconds=0 独立分支：事务内直接 open + 释放占用 + bump fence，与 grace→open 共用落锁实现；
 * - checkpoint 存取（含评论渲染）、删卡级联、stop 信号可读。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Issue } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { openDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, deleteIssue, getIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import {
  countDecisions,
  getStopState,
  ackStop,
  listDecisions,
  listOptions,
} from '../src/db/repos/decision.js';
import {
  answerPendingDecision,
  assertValidGraceSeconds,
  createPendingDecision,
  resolveGraceSeconds,
  DECISION_GRACE_DEFAULT_SECONDS,
  lockIssueForDecision,
  withdrawPendingDecision,
  setWorkspaceGraceSeconds,
} from '../src/services/decision.js';
import { claimIssue } from '../src/services/claim.js';
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

function seedIssue(title = '决策任务'): Issue {
  return createIssue(t.db, { workspace_id: wsId, title });
}

function claimedIssue(title = '决策任务'): { issue: Issue; fence: number; agent: string } {
  const issue = seedIssue(title);
  const agent = 'agent-1';
  const claimed = claimIssue(t.db, issue.id, agent, null);
  return { issue: claimed, fence: claimed.claim_fence, agent };
}

function issueRow(id: string): { status: string; claimed_by: string | null; claim_fence: number } {
  return t.db.prepare('SELECT status,claimed_by,claim_fence FROM issue WHERE id=?').get(id) as {
    status: string;
    claimed_by: string | null;
    claim_fence: number;
  };
}

function expectApi(fn: () => unknown, status: number, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ status, code }) as ApiError);
}

const OPTIONS = [
  { label: 'A 方案', consequence: '按 A 继续' },
  { label: 'B 方案', consequence: '按 B 继续' },
];

describe('迁移：建表与加列幂等', () => {
  it('initSchema 重复执行不报错，索引与 workspace 列保持唯一', () => {
    initSchema(t.db);
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'issue_decision%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'issue_decision',
      'issue_decision_answer',
      'issue_decision_option',
    ]);
    const indexes = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%decision%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain('ux_decision_active');
    const workspaceColumns = t.db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string }>;
    expect(workspaceColumns.filter((column) => column.name === 'decision_grace_seconds')).toHaveLength(1);
    expect(workspaceColumns.find((column) => column.name === 'decision_grace_seconds')).toBeTruthy();
    const graceRow = t.db.prepare('SELECT decision_grace_seconds FROM workspace WHERE id=?').get(wsId) as {
      decision_grace_seconds: number;
    };
    expect(graceRow.decision_grace_seconds).toBe(180);
  });

  it('存量库（workspace 无该列）迁移后补列且历史行取默认 180', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-'));
    const db = openDb(join(dir, 'legacy.db'));
    try {
      db.exec('CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO workspace (id,name,path,created_at) VALUES (?,?,?,?)').run('w1', 'old', 'D:\\old', Date.now());
      initSchema(db);
      const row = db.prepare('SELECT decision_grace_seconds FROM workspace WHERE id=?').get('w1') as {
        decision_grace_seconds: number;
      };
      expect(row.decision_grace_seconds).toBe(180);
      // 存量库由 ensureColumn 补列（无 CHECK），历史脏值不报错，读取时 clamp 到 600
      db.prepare('UPDATE workspace SET decision_grace_seconds=9999 WHERE id=?').run('w1');
      expect(resolveGraceSeconds(db, 'w1')).toBe(600);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('宽限取值与默认值', () => {
  it('显式宽限只接受 0–600 整数，0 合法', () => {
    expect(assertValidGraceSeconds(0)).toBe(0);
    expect(assertValidGraceSeconds(180)).toBe(180);
    expect(assertValidGraceSeconds(600)).toBe(600);
    for (const bad of [-1, 601, 1.5, Number.NaN]) {
      expectApi(() => assertValidGraceSeconds(bad), 400, 'INVALID_GRACE');
    }
  });

  it('缺省宽限取工作区默认 180；工作区可配置为 0（夜间立即锁）', () => {
    expect(DECISION_GRACE_DEFAULT_SECONDS).toBe(180);
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '走哪条路径？',
      options: OPTIONS,
    });
    expect(created.decision.grace_seconds).toBe(180);
    expect(created.decision.state).toBe('grace');
    expect(created.locked).toBe(false);
    expect(created.decision.remaining_grace_seconds).toBeGreaterThan(170);
  });

  it('工作区默认写入非法值被拒绝（不静默截断）', () => {
    expectApi(() => setWorkspaceGraceSeconds(t.db, wsId, 601), 400, 'INVALID_GRACE');
    expectApi(() => setWorkspaceGraceSeconds(t.db, wsId, -1), 400, 'INVALID_GRACE');
    expect(setWorkspaceGraceSeconds(t.db, wsId, 0)).toBe(0);
  });
});

describe('提问：唯一约束与选项校验', () => {
  it('同一张卡同时只允许一条 grace/open 决策', () => {
    const { issue, agent } = claimedIssue();
    createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q1', options: OPTIONS });
    expectApi(
      () => createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q2', options: OPTIONS }),
      409,
      'DECISION_ALREADY_OPEN',
    );
  });

  it('选项至少 2 个、label 不重复、consequence 非空；缺省默认项为第 1 个', () => {
    const { issue, agent } = claimedIssue();
    const base = { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q' };
    expectApi(() => createPendingDecision(t.db, { ...base, options: [OPTIONS[0]] }), 400, 'VALIDATION_ERROR');
    expectApi(
      () => createPendingDecision(t.db, { ...base, options: [OPTIONS[0], { label: 'A 方案', consequence: 'x' }] }),
      400,
      'VALIDATION_ERROR',
    );
    expectApi(
      () => createPendingDecision(t.db, { ...base, options: [{ label: 'A', consequence: '' }, OPTIONS[1]] }),
      400,
      'VALIDATION_ERROR',
    );
    const created = createPendingDecision(t.db, { ...base, options: OPTIONS });
    const options = listOptions(t.db, created.decision.id);
    expect(options).toHaveLength(2);
    expect(options[0].is_default).toBe(1);
    expect(options[1].is_default).toBe(0);
  });
});

describe('状态机：grace', () => {
  it('建 grace 决策：卡保持进行中、占用与 fence 均不变', () => {
    const { issue, agent, fence } = claimedIssue();
    createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '选哪个？',
      options: OPTIONS,
      created_fence: fence,
    });
    const row = issueRow(issue.id);
    expect(row).toEqual({ status: '进行中', claimed_by: agent, claim_fence: fence });
  });

  it('grace 内回答：state=answered，卡仍进行中且无需重新 claim', () => {
    const { issue, agent, fence } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '选哪个？',
      options: OPTIONS,
    });
    const answered = answerPendingDecision(t.db, {
      decision_id: created.decision.id,
      option_ord: 1,
      answered_by: 'user',
      source: 'web',
    });
    expect(answered.state).toBe('answered');
    expect(answered.answer_revision).toBe(1);
    expect(answered.current_answer_id).toBeTruthy();
    expect(answered.remaining_grace_seconds).toBeNull();
    expect(issueRow(issue.id)).toEqual({ status: '进行中', claimed_by: agent, claim_fence: fence });
    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments.at(-1)?.content).toContain('宽限内回答');
  });

  it('grace→open：释放占用、bump fence、写 locked/stop，且重复落锁幂等', () => {
    const { issue, agent, fence } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '选哪个？',
      options: OPTIONS,
    });
    const before = listCommentsByIssue(t.db, issue.id).length;
    const locked = lockIssueForDecision(t.db, created.decision.id, { reason: 'grace_expired' });
    expect(locked.decision.state).toBe('open');
    expect(locked.decision.locked_at).toBeTypeOf('number');
    expect(locked.decision.stop_requested_at).toBeTypeOf('number');
    expect(locked.decision.remaining_grace_seconds).toBeNull();
    const row = issueRow(issue.id);
    expect(row.status).toBe('待规划');
    expect(row.claimed_by).toBeNull();
    expect(row.claim_fence).toBe(fence + 1);
    expect(listCommentsByIssue(t.db, issue.id).length).toBe(before + 1);
    expect(getStopState(t.db, issue.id).stop_requested).toBe(true);
    // 幂等：ticker 再次触发不重复 bump、不重复评论
    lockIssueForDecision(t.db, created.decision.id, { reason: 'grace_expired' });
    expect(issueRow(issue.id).claim_fence).toBe(fence + 1);
    expect(listCommentsByIssue(t.db, issue.id).length).toBe(before + 1);
  });
});

describe('状态机：open / grace=0', () => {
  it('grace_seconds=0：事务内直接 open，卡立即释放并 bump fence', () => {
    const { issue, agent, fence } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '夜间批处理要不要继续？',
      options: OPTIONS,
      grace_seconds: 0,
    });
    expect(created.locked).toBe(true);
    expect(created.decision.state).toBe('open');
    expect(created.decision.grace_seconds).toBe(0);
    expect(created.decision.grace_until).toBe(created.decision.created_at);
    expect(created.decision.locked_at).toBe(created.decision.created_at);
    expect(created.decision.stop_requested_at).toBe(created.decision.created_at);
    const row = issueRow(issue.id);
    expect(row).toEqual({ status: '待规划', claimed_by: null, claim_fence: fence + 1 });
    expect(listCommentsByIssue(t.db, issue.id).some((comment) => comment.content.includes('--grace 0'))).toBe(true);
  });

  it('open 后回答：解锁（卡保持待规划），不再 bump fence', () => {
    const { issue, agent, fence } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: '选哪个？',
      options: OPTIONS,
      grace_seconds: 0,
    });
    const answered = answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 2 });
    expect(answered.state).toBe('answered');
    expect(issueRow(issue.id)).toEqual({ status: '待规划', claimed_by: null, claim_fence: fence + 1 });
  });

  it('首次回答后再次回答：无 expected_revision → 409 DECISION_ALREADY_ANSWERED', () => {
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q', options: OPTIONS });
    answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 1 });
    expectApi(
      () => answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 2 }),
      409,
      'DECISION_ALREADY_ANSWERED',
    );
  });
});

describe('修订 CAS', () => {
  it('expected_revision 匹配时追加新 revision；旧版本冲突 409', () => {
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q', options: OPTIONS });
    const first = answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 1 });
    expect(first.answer_revision).toBe(1);
    const second = answerPendingDecision(t.db, {
      decision_id: created.decision.id,
      option_ord: 2,
      answer_text: '改成 B',
      expected_revision: 1,
    });
    expect(second.answer_revision).toBe(2);
    expect(second.answers.map((answer) => answer.revision)).toEqual([1, 2]);
    expectApi(
      () =>
        answerPendingDecision(t.db, {
          decision_id: created.decision.id,
          option_ord: 1,
          expected_revision: 1,
        }),
      409,
      'DECISION_REVISION_CONFLICT',
    );
  });
});

describe('撤回', () => {
  it('grace 内撤回：取消宽限，卡保持占用', () => {
    const { issue, agent, fence } = claimedIssue();
    const created = createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q', options: OPTIONS });
    const withdrawn = withdrawPendingDecision(t.db, {
      decision_id: created.decision.id,
      by: 'user',
      reason: '不需要了',
    });
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.withdrawn_by).toBe('user');
    expect(withdrawn.withdrawn_reason).toBe('不需要了');
    expect(issueRow(issue.id)).toEqual({ status: '进行中', claimed_by: agent, claim_fence: fence });
  });

  it('open 后撤回：解锁，卡保持待规划；非提问者 agent 撤回被拒', () => {
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: 'Q',
      options: OPTIONS,
      grace_seconds: 0,
    });
    expectApi(
      () => withdrawPendingDecision(t.db, { decision_id: created.decision.id, by: 'other-agent', reason: 'x' }),
      403,
      'FORBIDDEN',
    );
    expectApi(
      () => withdrawPendingDecision(t.db, { decision_id: created.decision.id, by: 'user', reason: '  ' }),
      400,
      'VALIDATION_ERROR',
    );
    const withdrawn = withdrawPendingDecision(t.db, { decision_id: created.decision.id, by: 'user', reason: '误报' });
    expect(withdrawn.state).toBe('withdrawn');
    expect(issueRow(issue.id).status).toBe('待规划');
  });
});

describe('checkpoint / stop / 级联 / 列表', () => {
  it('checkpoint 落库并渲染卡评论；非法 JSON 400', () => {
    const { issue, agent } = claimedIssue();
    expectApi(
      () =>
        createPendingDecision(t.db, {
          workspace_id: wsId,
          issue_id: issue.id,
          created_by: agent,
          question: 'Q',
          options: OPTIONS,
          checkpoint: '{not-json',
        }),
      400,
      'VALIDATION_ERROR',
    );
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: 'Q',
      options: OPTIONS,
      checkpoint: { next_step: '接线 REST', stash_sha: 'abc123', background_pid: 4242 },
    });
    expect(JSON.parse(created.decision.checkpoint_json!)).toEqual({
      next_step: '接线 REST',
      stash_sha: 'abc123',
      background_pid: 4242,
    });
    const comment = listCommentsByIssue(t.db, issue.id).find((item) => item.content.includes('决策断点'));
    expect(comment?.content).toContain('next_step=接线 REST');
    expect(comment?.content).toContain('stash=abc123');
  });

  it('stop-ack 记录确认时间且不影响锁', () => {
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, {
      workspace_id: wsId,
      issue_id: issue.id,
      created_by: agent,
      question: 'Q',
      options: OPTIONS,
      grace_seconds: 0,
    });
    expect(getStopState(t.db, issue.id)).toMatchObject({ stop_requested: true, decision_id: created.decision.id });
    const acked = ackStop(t.db, issue.id, Date.now());
    expect(acked?.stop_ack_at).toBeTypeOf('number');
    expect(getStopState(t.db, issue.id).decision_id).toBe(created.decision.id);
  });

  it('删卡级联删除决策/选项/答案', () => {
    const { issue, agent } = claimedIssue();
    const created = createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q', options: OPTIONS });
    answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 1 });
    expect(getIssue(t.db, issue.id)).toBeTruthy();
    deleteIssue(t.db, issue.id);
    const remaining = t.db
      .prepare('SELECT COUNT(*) AS n FROM issue_decision WHERE issue_id=?')
      .get(issue.id) as { n: number };
    expect(remaining.n).toBe(0);
    const answers = t.db
      .prepare('SELECT COUNT(*) AS n FROM issue_decision_answer WHERE decision_id=?')
      .get(created.decision.id) as { n: number };
    expect(answers.n).toBe(0);
    const options = t.db
      .prepare('SELECT COUNT(*) AS n FROM issue_decision_option WHERE decision_id=?')
      .get(created.decision.id) as { n: number };
    expect(options.n).toBe(0);
  });

  it('列表与计数：grace/open 统计、stale 与近 24h 已回答', () => {
    const { issue, agent } = claimedIssue('列表任务');
    const created = createPendingDecision(t.db, { workspace_id: wsId, issue_id: issue.id, created_by: agent, question: 'Q', options: OPTIONS });
    const items = listDecisions(t.db, { workspace_id: wsId });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: created.decision.id, issue_title: '列表任务', option_count: 2 });
    expect(countDecisions(t.db, wsId)).toMatchObject({ grace: 1, open: 0, stale_open: 0, answered_recent: 0 });
    lockIssueForDecision(t.db, created.decision.id, { reason: 'grace_expired' });
    expect(countDecisions(t.db, wsId)).toMatchObject({ grace: 0, open: 1, stale_open: 0 });
    t.db.prepare('UPDATE issue_decision SET locked_at=? WHERE id=?').run(Date.now() - 80 * 3600 * 1000, created.decision.id);
    expect(countDecisions(t.db, wsId).stale_open).toBe(1);
    answerPendingDecision(t.db, { decision_id: created.decision.id, option_ord: 1 });
    expect(countDecisions(t.db, wsId)).toMatchObject({ grace: 0, open: 0, stale_open: 0, answered_recent: 1 });
  });
});
