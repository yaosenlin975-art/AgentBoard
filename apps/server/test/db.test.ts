import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace, deleteWorkspace, listWorkspaces } from '../src/db/repos/workspace.js';
import {
  createIssue,
  deleteIssue,
  getIssue,
  listIssues,
  updateIssue,
} from '../src/db/repos/issue.js';
import { addComment, listCommentsByIssue } from '../src/db/repos/comment.js';
import {
  createSession,
  getSession,
  listSessionsByWorkspace,
  updateSession,
} from '../src/db/repos/session.js';
import { addMessage, listMessagesBySession } from '../src/db/repos/message.js';
import { NotFoundError } from '../src/errors.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'demo', path: 'D:\\ws\\demo' }).id;
});

afterEach(() => {
  t.cleanup();
});

describe('workspace repo', () => {
  it('create/list 往返', () => {
    const list = listWorkspaces(t.db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'demo', path: 'D:\\ws\\demo' });
    expect(list[0]!.created_at).toBeGreaterThan(0);
  });

  it('delete 级联清理 issue/评论/会话/消息（外键 ON DELETE CASCADE）', () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '任务' });
    addComment(t.db, { issue_id: issue.id, author: 'user', content: 'hi' });
    const session = createSession(t.db, { workspace_id: wsId, issue_id: issue.id, cli: 'codex' });
    addMessage(t.db, { session_id: session.id, role: 'user', content: 'm' });

    deleteWorkspace(t.db, wsId);
    expect(listWorkspaces(t.db)).toHaveLength(0);
    expect(listIssues(t.db, wsId)).toHaveLength(0);
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(0);
    expect(listSessionsByWorkspace(t.db, wsId)).toHaveLength(0);
    expect(listMessagesBySession(t.db, session.id)).toHaveLength(0);
  });

  it('删除不存在的 id 抛 NotFoundError', () => {
    expect(() => deleteWorkspace(t.db, 'nope')).toThrow(NotFoundError);
  });
});

describe('issue repo', () => {
  it('create 默认值：优先级中、labels 空、状态待规划、描述空', () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '默认' });
    expect(issue).toMatchObject({
      workspace_id: wsId,
      title: '默认',
      description: '',
      priority: '中',
      labels: [],
      status: '待规划',
      sort_order: 0,
      claimed_by: null,
      claimed_at: null,
      session_id: null,
    });
    expect(issue.created_at).toBeGreaterThan(0);
    expect(issue.updated_at).toBeGreaterThan(0);
  });

  it('labels round-trip：string[] 落库为 JSON，读回 string[]', () => {
    const labels = ['前端', 'bug', 'api'];
    const issue = createIssue(t.db, { workspace_id: wsId, title: '标签', labels });
    expect(getIssue(t.db, issue.id)!.labels).toEqual(labels);
    const updated = updateIssue(t.db, issue.id, { labels: ['重开'] });
    expect(updated.labels).toEqual(['重开']);
  });

  it('update 任意字段子集，未传字段不动，updated_at 刷新', () => {
    const issue = createIssue(t.db, {
      workspace_id: wsId,
      title: '原题',
      description: '原描述',
      priority: '高',
      labels: ['a'],
      sort_order: 5,
    });
    const patched = updateIssue(t.db, issue.id, { title: '新题' });
    expect(patched.title).toBe('新题');
    expect(patched.description).toBe('原描述');
    expect(patched.priority).toBe('高');
    expect(patched.labels).toEqual(['a']);
    expect(patched.sort_order).toBe(5);
    expect(patched.status).toBe('待规划');
    expect(patched.updated_at).toBeGreaterThanOrEqual(patched.created_at);
  });

  it('list 按 sort_order 升序', () => {
    createIssue(t.db, { workspace_id: wsId, title: 'b', sort_order: 2 });
    createIssue(t.db, { workspace_id: wsId, title: 'a', sort_order: 1 });
    createIssue(t.db, { workspace_id: wsId, title: 'c', sort_order: 10 });
    const titles = listIssues(t.db, wsId).map((i) => i.title);
    expect(titles).toEqual(['a', 'b', 'c']);
  });

  it('list 隔离其他工作空间；delete 生效', () => {
    const otherWs = createWorkspace(t.db, { name: 'other', path: 'D:\\ws\\other' }).id;
    const mine = createIssue(t.db, { workspace_id: wsId, title: 'mine' });
    createIssue(t.db, { workspace_id: otherWs, title: 'theirs' });
    expect(listIssues(t.db, wsId).map((i) => i.title)).toEqual(['mine']);

    deleteIssue(t.db, mine.id);
    expect(getIssue(t.db, mine.id)).toBeNull();
    expect(() => deleteIssue(t.db, mine.id)).toThrow(NotFoundError);
  });

  it('comment_count：无评论为 0，加 2 条后 getIssue/listIssues 均 2，且不串到其他任务', () => {
    const withComments = createIssue(t.db, { workspace_id: wsId, title: '带评论' });
    const clean = createIssue(t.db, { workspace_id: wsId, title: '无评论' });
    expect(getIssue(t.db, withComments.id)!.comment_count).toBe(0);
    expect(listIssues(t.db, wsId).find((i) => i.id === withComments.id)!.comment_count).toBe(0);

    addComment(t.db, { issue_id: withComments.id, author: 'user', content: '第一条' });
    addComment(t.db, { issue_id: withComments.id, author: 'agent:a1', content: '第二条' });
    expect(getIssue(t.db, withComments.id)!.comment_count).toBe(2);
    const list = listIssues(t.db, wsId);
    expect(list.find((i) => i.id === withComments.id)!.comment_count).toBe(2);
    expect(list.find((i) => i.id === clean.id)!.comment_count).toBe(0);
  });
});

