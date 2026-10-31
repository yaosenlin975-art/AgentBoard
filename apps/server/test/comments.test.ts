import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { claimIssue } from '../src/services/claim.js';
import { addComment, resetSessionSender, setSessionSender } from '../src/services/comments.js';
import type { SessionSender } from '../src/services/sessionManager.js';
import { NotFoundError } from '../src/errors.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
  resetSessionSender();
});

afterEach(() => {
  t.cleanup();
});

function seedIssue() {
  return createIssue(t.db, { workspace_id: wsId, title: '任务' });
}

function claimWith(issueId: string) {
  claimIssue(t.db, issueId, 'agent-a', 'session-a');
}

describe('addComment 落库', () => {
  it('插入评论并触碰 issue.updated_at；返回落库的 comment（未占用不触发唤醒）', async () => {
    const issue = seedIssue();
    t.db.prepare('UPDATE issue SET updated_at = 1000').run();

    const result = await addComment(t.db, issue.id, 'user', '请补充测试范围');

    expect(result.woke).toBe(false);
    expect(result.comment).toMatchObject({
      issue_id: issue.id,
      author: 'user',
      content: '请补充测试范围',
    });
    const after = getIssue(t.db, issue.id)!;
    expect(after.updated_at).toBeGreaterThan(1000);

    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'user', content: '请补充测试范围' });
  });

  it('issue 不存在 → NotFoundError 且不落库', async () => {
    await expect(addComment(t.db, 'nope', 'user', 'x')).rejects.toThrow(NotFoundError);
    expect(listCommentsByIssue(t.db, 'nope')).toHaveLength(0);
  });
});

describe('agent/system 作者不触发唤醒', () => {
  it('agent:<id> 作者在占用中也不调 sender', async () => {
    const issue = seedIssue();
    claimWith(issue.id);
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'agent:a1', '进展总结');

    expect(result.woke).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(1);
  });

  it('system 作者在占用中也不调 sender', async () => {
    const issue = seedIssue();
    claimWith(issue.id);
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'system', '服务重启，会话中断');

    expect(result.woke).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(1);
  });
});

describe('sender 异常语义', () => {
  it('sender 抛错：评论已落库、占用保持、错误向上抛', async () => {
    const issue = seedIssue();
    claimWith(issue.id);
    const sender = vi.fn<SessionSender>().mockRejectedValue(new Error('队列故障'));
    setSessionSender(sender);

    await expect(addComment(t.db, issue.id, 'user', '补充指令')).rejects.toThrow('队列故障');

    expect(sender).toHaveBeenCalledOnce();
    expect(sender).toHaveBeenCalledWith('session-a', '补充指令');
    // 评论已落库
    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'user', content: '补充指令' });
    // 占用保持，未被错误破坏
    const after = getIssue(t.db, issue.id)!;
    expect(after.claimed_by).toBe('agent-a');
    expect(after.session_id).toBe('session-a');
  });

  it('未装配 sender：占用中 user 评论抛 "sessionManager 未装配"，评论已落库', async () => {
    const issue = seedIssue();
    claimWith(issue.id);
    // 不调 setSessionSender，使用默认 sender

    await expect(addComment(t.db, issue.id, 'user', 'hi')).rejects.toThrow('sessionManager 未装配');
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(1);
  });
});
