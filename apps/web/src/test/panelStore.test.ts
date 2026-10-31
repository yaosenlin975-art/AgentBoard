/**
 * panelStore 持久化（zustand persist，localStorage 键 agentboard.panel）：
 * partialize 只落 view/issueId/sessionId/chatSession/rightOpen；unread 不持久化；
 * 重水合恢复五字段且 unread 保持启动默认空。
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
  it('五字段落 agentboard.panel；unread 不写入；rehydrate 恢复且 unread 保持空', async () => {
    usePanelStore.setState({
      view: 'chat',
      issueId: 'iss-1',
      sessionId: 's1',
      chatSession: session,
      unread: { s2: 3 },
      rightOpen: true,
    });

    const raw = localStorage.getItem('agentboard.panel');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(persisted.state).toMatchObject({
      view: 'chat',
      issueId: 'iss-1',
      sessionId: 's1',
      rightOpen: true,
    });
    expect(persisted.state.chatSession).toEqual(session);
    expect(persisted.state.unread).toBeUndefined();

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
    expect(s).toMatchObject({
      view: 'chat',
      issueId: 'iss-1',
      sessionId: 's1',
      chatSession: session,
      rightOpen: true,
    });
    expect(s.unread).toEqual({});
  });
});
