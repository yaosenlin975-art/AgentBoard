import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue, updateIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import {
  claimIssue,
  doneIssue,
  failIssue,
  releaseClaimedIssue,
  releaseIssue,
  updateIssueGuarded,
} from '../src/services/claim.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../src/errors.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
});

afterEach(() => {
  t.cleanup();
});

function seedIssue(): Issue {
  return createIssue(t.db, { workspace_id: wsId, title: '任务' });
}

describe('claimIssue 并发领取', () => {
  it('8 路 Promise.all 并行 claim 同一 issue 恰 1 成功，其余 ConflictError', async () => {
    const issue = seedIssue();
    const attempts = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() => claimIssue(t.db, issue.id, `agent-${i}`, `session-${i}`)),
    );
    const settled = await Promise.allSettled(attempts);
    const ok = settled.filter((r): r is PromiseFulfilledResult<Issue> => r.status === 'fulfilled');
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const r of failed) {
      // CLAIM-MSG：并发失败者都是「被别人占了」，不能再和「状态不可领取」混成一句话
      expect(r.reason).toBeInstanceOf(ApiError);
      expect((r.reason as ApiError).status).toBe(409);
      expect((r.reason as ApiError).code).toBe('ISSUE_CLAIMED');
      expect((r.reason as ApiError).message).toMatch(/^已被 .+ 占用/);
    }

    const winner = ok[0]!.value;
    const after = getIssue(t.db, issue.id)!;
    expect(after.claimed_by).toBe(winner.claimed_by);
    expect(after.session_id).toBe(winner.session_id);
    expect(after.claimed_at).toBeGreaterThan(0);
    expect(after.status).toBe('进行中');
  });

  it('待验收 issue 不可领取：文案是「状态不可领取」而不是「已被占用」（无人占用）', () => {
    const issue = seedIssue();
    updateIssue(t.db, issue.id, { status: '待验收' });
    try {
      claimIssue(t.db, issue.id, 'a', 's');
      throw new Error('应当抛出 409');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.status).toBe(409);
      expect(api.code).toBe('ISSUE_STATUS_NOT_CLAIMABLE');
      expect(api.message).toContain('状态不可领取（当前=待验收，需=待规划 或 进行中）');
      expect(api.message).not.toContain('已被');
    }
  });

  it('已占用 issue 领取：文案带占用者名（换成别的 agent 也知道是谁在占）', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'board-web-accounts', 's');
    try {
      claimIssue(t.db, issue.id, 'another', 's2');
      throw new Error('应当抛出 409');
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe('ISSUE_CLAIMED');
      expect(api.message).toBe('已被 board-web-accounts 占用；先 release 或换卡，勿重复 claim');
      expect(api.message).not.toContain('状态不可领取');
    }
  });

  it('已占用 issue 不可被第二个领取', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', 'session-a');
    expect(() => claimIssue(t.db, issue.id, 'agent-b', 'session-b')).toThrow(ApiError);
  });

  it('release 未占用卡：文案区分「未被占用」，不冒充「只有当前占用者」', () => {
    const issue = seedIssue();
    try {
      releaseClaimedIssue(t.db, issue.id, wsId, 'agent-a');
      throw new Error('应当抛出 409');
    } catch (error) {
      const api = error as ApiError;
      expect(api.status).toBe(409);
      expect(api.message).toContain('未被占用，无需释放');
      expect(api.message).not.toContain('只有当前占用者');
    }
  });
});

describe('updateIssueGuarded 占用守卫', () => {
  it('占用中 PATCH status 抛 ConflictError 且状态不变', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', 'session-a');
    expect(() => updateIssueGuarded(t.db, issue.id, { status: '已关闭' })).toThrow(ConflictError);
    expect(getIssue(t.db, issue.id)!.status).toBe('进行中');
  });

  it('占用中允许改 title/labels 等非 status 字段；未占用允许改 status', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', 'session-a');
    const patched = updateIssueGuarded(t.db, issue.id, { title: '占用中改名', labels: ['x'] });
    expect(patched.title).toBe('占用中改名');
    expect(patched.labels).toEqual(['x']);

    const free = seedIssue();
    const moved = updateIssueGuarded(t.db, free.id, { status: '进行中' });
    expect(moved.status).toBe('进行中');
    expect(moved.claimed_by).toBeNull();
  });

  it('不存在的 id 抛 NotFoundError', () => {
    expect(() => updateIssueGuarded(t.db, 'nope', { title: 'x' })).toThrow(NotFoundError);
  });
});

describe('doneIssue', () => {
  it('done→待验收 + 占用清空 + notes 落评论 author=agent:<id>；返回 comment', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a1', 'session-a');
    const { issue: done, comment } = await doneIssue(t.db, issue.id, 'a1', '已完成主体功能');
    expect(done.status).toBe('待验收');
    expect(done.claimed_by).toBeNull();
    expect(done.claimed_at).toBeNull();
    expect(done.session_id).toBeNull();

    expect(comment).toMatchObject({ author: 'agent:a1', content: '已完成主体功能' });
    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'agent:a1', content: '已完成主体功能' });
  });

  it('notes 为空不写评论（返回 comment=null）；重复 done 未占用→ConflictError；不存在→NotFoundError', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a1', 'session-a');
    const { comment } = await doneIssue(t.db, issue.id, 'a1', '   ');
    expect(comment).toBeNull();
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(0);

    await expect(doneIssue(t.db, issue.id, 'a1')).rejects.toThrow(ConflictError);
    await expect(doneIssue(t.db, 'nope', 'a1')).rejects.toThrow(NotFoundError);
  });
});

describe('failIssue', () => {
  it('fail→待规划 + 占用清空 + reason 落评论；返回 comment', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a2', 'session-a');
    const { issue: failed, comment } = await failIssue(t.db, issue.id, 'a2', '依赖缺失无法继续');
    expect(failed.status).toBe('待规划');
    expect(failed.claimed_by).toBeNull();
    expect(failed.session_id).toBeNull();

    expect(comment).toMatchObject({ author: 'agent:a2', content: '依赖缺失无法继续' });
    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'agent:a2', content: '依赖缺失无法继续' });
  });

  it('reason 必填；未占用→ConflictError', async () => {
    const issue = seedIssue();
    await expect(failIssue(t.db, issue.id, 'a2', '  ')).rejects.toThrow(ValidationError);
    await expect(failIssue(t.db, issue.id, 'a2', '原因')).rejects.toThrow(ConflictError);
  });
});

describe('releaseIssue', () => {
  it('release→待规划 + 清空占用 + system 评论；返回 comment', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a3', 'session-a');
    const { issue: released, comment } = await releaseIssue(t.db, issue.id);
    expect(released.status).toBe('待规划');
    expect(released.claimed_by).toBeNull();
    expect(released.session_id).toBeNull();

    expect(comment).toMatchObject({ author: 'system', content: '用户强制释放' });
    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'system', content: '用户强制释放' });
  });

  it('不存在→NotFoundError', async () => {
    await expect(releaseIssue(t.db, 'nope')).rejects.toThrow(NotFoundError);
  });
});
