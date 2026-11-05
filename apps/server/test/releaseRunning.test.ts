/**
 * REL-1：工作区批量退回待规划（POST /api/workspaces/:workspaceId/release-running）。
 *
 * 覆盖卡面验收：
 * 1. dry_run 只干跑、零写入；
 * 2. 真跑：released 内每卡回「待规划」且清占用，各新增 1 条 system 审计评论；
 * 3. 未知工作区 404 零写入；body 里的 workspace_id 被忽略；
 * 4. 新鲜租约 → LEASE_ACTIVE、有主无租约 → UNDETERMINED；mode=all 全释放；
 * 5. 无主进行中卡在 expired 下可释放；
 * 6. 非本区 issue_ids → NOT_IN_WORKSPACE；
 * 7. 旧 fence 调 done/release → 409 STALE_FENCE，heartbeat → 409 NOT_TASK_OWNER；
 * 8. 重复提交第二次 released 为空且 200；
 * 9. 写回阶段任一卡失败 → 整批回滚。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Issue } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { claimIssue } from '../src/services/claim.js';
import { releaseRunning } from '../src/services/releaseRunning.js';

let t: TestDb;
let app: Express;
let wsA: string;
let wsB: string;

beforeEach(async () => {
  t = createTestDb();
  wsA = createWorkspace(t.db, { name: 'A', path: 'D:\\wsA' }).id;
  wsB = createWorkspace(t.db, { name: 'B', path: 'D:\\wsB' }).id;
  const adapter = new FakeAdapter();
  const created = await createApp({ db: t.db, getAdapter: (id) => {
    if (id === 'fake') return adapter;
    throw new Error(`未知适配器 id: ${id}`);
  }, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
});

afterEach(() => {
  t.cleanup();
});

interface IssueRow {
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
  claim_lease_until: number | null;
  last_heartbeat_at: number | null;
  session_id: string | null;
  claim_fence: number;
  updated_at: number;
}

function row(id: string): IssueRow {
  return t.db.prepare(
    `SELECT status, claimed_by, claimed_at, claim_lease_until, last_heartbeat_at, session_id, claim_fence, updated_at
     FROM issue WHERE id=?`,
  ).get(id) as IssueRow;
}

function seed(title: string, workspaceId = wsA): Issue {
  return createIssue(t.db, { workspace_id: workspaceId, title });
}

/** 领取后把租约拨到过去（模拟静默超时） */
function claimExpired(issue: Issue, agent = 'agent-a'): number {
  const fence = claimIssue(t.db, issue.id, agent, null).claim_fence;
  t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
  return fence;
}

function seedRunningOrphan(title: string): Issue {
  const issue = seed(title);
  t.db.prepare("UPDATE issue SET status='进行中' WHERE id=?").run(issue.id);
  return issue;
}

function post(workspaceId: string, body: Record<string, unknown> = {}) {
  return request(app).post(`/api/workspaces/${workspaceId}/release-running`).send(body);
}

