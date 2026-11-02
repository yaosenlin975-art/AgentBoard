import { describe, expect, it } from 'vitest';
import type { Issue, WsEvent } from '@agentboard/shared';
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
  it('issue.changed → issues+workspace 与 issue+id', () => {
    const event: WsEvent = { type: 'issue.changed', issue };
    expect(eventToQueryKeys(event)).toEqual([
      ['issues', 'ws-1'],
      ['issue', 'i-1'],
    ]);
  });

  it('issue.deleted → issues+workspace 与 issue+id', () => {
    const event: WsEvent = { type: 'issue.deleted', issue_id: 'i-1', workspace_id: 'ws-1' };
    expect(eventToQueryKeys(event)).toEqual([
      ['issues', 'ws-1'],
      ['issue', 'i-1'],
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
});
