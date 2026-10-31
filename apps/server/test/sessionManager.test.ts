import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import type { WsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { listMessagesBySession } from '../src/db/repos/message.js';
import { getSession } from '../src/db/repos/session.js';
import { claimIssue } from '../src/services/claim.js';
import {
  createSession,
  initSessionManager,
  recoverOnBoot,
  resetSessionManager,
  sendToSession,
  setBroadcaster,
  stopSession,
  type CreateSessionInput,
} from '../src/services/sessionManager.js';

// ---- 夹具 ----

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

async function newSession(opts: Partial<CreateSessionInput> = {}) {
  return createSession({ cli: 'fake', workspace_id: wsId, ...opts });
}

/** 挂起控制：首轮挂起（进 held），后续轮自动完成 */
function hangFirstTurn(held: FakeTurnControl[]): void {
  adapter.script = (control) => {
    if (control.callIndex === 0) {
      held.push(control);
      return;
    }
    control.emit({ type: 'text', delta: `回复${control.callIndex}` });
    control.finish(0, `fake-as-${control.callIndex}`);
  };
}

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\demo' }).id;
  adapter = new FakeAdapter();
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  // Date.now 单调递增：message.ts 以 (ts, id) 排序，毫秒内随机 UUID 会打乱顺序，这里钉死确定性
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('空闲起轮', () => {
  it('user 消息落库、runTurn 参数正确、事件经 broadcaster 可订阅、正常结束', async () => {
    const events: WsEvent[] = [];
    setBroadcaster((e) => events.push(e));

    const session = await newSession({ model: 'm1', prompt: '第一轮指令' });
    expect(session.status).toBe('运行中');
    await settle();

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toEqual({
      cwd: 'D:\\ws\\demo',
      model: 'm1',
      prompt: '第一轮指令',
      adapterSessionId: undefined,
    });

    const messages = listMessagesBySession(t.db, session.id);
    expect(messages[0]).toMatchObject({ role: 'user', content: '第一轮指令' });
    expect(messages.filter((m) => m.role === 'assistant')).toEqual([
      expect.objectContaining({ role: 'assistant', content: '回复0' }),
    ]);

    expect(events.some((e) => e.type === 'message.added' && e.message.role === 'user')).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'session.event' && e.event.type === 'text' && e.event.delta === '回复0',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'message.added' && e.message.role === 'assistant')).toBe(true);
    expect(events.some((e) => e.type === 'session.event' && e.event.type === 'end')).toBe(true);

    const after = getSession(t.db, session.id)!;
    expect(after.status).toBe('已结束');
    expect(after.adapter_session_id).toBe('fake-as-0');
  });

  it('未设置 model 时 runTurn 收到 model=undefined', async () => {
    const session = await newSession({ prompt: '无模型' });
    await settle();
    expect(adapter.calls[0]!.cwd).toBe('D:\\ws\\demo');
    expect(adapter.calls[0]!.model).toBeUndefined();
    expect(adapter.calls[0]!.adapterSessionId).toBeUndefined();
    expect(getSession(t.db, session.id)!.status).toBe('已结束');
  });
});

