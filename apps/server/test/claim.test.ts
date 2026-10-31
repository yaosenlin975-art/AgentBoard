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
  releaseIssue,
  updateIssueGuarded,
} from '../src/services/claim.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';

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
      expect(r.reason).toBeInstanceOf(ConflictError);
      expect((r.reason as ConflictError).message).toBe('已被占用');
    }

    const winner = ok[0]!.value;
    const after = getIssue(t.db, issue.id)!;
    expect(after.claimed_by).toBe(winner.claimed_by);
    expect(after.session_id).toBe(winner.session_id);
    expect(after.claimed_at).toBeGreaterThan(0);
    expect(after.status).toBe('进行中');
  });

  it('待验收 issue 不可领取（状态白名单外）', () => {
    const issue = seedIssue();
    updateIssue(t.db, issue.id, { status: '待验收' });
    expect(() => claimIssue(t.db, issue.id, 'a', 's')).toThrow(ConflictError);
  });

  it('已占用 issue 不可被第二个领取', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', 'session-a');
    expect(() => claimIssue(t.db, issue.id, 'agent-b', 'session-b')).toThrow(ConflictError);
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
  it('done→待验收 + 占用清空 + notes 落评论 author=agent:<id>', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a1', 'session-a');
    const done = await doneIssue(t.db, issue.id, 'a1', '已完成主体功能');
    expect(done.status).toBe('待验收');
    expect(done.claimed_by).toBeNull();
    expect(done.claimed_at).toBeNull();
    expect(done.session_id).toBeNull();

    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'agent:a1', content: '已完成主体功能' });
  });

  it('notes 为空不写评论；重复 done 未占用→ConflictError；不存在→NotFoundError', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a1', 'session-a');
    await doneIssue(t.db, issue.id, 'a1', '   ');
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(0);

    await expect(doneIssue(t.db, issue.id, 'a1')).rejects.toThrow(ConflictError);
    await expect(doneIssue(t.db, 'nope', 'a1')).rejects.toThrow(NotFoundError);
  });
});

describe('failIssue', () => {
  it('fail→待规划 + 占用清空 + reason 落评论', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a2', 'session-a');
    const failed = await failIssue(t.db, issue.id, 'a2', '依赖缺失无法继续');
    expect(failed.status).toBe('待规划');
    expect(failed.claimed_by).toBeNull();
    expect(failed.session_id).toBeNull();

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
  it('release→待规划 + 清空占用 + system 评论', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'a3', 'session-a');
    const released = await releaseIssue(t.db, issue.id);
    expect(released.status).toBe('待规划');
    expect(released.claimed_by).toBeNull();
    expect(released.session_id).toBeNull();

    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'system', content: '用户强制释放' });
  });

  it('不存在→NotFoundError', async () => {
    await expect(releaseIssue(t.db, 'nope')).rejects.toThrow(NotFoundError);
  });
});
