import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { claimIssue } from '../src/services/claim.js';
import { addComment, resetSessionSender, setSessionSender } from '../src/services/comments.js';
import type { SessionSender } from '../src/services/sessionManager.js';

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

function seedClaimedIssue() {
  const issue = createIssue(t.db, { workspace_id: wsId, title: '任务' });
  claimIssue(t.db, issue.id, 'agent-a', 'session-a');
  return issue;
}

describe('评论唤醒路由', () => {
  it('占用中 user 评论 → sender 收到内容、woke=true', async () => {
    const issue = seedClaimedIssue();
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'user', '把边界条件也覆盖一下');

    expect(sender).toHaveBeenCalledOnce();
    expect(sender).toHaveBeenCalledWith('session-a', '把边界条件也覆盖一下');
    expect(result.woke).toBe(true);
    expect(result.comment).toMatchObject({ author: 'user', content: '把边界条件也覆盖一下' });
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(1);
  });

  it('运行中 stub 返回 {queued:true}：语义不变——不抛错、woke=true、内容透传一次', async () => {
    const issue = seedClaimedIssue();
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const first = await addComment(t.db, issue.id, 'user', '第一条');
    const second = await addComment(t.db, issue.id, 'user', '第二条');

    expect(first.woke).toBe(true);
    expect(second.woke).toBe(true);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender).toHaveBeenNthCalledWith(1, 'session-a', '第一条');
    expect(sender).toHaveBeenNthCalledWith(2, 'session-a', '第二条');
  });

  it('空闲起轮 stub 返回 {queued:false}：woke=true（queued 值不改变唤醒语义）', async () => {
    const issue = seedClaimedIssue();
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: false });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'user', '开工前提醒');

    expect(result.woke).toBe(true);
    expect(sender).toHaveBeenCalledOnce();
  });

  it('未占用 user 评论 → woke=false、sender 未调用', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '没人领的任务' });
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'user', '留言等下次派发');

    expect(result.woke).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(1);
  });

  it('占用字段不完整（claimed_by 有值但 session_id 为空）不触发唤醒', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '异常占用态' });
    t.db
      .prepare(`UPDATE issue SET claimed_by='agent-a', claimed_at=?, session_id=NULL WHERE id=?`)
      .run(Date.now(), issue.id);
    const sender = vi.fn<SessionSender>().mockResolvedValue({ queued: true });
    setSessionSender(sender);

    const result = await addComment(t.db, issue.id, 'user', 'x');

    expect(result.woke).toBe(false);
    expect(sender).not.toHaveBeenCalled();
  });

  it('唤醒失败不改变占用与评论状态（幂等可重试）', async () => {
    const issue = seedClaimedIssue();
    const sender = vi
      .fn<SessionSender>()
      .mockRejectedValueOnce(new Error('暂时不可用'))
      .mockResolvedValueOnce({ queued: true });
    setSessionSender(sender);

    await expect(addComment(t.db, issue.id, 'user', '重试前')).rejects.toThrow('暂时不可用');
    const retry = await addComment(t.db, issue.id, 'user', '重试后');

    expect(retry.woke).toBe(true);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(getIssue(t.db, issue.id)!.session_id).toBe('session-a');
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(2);
  });
});