describe('运行中排队与合并', () => {
  it('运行中 send → queued=true；轮次结束自动以排队文本起下一轮并 resume', async () => {
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control); // 全部挂起，逐轮手动放行
    };

    const session = await newSession({ prompt: '首轮' });
    await settle();
    expect(adapter.calls).toHaveLength(1);

    expect(await sendToSession(session.id, '第二条')).toEqual({ queued: true });
    expect(await sendToSession(session.id, '第三条')).toEqual({ queued: true });
    expect(adapter.calls).toHaveLength(1); // 仍在首轮，未叠进程

    held[0]!.finish(0, 'fake-as-r1');
    await settle();

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]).toMatchObject({
      prompt: '第二条\n\n第三条',
      adapterSessionId: 'fake-as-r1',
    });
    const userTexts = listMessagesBySession(t.db, session.id)
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(userTexts).toEqual(['首轮', '第二条', '第三条']); // 排队消息各自落 user 行

    held[1]!.finish(0, 'fake-as-r2');
    await settle();
    expect(getSession(t.db, session.id)!.status).toBe('已结束');
    expect(getSession(t.db, session.id)!.adapter_session_id).toBe('fake-as-r2');
  });

  it('连续 3 条运行中消息：只合并为一次下一轮 prompt，不叠 3 个进程（Review Focus 3）', async () => {
    const held: FakeTurnControl[] = [];
    hangFirstTurn(held);

    const session = await newSession({ prompt: '首轮' });
    await settle();

    await sendToSession(session.id, '甲');
    await sendToSession(session.id, '乙');
    await sendToSession(session.id, '丙');
    expect(adapter.calls).toHaveLength(1);

    held[0]!.finish(0, 'as-1');
    await settle();

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.prompt).toBe('甲\n\n乙\n\n丙');
  });
});

describe('全局并发槽位', () => {
  it('maxConcurrentTurns=1：第二个会话的轮次等槽位，释放后按先到先发', async () => {
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 1 });
    const held: FakeTurnControl[] = [];
    hangFirstTurn(held);

    const a = await newSession({ prompt: 'A 轮' });
    await settle();
    expect(adapter.calls).toHaveLength(1);

    const b = await newSession({ prompt: 'B 轮' });
    await settle();
    expect(adapter.calls).toHaveLength(1); // B 的轮次已受理但等槽位，runTurn 未被调
    expect(adapter.calls[0]!.prompt).toBe('A 轮');

    // 等槽位中的会话再发消息 → 会话级排队
    expect(await sendToSession(b.id, 'B 追加')).toEqual({ queued: true });

    held[0]!.finish(0, 'as-a');
    await settle();

    expect(adapter.calls.map((c) => c.prompt)).toEqual(['A 轮', 'B 轮', 'B 追加']);
    expect(getSession(t.db, a.id)!.status).toBe('已结束');
    expect(getSession(t.db, b.id)!.status).toBe('已结束');
  });
});

describe('停止', () => {
  it('stop：kill 当轮、session 置已结束、队列保留；续聊后保留队列仍会发出', async () => {
    const held: FakeTurnControl[] = [];
    hangFirstTurn(held);

    const session = await newSession({ prompt: '首轮' });
    await settle();
    expect(adapter.calls).toHaveLength(1);

    expect(await sendToSession(session.id, '排队消息')).toEqual({ queued: true });

    const stopped = await stopSession(session.id);
    expect(stopped.status).toBe('已结束');
    expect(held[0]!.killed).toBe(true);

    await settle();
    // kill 的非零 exitCode 不再把会话置失败；队列不自动消费
    expect(getSession(t.db, session.id)!.status).toBe('已结束');
    expect(adapter.calls).toHaveLength(1);

    // 续聊：新消息立即起轮（resume），保留的排队消息随后合并发出
    expect(await sendToSession(session.id, '续聊')).toEqual({ queued: false });
    await settle();
    expect(adapter.calls.map((c) => c.prompt)).toEqual(['首轮', '续聊', '排队消息']);
    expect(getSession(t.db, session.id)!.status).toBe('已结束');
  });
});

