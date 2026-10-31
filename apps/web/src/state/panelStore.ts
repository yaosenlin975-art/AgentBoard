/**
 * 右侧面板视图状态：detail / chat 互斥，可整体收起（rightOpen）。
 * openDetail/openChat 只切换视图并展开，不重置另一视图的数据：
 * 两个视图组件各持 react-query 缓存，往返切换不丢选中 issue/session。
 * chatSession 携带打开聊天时的会话对象（ChatPanel 无 GET /api/sessions/:id 端点，
 * 以此定位 workspace 并显示 CLI/模型；后续以 WS session.changed 覆盖）。
 * unread：聊天视图本地未读计数（WS message.added 且非当前会话 +1，openChat 清零）。
 */
import { create } from 'zustand';
import type { Session } from '@agentboard/shared';

export type PanelView = 'detail' | 'chat';

interface PanelState {
  view: PanelView | null;
  issueId: string | null;
  sessionId: string | null;
  /** 打开聊天视图时携带的会话对象（同 sessionId 下被 WS session.changed 更新前的基础数据） */
  chatSession: Session | null;
  /** 各会话未读新消息计数（会话 id → 条数） */
  unread: Record<string, number>;
  /** 右侧面板是否展开（收起保留 view/issueId/sessionId，展开按钮恢复） */
  rightOpen: boolean;
  /** 打开任务详情并展开右侧 */
  openDetail: (issueId: string) => void;
  /** 切到聊天视图并展开右侧；不传 sessionId 时沿用当前选中会话 */
  openChat: (sessionId?: string, session?: Session) => void;
  /** 记一条未读（非当前聊天会话收到 message.added） */
  markUnread: (sessionId: string) => void;
  /** 清除某会话未读计数 */
  clearUnread: (sessionId: string) => void;
  /** 收起右侧面板（数据保留） */
  closeRight: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  view: null,
  issueId: null,
  sessionId: null,
  chatSession: null,
  unread: {},
  rightOpen: false,
  openDetail: (issueId) => set({ view: 'detail', issueId, rightOpen: true }),
  openChat: (sessionId, session) =>
    set((s) => {
      const id = sessionId ?? s.sessionId;
      return {
        view: 'chat',
        sessionId: id,
        // 同会话沿用已存会话对象；换会话只认新传入的
        chatSession: session ?? (id === s.sessionId ? s.chatSession : null),
        unread: id !== null ? { ...s.unread, [id]: 0 } : s.unread,
        rightOpen: true,
      };
    }),
  markUnread: (sessionId) =>
    set((s) => ({ unread: { ...s.unread, [sessionId]: (s.unread[sessionId] ?? 0) + 1 } })),
  clearUnread: (sessionId) => set((s) => ({ unread: { ...s.unread, [sessionId]: 0 } })),
  closeRight: () => set({ rightOpen: false }),
}));
