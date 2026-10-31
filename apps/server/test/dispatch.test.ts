import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { addComment as insertCommentRow } from '../src/db/repos/comment.js';
import { getSession } from '../src/db/repos/session.js';
import { claimIssue, releaseIssue } from '../src/services/claim.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import {
  DISPATCH_PROMPT_TEMPLATE,
  HISTORY_NOTE_LIMIT,
  dispatchIssue,
  renderHistoryNotes,
  renderPrompt,
  type DispatchDeps,
} from '../src/services/dispatch.js';
import { initSessionManager, resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;
let deps: DispatchDeps;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

function sessionsOf(issueId: string): Array<{ id: string; adapter_session_id: string | null }> {
  return t.db.prepare('SELECT id, adapter_session_id FROM session WHERE issue_id = ?').all(issueId) as Array<{
    id: string;
    adapter_session_id: string | null;
  }>;
}

function seedIssue(overrides: Partial<Parameters<typeof createIssue>[1]> = {}) {
  return createIssue(t.db, { workspace_id: wsId, title: '实现登录', description: '支持邮箱登录', ...overrides });
}

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\demo' }).id;
  adapter = new FakeAdapter();
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  deps = { getAdapter: fakeResolver };
  // Date.now 单调递增：评论 (ts, id) 排序需要确定性
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('模板渲染', () => {
  it('默认模板渲染 4 变量，无评论时省略历史备注段', async () => {
    const issue = seedIssue();
    const { issue: claimed, session } = await dispatchIssue(t.db, deps, {
      issueId: issue.id,
      cli: 'fake',
      model: 'glm-5.3',
    });
    await settle();

    const expected = renderPrompt(DISPATCH_PROMPT_TEMPLATE, {
      issue_id: issue.id,
      title: '实现登录',
      description: '支持邮箱登录',
      workspace_path: 'D:\\ws\\demo',
    });
    expect(adapter.calls[0]!.prompt).toBe(expected);
    expect(adapter.calls[0]!.prompt).toContain(`任务 ID：${issue.id}`);
    expect(adapter.calls[0]!.prompt).toContain('标题：实现登录');
    expect(adapter.calls[0]!.prompt).toContain('支持邮箱登录');
    expect(adapter.calls[0]!.prompt).toContain('工作目录：D:\\ws\\demo');
    expect(adapter.calls[0]!.prompt).not.toContain('历史备注');

    expect(claimed.status).toBe('进行中');
    expect(claimed.claimed_by).toBe('fake');
    expect(claimed.session_id).toBe(session.id);
    expect(session.cli).toBe('fake');
    expect(session.model).toBe('glm-5.3');
    expect(session.issue_id).toBe(issue.id);
  });

  it('description 为空渲染为"(空)"', async () => {
    const issue = seedIssue({ description: '' });
    await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' });
    await settle();
    expect(adapter.calls[0]!.prompt).toContain('描述：\n(空)\n');
  });

  it('历史备注段：最近 10 条 ts 升序 `- [author] content`；超过 10 条只留最近', async () => {
    const issue = seedIssue();
    for (let i = 1; i <= 12; i++) {
      insertCommentRow(t.db, { issue_id: issue.id, author: i % 2 === 0 ? 'user' : 'agent:x', content: `第${i}条` });
    }

    const { session } = await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' });
    await settle();

    const rendered = renderPrompt(DISPATCH_PROMPT_TEMPLATE, {
      issue_id: issue.id,
      title: '实现登录',
      description: '支持邮箱登录',
      workspace_path: 'D:\\ws\\demo',
    });
    const lines = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
      (i) => `- [${i % 2 === 0 ? 'user' : 'agent:x'}] 第${i}条`,
    );
    expect(adapter.calls[0]!.prompt).toBe(`${rendered}\n## 历史备注\n${lines.join('\n')}`);
    expect(adapter.calls[0]!.prompt).not.toContain('第1条');
    expect(adapter.calls[0]!.prompt).not.toContain('第2条');
    expect(session.status).toBe('运行中');
  });

  it('promptTemplate 整体替换默认模板：变量仍渲染、历史备注仍追加', async () => {
    const issue = seedIssue();
    insertCommentRow(t.db, { issue_id: issue.id, author: 'user', content: '先跑通主流程' });

    await dispatchIssue(t.db, deps, {
      issueId: issue.id,
      cli: 'fake',
      promptTemplate: '自定义模板 {{title}} @ {{issue_id}} @ {{workspace_path}} @ {{description}}',
    });
    await settle();

    expect(adapter.calls[0]!.prompt).toBe(
      `自定义模板 实现登录 @ ${issue.id} @ D:\\ws\\demo @ 支持邮箱登录\n## 历史备注\n- [user] 先跑通主流程`,
    );
  });

  it('renderHistoryNotes 纯函数：无评论 null、有评论升序行', () => {
    const issue = seedIssue();
    expect(renderHistoryNotes(t.db, issue.id)).toBeNull();
    insertCommentRow(t.db, { issue_id: issue.id, author: 'system', content: '服务重启' });
    insertCommentRow(t.db, { issue_id: issue.id, author: 'user', content: '补充' });
    expect(renderHistoryNotes(t.db, issue.id)).toBe('## 历史备注\n- [system] 服务重启\n- [user] 补充');
    expect(HISTORY_NOTE_LIMIT).toBe(10);
  });
});