describe('失败联动', () => {
  it('exitCode≠0：会话置失败；占用 issue 走 fail 释放并写 agent:<cli> 评论', async () => {
    const held: FakeTurnControl[] = [];
    hangFirstTurn(held);
    const issue = createIssue(t.db, { workspace_id: wsId, title: '失败任务' });
    const session = await newSession({ issue_id: issue.id, prompt: '干活' });
    await settle();
    claimIssue(t.db, issue.id, 'agent-x', session.id);

    held[0]!.finish(1, null);
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('失败');
    const after = getIssue(t.db, issue.id)!;
    expect(after.status).toBe('待规划');
    expect(after.claimed_by).toBeNull();
    expect(after.session_id).toBeNull();
    expect(listCommentsByIssue(t.db, issue.id)).toEqual([
      expect.objectContaining({ author: 'agent:fake', content: '会话异常退出' }),
    ]);
  });

  it('TurnResult 带 stderrTail：以 role=error 落一条含 tail 的消息（exit 0 也落）', async () => {
    adapter.script = (control) => {
      control.finish(0, null, ['boom line 1', 'boom line 2']);
    };
    const session = await newSession({ prompt: '静默失败' });
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('已结束');
    const messages = listMessagesBySession(t.db, session.id);
    const tailMessages = messages.filter((m) => m.role === 'error');
    expect(tailMessages).toHaveLength(1);
    expect(tailMessages[0]).toMatchObject({
      role: 'error',
      content: '适配器 stderr 尾部：\nboom line 1\nboom line 2',
    });
  });

  it('TurnResult 无 stderrTail / 空数组：不落额外 error 消息', async () => {
    adapter.script = (control) => {
      control.finish(0, 'fake-as-0');
    };
    const session = await newSession({ prompt: '正常轮次' });
    await settle();

    const messages = listMessagesBySession(t.db, session.id);
    expect(messages.filter((m) => m.role === 'error')).toHaveLength(0);
  });

  it('自由会话失败：只标会话，不涉及 issue', async () => {
    const other = createIssue(t.db, { workspace_id: wsId, title: '无关任务' });
    adapter.script = (control) => {
      control.finish(2, null);
    };
    const session = await newSession({ prompt: '自由' });
    await settle();
    expect(getSession(t.db, session.id)!.status).toBe('失败');
    // 无关 issue 不受影响、无评论产生
    expect(getIssue(t.db, other.id)).toMatchObject({ status: '待规划', claimed_by: null });
    expect(listCommentsByIssue(t.db, other.id)).toHaveLength(0);
  });

  it('issue 被其他会话占用时：会话失败不触发该 issue 的 fail 流程', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '别人的任务' });
    claimIssue(t.db, issue.id, 'agent-y', 'session-other');
    adapter.script = (control) => {
      control.finish(3, null);
    };
    const session = await newSession({ issue_id: issue.id, prompt: 'x' });
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('失败');
    const after = getIssue(t.db, issue.id)!;
    expect(after.claimed_by).toBe('agent-y');
    expect(after.session_id).toBe('session-other');
    expect(listCommentsByIssue(t.db, issue.id)).toHaveLength(0);
  });

  it('未知 CLI 起轮：错误消息落库、会话置失败、不崩进程（Review Focus 5）', async () => {
    const session = await newSession({ cli: 'nope', prompt: 'x' });
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('失败');
    expect(adapter.calls).toHaveLength(0);
    const messages = listMessagesBySession(t.db, session.id);
    expect(messages.some((m) => m.role === 'error' && m.content.includes('nope'))).toBe(true);

    // 进程未崩：后续正常起轮可用
    const ok = await newSession({ prompt: '正常' });
    await settle();
    expect(getSession(t.db, ok.id)!.status).toBe('已结束');
  });

  it('未知 CLI 起轮失败且占用 issue：释放占用并写失败评论', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '未装 CLI' });
    const session = await newSession({ cli: 'nope', issue_id: issue.id }); // 无 prompt：不起轮
    claimIssue(t.db, issue.id, 'agent-x', session.id);

    await sendToSession(session.id, '试试起轮');
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('失败');
    const after = getIssue(t.db, issue.id)!;
    expect(after.status).toBe('待规划');
    expect(after.claimed_by).toBeNull();
    expect(listCommentsByIssue(t.db, issue.id)).toEqual([
      expect.objectContaining({ author: 'agent:nope', content: '会话异常退出' }),
    ]);
  });
});

