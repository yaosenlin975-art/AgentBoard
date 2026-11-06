/**
 * LEASE-GAP（01eb3624）：租约过期被 sweep 后，原占用代次仍能收尾。
 *
 * 背景：`CLAIM_LEASE_MS` 到期 → `sweepExpiredLeases` 只清占用、任务保留「进行中」；
 * 而 `kb claim` 要求「待规划」、`done/fail` 又要求「当前占用者」→ 卡死在这张卡上（handoff 长流程必踩）。
 * 新口径：fence 等于当前代次 + 无人占用 + 状态进行中 → 原代次可直接 done/fail；
 * 抢占会自增 fence，旧代次仍在任何写之前落 STALE_FENCE。
 *
 * 覆盖：scoped（workspace）与 legacy（无 workspace）两条收尾路径、done/fail 两个动作、
 * 抢占后旧 fence 拒绝、缺席 fence 不放行、正常占用时非占用者仍被拒（回归）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import type { Express } from 'express';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import {
  claimIssue,
  doneIssue,
  failIssue,
  finishClaimedIssue,
  sweepExpiredLeases,
} from '../src/services/claim.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
});
afterEach(() => {
  t.cleanup();
});

const seed = (title = '长流程交接卡'): Issue => createIssue(t.db, { workspace_id: wsId, title });

/** 把租约推到过去并执行一次清扫（等价于服务启动时的 sweep / 15 分钟无心跳） */
function expireAndSweep(issueId: string): void {
  t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1000, issueId);
  expect(sweepExpiredLeases(t.db)).toBe(1);
  const row = t.db.prepare('SELECT claimed_by, status FROM issue WHERE id=?').get(issueId) as { claimed_by: string | null; status: string };
  expect(row).toEqual({ claimed_by: null, status: '进行中' });
}

const statusOf = (issueId: string): string =>
  (t.db.prepare('SELECT status FROM issue WHERE id=?').get(issueId) as { status: string }).status;

const commentsOf = (issueId: string): Array<{ author: string; content: string }> =>
  listCommentsByIssue(t.db, issueId).map(item => ({ author: item.author, content: item.content }));

describe('LEASE-GAP：sweep 后原代次仍可收尾（scoped 路径）', () => {
  it('done：待验收 + 占用清空 + 系统留痕 + notes 落评论', () => {
    const issue = seed();
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);

    const result = finishClaimedIssue(t.db, issue.id, wsId, 'app-dev', 'done', '交接完成', claimed.claim_fence);
    expect(result.issue.status).toBe('待验收');
    expect(result.issue.claimed_by).toBeNull();
    expect(statusOf(issue.id)).toBe('待验收');
    const comments = commentsOf(issue.id);
    expect(comments.some(item => item.author === 'system' && item.content.includes('占用租约已过期'))).toBe(true);
    expect(comments.some(item => item.author === 'agent:app-dev' && item.content === '交接完成')).toBe(true);
  });

  it('fail：回待规划 + 失败原因落评论', () => {
    const issue = seed('要回报失败的卡');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);

    finishClaimedIssue(t.db, issue.id, wsId, 'app-dev', 'fail', '外部接口不可用', claimed.claim_fence);
    expect(statusOf(issue.id)).toBe('待规划');
    expect(commentsOf(issue.id).some(item => item.content === '外部接口不可用')).toBe(true);
  });

  it('抢占后旧 fence：STALE_FENCE，状态与占用都不变', () => {
    const issue = seed('被抢占的卡');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);
    const reclaimed = claimIssue(t.db, issue.id, 'other-agent', null);
    expect(reclaimed.claim_fence).toBe(claimed.claim_fence + 1);

    expect(() => finishClaimedIssue(t.db, issue.id, wsId, 'app-dev', 'done', '旧代次收尾', claimed.claim_fence))
      .toThrowError(/占用代次已过期/);
    const row = t.db.prepare('SELECT claimed_by, status FROM issue WHERE id=?').get(issue.id) as { claimed_by: string | null; status: string };
    expect(row).toEqual({ claimed_by: 'other-agent', status: '进行中' });
  });

  it('不带 fence：不享受逾期收尾口子，仍报非占用者', () => {
    const issue = seed('无 fence 收尾');
    claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);

    expect(() => finishClaimedIssue(t.db, issue.id, wsId, 'app-dev', 'done', '无 fence'))
      .toThrowError(/只有当前占用者可执行此操作/);
    expect(statusOf(issue.id)).toBe('进行中');
  });

  it('回归：正常占用时非占用者带当前 fence 也不能收尾', () => {
    const issue = seed('正常占用');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);

    expect(() => finishClaimedIssue(t.db, issue.id, wsId, 'other-agent', 'done', '冒名收尾', claimed.claim_fence))
      .toThrowError(/只有当前占用者可执行此操作/);
    expect(statusOf(issue.id)).toBe('进行中');
  });
});

describe('LEASE-GAP：legacy（无 workspace）路径同样放行', () => {
  it('doneIssue：sweep 后原代次完成', async () => {
    const issue = seed('legacy done');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);

    const result = await doneIssue(t.db, issue.id, 'app-dev', 'legacy 收尾', claimed.claim_fence);
    expect(result.issue.status).toBe('待验收');
    expect(commentsOf(issue.id).some(item => item.content.includes('LEASE-GAP'))).toBe(true);
  });

  it('failIssue：sweep 后原代次回报失败', async () => {
    const issue = seed('legacy fail');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);
    expireAndSweep(issue.id);

    await failIssue(t.db, issue.id, 'app-dev', 'legacy 失败原因', undefined, claimed.claim_fence);
    expect(statusOf(issue.id)).toBe('待规划');
  });

  it('回归：正常占用时非占用者不能 legacy 收尾', async () => {
    const issue = seed('legacy 冒名');
    const claimed = claimIssue(t.db, issue.id, 'app-dev', null);

    await expect(doneIssue(t.db, issue.id, 'other-agent', '冒名', claimed.claim_fence))
      .rejects.toThrowError(/只有当前占用者可完成任务/);
    expect(statusOf(issue.id)).toBe('进行中');
  });
});

describe('LEASE-GAP：真实 app 接线（RULE-3）', () => {
  let app: Express;
  let apiWs: string;

  beforeEach(async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    apiWs = createWorkspace(t.db, { name: 'LEASE 区', path: 'D:\\ws-lease' }).id;
  });

  it('sweep 后 POST /api/issues/:id/done 带原 fence 仍 200，状态进待验收', async () => {
    const created = await request(app).post('/api/issues').send(issuePayload(apiWs, { title: 'HTTP 收尾' }));
    expect(created.status).toBe(200);
    const issueId = created.body.id as string;
    const claimed = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'app-dev' });
    expect(claimed.status).toBe(200);
    const fence = claimed.body.claim_fence as number;

    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1000, issueId);
    expect(sweepExpiredLeases(t.db)).toBe(1);

    const done = await request(app)
      .post(`/api/issues/${issueId}/done`)
      .set('x-claim-fence', String(fence))
      .send({ agent_id: 'app-dev', notes: '租约过期后收尾', workspace_id: apiWs });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('待验收');
    expect(done.body.claimed_by).toBeNull();
  }, 30_000);
});
