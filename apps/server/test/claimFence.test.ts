/**
 * BORROW-0.3：fence 闭环。
 *
 * 覆盖卡面验收 5 条：
 * 1. 旧 fence 调 done/fail/release → 409 STALE_FENCE，库内零写入；
 * 2. 不传 fence 的既有调用仍成功（软模式兼容）；
 * 3. 路由层：body.fence 与 x-claim-fence 头双通道，非法头 400；
 * 4. 并发领取仅一方成功，fence 连续递增无重复；
 * 5. heartbeat / updateIssueGuarded / storeComment 同样受 fence 软校验保护。
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
import {
  claimIssue,
  doneIssue,
  failIssue,
  heartbeatClaim,
  releaseIssue,
  updateIssueGuarded,
} from '../src/services/claim.js';
import { storeComment } from '../src/services/comments.js';
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

function seedIssue(title = 'fence 任务'): Issue {
  return createIssue(t.db, { workspace_id: wsId, title });
}

interface Row { claimed_by: string | null; status: string; claim_fence: number; updated_at: number; }
function row(id: string): Row {
  return t.db.prepare('SELECT claimed_by, status, claim_fence, updated_at FROM issue WHERE id=?').get(id) as Row;
}

function expectStaleFence(fn: () => unknown): void {
  expect(fn).toThrowError(expect.objectContaining({ status: 409, code: 'STALE_FENCE' }) as ApiError);
}

describe('收尾写入口 fence 软校验（服务层）', () => {
  it('旧 fence：done/fail/release 全部 409 STALE_FENCE 且库内零写入', async () => {
    for (const action of ['done', 'fail', 'release'] as const) {
      const issue = seedIssue(`旧fence-${action}`);
      claimIssue(t.db, issue.id, 'agent-a', null);
      // 抢占一次抬高 fence → 旧持有者（agent-a）手里的 fence 已过期
      t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
      claimIssue(t.db, issue.id, 'agent-b', null);
      const staleFence = 1;
      const before = row(issue.id);
      // doneIssue/failIssue/releaseIssue 是 async：必须用 rejects 断言（否则拒绝变成 unhandled）
      if (action === 'release') {
        await expect(releaseIssue(t.db, issue.id, staleFence)).rejects.toMatchObject({ status: 409, code: 'STALE_FENCE' });
      } else if (action === 'done') {
        await expect(doneIssue(t.db, issue.id, 'agent-b', '旧 fence', staleFence)).rejects.toMatchObject({ status: 409, code: 'STALE_FENCE' });
      } else {
        await expect(failIssue(t.db, issue.id, 'agent-b', '旧 fence', undefined, staleFence)).rejects.toMatchObject({ status: 409, code: 'STALE_FENCE' });
      }
      const after = row(issue.id);
      expect(after).toEqual(before);
    }
  });

  it('软模式：不传 fence 的既有调用仍成功；正确 fence 也成功', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    // 软模式（无 fence 参数）
    expect(() => heartbeatClaim(t.db, issue.id, 'agent-a')).not.toThrow();
    // 正确 fence
    const current = row(issue.id).claim_fence;
    expect(heartbeatClaim(t.db, issue.id, 'agent-a', current).claim_fence).toBe(current);
  });

  it('heartbeat / updateIssueGuarded / storeComment：旧 fence 409 零写入', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    // 抬高 fence 模拟抢占
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
    claimIssue(t.db, issue.id, 'agent-b', null);
    const staleFence = 1;
    const before = row(issue.id);

    expectStaleFence(() => heartbeatClaim(t.db, issue.id, 'agent-b', staleFence));
    expect(row(issue.id)).toEqual(before);

    expectStaleFence(() => updateIssueGuarded(t.db, issue.id, { title: '被旧 fence 改名' }, staleFence));
    expect(row(issue.id)).toEqual(before);

    const commentCountBefore = listCommentsByIssue(t.db, issue.id).length;
    expectStaleFence(() => storeComment(t.db, issue.id, 'agent:agent-b', '旧 fence 评论', [], staleFence));
    expect(row(issue.id)).toEqual(before);
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(commentCountBefore);

    // 正确 fence：三个入口都放行
    const current = row(issue.id).claim_fence;
    expect(() => storeComment(t.db, issue.id, 'agent:agent-b', '新 fence 评论', [], current)).not.toThrow();
    expect(() => updateIssueGuarded(t.db, issue.id, { title: '新 fence 改名' }, current)).not.toThrow();
    expect(heartbeatClaim(t.db, issue.id, 'agent-b', current).claimed_by).toBe('agent-b');
  });

  it('并发领取仅一方成功，fence 连续递增无重复', async () => {
    const issue = seedIssue();
    const attempts = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() => claimIssue(t.db, issue.id, `agent-${i}`, null)),
    );
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // 依次抢占 3 次：fence 必须是 1,2,3,4 连续
    const fences: number[] = [row(issue.id).claim_fence];
    for (let i = 0; i < 3; i++) {
      t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
      claimIssue(t.db, issue.id, `agent-x-${i}`, null);
      fences.push(row(issue.id).claim_fence);
    }
    expect(fences).toEqual([1, 2, 3, 4]);
  });
});

describe('REST 路由 fence 双通道', () => {
  let app: Express;

  beforeEach(async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });

  it('claim 响应携带 claim_fence；done 用 body.fence 过期 → 409 STALE_FENCE', async () => {
    const issue = seedIssue();
    const claimRes = await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.claim_fence).toBe(1);

    // 抬高 fence 模拟抢占（真实链路由另一 claim 完成，这里直接改列保持用例聚焦）
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
    await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-b', workspace_id: wsId });

    const before = row(issue.id);
    const stale = await request(app).post(`/api/issues/${issue.id}/done`)
      .send({ agent_id: 'agent-b', notes: '旧 fence', fence: 1, workspace_id: wsId });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_FENCE');
    expect(stale.body.error.message).toContain('重新 kb claim');
    expect(row(issue.id)).toEqual(before);

    const ok = await request(app).post(`/api/issues/${issue.id}/done`)
      .send({ agent_id: 'agent-b', notes: '新 fence', fence: 2, workspace_id: wsId });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('待验收');
  });

  it('x-claim-fence 头通道：过期 409、正确 200、非法值 400、缺席放行', async () => {
    const issue = seedIssue();
    await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-a', workspace_id: wsId });
    const before = row(issue.id);

    const staleHeader = await request(app).post(`/api/issues/${issue.id}/heartbeat`)
      .set('x-claim-fence', '999')
      .send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(staleHeader.status).toBe(409);
    expect(staleHeader.body.error.code).toBe('STALE_FENCE');
    expect(row(issue.id)).toEqual(before);

    const okHeader = await request(app).post(`/api/issues/${issue.id}/heartbeat`)
      .set('x-claim-fence', '1')
      .send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(okHeader.status).toBe(200);
    expect(okHeader.body.claim_fence).toBe(1);

    const badHeader = await request(app).post(`/api/issues/${issue.id}/heartbeat`)
      .set('x-claim-fence', 'abc')
      .send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(badHeader.status).toBe(400);

    const noHeader = await request(app).post(`/api/issues/${issue.id}/heartbeat`)
      .send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(noHeader.status).toBe(200);
  });

  it('storeComment 路由：旧 fence 409 且评论未落库', async () => {
    const issue = seedIssue();
    await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-a', workspace_id: wsId });
    const stale = await request(app).post(`/api/issues/${issue.id}/comments`)
      .send({ content: '旧 fence', agent_id: 'agent-a', fence: 7, workspace_id: wsId });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_FENCE');
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(0);
  });

  it('updateIssueGuarded 路由：旧 fence 409 零写入', async () => {
    const issue = seedIssue();
    await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-a', workspace_id: wsId });
    const before = row(issue.id);
    const stale = await request(app).patch(`/api/issues/${issue.id}`)
      .send({ title: '旧 fence 改名', fence: 42, workspace_id: wsId });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_FENCE');
    expect(row(issue.id)).toEqual(before);
  });
});