describe('重启恢复', () => {
  it('recoverOnBoot：运行中会话转失败；占用 issue 释放并写 system 评论', async () => {
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control); // 两个会话的轮次都挂起，保持 '运行中'
    };
    const issue = createIssue(t.db, { workspace_id: wsId, title: '中断任务' });
    const busy = await newSession({ issue_id: issue.id, prompt: '干活' });
    await settle();
    claimIssue(t.db, issue.id, 'agent-x', busy.id);
    const free = await newSession({ prompt: '自由会话' });
    await settle();

    // 模拟服务重启：重建 manager（内存态清零）→ 恢复
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
    await recoverOnBoot(t.db);

    expect(getSession(t.db, busy.id)!.status).toBe('失败');
    expect(getSession(t.db, free.id)!.status).toBe('失败');
    const after = getIssue(t.db, issue.id)!;
    expect(after.status).toBe('待规划');
    expect(after.claimed_by).toBeNull();
    expect(after.session_id).toBeNull();
    expect(listCommentsByIssue(t.db, issue.id)).toEqual([
      expect.objectContaining({ author: 'system', content: '服务重启，会话中断' }),
    ]);
  });
});

describe('adapter_session_id', () => {
  it('TurnResult 后回写；下一轮作为 resume 传入', async () => {
    const session = await newSession({ prompt: '第一轮' });
    await settle();
    expect(getSession(t.db, session.id)!.adapter_session_id).toBe('fake-as-0');

    await sendToSession(session.id, '第二轮');
    await settle();
    expect(adapter.calls[1]!.adapterSessionId).toBe('fake-as-0');
    expect(getSession(t.db, session.id)!.adapter_session_id).toBe('fake-as-1');
  });

  it('TurnResult 无 adapterSessionId 时不覆盖已有 resume 值', async () => {
    const session = await newSession({ prompt: '首轮' });
    await settle();
    adapter.script = (control) => {
      control.finish(0, null);
    };
    await sendToSession(session.id, '次轮');
    await settle();
    expect(getSession(t.db, session.id)!.adapter_session_id).toBe('fake-as-0');
  });

  it('reuse_session=last：沿用该 issue 最近 session 的 adapter_session_id', async () => {
    // 首轮自动完成产生 fake-as-0；第二个会话的轮次挂起，避免其写回抢先于断言
    adapter.script = (control) => {
      if (control.callIndex === 1) return;
      control.emit({ type: 'text', delta: `回复${control.callIndex}` });
      control.finish(0, `fake-as-${control.callIndex}`);
    };
    const issue = createIssue(t.db, { workspace_id: wsId, title: '续用' });
    const first = await newSession({ issue_id: issue.id, prompt: '第一轮' });
    await settle();
    expect(getSession(t.db, first.id)!.adapter_session_id).toBe('fake-as-0');

    const second = await newSession({ issue_id: issue.id, reuse_session: 'last', prompt: '续用轮' });
    expect(getSession(t.db, second.id)!.adapter_session_id).toBe('fake-as-0');
    await settle();
    expect(adapter.calls[1]!.adapterSessionId).toBe('fake-as-0');
  });
});

describe('事件聚合', () => {
  it('连续 text 合并为一条 assistant；tool/error 切分并按角色落库', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'text', delta: '第一段' });
      control.emit({ type: 'text', delta: '第二段' });
      control.emit({ type: 'tool', name: 'kb.show', input: '{"id":"i1"}' });
      control.emit({ type: 'text', delta: '第三段' });
      control.emit({ type: 'error', message: '子任务超时' });
      control.emit({ type: 'text', delta: '收尾' });
      control.finish(0, 'as-mix');
    };
    const session = await newSession({ prompt: 'x' });
    await settle();

    expect(
      listMessagesBySession(t.db, session.id).map((m) => [m.role, m.content]),
    ).toEqual([
      ['user', 'x'],
      ['assistant', '第一段第二段'],
      ['event', JSON.stringify({ name: 'kb.show', input: '{"id":"i1"}' })],
      ['assistant', '第三段'],
      ['error', '子任务超时'],
      ['assistant', '收尾'],
    ]);
  });
});