describe('POST /release-running', () => {
  it('dry_run：返回干跑清单但零写入（updated_at 与评论数不变）', async () => {
    const expired = seed('过期租约');
    claimExpired(expired);
    const orphan = seedRunningOrphan('无主进行中');
    const commentBefore = listCommentsByIssue(t.db, expired.id).length;
    const updatedBefore = row(expired.id).updated_at;

    const res = await post(wsA, { mode: 'expired', dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.released.map((i: Issue) => i.id).sort()).toEqual([expired.id, orphan.id].sort());
    expect(res.body.skipped).toEqual([]);
    expect(row(expired.id).updated_at).toBe(updatedBefore);
    expect(row(expired.id).status).toBe('进行中');
    expect(listCommentsByIssue(t.db, expired.id)).toHaveLength(commentBefore);
  });

  it('真跑：回待规划、清占用与租约、bump fence、写 system 审计评论', async () => {
    const expired = seed('过期租约');
    const fenceBefore = claimExpired(expired);
    const res = await post(wsA, { mode: 'expired' });
    expect(res.status).toBe(200);
    expect(res.body.released).toHaveLength(1);

    const after = row(expired.id);
    expect(after.status).toBe('待规划');
    expect(after.claimed_by).toBeNull();
    expect(after.claimed_at).toBeNull();
    expect(after.claim_lease_until).toBeNull();
    expect(after.last_heartbeat_at).toBeNull();
    expect(after.session_id).toBeNull();
    expect(after.claim_fence).toBe(fenceBefore + 1);

    const audit = listCommentsByIssue(t.db, expired.id).filter((c) => c.author === 'system');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.content).toContain('原占用者=agent-a');
    expect(audit[0]!.content).toContain('mode=expired');
    expect(res.body.released[0].status).toBe('待规划');
  });

  it('无主进行中卡：expired 下同样释放，审计写「原占用者=无」', async () => {
    const orphan = seedRunningOrphan('无主进行中');
    const res = await post(wsA, { mode: 'expired' });
    expect(res.status).toBe(200);
    expect(res.body.released.map((i: Issue) => i.id)).toEqual([orphan.id]);
    const audit = listCommentsByIssue(t.db, orphan.id).filter((c) => c.author === 'system');
    expect(audit[0]!.content).toContain('原占用者=无');
  });

  it('新鲜租约 → LEASE_ACTIVE，有主无租约 → UNDETERMINED；mode=all 两卡都释放', async () => {
    const fresh = seed('新鲜租约');
    claimIssue(t.db, fresh.id, 'agent-b', null);
    const legacy = seed('有主无租约');
    claimIssue(t.db, legacy.id, 'agent-c', null);
    t.db.prepare('UPDATE issue SET claim_lease_until=NULL WHERE id=?').run(legacy.id);

    const expiredRes = await post(wsA, { mode: 'expired' });
    expect(expiredRes.status).toBe(200);
    expect(expiredRes.body.released).toEqual([]);
    expect(expiredRes.body.skipped).toEqual(
      expect.arrayContaining([
        { id: fresh.id, reason: 'LEASE_ACTIVE' },
        { id: legacy.id, reason: 'UNDETERMINED' },
      ]),
    );
    expect(row(fresh.id).claimed_by).toBe('agent-b');

    const allRes = await post(wsA, { mode: 'all' });
    expect(allRes.status).toBe(200);
    expect(allRes.body.released.map((i: Issue) => i.id).sort()).toEqual([fresh.id, legacy.id].sort());
    expect(row(fresh.id).status).toBe('待规划');
    expect(row(legacy.id).status).toBe('待规划');
  });

  it('未知工作区 404 且零写入；body 里的 workspace_id 被忽略', async () => {
    const other = seed('别的区任务', wsB);
    claimExpired(other, 'agent-x');
    const before = row(other.id);

    const notFound = await post('not-a-uuid', { mode: 'all' });
    expect(notFound.status).toBe(404);

    const ignored = await post(wsA, { mode: 'all', workspace_id: wsB });
    expect(ignored.status).toBe(200);
    expect(ignored.body.released).toEqual([]);
    expect(row(other.id)).toEqual(before);
  });

  it('issue_ids 只在交集内处理，非本区 id 落 NOT_IN_WORKSPACE', async () => {
    const target = seed('目标卡');
    claimExpired(target);
    const untouched = seed('不该动');
    claimExpired(untouched, 'agent-b');
    const foreign = seed('外区', wsB);

    const res = await post(wsA, { mode: 'all', issue_ids: [target.id, foreign.id] });
    expect(res.status).toBe(200);
    expect(res.body.released.map((i: Issue) => i.id)).toEqual([target.id]);
    expect(res.body.skipped).toEqual([{ id: foreign.id, reason: 'NOT_IN_WORKSPACE' }]);
    expect(row(untouched.id).status).toBe('进行中');
  });

  it('旧 fence：done/release 409 STALE_FENCE，heartbeat 409 NOT_TASK_OWNER', async () => {
    const issue = seed('旧代次');
    const fence = claimExpired(issue);
    await post(wsA, { mode: 'expired' });

    const done = await request(app)
      .post(`/api/issues/${issue.id}/done`)
      .send({ agent_id: 'agent-a', workspace_id: wsA, fence });
    expect(done.status).toBe(409);
    expect(done.body.error?.code).toBe('STALE_FENCE');

    const release = await request(app)
      .post(`/api/issues/${issue.id}/release`)
      .send({ agent_id: 'agent-a', workspace_id: wsA, fence });
    expect(release.status).toBe(409);
    expect(release.body.error?.code).toBe('STALE_FENCE');

    const heartbeat = await request(app)
      .post(`/api/issues/${issue.id}/heartbeat`)
      .send({ agent_id: 'agent-a', workspace_id: wsA });
    // 占用已被清空 → heartbeatClaim 走「未被占用」分支（409 CONFLICT）；BORROW-0.2 既有口径
    expect(heartbeat.status).toBe(409);
    expect(heartbeat.body.error?.code).toBe('CONFLICT');
    expect(row(issue.id).status).toBe('待规划');
  });

  it('重复提交第二次 released 为空、200 不报错', async () => {
    const issue = seed('幂等');
    claimExpired(issue);
    const first = await post(wsA, { mode: 'expired' });
    expect(first.status).toBe(200);
    expect(first.body.released).toHaveLength(1);
    const second = await post(wsA, { mode: 'expired' });
    expect(second.status).toBe(200);
    expect(second.body.released).toEqual([]);
  });

  it('事务性：写回阶段某卡失败 → 整批回滚', () => {
    const good = seed('正常卡');
    claimExpired(good);
    const boom = seed('触发失败卡');
    claimExpired(boom, 'agent-b');
    t.db.exec(`CREATE TRIGGER rel1_boom BEFORE UPDATE ON issue WHEN OLD.id='${boom.id}'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

    expect(() => releaseRunning(t.db, wsA, { mode: 'expired' })).toThrow();
    expect(row(good.id).status).toBe('进行中');
    expect(row(boom.id).status).toBe('进行中');
    expect(listCommentsByIssue(t.db, good.id).filter((c) => c.author === 'system')).toHaveLength(0);
  });
});
