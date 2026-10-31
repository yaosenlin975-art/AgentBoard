/**
 * 右侧面板视图状态：detail / chat 互斥。
 * T13 扩展任务详情、T14 扩展聊天视图；本文件先钉最小契约。
 */
import { create } from 'zustand';

export type PanelView = 'detail' | 'chat';

interface PanelState {
  view: PanelView | null;
  issueId: string | null;
  sessionId: string | null;
  openDetail: (issueId: string) => void;
  openChat: (sessionId?: string) => void;
  close: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  view: null,
  issueId: null,
  sessionId: null,
  openDetail: (issueId) => set({ view: 'detail', issueId }),
  openChat: (sessionId) => set({ view: 'chat', sessionId: sessionId ?? null }),
  close: () => set({ view: null, issueId: null, sessionId: null }),
}));