describe('派发事务', () => {
  it('reuse_session=last：沿用该 issue 最近 session 的 adapter_session_id 并作为首轮 resume', async () => {
    const issue = seedIssue();
    const first = await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' });
    await settle();
    expect(getSession(t.db, first.session.id)!.adapter_session_id).toBe('fake-as-0');

    // 首个会话仍占用：先释放再续用派发
    await releaseIssue(t.db, issue.id);
    const second = await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake', reuse_session: 'last' });
    // 起轮前会话行已带上沿用值（轮次回写会覆盖为 fake-as-1，故先断言）
    expect(getSession(t.db, second.session.id)!.adapter_session_id).toBe('fake-as-0');
    await settle();

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.adapterSessionId).toBe('fake-as-0');
  });

  it('未指定 reuse_session：新会话干净上下文，首轮不传 adapterSessionId', async () => {
    const issue = seedIssue();
    await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' });
    await settle();
    await releaseIssue(t.db, issue.id);
    const second = await dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' });
    expect(getSession(t.db, second.session.id)!.adapter_session_id).toBeNull();
    await settle();
    expect(adapter.calls[1]!.adapterSessionId).toBeUndefined();
  });

  it('占用冲突：ConflictError 向上抛、回滚新建会话行、不起轮', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'other-agent', 'session-other');
    const callsBefore = adapter.calls.length;

    await expect(dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' })).rejects.toThrow(ConflictError);
    await settle();

    expect(sessionsOf(issue.id)).toHaveLength(0); // 冲突派发的会话行已回滚
    expect(adapter.calls).toHaveLength(callsBefore);
    const after = getIssue(t.db, issue.id)!;
    expect(after.claimed_by).toBe('other-agent');
    expect(after.session_id).toBe('session-other');
  });

  it('未知 CLI：ValidationError，不建会话不起轮', async () => {
    const issue = seedIssue();
    await expect(dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'nope' })).rejects.toThrow(ValidationError);
    expect(sessionsOf(issue.id)).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it('issue 不存在：NotFoundError', async () => {
    await expect(dispatchIssue(t.db, deps, { issueId: 'no-such-id', cli: 'fake' })).rejects.toThrow(
      '任务不存在',
    );
  });

  it('并发派发同一 issue：恰好一个成功（其余 ConflictError 且无残留会话）', async () => {
    const issue = seedIssue();
    const results = await Promise.allSettled([
      dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' }),
      dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' }),
      dispatchIssue(t.db, deps, { issueId: issue.id, cli: 'fake' }),
    ]);
    await settle();

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    // 成功者的会话存活，失败者回滚干净
    expect(sessionsOf(issue.id)).toHaveLength(1);
  });
});
