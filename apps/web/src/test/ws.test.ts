import { describe, expect, it } from 'vitest';
import type { Issue, ServerWsEvent, WsEvent } from '@agentboard/shared';
import { eventToQueryKeys } from '../api/ws';

const issue: Issue = {
  id: 'i-1',
  workspace_id: 'ws-1',
  title: 't',
  description: '',
  priority: '中',
  labels: [],
  status: '待规划',
  sort_order: 0,
  parent_issue_id: null,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  comment_count: 0,
  created_at: 1,
  updated_at: 1,
};

describe('eventToQueryKeys', () => {
  it('issue.changed → issues+workspace、issue+id 与依赖前缀', () => {
    const event: WsEvent = { type: 'issue.changed', issue };
    expect(eventToQueryKeys(event)).toEqual([
      ['issues', 'ws-1'],
      ['issue', 'i-1'],
      ['dependencies'],
    ]);
  });

  it('issue.deleted → issues+workspace、issue+id 与依赖前缀', () => {
    const event: WsEvent = { type: 'issue.deleted', issue_id: 'i-1', workspace_id: 'ws-1' };
    expect(eventToQueryKeys(event)).toEqual([
      ['issues', 'ws-1'],
      ['issue', 'i-1'],
      ['dependencies'],
    ]);
  });

  it('comment.added → comments+issue_id、issues（前缀，卡片评论数刷新）、issue+issue_id', () => {
    const event: WsEvent = {
      type: 'comment.added',
      comment: { id: 'c-1', issue_id: 'i-1', author: 'user', content: 'x', ts: 1 },
    };
    expect(eventToQueryKeys(event)).toEqual([
      ['comments', 'i-1'],
      ['issues'],
      ['issue', 'i-1'],
    ]);
    const imageEvent: WsEvent = {
      type: 'comment.added',
      comment: {
        id: 'c-image', issue_id: 'i-1', author: 'user', content: '', ts: 2,
        attachments: [{ id: 'a-1', file_name: 'a.png', mime_type: 'image/png', size_bytes: 8, url: '/a', delivery_state: 'pending' }],
      },
    };
    expect(eventToQueryKeys(imageEvent)).toContainEqual(['pending-attachments', 'i-1']);
  });

  it('comment.delivery.changed → comments 与待派发图片+issue_id', () => {
    const event: WsEvent = { type: 'comment.delivery.changed', issue_id: 'i-1', comment_ids: ['c-1'] };
    expect(eventToQueryKeys(event)).toEqual([['comments', 'i-1'], ['pending-attachments', 'i-1']]);
  });

  it('session.changed → sessions', () => {
    const event: WsEvent = {
      type: 'session.changed',
      session: {
        id: 's-1',
        workspace_id: 'ws-1',
        issue_id: null,
        cli: 'codex',
        model: null,
        status: '运行中',
        adapter_session_id: null,
        created_at: 1,
      },
    };
    expect(eventToQueryKeys(event)).toEqual([['sessions']]);
  });

  it('session.deleted → sessions', () => {
    const event: WsEvent = { type: 'session.deleted', session_id: 's-1' };
    expect(eventToQueryKeys(event)).toEqual([['sessions']]);
  });

  it('message.added → messages+session_id', () => {
    const event: WsEvent = {
      type: 'message.added',
      message: { id: 'm-1', session_id: 's-1', role: 'user', content: 'hi', ts: 1 },
    };
    expect(eventToQueryKeys(event)).toEqual([['messages', 's-1']]);
  });

  it('clis.changed → clis', () => {
    const event: WsEvent = {
      type: 'clis.changed',
      clis: [
        { id: 'dsh', displayName: 'DSH', installed: true, version: '0.2.1', supportsModelSelection: false },
      ],
    };
    expect(eventToQueryKeys(event)).toEqual([['clis']]);
  });

  it('session.event → 空（流式事件不触发 invalidation）', () => {
    const event: WsEvent = { type: 'session.event', session_id: 's-1', event: { type: 'text' } };
    expect(eventToQueryKeys(event)).toEqual([]);
  });

  it('session.runtime → 空（运行时态由聊天视图经 wsBus 增量校正，不触发 invalidation）', () => {
    const event: WsEvent = {
      type: 'session.runtime',
      session_id: 's-1',
      queued_count: 2,
      waiting_slot: true,
    };
    expect(eventToQueryKeys(event)).toEqual([]);
  });

  it('session.paused / session.resumed → sessions（暂停标记在会话行上）', () => {
    const session = {
      id: 's-1',
      workspace_id: 'ws-1',
      issue_id: null,
      cli: 'codex',
      model: null,
      status: '运行中' as const,
      adapter_session_id: null,
      created_at: 1,
    };
    const paused: ServerWsEvent = {
      type: 'session.paused',
      session_id: 's-1',
      paused_at: 2,
      session: { ...session, paused_at: 2 },
    };
    const resumed: ServerWsEvent = {
      type: 'session.resumed',
      session_id: 's-1',
      paused_at: null,
      session: { ...session, paused_at: null },
    };
    expect(eventToQueryKeys(paused)).toEqual([['sessions']]);
    expect(eventToQueryKeys(resumed)).toEqual([['sessions']]);
  });
});

