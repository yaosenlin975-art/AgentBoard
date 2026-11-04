/**
 * NAV-CHAT-EXIT：整屏聊天的退出入口。
 *
 * 覆盖三件事（纯数据，不依赖 DOM 渲染）：
 * - 进入聊天记住来源视图，退出回它；
 * - 来源缺失/非法（历史快照、刷新后）回 board；
 * - 退出快捷键：Esc 与 Ctrl/Cmd + [，Alt 组合不算。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NAV_VIEW, NAV_STORAGE_KEY, isChatExitKey, useNavStore } from '../state/navStore';

function reset(): void {
  localStorage.removeItem(NAV_STORAGE_KEY);
  useNavStore.setState({ view: DEFAULT_NAV_VIEW, drawer: null, chatOrigin: null });
}

beforeEach(reset);

describe('退出聊天回来源视图（NAV-CHAT-EXIT）', () => {
  it('从任务树进聊天 → 退出回任务树', () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().setView('chat');
    expect(useNavStore.getState().chatOrigin).toBe('tree');
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe('tree');
    expect(useNavStore.getState().chatOrigin).toBeNull();
  });

  it('从看板进聊天 → 退出回看板；从知识库/日志进也各自回原视图', () => {
    useNavStore.getState().setView('board');
    useNavStore.getState().setView('chat');
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe('board');

    for (const origin of ['knowledge', 'log'] as const) {
      useNavStore.getState().setView(origin);
      useNavStore.getState().setView('chat');
      useNavStore.getState().exitChat();
      expect(useNavStore.getState().view).toBe(origin);
    }
  });

  it('已在聊天里重复进入：保留最初的来源视图', () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().setView('chat');
    useNavStore.getState().setView('chat');
    expect(useNavStore.getState().chatOrigin).toBe('tree');
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe('tree');
  });

  it('来源缺失或非法 → 退出回 board（不留在 chat）', () => {
    useNavStore.setState({ view: 'chat', chatOrigin: null });
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe(DEFAULT_NAV_VIEW);

    // 非法来源（手改 localStorage / 旧版本遗留的 'chat'）
    useNavStore.setState({ view: 'chat', chatOrigin: 'chat' as never });
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe(DEFAULT_NAV_VIEW);
  });

  it('直接切到其它视图会清空来源（不残留过期来源）', () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().setView('chat');
    useNavStore.getState().setView('knowledge');
    expect(useNavStore.getState().chatOrigin).toBeNull();
    expect(useNavStore.getState().view).toBe('knowledge');
  });

  it('chatOrigin 不持久化：只落 view', () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().setView('chat');
    const raw = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? '{}') as { state?: Record<string, unknown> };
    expect(raw.state).toMatchObject({ view: 'chat' });
    expect(raw.state).not.toHaveProperty('chatOrigin');
  });
});

describe('退出快捷键判定（NAV-CHAT-EXIT）', () => {
  it('Esc / Ctrl+[ / Cmd+[ 触发；普通 [ 与 Alt 组合不触发', () => {
    expect(isChatExitKey({ key: 'Escape' })).toBe(true);
    expect(isChatExitKey({ key: '[', ctrlKey: true })).toBe(true);
    expect(isChatExitKey({ key: '[', metaKey: true })).toBe(true);
    expect(isChatExitKey({ key: '[' })).toBe(false);
    expect(isChatExitKey({ key: '[', altKey: true, ctrlKey: true })).toBe(false);
    expect(isChatExitKey({ key: 'Escape', altKey: true })).toBe(false);
    expect(isChatExitKey({ key: 'b' })).toBe(false);
  });
});
