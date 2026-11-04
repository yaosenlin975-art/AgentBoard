/**
 * panelStore 持久化（zustand persist，localStorage 键 agentboard.panel）：
 * partialize 落 view/issueId/sessionId/chatSession/rightOpen/unread 六字段；
 * unread 重水合经 sanitizeUnread 容错（非对象回空对象，非正整数条目剔除）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@agentboard/shared';
import { usePanelStore } from '../state/panelStore';

const session: Session = {
  id: 's1',
  workspace_id: 'ws-1',
  issue_id: null,
  cli: 'codebuddy',
  model: 'm1',
  status: '运行中',
  adapter_session_id: null,
  created_at: 1,
};

beforeEach(() => {
  localStorage.clear();
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    rightOpen: false,
  });
});

describe('panelStore 持久化', () => {
  it('只持久化 sessionId/chatSession/unread；视图意图（view/issueId/rightOpen）不落盘（PANEL-VIEW-BUG）', async () => {
    usePanelStore.setState({
      view: null,
      issueId: 'iss-1',
      sessionId: 's1',
      chatSession: session,
      unread: { s2: 3 },
      rightOpen: true,
    });

    const raw = localStorage.getItem('agentboard.panel');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(persisted.state).toMatchObject({ sessionId: 's1', unread: { s2: 3 } });
    expect(persisted.state.chatSession).toEqual(session);
    // 视图意图不持久化：刷新后不会把「上次停在聊天」带回内存，点任务必然进详情
    expect(persisted.state).not.toHaveProperty('view');
    expect(persisted.state).not.toHaveProperty('issueId');
    expect(persisted.state).not.toHaveProperty('rightOpen');

    // 模拟刷新：内存态重置为启动默认；localStorage 保留刷新前的持久化快照（重置触发的回写会被覆盖回来）
    usePanelStore.setState({
      view: null,
      issueId: null,
      sessionId: null,
      chatSession: null,
      unread: {},
      rightOpen: false,
    });
    localStorage.setItem('agentboard.panel', raw!);
    await usePanelStore.persist.rehydrate();
    const s = usePanelStore.getState();
    expect(s).toMatchObject({ sessionId: 's1', chatSession: session, view: null, issueId: null, rightOpen: false });
    expect(s.unread).toEqual({ s2: 3 });
  });

  it('unread 脏数据容错：非对象回空对象；非正整数条目剔除（0/负数/小数/字符串）', async () => {
    localStorage.setItem(
      'agentboard.panel',
      JSON.stringify({
        state: {
          view: 'chat',
          sessionId: 's1',
          rightOpen: true,
          unread: { s2: 2, str: 'x', zero: 0, neg: -1, half: 1.5 },
        },
        version: 0,
      }),
    );
    await usePanelStore.persist.rehydrate();
    const s = usePanelStore.getState();
    // PANEL-VIEW-BUG：视图意图不随快照恢复（旧快照里的 view 被丢弃），unread 仍按校验恢复
    expect(s.view).toBeNull();
    expect(s.unread).toEqual({ s2: 2 });

    localStorage.setItem(
      'agentboard.panel',
      JSON.stringify({ state: { unread: 'corrupt' }, version: 0 }),
    );
    await usePanelStore.persist.rehydrate();
    expect(usePanelStore.getState().unread).toEqual({});
  });
});

describe('removeSession（session.deleted 级联）', () => {
  it('被删的是当前选中会话：清 sessionId/chatSession 回空态，并清其未读计数', () => {
    usePanelStore.setState({
      view: null,
      sessionId: 's1',
      chatSession: session,
      unread: { s1: 2, s2: 1 },
      rightOpen: true,
    });

    usePanelStore.getState().removeSession('s1');

    const s = usePanelStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.chatSession).toBeNull();
    expect(s.unread).toEqual({ s2: 1 });
  });

  it('被删的是非当前会话：仅清其未读计数，当前选中不变', () => {
    usePanelStore.setState({
      view: null,
      sessionId: 's1',
      chatSession: session,
      unread: { s1: 2, s2: 3 },
    });

    usePanelStore.getState().removeSession('s2');

    const s = usePanelStore.getState();
    expect(s.sessionId).toBe('s1');
    expect(s.chatSession).toEqual(session);
    expect(s.unread).toEqual({ s1: 2 });
  });
});