/**
 * 类型护栏：`ServerWsEvent['type']` 的每个取值都必须出现在这个夹具里。
 *
 * `satisfies Record<ServerWsEvent['type'], …>` 在编译期强制键集与联合类型一致——
 * 以后谁往 `ServerWsEvent` 加事件却忘了在 `eventToQueryKeys` 里显式加 case，
 * 这里会先报「缺少属性 <新事件>」，而不是等到运行时才发现缓存没刷新。
 * 运行时再把每个 type 真跑一遍，断言不抛错、返回二维数组。
 */
const EVENT_FIXTURES = {
  'issue.changed': { type: 'issue.changed', issue },
  'issue.deleted': { type: 'issue.deleted', issue_id: 'i-1', workspace_id: 'ws-1' },
  'comment.added': {
    type: 'comment.added',
    comment: { id: 'c-1', issue_id: 'i-1', author: 'user', content: 'x', ts: 1 },
  },
  'comment.delivery.changed': { type: 'comment.delivery.changed', issue_id: 'i-1', comment_ids: [] },
  'session.changed': {
    type: 'session.changed',
    session: {
      id: 's-1',
      workspace_id: 'ws-1',
      issue_id: null,
      cli: 'codex',
      model: null,
      status: '运行中',
      adapter_session_id: null,
      created_at: 1,
    },
  },
  'session.deleted': { type: 'session.deleted', session_id: 's-1' },
  'session.event': { type: 'session.event', session_id: 's-1', event: { type: 'text' } },
  'session.runtime': {
    type: 'session.runtime',
    session_id: 's-1',
    queued_count: 0,
    waiting_slot: false,
  },
  'message.added': {
    type: 'message.added',
    message: { id: 'm-1', session_id: 's-1', role: 'user', content: 'hi', ts: 1 },
  },
  'clis.changed': { type: 'clis.changed', clis: [] },
  'account.notice': {
    type: 'account.notice',
    app_id: 'trae',
    client_instance_id: 'inst-1',
    message: 'notice',
  },
  'session.plan': {
    type: 'session.plan',
    session_id: 's-1',
    turn_id: 't-1',
    plan: [],
    current_index: 0,
  },
  'session.usage': {
    type: 'session.usage',
    session_id: 's-1',
    turn_id: 't-1',
    usage: {
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      context_used_tokens: null,
      context_limit_tokens: null,
      estimated: true,
    },
  },
  'session.turn': {
    type: 'session.turn',
    session_id: 's-1',
    turn_id: 't-1',
    state: 'running',
  },
  'session.approval_request': {
    type: 'session.approval_request',
    session_id: 's-1',
    turn_id: 't-1',
    request_id: 'r-1',
    tool: 'shell',
    target: 'rm -rf build',
    risk: 'high',
  },
  'decision.grace_started': {
    type: 'decision.grace_started',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'grace',
  },
  'decision.answered': {
    type: 'decision.answered',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'answered',
  },
  'decision.expired': {
    type: 'decision.expired',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'open',
  },
  'decision.revised': {
    type: 'decision.revised',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'answered',
  },
  'decision.withdrawn': {
    type: 'decision.withdrawn',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'withdrawn',
  },
  'decision.extended': {
    type: 'decision.extended',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'grace',
    grace_until: 2,
    extended_seconds: 60,
    extension_count: 1,
  },
  'decision.undone': {
    type: 'decision.undone',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'grace',
    reverted_to: 'grace',
    last_undone_revision: 1,
    undo_deadline_at: 2,
  },
  'issue.stop_requested': {
    type: 'issue.stop_requested',
    workspace_id: 'ws-1',
    issue_id: 'i-1',
    decision_id: 'd-1',
    state: 'open',
    reason: 'grace_expired',
  },
  'session.paused': {
    type: 'session.paused',
    session_id: 's-1',
    paused_at: 2,
    session: {
      id: 's-1',
      workspace_id: 'ws-1',
      issue_id: null,
      cli: 'codex',
      model: null,
      status: '运行中',
      adapter_session_id: null,
      created_at: 1,
      paused_at: 2,
    },
  },
  'session.resumed': {
    type: 'session.resumed',
    session_id: 's-1',
    paused_at: null,
    session: {
      id: 's-1',
      workspace_id: 'ws-1',
      issue_id: null,
      cli: 'codex',
      model: null,
      status: '运行中',
      adapter_session_id: null,
      created_at: 1,
      paused_at: null,
    },
  },
} satisfies Record<ServerWsEvent['type'], ServerWsEvent>;

describe('eventToQueryKeys 类型护栏', () => {
  it('ServerWsEvent 每个 type 都跑一遍：不抛错且返回二维数组', () => {
    for (const [type, event] of Object.entries(EVENT_FIXTURES)) {
      expect(event.type).toBe(type);
      const keys = eventToQueryKeys(event);
      expect(Array.isArray(keys)).toBe(true);
      for (const key of keys) expect(Array.isArray(key)).toBe(true);
    }
  });

  it('夹具覆盖 ServerWsEvent 的全部 type（缺键由 satisfies 编译期拦截）', () => {
    expect(Object.keys(EVENT_FIXTURES)).toHaveLength(25);
  });
});