describe('comment repo', () => {
  it('add/list by issue，ts 升序', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const issue = createIssue(t.db, { workspace_id: wsId, title: '任务' });
    addComment(t.db, { issue_id: issue.id, author: 'agent:codex', content: '第一条' });
    vi.setSystemTime(2_000);
    addComment(t.db, { issue_id: issue.id, author: 'user', content: '第二条' });
    vi.setSystemTime(3_000);
    addComment(t.db, { issue_id: issue.id, author: 'system', content: '第三条' });
    vi.useRealTimers();

    const comments = listCommentsByIssue(t.db, issue.id);
    expect(comments.map((c) => c.content)).toEqual(['第一条', '第二条', '第三条']);
    expect(comments.map((c) => c.ts)).toEqual([1_000, 2_000, 3_000]);
  });
});

describe('session repo', () => {
  it('create 默认运行中 + adapter_session_id 空；update 状态与 adapter_session_id；list/get', () => {
    const session = createSession(t.db, { workspace_id: wsId, issue_id: null, cli: 'codex', model: 'gpt-5' });
    expect(session).toMatchObject({
      workspace_id: wsId,
      issue_id: null,
      cli: 'codex',
      model: 'gpt-5',
      status: '运行中',
      adapter_session_id: null,
    });

    const updated = updateSession(t.db, session.id, {
      status: '已结束',
      adapter_session_id: 'abc-123',
    });
    expect(getSession(t.db, session.id)).toMatchObject({
      status: '已结束',
      adapter_session_id: 'abc-123',
    });
    expect(updated.status).toBe('已结束');

    const other = createSession(t.db, {
      workspace_id: createWorkspace(t.db, { name: 'w2', path: 'D:\\ws\\2' }).id,
      cli: 'dsh',
    });
    const list = listSessionsByWorkspace(t.db, wsId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(session.id);
    expect(listSessionsByWorkspace(t.db, other.workspace_id)).toHaveLength(1);
  });
});

describe('message repo', () => {
  it('add/listBySession after 过滤，ts 升序', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const session = createSession(t.db, { workspace_id: wsId, cli: 'codex' });
    addMessage(t.db, { session_id: session.id, role: 'user', content: 'q1' });
    vi.setSystemTime(2_000);
    addMessage(t.db, { session_id: session.id, role: 'assistant', content: 'a1' });
    vi.setSystemTime(3_000);
    addMessage(t.db, { session_id: session.id, role: 'user', content: 'q2' });
    vi.useRealTimers();

    expect(listMessagesBySession(t.db, session.id).map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(listMessagesBySession(t.db, session.id, 2_000).map((m) => m.content)).toEqual(['q2']);
    expect(listMessagesBySession(t.db, session.id, 99_999)).toEqual([]);
  });
});
