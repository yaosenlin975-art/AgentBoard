/**
 * 右侧面板视图状态：detail / chat 互斥，可整体收起（rightOpen）。
 * openDetail/openChat 只切换视图并展开，不重置另一视图的数据：
 * 两个视图组件各持 react-query 缓存，往返切换不丢选中 issue/session。
 * T13 扩展任务详情；T14 扩展聊天视图（ChatPanel 替换占位）。
 */
import { create } from 'zustand';

export type PanelView = 'detail' | 'chat';

interface PanelState {
  view: PanelView | null;
  issueId: string | null;
  sessionId: string | null;
  /** 右侧面板是否展开（收起保留 view/issueId/sessionId，展开按钮恢复） */
  rightOpen: boolean;
  /** 打开任务详情并展开右侧 */
  openDetail: (issueId: string) => void;
  /** 切到聊天视图并展开右侧；不传 sessionId 时沿用当前选中会话 */
  openChat: (sessionId?: string) => void;
  /** 收起右侧面板（数据保留） */
  closeRight: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  view: null,
  issueId: null,
  sessionId: null,
  rightOpen: false,
  openDetail: (issueId) => set({ view: 'detail', issueId, rightOpen: true }),
  openChat: (sessionId) =>
    set((s) => ({ view: 'chat', sessionId: sessionId ?? s.sessionId, rightOpen: true })),
  closeRight: () => set({ rightOpen: false }),
}));
